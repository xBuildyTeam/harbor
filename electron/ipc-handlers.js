const { ipcMain, app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ollama = require('./ollama');
const tunnel = require('./tunnel');

const settingsPath = path.join(app.getPath('userData'), 'wave-dock-settings.json');

function getSettingsData() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      return {
        aiMode: data.aiMode || 'auto',
        chatCollapsed: !!data.chatCollapsed,
        conversations: Array.isArray(data.conversations) ? data.conversations : [],
        // Pairing state. NOTE: this function is a WHITELIST - saveSettingsData
        // merges over its result, so any key missing here is silently dropped on
        // the next write. Adding a persisted field means adding it in both places.
        agentId: data.agentId || null,
        deviceId: data.deviceId || null,
        deviceToken: data.deviceToken || null,
        pairedAt: data.pairedAt || null,
        sharedFolders: Array.isArray(data.sharedFolders) ? data.sharedFolders : []
      };
    }
  } catch (e) {
    console.error('Failed to read settings:', e);
  }
  return {
    aiMode: 'auto', chatCollapsed: false, conversations: [],
    agentId: null, deviceId: null, deviceToken: null, pairedAt: null,
    sharedFolders: []
  };
}

function saveSettingsData(newSettings) {
  try {
    const current = getSettingsData();
    const updated = { ...current, ...newSettings };
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  } catch (e) {
    console.error('Failed to save settings:', e);
    throw e;
  }
}

function pruneConversations(conversations) {
  if (conversations.length > 100) {
    const archived = conversations.filter(c => c.archived);
    const active = conversations.filter(c => !c.archived);
    
    archived.sort((a, b) => new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0));
    
    while (active.length + archived.length > 100 && archived.length > 0) {
      archived.shift();
    }
    
    while (active.length + archived.length > 100 && active.length > 0) {
      active.sort((a, b) => new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0));
      active.shift();
    }
    
    return [...active, ...archived];
  }
  return conversations;
}

/**
 * Registers all IPC handlers to bridge renderer calls to main process APIs
 */
function registerIpcHandlers({
  getBrowserView,
  expandWindow,
  closeDock,
  minimizeDock,
  onToggleSidebar,
  resizeBrowserView
}) {
  // --- Pairing Handlers (Harbor's half of the device-code handshake) ---
  const pairing = require('./pairing');

  function ensureAgentId() {
    const st = getSettingsData();
    if (st.agentId) return st.agentId;
    const id = crypto.randomUUID();
    saveSettingsData({ agentId: id });
    return id;
  }

  ipcMain.handle('pairing:getStatus', async () => {
    const st = getSettingsData();
    return {
      paired: !!st.deviceToken,
      deviceId: st.deviceId,
      pairedAt: st.pairedAt,
      deviceName: pairing.localDeviceName(),
      platform: pairing.localPlatform(),
    };
  });

  ipcMain.handle('pairing:start', async () => {
    const code = pairing.generateCode();
    const res = await pairing.callHarborPair('register-code', {
      code,
      agent_id: ensureAgentId(),
      device_name: pairing.localDeviceName(),
      platform: pairing.localPlatform(),
    });
    if (!res.ok) return { ok: false, error: res.error };
    // The countdown is driven by the SERVER's expires_at, never a local timer -
    // a locally invented countdown is a number the UI cannot actually know.
    return { ok: true, code, expiresAt: res.data.expires_at };
  });

  ipcMain.handle('pairing:poll', async (event, code) => {
    const st = getSettingsData();
    if (!st.agentId) return { ok: false, error: 'No agent id' };
    const res = await pairing.callHarborPair('poll-code', { code, agent_id: st.agentId });
    if (!res.ok) return { ok: false, error: res.error };
    const status = res.data.status;
    if (status === 'claimed' && res.data.device_token) {
      saveSettingsData({
        deviceId: res.data.device_id,
        deviceToken: res.data.device_token,
        pairedAt: new Date().toISOString(),
      });
      startHeartbeat();
      return { ok: true, status: 'claimed', deviceId: res.data.device_id };
    }
    return { ok: true, status: status || 'pending' };
  });

  ipcMain.handle('pairing:unpair', async () => {
    // Clears the local credential only. The HarborDevice row stays in Wave OS -
    // removing it is the owner's call from the device list, not the agent's.
    await sendHeartbeat(false); // tell Wave OS before the token is discarded
    stopHeartbeat();
    saveSettingsData({ deviceId: null, deviceToken: null, pairedAt: null });
    return { ok: true };
  });

  // --- Heartbeat ---------------------------------------------------------
  // Wave OS reads a STORED is_online boolean, so a paired PC reads "offline"
  // until the agent asserts otherwise on a timer. 30s cadence.
  // Known weakness of the stored model: a crash or kill leaves the row reading
  // online forever, because the final offline sync below is best-effort. The
  // durable fix is for Wave OS to DERIVE online from last_seen; until it does,
  // this is the honest best a client can manage.
  let heartbeatTimer = null;

  async function sendHeartbeat(online) {
    const st = getSettingsData();
    if (!st.deviceToken) return { ok: false, error: 'Not paired' };
    return await pairing.callHarborDeviceSync({
      device_token: st.deviceToken,
      is_online: online !== false,
      shared_folders: Array.isArray(st.sharedFolders) ? st.sharedFolders : [],
    });
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    sendHeartbeat(true);
    heartbeatTimer = setInterval(() => sendHeartbeat(true), 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  if (getSettingsData().deviceToken) startHeartbeat();

  app.on('before-quit', () => {
    stopHeartbeat();
    sendHeartbeat(false); // best-effort; see the note above
  });

  ipcMain.handle('pairing:heartbeatNow', async () => await sendHeartbeat(true));

  ipcMain.handle('pairing:listFolders', async () => {
    const st = getSettingsData();
    return Array.isArray(st.sharedFolders) ? st.sharedFolders : [];
  });

  ipcMain.handle('pairing:addFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Share a folder with Wave OS',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const st = getSettingsData();
    const folders = Array.isArray(st.sharedFolders) ? st.sharedFolders.slice() : [];
    for (const dir of result.filePaths) {
      if (folders.some(f => f.path === dir)) continue;
      // read-only, matching the per-folder permission model already present on
      // Wave OS's device rows. Harbor must never widen this to whole-disk.
      folders.push({ path: dir, name: path.basename(dir) || dir, permissions: 'read-only' });
    }
    saveSettingsData({ sharedFolders: folders });
    const sync = await sendHeartbeat(true);
    return { ok: true, folders, synced: !!(sync && sync.ok) };
  });

  ipcMain.handle('pairing:removeFolder', async (event, dirPath) => {
    const st = getSettingsData();
    const folders = (Array.isArray(st.sharedFolders) ? st.sharedFolders : [])
      .filter(f => f.path !== dirPath);
    saveSettingsData({ sharedFolders: folders });
    await sendHeartbeat(true);
    return { ok: true, folders };
  });

  // --- Settings & Conversation Handlers ---
  ipcMain.handle('settings:get', async () => {
    return getSettingsData();
  });

  ipcMain.handle('settings:set', async (event, newSettings) => {
    return saveSettingsData(newSettings);
  });

  ipcMain.handle('settings:getConversations', async () => {
    const settings = getSettingsData();
    return settings.conversations || [];
  });

  ipcMain.handle('settings:saveConversation', async (event, conv) => {
    const settings = getSettingsData();
    let conversations = settings.conversations || [];
    const index = conversations.findIndex(c => c.id === conv.id);
    const now = new Date().toISOString();

    if (index >= 0) {
      conversations[index] = {
        ...conversations[index],
        ...conv,
        updatedAt: conv.updatedAt || now
      };
    } else {
      const newConv = {
        id: conv.id || 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        title: conv.title || 'New Conversation',
        messages: conv.messages || [],
        createdAt: conv.createdAt || now,
        updatedAt: conv.updatedAt || now,
        archived: !!conv.archived
      };
      conversations.unshift(newConv);
    }
    conversations = pruneConversations(conversations);
    saveSettingsData({ conversations });
    return conversations;
  });

  ipcMain.handle('settings:archiveConversation', async (event, id) => {
    const settings = getSettingsData();
    let conversations = settings.conversations || [];
    const conv = conversations.find(c => c.id === id);
    if (conv) {
      conv.archived = true;
      conv.updatedAt = new Date().toISOString();
      conversations = pruneConversations(conversations);
      saveSettingsData({ conversations });
    }
    return conversations;
  });

  // --- Chat Sidebar Toggle Handler ---
  ipcMain.on('chat:toggleSidebar', (event, collapsed) => {
    saveSettingsData({ chatCollapsed: !!collapsed });
    if (onToggleSidebar) {
      onToggleSidebar(!!collapsed);
    }
  });

  // --- Webview Resize Handler (for collapsible sidebar) ---
  ipcMain.handle('webview:resize', async (event, collapsed) => {
    if (resizeBrowserView) {
      resizeBrowserView(collapsed);
    }
    return { resized: true };
  });

  // --- Ollama Handlers ---
  ipcMain.handle('ollama:check', async () => {
    return await ollama.checkOllama();
  });

  ipcMain.handle('ollama:start', async () => {
    return await ollama.startOllama();
  });

  ipcMain.handle('ollama:stop', async () => {
    return await ollama.stopOllama();
  });


  ipcMain.handle('ollama:pullModel', async (event, name) => {
    return await ollama.pullModel(name);
  });

  ipcMain.handle('ollama:chat', async (event, model, messages, options = {}) => {
    const settings = getSettingsData();
    const aiMode = options.aiMode || settings.aiMode || 'auto';
    const chatOptions = { ...options, aiMode };
    return await ollama.chat(model, messages, chatOptions);
  });

  // --- Local LLM Detection Handler (for Wave OS Settings → AI Models) ---
  // Exposes tunnel URL and Ollama status so Wave OS can auto-detect local LLM
  ipcMain.handle('localllm:getInfo', async () => {
    const ollamaStatus = await ollama.checkOllama();
    const tunnelUrl = tunnel.getTunnelUrl();
    return {
      ollama: {
        running: ollamaStatus.running,
        models: ollamaStatus.models || [],
        endpoint: 'http://localhost:11434'
      },
      tunnel: {
        active: !!tunnelUrl,
        url: tunnelUrl || null,
        // The Wave OS-compatible endpoint (OpenAI-compatible)
        llmEndpoint: tunnelUrl ? `${tunnelUrl}/v1` : null
      },
    };
  });

  // --- Tunnel Handlers ---
  ipcMain.handle('tunnel:start', async () => {
    return await tunnel.startTunnel();
  });

  ipcMain.handle('tunnel:stop', async () => {
    return await tunnel.stopTunnel();
  });

  ipcMain.handle('tunnel:getUrl', async () => {
    return tunnel.getTunnelUrl();
  });

  // --- BrowserView Navigation Handlers (app.oswave.io) ---
  ipcMain.on('nav:goBack', () => {
    const bv = getBrowserView();
    if (bv && bv.webContents.canGoBack()) {
      bv.webContents.goBack();
    }
  });

  ipcMain.on('nav:goForward', () => {
    const bv = getBrowserView();
    if (bv && bv.webContents.canGoForward()) {
      bv.webContents.goForward();
    }
  });

  ipcMain.on('nav:reload', () => {
    const bv = getBrowserView();
    if (bv) {
      bv.webContents.reload();
    }
  });

  // --- Window Operations Handlers ---
  ipcMain.on('window:expand', () => {
    expandWindow();
  });

  ipcMain.on('window:closeDock', () => {
    closeDock();
  });

  ipcMain.on('window:minimizeDock', () => {
    minimizeDock();
  });
}

module.exports = {
  registerIpcHandlers
};

// ============================================================
// FILESYSTEM BRIDGE HANDLERS (v3 — waveDockFS)
// ============================================================
function registerFsHandlers(ipcMain, app, shell) {
  const fsPromises = require('fs').promises;
  const pathModule = require('path');

  const BLOCKED_PATHS = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information'
  ];

  function isPathBlocked(targetPath) {
    const normalized = pathModule.resolve(targetPath).toUpperCase();
    return BLOCKED_PATHS.some(b => normalized.startsWith(pathModule.resolve(b).toUpperCase()));
  }

  ipcMain.handle('fs:list-drives', async () => {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const drivePath = `${letter}:\\`;
      try {
        await fsPromises.access(drivePath);
        let totalBytes = 0, freeBytes = 0;
        try { const s = await fsPromises.statfs(drivePath); totalBytes = s.blocks * s.bsize; freeBytes = s.bfree * s.bsize; } catch {}
        drives.push({ letter: `${letter}:`, path: drivePath, label: drivePath, totalBytes, freeBytes });
      } catch {}
    }
    return drives;
  });

  ipcMain.handle('fs:read-dir', async (event, dirPath) => {
    if (isPathBlocked(dirPath)) return { error: 'Access denied: system directory' };
    try {
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        const fullPath = pathModule.join(dirPath, entry.name);
        try {
          const stat = await fsPromises.stat(fullPath);
          items.push({ name: entry.name, path: fullPath, isFolder: entry.isDirectory(), isFile: entry.isFile(), size: stat.size, modified: stat.mtime.toISOString(), extension: entry.isFile() ? pathModule.extname(entry.name).slice(1).toLowerCase() : null });
        } catch {}
      }
      return items.sort((a, b) => { if (a.isFolder && !b.isFolder) return -1; if (!a.isFolder && b.isFolder) return 1; return a.name.localeCompare(b.name); });
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:read-file', async (event, filePath) => {
    if (isPathBlocked(filePath)) return { error: 'Access denied: system directory' };
    try {
      const stat = await fsPromises.stat(filePath);
      if (stat.size > 5 * 1024 * 1024) return { error: 'File too large for inline preview', size: stat.size };
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return { content, size: stat.size };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:write-file', async (event, filePath, content) => {
    if (isPathBlocked(filePath)) return { error: 'Access denied: system directory' };
    try { await fsPromises.writeFile(filePath, content, 'utf-8'); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:create-folder', async (event, dirPath) => {
    if (isPathBlocked(dirPath)) return { error: 'Access denied: system directory' };
    try { await fsPromises.mkdir(dirPath, { recursive: true }); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:rename', async (event, oldPath, newPath) => {
    if (isPathBlocked(oldPath) || isPathBlocked(newPath)) return { error: 'Access denied: system directory' };
    try { await fsPromises.rename(oldPath, newPath); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:delete', async (event, filePath) => {
    if (isPathBlocked(filePath)) return { error: 'Access denied: system directory' };
    try { await shell.trashItem(filePath); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:get-path', async (event, type) => {
    const paths = { desktop: app.getPath('desktop'), documents: app.getPath('documents'), downloads: app.getPath('downloads'), home: app.getPath('home'), pictures: app.getPath('pictures'), music: app.getPath('music'), videos: app.getPath('videos') };
    return paths[type] || null;
  });
}

// AI ROUTING HANDLERS (v3 — waveDockAI)
function registerAiHandlers(ipcMain) {
  // Harbor is LOCAL-ONLY by design. Cloud inference belongs to Wave OS, which
  // already owns Theta key management and model routing - a second router here
  // competed with it. Note this particular handler's Theta branch was ALSO dead:
  // it called theta.thetaChat(), which the module never exported, so 'auto' threw
  // instead of degrading whenever Ollama was stopped. The working Theta path was
  // the separate one in ollama.js; both are gone. Local failure now returns a
  // clear result object rather than throwing.
  ipcMain.handle('ai:chat', async (event, messages, options = {}) => {
    const ollama = require('./ollama');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await ollama.chat(options.model || 'phi4-mini', messages, controller.signal);
      return { ...result, provider: 'ollama' };
    } catch (e) {
      return {
        error: true,
        provider: 'ollama',
        content: 'Local AI is not running. Start Ollama from the Harbor dock, or ask the Wave Assistant in Wave OS for cloud models.',
        reason: e && e.message ? e.message : String(e)
      };
    } finally {
      clearTimeout(timeout);
    }
  })
}

// Self-registering: call at bottom of registerIpcHandlers or export for main.js
module.exports.registerFsHandlers = registerFsHandlers;
module.exports.registerAiHandlers = registerAiHandlers;
