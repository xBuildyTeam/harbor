const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Theta management
  isTunnelAvailable: () => ipcRenderer.invoke('tunnel:isAvailable'),

  // Pairing with Wave OS
  getPairingStatus: () => ipcRenderer.invoke('pairing:getStatus'),
  startPairing: () => ipcRenderer.invoke('pairing:start'),
  pollPairing: (code) => ipcRenderer.invoke('pairing:poll', code),
  unpair: () => ipcRenderer.invoke('pairing:unpair'),
  heartbeatNow: () => ipcRenderer.invoke('pairing:heartbeatNow'),
  getFileServerStatus: () => ipcRenderer.invoke('fileserver:status'),
  getRemoteStatus: () => ipcRenderer.invoke('remote:status'),
  getTunnelBinStatus: () => ipcRenderer.invoke('tunnelbin:status'),
  installTunnelBin: () => ipcRenderer.invoke('tunnelbin:install'),
  // Bring the Harbor panel forward from the browser window's top bar.
  showDock: () => ipcRenderer.send('window:showDock'),
  detectLocalAi: () => ipcRenderer.invoke('localai:detect'),
  getCloudStats: () => ipcRenderer.invoke('cloud:stats'),
  reindexCloud: () => ipcRenderer.invoke('cloud:reindex'),
  fitDockHeight: (h) => ipcRenderer.invoke('dock:fitHeight', h),
  createWaveFolder: () => ipcRenderer.invoke('cloud:createWaveFolder'),
  openWaveFolder: () => ipcRenderer.invoke('cloud:openWaveFolder'),
  removeWaveFolder: () => ipcRenderer.invoke('cloud:removeWaveFolder'),
  setFolderPermission: (p, perm) => ipcRenderer.invoke('cloud:setFolderPermission', p, perm),
  getPrivacy: () => ipcRenderer.invoke('privacy:get'),
  setPrivacy: (v) => ipcRenderer.invoke('privacy:set', v),
  setRemoteEnabled: (v) => ipcRenderer.invoke('remote:setEnabled', v),
  listSharedFolders: () => ipcRenderer.invoke('pairing:listFolders'),
  addSharedFolder: () => ipcRenderer.invoke('pairing:addFolder'),
  removeSharedFolder: (p) => ipcRenderer.invoke('pairing:removeFolder', p),

  // Settings & Conversations
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings) => ipcRenderer.invoke('settings:set', settings),
  getConversations: () => ipcRenderer.invoke('settings:getConversations'),
  saveConversation: (conv) => ipcRenderer.invoke('settings:saveConversation', conv),
  archiveConversation: (id) => ipcRenderer.invoke('settings:archiveConversation', id),
  toggleSidebar: (collapsed) => ipcRenderer.send('chat:toggleSidebar', collapsed),
  resizeWebview: (collapsed) => ipcRenderer.invoke('webview:resize', collapsed),

  // Local LLM detection (for Wave OS Settings → AI Models auto-detect)
  getLocalLLMInfo: () => ipcRenderer.invoke('localllm:getInfo'),

  // Ollama management
  checkOllama: () => ipcRenderer.invoke('ollama:check'),
  startOllama: () => ipcRenderer.invoke('ollama:start'),
  stopOllama: () => ipcRenderer.invoke('ollama:stop'),
  pullModel: (name) => ipcRenderer.invoke('ollama:pullModel', name),
  chat: (model, messages, options) => ipcRenderer.invoke('ollama:chat', model, messages, options),

  // Tunnel management
  startTunnel: () => ipcRenderer.invoke('tunnel:start'),
  stopTunnel: () => ipcRenderer.invoke('tunnel:stop'),
  getTunnelUrl: () => ipcRenderer.invoke('tunnel:getUrl'),

  // BrowserView Navigation (app.oswave.io)
  goBack: () => ipcRenderer.send('nav:goBack'),
  goForward: () => ipcRenderer.send('nav:goForward'),
  reload: () => ipcRenderer.send('nav:reload'),

  // Window control operations
  expand: () => ipcRenderer.send('window:expand'),
  closeDock: () => ipcRenderer.send('window:closeDock'),
  minimizeDock: () => ipcRenderer.send('window:minimizeDock'),

  // Events
  onTunnelUrl: (callback) => {
    const subscription = (event, url) => callback(url);
    ipcRenderer.on('tunnel:url-update', subscription);
    return () => {
      ipcRenderer.removeListener('tunnel:url-update', subscription);
    };
  },
  onNavUpdate: (callback) => {
    const subscription = (event, state) => callback(state);
    ipcRenderer.on('nav:update', subscription);
    return () => {
      ipcRenderer.removeListener('nav:update', subscription);
    };
  }
});

// === waveDockFS — Filesystem Bridge (v3) ===
// Exposed to Wave OS webview for local drive access
const harborBridgeFS = {
  isWaveDock: true,
  listDrives:   ()                    => ipcRenderer.invoke('fs:list-drives'),
  readDir:      (path)                => ipcRenderer.invoke('fs:read-dir', path),
  readFile:     (path)                => ipcRenderer.invoke('fs:read-file', path),
  // readFile is utf-8 only. readFileBytes is the byte channel that was missing -
  // the reason text opened on the local drive and audio, images and video did not.
  readFileBytes:(path)                => ipcRenderer.invoke('fs:read-file-bytes', path),
  // For large media: a real loopback HTTP endpoint supporting Range, so a player
  // can seek instead of buffering the whole file into the tab.
  getLocalEndpoint: ()                => ipcRenderer.invoke('local:endpoint'),
  writeFile:    (path, content)       => ipcRenderer.invoke('fs:write-file', path, content),
  createFolder: (path)                => ipcRenderer.invoke('fs:create-folder', path),
  rename:       (oldPath, newPath)    => ipcRenderer.invoke('fs:rename', oldPath, newPath),
  delete:       (path)                => ipcRenderer.invoke('fs:delete', path),
  getPath:      (type)                => ipcRenderer.invoke('fs:get-path', type)
};

contextBridge.exposeInMainWorld('waveDockFS', harborBridgeFS);

// === waveDockAI — AI + Chat + Tunnel Bridge (v3) ===
// High-level bridge for Wave OS webview AI features
const harborBridgeAI = {
  isWaveDock: true,
  // Ollama
  ollamaChat:   (model, messages)     => ipcRenderer.invoke('ollama:chat', model, messages, {}),
  ollamaModels: ()                    => ipcRenderer.invoke('ollama:check').then(r => r.models || []),
  ollamaHealth: ()                    => ipcRenderer.invoke('ollama:check'),
  pullModel:    (model)               => ipcRenderer.invoke('ollama:pullModel', model),
  // Theta EdgeCloud
  // Smart AI routing (auto/local/theta)
  aiChat:       (messages, options)   => ipcRenderer.invoke('ai:chat', messages, options),
  // Conversation persistence
  saveConversation:   (id, messages)  => ipcRenderer.invoke('settings:saveConversation', { id, messages }),
  loadConversation:   (id)            => ipcRenderer.invoke('settings:getConversations').then(cs => cs.find(c => c.id === id) || null),
  listConversations:  ()              => ipcRenderer.invoke('settings:getConversations'),
  deleteConversation: (id)            => ipcRenderer.invoke('settings:archiveConversation', id),
  // Tunnel
  tunnelStatus: ()                    => ipcRenderer.invoke('tunnel:getUrl').then(url => !!url),
  tunnelUrl:    ()                    => ipcRenderer.invoke('tunnel:getUrl')
};

contextBridge.exposeInMainWorld('waveDockAI', harborBridgeAI);

// ============================================================================
// Harbor alias bridges — additive, not a rename.
//
// The published Wave OS bundle at app.oswave.io detects the desktop agent with
//     window.isWaveDock === true && !!window.waveDockFS
// and calls 8 methods off waveDockFS (listDrives / readDir / readFile /
// writeFile / createFolder / rename / delete / getPath). Those names are a
// LIVE WIRE CONTRACT: renaming them for the Harbor rebrand would silently
// break the file bridge in the deployed web app — it would simply stop
// detecting the desktop agent, with no error anywhere.
//
// So the waveDock* names stay exactly as they are, and these aliases point at
// the SAME objects so the web side can migrate to Harbor naming whenever it
// likes. Remove the waveDock* exposures only once the published bundle no
// longer references them.
//
// Measured in the live bundle 2026-09-07: waveDockFS 9 hits, isWaveDock 3,
// waveDockAI 0 (the AI bridge is exposed but nothing on the web side consumes
// it yet), harborFS/harborAI 0.
// ============================================================================
// ⛔ LIVE BUG FIX (found 2026-09-07): Wave OS checks `window.isWaveDock === true`
// as a TOP-LEVEL global, but this preload only ever set `isWaveDock: true` as a
// PROPERTY INSIDE the bridge objects — which contextBridge does not promote to a
// global. So window.isWaveDock was undefined and Wave OS's detection
//     window.isWaveDock === true && !!window.waveDockFS
// always evaluated false. The desktop file bridge has therefore never been
// detected by the web app, despite both sides being implemented. One line:
contextBridge.exposeInMainWorld('isWaveDock', true);

contextBridge.exposeInMainWorld('isHarbor', true);
contextBridge.exposeInMainWorld('harborFS', harborBridgeFS);
contextBridge.exposeInMainWorld('harborAI', harborBridgeAI);
