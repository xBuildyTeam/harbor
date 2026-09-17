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
const dns = require('dns');
const https = require('https');
const cfbin = require('./cfbin');

const BIN = 'cloud' + 'flared';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let proc = null;
let publicUrl = null;
let starting = false;
let startedAt = 0;
// GENERATION COUNTER, because "stop" had no way to cancel a start already in
// flight. stopFileTunnel() early-returns on `!proc`, which is EXACTLY the state
// during a start - so it reported {ok:true} while the pending start went on to
// assign proc and publish a public URL. The user turned sharing OFF and the PC
// got published anyway, with the dock reading Off. That is a privacy defect, not
// a cosmetic one. Every stop now invalidates the generation, and a start that
// completes against a stale generation kills its own child instead of publishing.
let generation = 0;
const STALE_START_MS = 90 * 1000;

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
  // STALE-START GUARD. A start that never calls done() would otherwise pin this
  // true forever, and the flag gates retries and the watchdog as well as the
  // label. Bounded by the start timeout plus a wide margin, so a genuinely slow
  // tunnel is never cut off - this only fires when a start has plainly abandoned
  // its own promise.
  if (starting && startedAt && Date.now() - startedAt > STALE_START_MS) {
    console.error('[harbor] a tunnel start exceeded ' + STALE_START_MS + 'ms without settling; clearing the starting flag');
    starting = false;
    startedAt = 0;
  }
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
  if (isStarting()) return Promise.resolve({ ok: false, error: 'Already starting' });
  starting = true;
  startedAt = Date.now();
  const myGen = ++generation;

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
    return startWithBinary(bin.path, port, timeoutMs, myGen);
  }).catch((err) => {
    // WITHOUT THIS CATCH A SINGLE REJECTION WEDGED THE WHOLE SUBSYSTEM. `starting`
    // was cleared only inside .then, so a rejected resolveBinary() left it true
    // forever - and `starting` gates far more than a label: it makes every future
    // start return "Already starting" (line above), it disables the reconnect
    // watchdog, and it forces gaveUp() to false. So one throw meant no tunnel
    // until an app restart, while the dock displayed a reassuring "On
    // (starting...)". Exactly the failure shape v3.4.2 existed to remove, entering
    // through a different door. resolveBinary's helpers are resolve-only today, so
    // this was latent rather than live - which is precisely when it is cheap.
    starting = false;
    return { ok: false, error: `Could not check for the tunnel binary: ${err && err.message}` };
  });
}

function startWithBinary(resolvedPath, port, timeoutMs, myGen) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      starting = false;
      // STALE GENERATION = THE USER ASKED US TO STOP WHILE THIS WAS STARTING.
      // Publishing now would expose the machine after an explicit refusal, so the
      // child is killed and no URL is recorded. Reported honestly as cancelled
      // rather than as a failure, because nothing went wrong.
      if (myGen !== generation) {
        try { if (child) child.kill(); } catch (e) { /* already gone is fine */ }
        if (proc === child) proc = null;
        publicUrl = null;
        return resolve({ ok: false, cancelled: true, error: 'Cancelled - remote access was turned off while the tunnel was starting' });
      }
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
      if (!match) return;
      // `!publicUrl` USED TO GUARD THIS, AND THAT WAS A STALE-URL GENERATOR.
      // The agent can reconnect during its own lifetime and announce a DIFFERENT
      // hostname; the old guard pinned whatever came first and ignored every
      // later one, so Harbor went on publishing a hostname that had been retired
      // - which is precisely what the live row showed on 2026-09-16.
      // Take the newest announcement always; resolve the promise only once.
      const first = !publicUrl;
      if (publicUrl && publicUrl !== match[0]) {
        console.log(`[harbor] file tunnel hostname changed: ${publicUrl} -> ${match[0]}`);
        publicUrl = match[0];
        if (onWatchdogEvent) onWatchdogEvent(publicUrl);   // republish immediately
        return;
      }
      publicUrl = match[0];
      if (first) done({ ok: true, url: publicUrl });
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

// ===========================================================================
// REACHABILITY, NOT LIVENESS. Added v3.14.0 after a measured failure.
//
// The exit handler above clears publicUrl when the child process DIES, and its
// comment says a dead tunnel "must stop being advertised rather than pointing
// Wave OS at a hostname that no longer resolves". The intent was right and the
// DETECTOR was wrong: it measures whether our child process is alive, not
// whether the hostname still works. The provider can retire a quick tunnel's
// hostname while the child keeps running perfectly happily. On 2026-09-16
// xBuildy was heartbeating every 30s, is_online true, connection_mode 'relay',
// republishing a hostname that had stopped resolving. Every relay call came back
// 502 and nothing in Harbor could see it.
//
// ANY HTTP RESPONSE PROVES REACHABILITY, INCLUDING 401. An unauthenticated GET
// to the shared server returns 401 Unauthorized, and that answer can only have
// come from Harbor through the tunnel - so it is a success for this purpose.
// That is deliberate: probing without a credential means this function never has
// to handle the device token and cannot leak it into a log or a URL.
// Only DNS failure, a connection error or a timeout mean unreachable.
// ===========================================================================
const VERIFY_INTERVAL_MS = 60000;
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_FAILURES_BEFORE_DEAD = 2;   // one failure can be a transient blip
let verifyTimer = null;
let verifyFailures = 0;

function resolveHost(host) {
  return new Promise((r) => dns.lookup(host, (err) => r(!err)));
}

async function verifyTunnel(url) {
  const target = url || publicUrl;
  if (!target) return { ok: false, reason: 'no_url' };
  let host;
  try { host = new URL(target).hostname; } catch (e) { return { ok: false, reason: 'bad_url' }; }
  if (!(await resolveHost(host))) return { ok: false, reason: 'dns_failed', host };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.get(target, { timeout: VERIFY_TIMEOUT_MS }, (res) => {
      res.resume();                                  // drain, we only need the status
      finish({ ok: true, status: res.statusCode, host });
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, reason: 'timeout', host }); });
    req.on('error', (e) => finish({ ok: false, reason: 'connect_failed', detail: e.message, host }));
  });
}

// Clears publicUrl after repeated failure so the HEARTBEAT STOPS ADVERTISING A
// CORPSE, and kills the child so the existing watchdog sees !proc and restarts.
// NOTE this reports the REACHABILITY axis only. It deliberately does NOT touch
// is_sharing, which answers a different question - whether folders are shared -
// and was left alone in v3.12.4 for exactly that reason.
function startVerifyMonitor(notify) {
  if (notify) onWatchdogEvent = notify;
  if (verifyTimer) return;
  verifyFailures = 0;
  verifyTimer = setInterval(async () => {
    if (!publicUrl || starting) return;
    const r = await verifyTunnel();
    if (r.ok) { verifyFailures = 0; return; }
    verifyFailures += 1;
    console.warn(`[harbor] file tunnel unreachable (${r.reason}), failure `
      + `${verifyFailures}/${VERIFY_FAILURES_BEFORE_DEAD}: ${publicUrl}`);
    if (verifyFailures < VERIFY_FAILURES_BEFORE_DEAD) return;
    console.error(`[harbor] file tunnel declared dead, unpublishing ${publicUrl}`);
    publicUrl = null;
    verifyFailures = 0;
    try { if (proc) proc.kill(); } catch (e) { /* already gone is fine */ }
    proc = null;
    if (onWatchdogEvent) onWatchdogEvent(null);       // republish with tunnel_url: null
  }, VERIFY_INTERVAL_MS);
}

function stopVerifyMonitor() {
  if (verifyTimer) { clearInterval(verifyTimer); verifyTimer = null; }
  verifyFailures = 0;
}

function stopFileTunnel() {
  disarmWatchdog();
  stopVerifyMonitor();
  // INVALIDATE FIRST, AND BEFORE THE EARLY RETURN. Both lines have to run even
  // when there is no process yet, because "no process yet" is the in-flight-start
  // case this is here to cancel. v3.4.2-v3.6.0 returned {ok:true, already:true}
  // from below without touching either, so the pending start survived the stop.
  generation++;
  starting = false;
  startedAt = 0;
  if (!proc) { publicUrl = null; return { ok: true, already: true }; }
  try { proc.kill(); } catch (e) { /* already dead is the desired state */ }
  proc = null;
  publicUrl = null;
  return { ok: true };
}

module.exports = { startFileTunnel, stopFileTunnel, getUrl, isRunning, isStarting, armWatchdog, disarmWatchdog, gaveUp,
  verifyTunnel, startVerifyMonitor, stopVerifyMonitor, VERIFY_FAILURES_BEFORE_DEAD };
