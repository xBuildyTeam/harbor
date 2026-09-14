const { ipcMain, app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ollama = require('./ollama');
const tunnel = require('./tunnel');

const settingsPath = path.join(app.getPath('userData'), 'wave-dock-settings.json');
const cfbin = require('./cfbin');
// Harbor's managed binary lives beside its settings, so it needs no admin rights
// and cannot be missed by a stale PATH.
cfbin.configure(app.getPath('userData'));

// ONE SOURCE OF TRUTH for persisted keys.
//
// This whitelist has silently dropped a field FIVE separate times
// (sharedFolders, deviceToken, relaySecret, remoteAccessEnabled, and the
// original). The failure mode is nasty: the write returns fine, the value is
// simply gone on the next save, so it presents as "the setting keeps resetting"
// with no error anywhere. Declaring keys in two places is what caused that, so
// now there is one place, and an unknown key COMPLAINS instead of vanishing.
const SETTINGS_SCHEMA = {
  aiMode: (v) => v || 'auto',
  chatCollapsed: (v) => !!v,
  conversations: (v) => (Array.isArray(v) ? v : []),
  agentId: (v) => v || null,
  deviceId: (v) => v || null,
  deviceToken: (v) => v || null,
  pairedAt: (v) => v || null,
  sharedFolders: (v) => (Array.isArray(v) ? v : []),
  relaySecret: (v) => v || null,
  remoteAccessEnabled: (v) => v === true,
  // Privacy: local addresses and the public tunnel hostname are masked in the
  // dock by default so a screen recording does not leak them. Default false
  // means "hidden" - the safe state has to be the one you get by doing nothing.
  revealLocalDetails: (v) => v === true,
};

const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA);

function getSettingsData() {
  let raw = {};
  try {
    if (fs.existsSync(settingsPath)) {
      raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
    }
  } catch (e) {
    raw = {};
  }
  const out = {};
  for (const key of SETTINGS_KEYS) out[key] = SETTINGS_SCHEMA[key](raw[key]);
  return out;
}

function saveSettingsData(newSettings) {
  // Sixth time is not the charm. An undeclared key would be dropped on the next
  // read, so say so at the moment it happens rather than weeks later.
  for (const key of Object.keys(arguments[0] || {})) {
    if (!SETTINGS_KEYS.includes(key)) {
      console.error(`[settings] REFUSING unknown key "${key}" - add it to SETTINGS_SCHEMA or it will be silently dropped`);
    }
  }
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
  const fileserver = require('./fileserver');
  const filetunnel = require('./filetunnel');

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
        // Wave OS's relay presents THIS, not the device token. The device token
        // proves Harbor to Wave OS; the relay secret proves Wave OS to Harbor.
        // Opposite directions, so they cannot be the same value.
        relaySecret: res.data.relay_secret || null,
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
    saveSettingsData({ deviceId: null, deviceToken: null, relaySecret: null, pairedAt: null });
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
    // MEASURED 2026-09-11: Wave OS's shared_folders schema uses `label`, not
    // `name`. Sending `name` was accepted with ok:true and stored as
    // label: null - a silent drop, so folders arrived unnamed. Send both:
    // `label` for Wave OS, `name` kept for Harbor's own UI.
    const folders = (Array.isArray(st.sharedFolders) ? st.sharedFolders : []).map(f => ({
      path: f.path,
      label: f.label || f.name || f.path,
      name: f.name || f.label || f.path,
      permissions: f.permissions || 'read-only',
    }));
    return await pairing.callHarborDeviceSync({
      device_token: st.deviceToken,
      is_online: online !== false,
      shared_folders: folders,
      // null when remote access is off, which is the honest value - the relay
      // then reports the device unreachable instead of dialling a dead host.
      tunnel_url: filetunnel.getUrl() || null,
      // connection_mode has sat at 'pending' on every row since pairing shipped
      // because nothing ever set it, and it may be what Wave OS's Harbor tab
      // reads for its offline banner. UNVERIFIED that the backend accepts this
      // key - confirm by reading the row back, never by trusting ok: true.
      connection_mode: filetunnel.getUrl() ? 'relay' : 'pending',
    });
  }

  // The file server reads its token and roots live from settings on every
  // request, so adding or removing a shared folder takes effect immediately
  // with no restart - and revoking the pairing kills access on the next call.
  function fileServerConfig() {
    const st = getSettingsData();
    return {
      token: st.deviceToken,
      relaySecret: st.relaySecret || null,
      folders: Array.isArray(st.sharedFolders) ? st.sharedFolders : [],
    };
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    fileserver.startFileServer(fileServerConfig).then(async (r) => {
      if (!r.ok) {
        console.error('[harbor] file server failed to bind:', r.error);
        return;
      }
      // THE FIX. startFileTunnel was previously called from exactly ONE place -
      // the toggle - so remoteAccessEnabled persisted as true across a restart
      // while nothing ever restarted the tunnel. The file server auto-started
      // and the heartbeat auto-started; the tunnel did not. Result: a paired,
      // online, heartbeating device that published tunnel_url: null forever, so
      // the relay had no address and Wave OS showed the PC offline with no
      // folders. Measured on xBuildy 2026-09-14.
      const st = getSettingsData();
      if (st.remoteAccessEnabled !== true) return;
      const res = await filetunnel.startFileTunnel(r.port);
      if (res && res.ok) {
        console.log('[harbor] remote access resumed at launch');
      } else {
        console.error('[harbor] remote access could not resume:', res && res.error);
      }
      // Armed either way: a tunnel that failed at boot because the network was
      // not up yet is the normal case on a cold start, not a permanent failure.
      filetunnel.armWatchdog(r.port, () => sendHeartbeat(true));
      await sendHeartbeat(true);
    });
    sendHeartbeat(true);
    heartbeatTimer = setInterval(() => sendHeartbeat(true), 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    fileserver.stopFileServer();
    filetunnel.stopFileTunnel();
  }

  if (getSettingsData().deviceToken) startHeartbeat();

  app.on('before-quit', () => {
    stopHeartbeat();
    sendHeartbeat(false); // best-effort; see the note above
  });

  ipcMain.handle('tunnelbin:status', async () => {
    const bin = await cfbin.resolveBinary();
    return {
      found: bin.found,
      source: bin.source,
      version: bin.version,
      unusable: !!bin.unusable,
      path: bin.path,
      installable: !!cfbin.assetName(),
    };
  });

  ipcMain.handle('tunnelbin:install', async () => {
    const before = await cfbin.resolveBinary();
    if (before.found) return { ok: true, already: true, version: before.version };
    return await cfbin.installBinary();
  });

  ipcMain.handle('privacy:get', async () => {
    return { reveal: getSettingsData().revealLocalDetails === true };
  });

  ipcMain.handle('privacy:set', async (event, reveal) => {
    saveSettingsData({ revealLocalDetails: reveal === true });
    return { ok: true, reveal: reveal === true };
  });

  ipcMain.handle('remote:status', async () => {
    const st = getSettingsData();
    return {
      enabled: st.remoteAccessEnabled === true,
      url: filetunnel.getUrl(),
      running: filetunnel.isRunning(),
      // Reported separately so the dock can never again invent "starting" for
      // something that is not starting.
      starting: filetunnel.isStarting(),
      gaveUp: filetunnel.gaveUp(),
      paired: !!st.deviceToken,
    };
  });

  ipcMain.handle('remote:setEnabled', async (event, enabled) => {
    const want = enabled === true;
    saveSettingsData({ remoteAccessEnabled: want });
    if (!want) {
      filetunnel.disarmWatchdog();
      filetunnel.stopFileTunnel();
      await sendHeartbeat(true); // republish immediately with tunnel_url: null
      return { ok: true, enabled: false, url: null };
    }
    const srv = fileserver.fileServerStatus();
    if (!srv.running) return { ok: false, error: 'File server is not running - pair the device first' };
    const res = await filetunnel.startFileTunnel(srv.port);
    if (!res.ok) {
      saveSettingsData({ remoteAccessEnabled: false });
      return { ok: false, error: res.error, needsInstall: !!res.needsInstall };
    }
    filetunnel.armWatchdog(srv.port, () => sendHeartbeat(true));
    await sendHeartbeat(true); // publish the new hostname without waiting 30s
    return { ok: true, enabled: true, url: res.url };
  });

  ipcMain.handle('fileserver:status', async () => {
    const st = fileserver.fileServerStatus();
    const cfg = fileServerConfig();
    return { ...st, folderCount: (cfg.folders || []).length, paired: !!cfg.token };
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
