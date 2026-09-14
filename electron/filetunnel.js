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
const cfbin = require('./cfbin');

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

// The dock must be able to tell "a start is in flight" from "nothing is
// starting". v3.3.0-v3.4.1 could not: remoteAccessEnabled persisted as true
// while nothing restarted the tunnel after a relaunch, so the dock rendered
// "On (starting...)" forever for a process that did not exist. A UI state that
// cannot be distinguished from a stalled one is a lie the UI tells.
function isStarting() {
  return starting;
}

// Quick tunnels hand out a RANDOM hostname every start, so this value is not
// stable across restarts. That is fine here only because the heartbeat
// republishes it every 30s - Wave OS always learns the current one within a
// heartbeat. Do not cache it anywhere with a longer life than that.
// Refuse point-blank to publish the local-scope port. Nothing should ever pass it
// here - the local listener is started separately and never handed to this
// function - but the failure mode of getting it wrong is the UNRESTRICTED
// whole-disk server exposed to the internet, and that is worth more than one line
// of defence. A per-scope-state bug made exactly this reachable in development.
const REFUSED_PORTS = new Set([47616]);

function startFileTunnel(port, timeoutMs = 30000) {
  if (REFUSED_PORTS.has(Number(port))) {
    const msg = 'Refusing to tunnel port ' + port + ': that is the local-scope '
      + 'file server, which serves the whole disk and must never be published.';
    console.error('[harbor] ' + msg);
    return Promise.resolve({ ok: false, error: msg, refusedByDesign: true });
  }
  if (proc && publicUrl) return Promise.resolve({ ok: true, url: publicUrl, already: true });
  if (starting) return Promise.resolve({ ok: false, error: 'Already starting' });
  starting = true;

  return cfbin.resolveBinary().then((bin) => {
    if (!bin.found) {
      starting = false;
      // Distinguish the two, because they need OPPOSITE actions: absent means
      // install it; present-but-unusable means the install is already there and
      // something else (arch, antivirus) is wrong.
      return {
        ok: false,
        needsInstall: !bin.unusable,
        error: bin.unusable
          ? `Tunnel binary found at ${bin.path} but it will not run here - architecture mismatch or blocked by antivirus`
          : 'Cloudflare Tunnel is not installed',
      };
    }
    return startWithBinary(bin.path, port, timeoutMs);
  });
}

function startWithBinary(resolvedPath, port, timeoutMs) {
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
      // resolved.path, never the bare name: a copy Harbor installed into its own
      // userData dir is not on PATH, and PATH itself is captured at launch so a
      // just-installed binary would be invisible until a restart.
      child = spawn(resolvedPath, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
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

// BOUNDED, never infinite. Quick tunnels do drop, and a dead tunnel that never
// comes back means Wave OS silently loses the device until someone notices a
// toggle. But an unbounded retry against a missing binary or a blocked network
// is just a hot loop, so this gives up after a few tries and says so.
const RETRY_DELAYS_MS = [5000, 15000, 45000];
let watchdogTimer = null;
let retryIndex = 0;
let watchPort = null;
let onWatchdogEvent = null;

function armWatchdog(port, notify) {
  watchPort = port;
  if (notify) onWatchdogEvent = notify;
  if (watchdogTimer) return;
  watchdogTimer = setInterval(async () => {
    // Only act when the tunnel is DOWN and no start is already in flight.
    if (proc || starting) { retryIndex = 0; return; }
    if (retryIndex >= RETRY_DELAYS_MS.length) return; // gave up, stay quiet
    const delay = RETRY_DELAYS_MS[retryIndex];
    retryIndex += 1;
    await new Promise((r) => setTimeout(r, delay));
    if (proc || starting) return;
    const res = await startFileTunnel(watchPort);
    if (res && res.ok) {
      retryIndex = 0;
      if (onWatchdogEvent) onWatchdogEvent(res.url);
    }
  }, 20000);
}

function disarmWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  retryIndex = 0;
  watchPort = null;
}

function gaveUp() {
  return retryIndex >= RETRY_DELAYS_MS.length && !proc && !starting;
}

function stopFileTunnel() {
  disarmWatchdog();
  if (!proc) { publicUrl = null; return { ok: true, already: true }; }
  try { proc.kill(); } catch (e) { /* already dead is the desired state */ }
  proc = null;
  publicUrl = null;
  return { ok: true };
}

module.exports = { startFileTunnel, stopFileTunnel, getUrl, isRunning, isStarting, armWatchdog, disarmWatchdog, gaveUp };
