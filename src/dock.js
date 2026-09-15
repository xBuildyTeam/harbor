// ---------------------------------------------------------------------------
// PRIVACY MASK - deliberately at MODULE scope.
//
// dock.js has TWO independent top-level scopes: the DOMContentLoaded callback
// and the separate initPairing IIFE. v3.4.0 declared these inside the first and
// called them from the second, which is a ReferenceError - and one that hid
// itself, because initPairing's refresh() wraps its whole success path in a
// single try/catch. The throw was swallowed and relabelled "Status unavailable"
// on a device that was correctly paired, and it aborted the chain before
// refreshRemote() ran, so the Remote access row never appeared and the file
// tunnel could not be switched on at all. Measured on xBuildy 2026-09-14.
//
// Anything both scopes need lives HERE, and resolves its own DOM nodes rather
// than closing over consts that only exist in one of them.
// ---------------------------------------------------------------------------
let revealLocal = false;

function setMasked(el, sensitive) {
  if (!el) return;
  if (sensitive && !revealLocal) el.classList.add('masked');
  else el.classList.remove('masked');
}

function applyMasks() {
  // Only mask values that actually carry an address. Blurring the word
  // "Inactive" or "Stopped" would just look broken.
  const tEl = document.getElementById('tunnel-url-text');
  setMasked(tEl, !!tEl && !!tEl.getAttribute('data-url'));
  const fsEl = document.getElementById('fileserver-status-text');
  setMasked(fsEl, !!fsEl && /\d/.test(fsEl.textContent || ''));
}

/**
 * Harbor Renderer - Dock Widget Logic
 */

// --- Browser consent grants -------------------------------------------------
// MODULE SCOPE ON PURPOSE. dock.js has two independent top-level regions, and
// v3.4.0 declared helpers inside the DOMContentLoaded callback then called them
// from the initPairing IIFE - a ReferenceError that got mislabelled as a pairing
// fault and took out the whole remote-access row. Anything reachable from more
// than one region lives out here.
let grantCountdownTimer = null;

// MODULE SCOPE, same reason as the grant helpers: reachable from the settings
// modal, the Browser access card, and the dock body.
function openHelpModal() {
  const m = document.getElementById('help-modal');
  const s2 = document.getElementById('settings-modal');
  if (s2) s2.classList.remove('show');
  if (m) m.classList.add('show');
}
function closeHelpModal() {
  const m = document.getElementById('help-modal');
  if (m) m.classList.remove('show');
}

function stopGrantCountdown() {
  if (grantCountdownTimer) { clearInterval(grantCountdownTimer); grantCountdownTimer = null; }
}

function renderGrantCode(result) {
  const row = document.getElementById('browser-grant-code-row');
  const codeEl = document.getElementById('browser-grant-code');
  const cdEl = document.getElementById('browser-grant-countdown');
  if (!row || !codeEl || !cdEl) return;
  if (!result || !result.ok) {
    row.style.display = 'none';
    const t = document.getElementById('browser-grant-text');
    if (t) t.textContent = (result && result.error) ? result.error : 'Could not create a code';
    return;
  }
  codeEl.textContent = result.code;
  row.style.display = 'flex';
  stopGrantCountdown();
  const tick = () => {
    const left = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
    cdEl.textContent = left > 0 ? `Expires in ${left}s` : 'Expired — create a new one';
    if (left <= 0) { stopGrantCountdown(); row.style.display = 'none'; refreshGrants(); }
  };
  tick();
  grantCountdownTimer = setInterval(tick, 1000);
}

async function refreshGrants() {
  const row = document.getElementById('browser-grant-active-row');
  const textEl = document.getElementById('browser-grant-active-text');
  if (!row || !textEl || !window.electronAPI || !window.electronAPI.listLocalGrants) return;
  const res = await window.electronAPI.listLocalGrants();
  const list = (res && res.grants) || [];
  const dot = document.getElementById('browser-access-dot');
  if (dot) dot.style.background = list.length ? 'var(--accent, #2dd4a7)' : 'var(--muted, #6b7280)';
  if (!list.length) {
    textEl.textContent = 'None';
    textEl.title = 'No browser has been given local access';
    row.style.display = 'flex';
    return;
  }
  // Show the soonest expiry, so "allowed" always carries its own deadline rather
  // than reading as permanent.
  const soonest = Math.min(...list.map(g => g.expiresInSeconds));
  const hrs = Math.max(1, Math.round(soonest / 3600));
  textEl.textContent = `${list.length} allowed — expires in ~${hrs}h — click to revoke`;
  textEl.title = 'Click to revoke all browser access immediately';
  row.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
  // Browser consent wiring. Shown unconditionally: local file access is not a
  // cloud feature and must not be gated on having paired.
  const grantRow = document.getElementById('browser-grant-row');
  const grantText = document.getElementById('browser-grant-text');
  if (grantRow) grantRow.style.display = 'flex';
  if (grantText) {
    grantText.addEventListener('click', async () => {
      grantText.textContent = 'Creating a code\u2026';
      const res = await window.electronAPI.mintLocalGrantCode();
      grantText.textContent = 'Allow another browser\u2026';
      renderGrantCode(res);
      await refreshGrants();
    });
  }
  const grantActive = document.getElementById('browser-grant-active-text');
  if (grantActive) {
    grantActive.addEventListener('click', async () => {
      const res = await window.electronAPI.revokeAllLocalGrants();
      if (res && res.revoked) grantActive.textContent = `Revoked ${res.revoked}`;
      await refreshGrants();
    });
  }
  refreshGrants();

  // Help, reachable from two places: the Settings modal (as asked) and directly
  // from the Browser access card, which is where the question actually occurs.
  const btnHelpOpen = document.getElementById('btn-help-open');
  const btnHelpClose = document.getElementById('btn-help-close');
  const btnBrowserHelp = document.getElementById('btn-browser-help');
  if (btnHelpOpen) btnHelpOpen.addEventListener('click', openHelpModal);
  if (btnBrowserHelp) btnBrowserHelp.addEventListener('click', openHelpModal);
  if (btnHelpClose) btnHelpClose.addEventListener('click', closeHelpModal);
  const helpOverlay = document.getElementById('help-modal');
  if (helpOverlay) {
    helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) closeHelpModal(); });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelpModal(); });

  // The Browser access card is always visible, and its dot reflects whether any
  // browser currently holds access.
  const bac = document.getElementById('browser-access-card');
  if (bac) bac.style.display = '';


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

      // NAME WHAT WAS ACTUALLY FOUND. The card said "Local AI (Ollama)" whatever was
      // running, so LM Studio on :1234 looked undetected even when Harbor was
      // talking to it.
      const titleEl = document.getElementById('lbl-localai-title');
      if (titleEl) titleEl.textContent = status.label ? `Local AI (${status.label})` : 'Local AI';

      if (isOllamaRunning) {
        dotOllama.className = 'status-dot online';
        labelOllamaStatus.textContent = 'Running';
        labelOllamaStatus.style.color = 'var(--green)';
        // A START/STOP BUTTON THAT CANNOT WORK IS WORSE THAN NO BUTTON. Harbor can
        // spawn and kill `ollama serve`; it cannot stop LM Studio, which is a desktop
        // GUI app. So when the detected runtime is not manageable the control says so
        // and is disabled, rather than offering an action that silently does nothing.
        if (status.canManage === false) {
          btnToggleOllama.textContent = 'Managed elsewhere';
          btnToggleOllama.disabled = true;
          btnToggleOllama.title = `${status.label || 'This runtime'} was started outside Harbor, so Harbor cannot stop it. Close it in its own app.`;
        } else {
          btnToggleOllama.textContent = 'Stop Ollama';
          btnToggleOllama.disabled = false;
          btnToggleOllama.title = '';
        }

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
        applyMasks();
      } else {
        isTunnelRunning = false;
        dotTunnel.className = 'status-dot offline';
        btnToggleTunnel.textContent = 'Start Tunnel';
        btnToggleTunnel.disabled = false;
        tunnelUrlText.textContent = 'Inactive';
        tunnelUrlText.removeAttribute('data-url');
        tunnelUrlText.title = 'Inactive (Start tunnel to generate url)';
        applyMasks();
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
    // Intercept BEFORE the start path: clicking "Start Tunnel" on a machine with
    // no binary is what produced the useless "Tunnel failed to start" toast.
    if (btnToggleTunnel.dataset.needsInstall === '1' && window.electronAPI && window.electronAPI.installTunnelBin) {
      btnToggleTunnel.disabled = true;
      const original = btnToggleTunnel.textContent;
      btnToggleTunnel.textContent = 'Installing…';
      tunnelUrlText.textContent = 'Downloading (~70MB)…';
      let res = null;
      try { res = await window.electronAPI.installTunnelBin(); } catch (e) { res = { ok: false, error: e.message }; }
      btnToggleTunnel.disabled = false;
      if (!res || !res.ok) {
        btnToggleTunnel.textContent = original;
        tunnelUrlText.textContent = 'Install failed';
        tunnelUrlText.title = (res && res.error) || 'Install failed';
        return;
      }
      delete btnToggleTunnel.dataset.needsInstall;
      btnToggleTunnel.textContent = 'Start Tunnel';
      btnToggleTunnel.title = res.version || '';
      tunnelUrlText.textContent = 'Inactive';
      tunnelUrlText.title = 'Installed. Click Start Tunnel.';
      return;
    }
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
        // GUARDED: #lbl-ai-mode has CSS in dock.css and a lookup here but NO
        // element in dock.html, so this is null and the bare assignment threw a
        // TypeError - swallowed by the catch below, which meant the modeButtons
        // loop underneath NEVER RAN and the active mode button was never
        // highlighted. Pre-existing, and the same shape as the v3.4.1 bug: a null
        // DOM reference inside a broad try/catch, aborting the useful work after
        // it and reporting nothing to the user.
        if (lblAiMode) {
          lblAiMode.textContent = settings.aiMode.charAt(0).toUpperCase() + settings.aiMode.slice(1);
        }
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
      if (lblAiMode) lblAiMode.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
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
      } else if (st.enabled && st.starting) {
        remoteText.textContent = 'On (starting…)';
        remoteText.title = 'Waiting for the tunnel to report a URL';
      } else if (st.enabled && st.gaveUp) {
        // Say the true thing. "starting..." for a process that is not starting
        // sent a real debugging session down the wrong path.
        remoteText.textContent = 'On — tunnel down';
        remoteText.title = 'Retries exhausted. Click to turn off and on again.';
      } else if (st.enabled) {
        remoteText.textContent = 'On (reconnecting…)';
        remoteText.title = 'Remote access is on but the tunnel is not up yet';
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

    const btnReveal = document.getElementById('btn-reveal');
    if (btnReveal) {
      btnReveal.addEventListener('click', async () => {
        revealLocal = !revealLocal;
        applyMasks();
        btnReveal.title = revealLocal
          ? 'Hide local address and public tunnel URL'
          : 'Show local address and public tunnel URL';
        // Persisted, so it survives a restart - but it persists the HIDDEN
        // default too, which is the point: you opt into exposure, never into
        // concealment.
        if (api.setPrivacy) { try { await api.setPrivacy(revealLocal); } catch (e) { /* non-fatal */ } }
      });
    }

    async function loadPrivacy() {
      if (!api.getPrivacy) return;
      try {
        const st = await api.getPrivacy();
        revealLocal = !!(st && st.reveal);
      } catch (e) {
        revealLocal = false;
      }
      applyMasks();
    }
    loadPrivacy();

    // ---- tunnel binary preflight ----
    // The whole point: say "not installed" BEFORE someone clicks, instead of
    // "failed to start" after. A7_Max spent a real debugging session on exactly
    // this, with the file server running fine the entire time.
    async function refreshTunnelBinary() {
      if (!api.getTunnelBinStatus) return null;
      // Resolved here, not closed over: these nodes belong to the other
      // top-level scope. This is the exact mistake v3.4.0 shipped.
      const btnToggleTunnel = document.getElementById('btn-toggle-tunnel');
      const tunnelUrlText = document.getElementById('tunnel-url-text');
      if (!btnToggleTunnel || !tunnelUrlText) return null;
      let bin = null;
      try { bin = await api.getTunnelBinStatus(); } catch (e) { return null; }
      if (!bin) return null;
      if (!bin.found) {
        if (bin.unusable) {
          btnToggleTunnel.textContent = 'Repair';
          btnToggleTunnel.title = `Found at ${bin.path} but it will not run here - wrong architecture, or blocked by antivirus`;
        } else if (bin.installable) {
          btnToggleTunnel.textContent = 'Install';
          btnToggleTunnel.title = 'Cloudflare Tunnel is not installed. Click to download it (~70MB, no admin rights needed).';
        } else {
          btnToggleTunnel.textContent = 'Unavailable';
          btnToggleTunnel.title = 'No prebuilt tunnel binary for this platform';
        }
        btnToggleTunnel.dataset.needsInstall = '1';
        tunnelUrlText.textContent = 'Not installed';
        tunnelUrlText.removeAttribute('data-url');
        applyMasks();
      } else {
        delete btnToggleTunnel.dataset.needsInstall;
        btnToggleTunnel.title = bin.version ? `${bin.version} (${bin.source})` : '';
      }
      return bin;
    }
    refreshTunnelBinary();

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
      applyMasks();
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

    // Each sub-refresh is isolated. Previously all four shared one try/catch, so
    // ONE failure in the last cosmetic widget overwrote a correct "Paired as
    // xBuildy" with "Status unavailable" and skipped everything after it. The
    // pairing status is authoritative and must not be destroyed by a row that
    // merely failed to render.
    async function settle(label, fn) {
      try {
        await fn();
      } catch (e) {
        console.error(`[dock] ${label} failed:`, e && e.stack ? e.stack : e);
      }
    }

    async function refresh() {
      let st = null;
      try {
        st = await api.getPairingStatus();
      } catch (e) {
        console.error('[dock] getPairingStatus failed:', e);
        // ONLY a genuine failure of the pairing query earns this label.
        statusText.textContent = 'Status unavailable';
        dot.className = 'status-dot offline';
        return;
      }
      try {
        if (st && st.paired) {
          dot.className = 'status-dot online';
          statusText.textContent = `Paired as ${st.deviceName}`;
          btn.textContent = 'Unpair';
          if (foldersRow) foldersRow.style.display = 'flex';
          await settle('refreshFolders', refreshFolders);
          await settle('refreshFileServer', refreshFileServer);
          await settle('refreshRemote', refreshRemote);
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

    // THE PAIRING CARD WAS A SNAPSHOT PRESENTED AS A STATUS. Ollama polls every
    // 3s, the tunnel every 5s, Wave OS every 10s - and this card polled NEVER.
    // refresh() ran once at startup and then only on a click. At launch the
    // tunnel is genuinely mid-start, so isStarting() is true and the row
    // correctly renders "On (starting...)" - and then FREEZES THERE FOREVER,
    // because nothing ever asks again. The tunnel came up seconds later and the
    // label never found out. That is why clicking the toggle "fixed" it: the
    // click handler is one of the only things that calls refreshRemote().
    //
    // The same freeze applied to every row in the card. If the tunnel DIED, the
    // dock would have kept saying "On" indefinitely - a status that cannot report
    // a change in the thing it displays is not a status, it is a screenshot.
    // v3.4.2 taught this exact lesson about a label that could not distinguish
    // starting from stalled; this is the same lesson one level up, in the
    // refresh loop rather than the state model.
    setInterval(async () => {
      // NEVER poll while a pairing code is on screen. refreshFolders and friends
      // are harmless, but re-entering the card mid-pairing risks clobbering the
      // code and countdown the user is actively reading off it.
      if (codeRow && codeRow.style.display !== 'none') return;
      let st = null;
      try { st = await api.getPairingStatus(); } catch (e) { return; }
      if (!st) return;
      // A device unpaired from elsewhere must collapse the card, so the
      // paired/unpaired transition goes through the full refresh.
      if (!st.paired) { await refresh(); return; }
      await settle('poll:refreshFolders', refreshFolders);
      await settle('poll:refreshFileServer', refreshFileServer);
      await settle('poll:refreshRemote', refreshRemote);
      await settle('poll:refreshGrants', refreshGrants);
    }, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
