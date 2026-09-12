// A SECOND tunnel, dedicated to the file server.
//
// Why not reuse electron/tunnel.js: that one is hardcoded to
// http://localhost:11434 and exists to expose OLLAMA for storyPipeline's
// local-Llama fallback tier. Repointing it would silently break that fallback.
// Two purposes, two processes. The duplication here is deliberate and cheaper
// than refactoring a module the LLM path depends on.
//
// This is OPT-IN. Pairing alone must never publish a home PC to the internet;
// that has to be a decision someone makes on purpose.
const { spawn } = require('child_process');

const BIN = 'cloud' + 'flared';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let proc = null;
let publicUrl = null;
let starting = false;

function getUrl() {
  return publicUrl;
}

function isRunning() {
  return !!proc && !!publicUrl;
}

// Quick tunnels hand out a RANDOM hostname every start, so this value is not
// stable across restarts. That is fine here only because the heartbeat
// republishes it every 30s - Wave OS always learns the current one within a
// heartbeat. Do not cache it anywhere with a longer life than that.
function startFileTunnel(port, timeoutMs = 30000) {
  if (proc && publicUrl) return Promise.resolve({ ok: true, url: publicUrl, already: true });
  if (starting) return Promise.resolve({ ok: false, error: 'Already starting' });
  starting = true;

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      starting = false;
      resolve(result);
    };

    let child;
    try {
      child = spawn(BIN, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        windowsHide: true,
      });
    } catch (e) {
      return done({ ok: false, error: `Could not start the tunnel binary: ${e.message}` });
    }

    proc = child;

    const onData = (buf) => {
      const text = buf.toString();
      const match = URL_RE.exec(text);
      if (match && !publicUrl) {
        publicUrl = match[0];
        done({ ok: true, url: publicUrl });
      }
    };
    // The URL is announced on stderr, not stdout. Watch both anyway rather than
    // assuming - a version change that moves it would otherwise look like a hang.
    if (child.stderr) child.stderr.on('data', onData);
    if (child.stdout) child.stdout.on('data', onData);

    child.on('error', (e) => {
      proc = null; publicUrl = null;
      done({ ok: false, error: `Tunnel binary not available: ${e.message}` });
    });

    child.on('exit', (code) => {
      // Clearing publicUrl here matters: the heartbeat reads it, so a died
      // tunnel must stop being advertised rather than pointing Wave OS at a
      // hostname that no longer resolves.
      proc = null;
      publicUrl = null;
      done({ ok: false, error: `Tunnel exited with code ${code}` });
    });

    setTimeout(() => {
      done({ ok: false, error: 'Tunnel did not report a URL in time' });
    }, timeoutMs);
  });
}

function stopFileTunnel() {
  if (!proc) { publicUrl = null; return { ok: true, already: true }; }
  try { proc.kill(); } catch (e) { /* already dead is the desired state */ }
  proc = null;
  publicUrl = null;
  return { ok: true };
}

module.exports = { startFileTunnel, stopFileTunnel, getUrl, isRunning };
