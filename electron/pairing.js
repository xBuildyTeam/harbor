const crypto = require('crypto');
const os = require('os');

// Wave OS's harborPair function. Both endpoints verified reachable and
// UNAUTHENTICATED on 2026-09-11: the custom domain first, the platform path as a
// fallback. register-code and poll-code must be unauthenticated by necessity -
// the agent has no Wave OS session until pairing completes. That is the point.
const WAVE_OS_APP_ID = '6a5abc9bfa61c917463b71cd';
const ENDPOINTS = [
  'https://app.oswave.io/api/functions/harborPair',
  `https://base44.app/api/apps/${WAVE_OS_APP_ID}/functions/harborPair`,
];

// crypto.randomInt is CSPRNG-backed and uniform across the range. Math.random()
// is neither, and this code is a credential that authorises filesystem access.
function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function localPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function localDeviceName() {
  try {
    return os.hostname() || 'My PC';
  } catch (e) {
    return 'My PC';
  }
}

async function callHarborPair(action, body = {}, timeoutMs = 12000) {
  let lastError = 'Could not reach Wave OS';
  for (const url of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, data };
      // A 4xx is a real ANSWER from the server, not a transport failure, so stop
      // here. Falling through to the next endpoint would make a legitimately
      // rejected code look like a network problem and retry it pointlessly.
      return { ok: false, status: res.status, error: data.error || `HTTP ${res.status}` };
    } catch (e) {
      lastError = (e && e.name === 'AbortError')
        ? 'Timed out reaching Wave OS'
        : ((e && e.message) || String(e));
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastError };
}

module.exports = { generateCode, callHarborPair, localPlatform, localDeviceName };
