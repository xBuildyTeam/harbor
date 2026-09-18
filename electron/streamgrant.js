// Short-lived, single-file, read-only stream grants for the SHARED (tunnelled) scope.
//
// WHY THIS EXISTS. A <video> or <audio> element cannot send an Authorization header -
// you hand it a URL and it issues its own range requests - so header-only auth means
// remote media can never stream from the tunnel at all. It has to be buffered whole
// through the relay instead, which measured out at about 1.9 MB/s and offers no
// partial content, so playback cannot start until the entire file has arrived. That is
// the capability this restores.
//
// WHY NOT JUST PUT THE DEVICE TOKEN IN THE QUERY STRING. Because fileserver.js already
// refuses exactly that, for a good reason stated in its own comment: the shared scope is
// tunnelled, so a query-string credential traverses a third-party edge network and lands
// in its request logs. That objection is about the DEVICE TOKEN specifically - a
// long-lived credential authorising the whole share, both read and write. It is not an
// objection to query strings as such. A grant here is a different object:
//
//   - ONE FILE. It carries a single resolved absolute path and authorises nothing else.
//   - READ ONLY. The caller still has to pass the method guard; no grant reaches /write.
//   - IDLE-EXPIRING. Ten minutes of no use and it is gone.
//   - PER-LAUNCH. Held in memory only, so every grant dies when Harbor closes.
//   - UNGUESSABLE and not derived from any stored credential, so a leaked grant reveals
//     nothing about the device token and cannot be extended into wider access.
//
// WHY A SLIDING WINDOW RATHER THAN A FIXED EXPIRY, which is what I first designed.
// A fixed short expiry is wrong for the actual workload. A <video> element re-requests
// the same URL for the whole time someone is watching - seeking backwards an hour into a
// film issues a fresh range request against the original src - so a two-minute token
// would authorise the start of a film and then 401 partway through, which is a worse
// failure than slow playback because it looks like corruption. A sliding idle window
// gets both properties at once: continuous use keeps a grant alive as long as someone is
// genuinely watching, and an abandoned one still dies in ten minutes. An absolute cap
// sits behind it so continuous use cannot keep one alive indefinitely.

'use strict';

const crypto = require('crypto');
const path = require('path');

// Ten minutes of inactivity. Long enough to survive a pause, a phone call, or a seek
// after a think; short enough that a grant captured from a log is almost always dead.
const IDLE_MS = 10 * 60 * 1000;

// Twelve hours regardless of activity, so continuous use cannot keep one alive forever.
// Longer than any single sitting, shorter than a working day.
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;

// A bound, so a caller that mints in a loop cannot grow this map without limit. At the
// cap the oldest grant is evicted rather than refusing to mint: refusing would break
// the newest legitimate request in favour of keeping a stale one alive.
const MAX_GRANTS = 256;

// Per-launch, in memory, never written to disk. token -> { file, lastUsed, mintedAt }
const grants = new Map();

function now() { return Date.now(); }

function isExpired(g, t) {
  return (t - g.lastUsed) > IDLE_MS || (t - g.mintedAt) > ABSOLUTE_MS;
}

// Called on every mint. Cheap at this size, and it means an abandoned grant does not
// sit in memory until the next redeem happens to notice it.
function sweep(t = now()) {
  let dropped = 0;
  for (const [token, g] of grants) {
    if (isExpired(g, t)) { grants.delete(token); dropped++; }
  }
  return dropped;
}

/**
 * Mint a grant for one already-resolved absolute file path.
 *
 * The caller MUST pass the path that came out of resolveForScope, not the raw path from
 * the query string. Signing the resolved path is what makes traversal a non-issue: at
 * redeem time the requested path is resolved again by the same function and compared to
 * this one, so '..' or a symlink pointing outside a shared folder yields a different
 * resolved path and simply fails to match.
 */
function mint(resolvedFile) {
  if (typeof resolvedFile !== 'string' || !resolvedFile) {
    throw new TypeError('mint requires a resolved absolute file path');
  }
  if (!path.isAbsolute(resolvedFile)) {
    throw new TypeError('mint requires an ABSOLUTE path, got: ' + resolvedFile);
  }
  const t = now();
  sweep(t);

  if (grants.size >= MAX_GRANTS) {
    // Evict the least recently used.
    let oldestToken = null, oldestSeen = Infinity;
    for (const [token, g] of grants) {
      if (g.lastUsed < oldestSeen) { oldestSeen = g.lastUsed; oldestToken = token; }
    }
    if (oldestToken) grants.delete(oldestToken);
  }

  // 32 bytes from the CSPRNG. base64url so it survives a query string untouched -
  // no padding, no characters needing escaping.
  const token = crypto.randomBytes(32).toString('base64url');
  grants.set(token, { file: resolvedFile, lastUsed: t, mintedAt: t });
  return { token, idleSeconds: Math.floor(IDLE_MS / 1000), absoluteSeconds: Math.floor(ABSOLUTE_MS / 1000) };
}

/**
 * Redeem a grant for a specific resolved path. Returns true only if the grant exists,
 * has not expired, and was minted for EXACTLY this path. On success the idle window
 * slides forward.
 *
 * Both arguments are compared with timingSafeEqual on equal-length buffers. The token
 * lookup is a Map get, which is not constant-time with respect to the key - but the
 * token is 256 bits of CSPRNG output, so there is no neighbouring value to walk toward
 * and a timing signal on lookup buys an attacker nothing. The path comparison is
 * constant-time because paths are guessable and an attacker CAN walk those.
 */
function redeem(token, resolvedFile) {
  if (typeof token !== 'string' || !token) return false;
  if (typeof resolvedFile !== 'string' || !resolvedFile) return false;

  const g = grants.get(token);
  if (!g) return false;

  const t = now();
  if (isExpired(g, t)) { grants.delete(token); return false; }

  const a = Buffer.from(g.file, 'utf8');
  const b = Buffer.from(resolvedFile, 'utf8');
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;

  g.lastUsed = t;
  return true;
}

// For the dock, for tests, and for anyone wondering what is outstanding. Deliberately
// returns no tokens and no paths - a status call should not become a way to read either.
function stats() {
  const t = now();
  let live = 0;
  for (const g of grants.values()) if (!isExpired(g, t)) live++;
  return { live, total: grants.size, idleMs: IDLE_MS, absoluteMs: ABSOLUTE_MS, max: MAX_GRANTS };
}

// Drops every grant. Called when remote access is turned off, so revoking access
// actually revokes it rather than leaving live grants behind for the idle window.
function revokeAll() {
  const n = grants.size;
  grants.clear();
  return n;
}

module.exports = { mint, redeem, stats, revokeAll, sweep, IDLE_MS, ABSOLUTE_MS, MAX_GRANTS };
