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
        showToast('cloudflared binary not found in PATH or tunnel failed.', 'error');
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
        return;
      }
      // Token exists — do a health check
      const result = await window.electronAPI.checkTheta();
      if (result && result.connected) {
        dotTheta.className = 'status-dot online';
        labelThetaStatus.textContent = 'Connected';
        labelThetaStatus.style.color = 'var(--green)';
      } else {
        dotTheta.className = 'status-dot offline';
        labelThetaStatus.textContent = 'Unreachable';
        labelThetaStatus.style.color = 'var(--amber)';
      }
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
  checkThetaStatus();
  loadAiMode();

  // Intervals
  setInterval(checkOllamaStatus, 3000); // Poll Ollama every 3s
  setInterval(checkTunnelStatus, 5000); // Poll Tunnel URL every 5s
  setInterval(checkWaveOSConnection, 10000); // Ping Wave OS every 10s
  setInterval(checkThetaStatus, 15000); // Poll Theta every 15s
});
