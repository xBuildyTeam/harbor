/**
 * Harbor Renderer - Dock Widget Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const btnExpand = document.getElementById('btn-expand');
  const btnMinimize = document.getElementById('btn-minimize');
  const btnClose = document.getElementById('btn-close');

  const dotWave = document.getElementById('dot-wave');
  const labelWaveStatus = document.getElementById('label-wave-status');
  const btnOpenWave = document.getElementById('btn-open-wave');

  const dotOllama = document.getElementById('dot-ollama');
  const labelOllamaStatus = document.getElementById('label-ollama-status');
  const btnToggleOllama = document.getElementById('btn-toggle-ollama');
  const lblActiveModel = document.getElementById('lbl-active-model');

  const dotTunnel = document.getElementById('dot-tunnel');
  const btnToggleTunnel = document.getElementById('btn-toggle-tunnel');
  const tunnelUrlText = document.getElementById('tunnel-url-text');

  const btnChat = document.getElementById('btn-chat');
  const btnSettings = document.getElementById('btn-settings');

  // Modal Settings Elements
  const settingsModal = document.getElementById('settings-modal');
  const settingModelInput = document.getElementById('setting-model');
  const btnSettingsCancel = document.getElementById('btn-settings-cancel');
  const btnSettingsSave = document.getElementById('btn-settings-save');

  // Toast elements
  const toast = document.getElementById('toast');
  const toastIcon = document.getElementById('toast-icon');
  const toastMessage = document.getElementById('toast-message');

  // Local State
  let isOllamaRunning = false;
  let isTunnelRunning = false;
  let defaultModel = localStorage.getItem('wave_default_model') || 'llama3:latest';

  // Set default model input value
  settingModelInput.value = defaultModel;

  // --- Toast notification utility ---
  function showToast(message, type = 'info') {
    toastMessage.textContent = message;
    toast.className = 'toast-container show';
    
    if (type === 'error') {
      toastIcon.textContent = '❌';
      toast.classList.add('toast-error');
    } else if (type === 'success') {
      toastIcon.textContent = '✅';
      toast.classList.add('toast-success');
    } else {
      toastIcon.textContent = 'ℹ️';
      toast.classList.add('toast-info');
    }

    setTimeout(() => {
      toast.className = 'toast-container';
    }, 4000);
  }

  // --- Polling & Status functions ---

  // Check Ollama Status
  async function checkOllamaStatus() {
    try {
      const status = await window.electronAPI.checkOllama();
      isOllamaRunning = status.running;

      if (isOllamaRunning) {
        dotOllama.className = 'status-dot online';
        labelOllamaStatus.textContent = 'Running';
        labelOllamaStatus.style.color = 'var(--green)';
        btnToggleOllama.textContent = 'Stop Ollama';
        btnToggleOllama.disabled = false;

        // Display current model or default
        if (status.models && status.models.length > 0) {
          const modelToUse = status.models.includes(defaultModel) ? defaultModel : status.models[0];
          lblActiveModel.textContent = modelToUse;
        } else {
          lblActiveModel.innerHTML = `<span style="color: var(--amber); font-weight: 500;">No models (Pull ${defaultModel})</span>`;
        }

        // Enable GPU Stats container
      } else {
        dotOllama.className = 'status-dot offline';
        labelOllamaStatus.textContent = 'Stopped';
        labelOllamaStatus.style.color = 'var(--muted)';
        btnToggleOllama.textContent = 'Start Ollama';
        btnToggleOllama.disabled = false;
        lblActiveModel.textContent = 'None';

        // Disable GPU stats visual style
      }
    } catch (err) {
      console.error('Failed to check Ollama:', err);
    }
  }

  // Fetch and update GPU metrics
  

  

  // Check Tunnel Status
  async function checkTunnelStatus() {
    try {
      const url = await window.electronAPI.getTunnelUrl();
      if (url) {
        isTunnelRunning = true;
        dotTunnel.className = 'status-dot online';
        btnToggleTunnel.textContent = 'Stop Tunnel';
        btnToggleTunnel.disabled = false;
        tunnelUrlText.textContent = window.sharedUtils.truncateUrl(url);
        tunnelUrlText.setAttribute('data-url', url);
        tunnelUrlText.title = `Click to copy public URL: ${url}`;
      } else {
        isTunnelRunning = false;
        dotTunnel.className = 'status-dot offline';
        btnToggleTunnel.textContent = 'Start Tunnel';
        btnToggleTunnel.disabled = false;
        tunnelUrlText.textContent = 'Inactive';
        tunnelUrlText.removeAttribute('data-url');
        tunnelUrlText.title = 'Inactive (Start tunnel to generate url)';
      }
    } catch (err) {
      console.error('Failed to get tunnel URL:', err);
    }
  }

  // Wave OS site connectivity check
  async function checkWaveOSConnection() {
    try {
      // Standard fetch ping
      const start = Date.now();
      await fetch('https://app.oswave.io', { mode: 'no-cors', cache: 'no-store' });
      const latency = Date.now() - start;
      dotWave.className = 'status-dot online';
      labelWaveStatus.textContent = `Online (${latency}ms)`;
      labelWaveStatus.style.color = 'var(--green)';
    } catch (e) {
      dotWave.className = 'status-dot offline';
      labelWaveStatus.textContent = 'Offline';
      labelWaveStatus.style.color = 'var(--red)';
    }
  }

  // --- Handlers & Event Listeners ---

  // Window frame buttons
  btnExpand.addEventListener('click', () => {
    window.electronAPI.expand();
  });

  btnMinimize.addEventListener('click', () => {
    window.electronAPI.minimizeDock();
  });

  btnClose.addEventListener('click', () => {
    window.electronAPI.closeDock();
  });

  // Action Buttons
  btnOpenWave.addEventListener('click', () => {
    window.electronAPI.expand();
  });

  btnChat.addEventListener('click', () => {
    window.electronAPI.expand();
  });

  // Start / Stop Ollama service
  btnToggleOllama.addEventListener('click', async () => {
    btnToggleOllama.disabled = true;
    if (isOllamaRunning) {
      labelOllamaStatus.textContent = 'Stopping...';
      dotOllama.className = 'status-dot loading';
      try {
        await window.electronAPI.stopOllama();
        showToast('Ollama service stopped', 'info');
      } catch (err) {
        showToast(err.message || 'Failed to stop Ollama', 'error');
      }
    } else {
      labelOllamaStatus.textContent = 'Starting...';
      dotOllama.className = 'status-dot loading';
      try {
        await window.electronAPI.startOllama();
        showToast('Ollama service started', 'success');
      } catch (err) {
        showToast('Ollama not installed or failed to start. Make sure ollama CLI is available.', 'error');
      }
    }
    // Refresh state immediately
    await checkOllamaStatus();
  });

  // Start / Stop Cloudflare Tunnel
  btnToggleTunnel.addEventListener('click', async () => {
    btnToggleTunnel.disabled = true;
    if (isTunnelRunning) {
      tunnelUrlText.textContent = 'Stopping...';
      dotTunnel.className = 'status-dot loading';
      try {
        await window.electronAPI.stopTunnel();
        showToast('Cloudflare tunnel terminated', 'info');
      } catch (err) {
        showToast(err.message || 'Failed to stop tunnel', 'error');
      }
    } else {
      tunnelUrlText.textContent = 'Acquiring URL...';
      dotTunnel.className = 'status-dot loading';
      try {
        const res = await window.electronAPI.startTunnel();
        if (res.success) {
          showToast('Tunnel generated successfully!', 'success');
        }
      } catch (err) {
        if (err && String(err.message || err).includes('TUNNEL_BINARY_MISSING')) {
          showToast('Tunnel binary is not installed. This is an optional developer feature.', 'error');
        } else {
          showToast('Tunnel failed to start.', 'error');
        }
      }
    }
    // Refresh state immediately
    await checkTunnelStatus();
  });

  // Click URL to Copy
  tunnelUrlText.addEventListener('click', async () => {
    const url = tunnelUrlText.getAttribute('data-url');
    if (url) {
      const ok = await window.sharedUtils.copyToClipboard(url);
      if (ok) {
        showToast('Tunnel URL copied to clipboard!', 'success');
      } else {
        showToast('Failed to copy to clipboard', 'error');
      }
    }
  });

  // Settings Panel Actions
  btnSettings.addEventListener('click', () => {
    settingsModal.classList.add('show');
  });

  btnSettingsCancel.addEventListener('click', () => {
    settingsModal.classList.remove('show');
    // reset input
    settingModelInput.value = defaultModel;
  });

  btnSettingsSave.addEventListener('click', () => {
    const val = settingModelInput.value.trim();
    if (val) {
      defaultModel = val;
      localStorage.setItem('wave_default_model', defaultModel);
      showToast(`Default model updated to: ${defaultModel}`, 'success');
      settingsModal.classList.remove('show');
      
      // Pull missing model confirmation
      if (isOllamaRunning) {
        checkOllamaStatus().then(() => {
          lblActiveModel.textContent = defaultModel;
        });
      }
    } else {
      showToast('Model name cannot be empty', 'error');
    }
  });

  // --- Theta EdgeCloud AI Status ---

  const lblAiMode = document.getElementById('lbl-ai-mode');
  const modeButtons = document.querySelectorAll('.mode-btn');
  let currentAiMode = 'auto';

  // Load saved AI mode on startup
  async function loadAiMode() {
    try {
      const settings = await window.electronAPI.getSettings();
      if (settings && settings.aiMode) {
        currentAiMode = settings.aiMode;
        lblAiMode.textContent = settings.aiMode.charAt(0).toUpperCase() + settings.aiMode.slice(1);
        modeButtons.forEach(btn => {
          btn.classList.toggle('active', btn.dataset.mode === currentAiMode);
        });
      }
    } catch (e) {
      console.error('Failed to load AI mode:', e);
    }
  }


  // AI Mode selector button handlers
  modeButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      currentAiMode = mode;
      lblAiMode.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      modeButtons.forEach(b => b.classList.toggle('active', b === btn));
      try {
        await window.electronAPI.setSettings({ aiMode: mode });
        const label = mode === 'auto' ? 'Auto (Ollama → Theta)' : mode === 'local' ? 'Local Only' : 'Theta Only';
        showToast(`AI mode: ${label}`, 'success');
      } catch (e) {
        showToast('Failed to save AI mode', 'error');
      }
    });
  });

  // --- Initialization and Polling Interval ---

  // Initial checks
  checkOllamaStatus();
  checkTunnelStatus();
  checkWaveOSConnection();
  loadAiMode();

  // Intervals
  setInterval(checkOllamaStatus, 3000); // Poll Ollama every 3s
  setInterval(checkTunnelStatus, 5000); // Poll Tunnel URL every 5s
  setInterval(checkWaveOSConnection, 10000); // Ping Wave OS every 10s
});

// ---------------------------------------------------------------------------
// Wave OS pairing (v3.1.0). Harbor's half of the device-code handshake.
// The PC generates and DISPLAYS the code so that entering it proves physical
// presence at this machine; the browser, which is already signed in, claims it.
// Self-contained and readyState-guarded so it does not depend on where in
// dock.js this block lands.
// ---------------------------------------------------------------------------
(function initPairing() {
  function start() {
    const api = window.electronAPI;
    const dot = document.getElementById('dot-pairing');
    const statusText = document.getElementById('pairing-status-text');
    const btn = document.getElementById('btn-pair');
    const codeRow = document.getElementById('pairing-code-row');
    const codeEl = document.getElementById('pairing-code');
    const countdownEl = document.getElementById('pairing-countdown');
    if (!api || !btn || !dot || !statusText) return;

    let pollTimer = null;
    let tickTimer = null;

    function stopTimers() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    function hideCode() {
      stopTimers();
      if (codeRow) codeRow.style.display = 'none';
      if (countdownEl) countdownEl.textContent = '';
    }

    const foldersRow = document.getElementById('pairing-folders-row');
    const folderCount = document.getElementById('pairing-folder-count');

    const fsRow = document.getElementById('fileserver-row');
    const fsText = document.getElementById('fileserver-status-text');

    const remoteRow = document.getElementById('remote-row');
    const remoteText = document.getElementById('remote-status-text');

    async function refreshRemote() {
      if (!remoteRow || !remoteText || !api.getRemoteStatus) return;
      let st = null;
      try { st = await api.getRemoteStatus(); } catch (e) { st = null; }
      if (!st || !st.paired) { remoteRow.style.display = 'none'; return; }
      remoteRow.style.display = 'flex';
      if (st.enabled && st.url) {
        remoteText.textContent = 'On';
        remoteText.title = st.url;
      } else if (st.enabled) {
        remoteText.textContent = 'On (starting…)';
        remoteText.title = 'Waiting for the tunnel to report a URL';
      } else {
        remoteText.textContent = 'Off — files stay on this PC';
        remoteText.title = 'Click to allow Wave OS to reach this PC from anywhere';
      }
    }

    if (remoteText) {
      remoteText.addEventListener('click', async () => {
        if (!api.getRemoteStatus || !api.setRemoteEnabled) return;
        const cur = await api.getRemoteStatus().catch(() => null);
        if (!cur) return;
        remoteText.textContent = cur.enabled ? 'Turning off…' : 'Starting…';
        const res = await api.setRemoteEnabled(!cur.enabled).catch(() => null);
        if (res && res.ok === false && res.error) {
          remoteText.textContent = 'Failed';
          remoteText.title = res.error;
          return;
        }
        await refreshRemote();
      });
    }

    async function refreshFileServer() {
      if (!fsRow || !fsText || !api.getFileServerStatus) return;
      let st = null;
      try {
        st = await api.getFileServerStatus();
      } catch (e) {
        st = null;
      }
      if (!st || !st.paired) { fsRow.style.display = 'none'; return; }
      fsRow.style.display = 'flex';
      fsText.textContent = st.running
        ? `Listening on 127.0.0.1:${st.port} (read-only)`
        : 'Stopped';
    }

    async function refreshFolders() {
      if (!foldersRow || !folderCount || !api.listSharedFolders) return;
      let folders = [];
      try {
        folders = (await api.listSharedFolders()) || [];
      } catch (e) {
        folders = [];
      }
      folderCount.textContent = folders.length
        ? `${folders.length} shared (read-only)`
        : 'None — click to add';
      folderCount.title = folders.length
        ? folders.map(f => f.path).join('\n')
        : 'Click to share a folder';
    }

    async function refresh() {
      try {
        const st = await api.getPairingStatus();
        if (st && st.paired) {
          dot.className = 'status-dot online';
          statusText.textContent = `Paired as ${st.deviceName}`;
          btn.textContent = 'Unpair';
          if (foldersRow) foldersRow.style.display = 'flex';
          await refreshFolders();
          await refreshFileServer();
          await refreshRemote();
        } else {
          dot.className = 'status-dot offline';
          statusText.textContent = 'Not paired';
          btn.textContent = 'Pair Device';
          if (foldersRow) foldersRow.style.display = 'none';
          if (fsRow) fsRow.style.display = 'none';
          if (remoteRow) remoteRow.style.display = 'none';
        }
      } catch (e) {
        statusText.textContent = 'Status unavailable';
      }
    }

    if (folderCount) {
      folderCount.addEventListener('click', async () => {
        if (!api.addSharedFolder) return;
        const res = await api.addSharedFolder().catch(() => null);
        if (res && res.ok) { await refreshFolders(); await refreshFileServer(); }
      });
    }

    async function beginPairing() {
      hideCode();
      btn.disabled = true;
      statusText.textContent = 'Requesting a code…';
      let res;
      try {
        res = await api.startPairing();
      } catch (e) {
        res = { ok: false, error: (e && e.message) || String(e) };
      }
      btn.disabled = false;
      if (!res || !res.ok) {
        statusText.textContent = (res && res.error) || 'Could not reach Wave OS';
        return;
      }

      const code = res.code;
      if (codeEl) codeEl.textContent = code.slice(0, 3) + ' ' + code.slice(3);
      if (codeRow) codeRow.style.display = 'flex';
      statusText.textContent = 'Waiting for Wave OS…';

      // Countdown comes from the server's expires_at. The browser-side modal used
      // a local useState(60), which invents a number it cannot know - this reads
      // the real deadline the backend is enforcing.
      const deadline = new Date(res.expiresAt).getTime();
      function tick() {
        const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        if (countdownEl) countdownEl.textContent = left > 0 ? `Expires in ${left}s` : 'Expired';
        if (left <= 0) {
          hideCode();
          statusText.textContent = 'Code expired — try again';
        }
      }
      tick();
      tickTimer = setInterval(tick, 1000);

      pollTimer = setInterval(async () => {
        let p;
        try {
          p = await api.pollPairing(code);
        } catch (e) {
          return; // transient; the countdown still bounds this loop
        }
        if (!p || !p.ok) return;
        if (p.status === 'claimed') {
          hideCode();
          statusText.textContent = 'Paired';
          await refresh();
        } else if (p.status === 'expired') {
          hideCode();
          statusText.textContent = 'Code expired — try again';
        }
      }, 2000);
    }

    btn.addEventListener('click', async () => {
      const st = await api.getPairingStatus().catch(() => null);
      if (st && st.paired) {
        await api.unpair().catch(() => null);
        hideCode();
        await refresh();
      } else {
        await beginPairing();
      }
    });

    refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
