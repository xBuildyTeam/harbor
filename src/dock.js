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

  const dotTheta = document.getElementById('dot-theta');
  const labelThetaStatus = document.getElementById('label-theta-status');
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

  // Check Theta EdgeCloud connectivity
  async function checkThetaStatus() {
    try {
      const tokenStatus = await window.electronAPI.getThetaTokenStatus();
      if (!tokenStatus.hasToken) {
        dotTheta.className = 'status-dot offline';
        labelThetaStatus.textContent = 'No Token';
        labelThetaStatus.style.color = 'var(--red)';
        if (thetaTokenRow) thetaTokenRow.style.display = 'flex';
        if (thetaProbeRow) thetaProbeRow.style.display = 'none';
        return;
      }
      // Token exists. Deliberately NO network call here: this used to fire a real
      // inference request, on a 15s timer, purely to colour this dot.
      dotTheta.className = 'status-dot online';
      labelThetaStatus.textContent = tokenStatus.source === 'env' ? 'Token set (env)' : 'Token set';
      labelThetaStatus.style.color = 'var(--green)';
      if (thetaTokenRow) thetaTokenRow.style.display = 'none';
      if (thetaProbeRow) thetaProbeRow.style.display = 'flex';
    } catch (e) {
      dotTheta.className = 'status-dot offline';
      labelThetaStatus.textContent = 'Error';
      labelThetaStatus.style.color = 'var(--red)';
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
  const thetaTokenRow = document.getElementById('theta-token-row');
  const thetaProbeRow = document.getElementById('theta-probe-row');
  const inputThetaToken = document.getElementById('input-theta-token');
  const btnSaveThetaToken = document.getElementById('btn-save-theta-token');
  const btnProbeTheta = document.getElementById('btn-probe-theta');

  if (btnSaveThetaToken) {
    btnSaveThetaToken.addEventListener('click', async () => {
      const v = inputThetaToken ? inputThetaToken.value : '';
      if (!v || !v.trim()) { showToast('Paste a token first.', 'error'); return; }
      await window.electronAPI.setThetaToken(v);
      if (inputThetaToken) inputThetaToken.value = '';
      showToast('Theta token saved.', 'success');
      await checkThetaStatus();
    });
  }

  // The ONLY place a real Theta request is made for status purposes.
  if (btnProbeTheta) {
    btnProbeTheta.addEventListener('click', async () => {
      btnProbeTheta.textContent = 'Testing...';
      try {
        const r = await window.electronAPI.probeTheta();
        showToast(r && r.connected ? 'Theta reachable.' : 'Theta unreachable: ' + ((r && (r.reason || r.status)) || 'unknown'), r && r.connected ? 'success' : 'error');
      } catch (e) {
        showToast('Theta test failed.', 'error');
      }
      btnProbeTheta.textContent = 'Test connection';
    });
  }

  // Hide the tunnel card entirely when the binary is absent - it is an optional
  // developer feature and a Start button that cannot work is worse than nothing.
  (async () => {
    try {
      const available = await window.electronAPI.isTunnelAvailable();
      if (!available) {
        const card = document.getElementById('tunnel-status-card');
        if (card) card.style.display = 'none';
      }
    } catch (e) { /* leave the card as-is */ }
  })();

  checkThetaStatus();
  loadAiMode();

  // Intervals
  setInterval(checkOllamaStatus, 3000); // Poll Ollama every 3s
  setInterval(checkTunnelStatus, 5000); // Poll Tunnel URL every 5s
  setInterval(checkWaveOSConnection, 10000); // Ping Wave OS every 10s
});
