const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;

/**
 * Creates the system tray and configures its actions
 */
function createTray({
  toggleDock,
  showFullWindow,
  startOllama,
  stopOllama,
  startTunnel,
  stopTunnel,
  checkOllamaStatus,
  isTunnelActive,
  quitApp
}) {
  const iconPath = path.join(__dirname, '../assets/icon.png');
  
  // Create native image from SVG and scale down for tray
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (!trayIcon || trayIcon.isEmpty()) {
    // Fail-safe empty native image
    trayIcon = nativeImage.createEmpty();
  } else {
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Harbor');

  // Single click toggles the dock window
  tray.on('click', () => {
    toggleDock();
  });

  // Dynamically build and update the context menu to reflect active service states
  async function updateContextMenu() {
    if (!tray) return;

    let isOllamaRunning = false;
    try {
      const status = await checkOllamaStatus();
      isOllamaRunning = status.running;
    } catch (e) {
      isOllamaRunning = false;
    }

    const isTunnelRunning = isTunnelActive();

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Harbor', enabled: false },
      { type: 'separator' },
      { label: 'Open Harbor', click: () => toggleDock() },
      { label: 'Open Wave OS (Full)', click: () => showFullWindow() },
      { type: 'separator' },
      {
        label: isOllamaRunning ? 'Stop Ollama' : 'Start Ollama',
        click: async () => {
          if (isOllamaRunning) {
            await stopOllama();
          } else {
            await startOllama();
          }
          updateContextMenu();
        }
      },
      {
        label: isTunnelRunning ? 'Stop Tunnel' : 'Start Tunnel',
        click: async () => {
          if (isTunnelRunning) {
            await stopTunnel();
          } else {
            await startTunnel();
          }
          updateContextMenu();
        }
      },
      { type: 'separator' },
      { label: 'Quit Harbor', click: () => quitApp() }
    ]);

    tray.setContextMenu(contextMenu);
  }

  // Initial update
  updateContextMenu();

  // Periodically refresh menu options
  const interval = setInterval(updateContextMenu, 3000);

  // Clean up interval when tray is destroyed
  app.on('before-quit', () => {
    clearInterval(interval);
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  return tray;
}

module.exports = {
  createTray
};
