const { app, BrowserWindow, BrowserView, screen, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const { registerIpcHandlers, registerFsHandlers, registerAiHandlers } = require('./ipc-handlers');
const { createTray } = require('./tray');
const ollama = require('./ollama');
const tunnel = require('./tunnel');
const theta = require('./theta');

let dockWindow = null;
let fullWindow = null;
let browserView = null;
let tray = null;

const sidebarWidth = 350;
const topBarHeight = 50;
let isSidebarCollapsed = false;

// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dockWindow) {
      if (dockWindow.isMinimized()) dockWindow.restore();
      dockWindow.show();
      dockWindow.focus();
    }
  });
}

// Window state storage path
const configPath = path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load window state:', e);
  }
  return {};
}

function saveState(state) {
  try {
    const current = loadState();
    const updated = { ...current, ...state };
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save window state:', e);
  }
}

// Create Dock Window (floating, frameless, bottom-right)
function createDockWindow() {
  const state = loadState();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.workArea;

  const dockWidth = 420;
  const dockHeight = 640;

  // Default to bottom-right position
  let dockX = x + width - dockWidth - 20;
  let dockY = y + height - dockHeight - 20;
  if (dockY < y) dockY = y + 10; // clamp if screen too short

  // Restore saved dock position if valid
  if (state.dockX !== undefined && state.dockY !== undefined) {
    if (
      state.dockX >= x &&
      state.dockX <= x + width - 100 &&
      state.dockY >= y &&
      state.dockY <= y + height - 100
    ) {
      dockX = state.dockX;
      dockY = state.dockY;
    }
  }

  dockWindow = new BrowserWindow({
    width: dockWidth,
    height: dockHeight,
    x: dockX,
    y: dockY,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  dockWindow.loadFile(path.join(__dirname, '../src/dock.html'));

  // Track position changes to persist
  dockWindow.on('move', () => {
    const bounds = dockWindow.getBounds();
    saveState({ dockX: bounds.x, dockY: bounds.y });
  });

  dockWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      dockWindow.hide();
    }
  });
}

// Resize BrowserView based on collapsed state or window bounds
function resizeBrowserView(collapsed) {
  if (typeof collapsed === 'boolean') {
    isSidebarCollapsed = collapsed;
  } else if (typeof collapsed === 'number') {
    isSidebarCollapsed = collapsed === 0;
  }

  if (!fullWindow || !browserView) return;
  const bounds = fullWindow.getContentBounds();
  const xOffset = isSidebarCollapsed ? 0 : sidebarWidth;
  const viewWidth = isSidebarCollapsed ? bounds.width : bounds.width - sidebarWidth;

  browserView.setBounds({
    x: xOffset,
    y: topBarHeight,
    width: Math.max(0, viewWidth),
    height: Math.max(0, bounds.height - topBarHeight)
  });
}

// Create Full Window (browser + AI sidebar)
function createFullWindow() {
  const state = loadState();

  const defaultWidth = 1200;
  const defaultHeight = 800;

  fullWindow = new BrowserWindow({
    width: state.fullWidth || defaultWidth,
    height: state.fullHeight || defaultHeight,
    x: state.fullX,
    y: state.fullY,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Harbor',
    // Harbor: hide the native Windows title bar but KEEP the min/max/close buttons,
    // overlaid on our own top strip. `frame: false` would remove them entirely.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a14',
      symbolColor: '#00e5c0',
      height: topBarHeight
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (state.fullMaximized) {
    fullWindow.maximize();
  }

  fullWindow.loadFile(path.join(__dirname, '../src/full.html'));

  // Create BrowserView for oswave.io — WITH preload so Wave OS can detect Wave Dock
  browserView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false  // Allow preload bridge to work; contextIsolation keeps it secure
    }
  });

  fullWindow.setBrowserView(browserView);
  browserView.webContents.loadURL('https://app.oswave.io');

  // Sync size of BrowserView on resize/maximize
  fullWindow.on('resize', () => resizeBrowserView());
  fullWindow.on('maximize', () => resizeBrowserView());
  fullWindow.on('unmaximize', () => resizeBrowserView());

  // Sync initial bounds
  fullWindow.once('ready-to-show', () => {
    resizeBrowserView();
  });

  // Track navigation inside BrowserView to update URL bar
  browserView.webContents.on('did-navigate', (event, url) => {
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send('nav:update', {
        url,
        canGoBack: browserView.webContents.canGoBack(),
        canGoForward: browserView.webContents.canGoForward()
      });
    }
  });

  browserView.webContents.on('did-navigate-in-page', (event, url) => {
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send('nav:update', {
        url,
        canGoBack: browserView.webContents.canGoBack(),
        canGoForward: browserView.webContents.canGoForward()
      });
    }
  });

  // Persist full window dimensions and position
  const saveFullWindowState = () => {
    if (!fullWindow) return;
    const bounds = fullWindow.getBounds();
    const isMax = fullWindow.isMaximized();
    saveState({
      fullWidth: bounds.width,
      fullHeight: bounds.height,
      fullX: bounds.x,
      fullY: bounds.y,
      fullMaximized: isMax
    });
  };

  fullWindow.on('move', saveFullWindowState);
  fullWindow.on('resize', saveFullWindowState);

  fullWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      fullWindow.hide();
    }
  });
}

// Toggle Dock visibility
function toggleDock() {
  if (!dockWindow) {
    createDockWindow();
  } else if (dockWindow.isVisible() && dockWindow.isFocused()) {
    dockWindow.hide();
  } else {
    dockWindow.show();
    dockWindow.focus();
  }
}

// Expand from Dock to Full Window
function expandWindow() {
  if (!fullWindow) {
    createFullWindow();
  }
  fullWindow.show();
  fullWindow.focus();
}

// Close and Minimize dock actions called from IPC
function closeDock() {
  if (dockWindow) {
    dockWindow.hide();
  }
}

function minimizeDock() {
  if (dockWindow) {
    dockWindow.minimize();
  }
}

// Quit absolute function
function quitApp() {
  app.isQuitting = true;
  ollama.stopOllama();
  tunnel.stopTunnel();
  app.quit();
}

// Build application menu with Window entry to re-open Wave Dock
function buildAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit', label: 'Quit Harbor' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Harbor',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => {
            if (!dockWindow) { createDockWindow(); }
            dockWindow.show();
            dockWindow.focus();
          }
        },
        {
          label: 'Wave OS (Full View)',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => { expandWindow(); }
        },
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Wave OS Website',
          click: () => { shell.openExternal('https://oswave.io'); }
        }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  // Harbor: no OS application menu (File/Edit/View/Window/Help) — the shell provides its own chrome.
  Menu.setApplicationMenu(null);
}

// Application startup
app.whenReady().then(() => {
  buildAppMenu();
  createDockWindow();
  createFullWindow();

  // Create System Tray
  tray = createTray({
    toggleDock,
    showFullWindow: expandWindow,
    startOllama: ollama.startOllama,
    stopOllama: ollama.stopOllama,
    startTunnel: tunnel.startTunnel,
    stopTunnel: tunnel.stopTunnel,
    checkOllamaStatus: ollama.checkOllama,
    isTunnelActive: tunnel.isTunnelRunning,
    quitApp
  });

  // Register all IPC bridges — core dock/full window handlers
  registerIpcHandlers({
    getBrowserView: () => browserView,
    expandWindow,
    closeDock,
    minimizeDock,
    resizeBrowserView
  });

  // Register filesystem bridge handlers (waveDockFS)
  registerFsHandlers(ipcMain, app, shell);

  // Register AI routing handlers (waveDockAI)
  registerAiHandlers(ipcMain, theta);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDockWindow();
      createFullWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // We stay active in tray
  }
});
