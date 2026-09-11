const { spawn, execFile } = require('child_process');

let tunnelProcess = null;
let tunnelUrl = null;

/**
 * Start Cloudflare quick tunnel to expose Ollama on port 11434
 */
/**
 * Is the tunnel binary actually on PATH? Harbor has never shipped it, so on a
 * fresh machine spawn() fails with ENOENT and the dock was showing a "Start
 * Tunnel" button for something that could not possibly work. Check first so the
 * UI can say "Not installed" instead of surfacing an error after the fact.
 */
function isTunnelBinaryAvailable() {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    try {
      execFile(probe, ['cloudflared'], (err, stdout) => {
        resolve(!err && !!String(stdout || '').trim());
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function startTunnel() {
  return isTunnelBinaryAvailable().then((available) => {
    if (!available) {
      const e = new Error('Tunnel binary is not installed or not on PATH.');
      e.code = 'TUNNEL_BINARY_MISSING';
      throw e;
    }
    return startTunnelInner();
  });
}

function startTunnelInner() {
  return new Promise((resolve, reject) => {
    if (tunnelProcess) {
      if (tunnelUrl) {
        resolve({ success: true, url: tunnelUrl });
      } else {
        reject(new Error('Tunnel is already starting...'));
      }
      return;
    }

    // Reset status
    tunnelUrl = null;

    try {
      // Spawn cloudflared quick tunnel exposing localhost:11434
      // We run 'cloudflared tunnel --url http://localhost:11434'
      tunnelProcess = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:11434'], {
        shell: true
      });

      let resolved = false;
      let errorBuffer = '';

      // cloudflared outputs its status and URL to stderr
      tunnelProcess.stderr.on('data', (data) => {
        const text = data.toString();
        errorBuffer += text;

        // Try to match the trycloudflare URL
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          tunnelUrl = match[0];
          if (!resolved) {
            resolved = true;
            resolve({ success: true, url: tunnelUrl });
          }
        }
      });

      tunnelProcess.stdout.on('data', (data) => {
        // Just in case anything goes to stdout
        const text = data.toString();
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          tunnelUrl = match[0];
          if (!resolved) {
            resolved = true;
            resolve({ success: true, url: tunnelUrl });
          }
        }
      });

      tunnelProcess.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          tunnelProcess = null;
          reject(new Error(`Failed to start cloudflared: ${err.message}. Make sure 'cloudflared' is installed in your system PATH.`));
        }
      });

      tunnelProcess.on('close', (code) => {
        tunnelProcess = null;
        tunnelUrl = null;
        if (!resolved) {
          resolved = true;
          reject(new Error(`Tunnel process exited prematurely with code ${code}. Error: ${errorBuffer}`));
        }
      });

      // Set a 15-second timeout in case it hangs and never returns a URL
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          stopTunnel();
          reject(new Error('Starting Cloudflare tunnel timed out (15s). Ensure you have internet and cloudflared is functional.'));
        }
      }, 15000);

    } catch (err) {
      tunnelProcess = null;
      reject(new Error(`Tunnel startup error: ${err.message}`));
    }
  });
}

/**
 * Stop the active Cloudflare tunnel
 */
function stopTunnel() {
  return new Promise((resolve) => {
    if (tunnelProcess) {
      try {
        tunnelProcess.kill();
      } catch (e) {}
      tunnelProcess = null;
    }
    tunnelUrl = null;
    resolve({ success: true, message: 'Tunnel stopped' });
  });
}

/**
 * Get active tunnel URL
 */
function getTunnelUrl() {
  return tunnelUrl;
}

/**
 * Check if tunnel is currently running
 */
function isTunnelRunning() {
  return tunnelProcess !== null;
}

module.exports = {
  isTunnelBinaryAvailable,
  startTunnel,
  stopTunnel,
  getTunnelUrl,
  isTunnelRunning
};
