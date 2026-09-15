// Harbor's local read-only file server.
//
// This is the piece BOTH transports need: a tunnel points at it, and a future
// WebRTC data channel would serve the same handlers. It binds to 127.0.0.1 only,
// so nothing is reachable off-machine until something is deliberately pointed at
// it - and when that happens, every request still has to carry the device_token.
//
// Three invariants, in order of how badly they bite if wrong:
//   1. Every request authenticates with the device_token, compared in constant time.
//   2. Every path resolves inside a folder the user explicitly shared, checked
//      AFTER realpath so a symlink cannot walk out.
//   3. Read-only. GET and HEAD only. No write verb is implemented at all.
const http = require('http');
const fs = require('fs');
const path = require('path');
const fileindex = require('./fileindex');
const crypto = require('crypto');

const DEFAULT_PORT = 47615;       // SHARED scope. The tunnel points here.
const LOCAL_PORT = 47616;         // LOCAL scope. NOTHING may ever tunnel this.

// WHY TWO SOCKETS INSTEAD OF ONE SERVER WITH A LOOPBACK CHECK.
// The obvious guard - "only serve the unrestricted scope to requests whose
// remote address is loopback" - DOES NOT WORK, and would have shipped a
// whole-disk hole reachable from the internet. cloudflared runs ON THIS PC and
// connects to 127.0.0.1, so tunnelled requests arrive from loopback too and are
// indistinguishable from a local page's request at the socket level.
// So the separation has to be structural: two listeners, two credentials, two
// scopes, and the tunnel is only ever handed DEFAULT_PORT. What keeps the whole
// disk private is which port cloudflared was told to forward - a fact about
// wiring, not a predicate that can be fooled.

// PER-SCOPE STATE, NOT A SINGLETON. This was `let server` + `let boundPort`, and
// with two listeners that single pair became a RACE: whichever socket finished
// binding last owned boundPort, and fileServerStatus() is what feeds
// startFileTunnel(). So cloudflared could have been handed 47616 and published
// the UNRESTRICTED WHOLE-DISK listener to the open internet. The token gate was
// the only thing left standing between that and someone's home directory.
// Worth recording how close it came: 18 headless checks passed on the broken
// version, because the test started both servers inside one Promise.all and both
// slipped past the `if (server)` guard before either resolved. A green suite that
// passes BECAUSE of the race it should have caught.
const servers = { shared: null, local: null };
const ports = { shared: null, local: null };
let getConfig = () => ({ token: null, folders: [] });

// ===========================================================================
// BROWSER CONSENT GRANTS
//
// THE PROBLEM. Inside Harbor's own window a page gets the whole-disk token over
// the preload bridge, so only a page Harbor itself loaded can ever hold it. A
// browser tab at https://app.oswave.io has no bridge - so on the machine the
// files are actually ON, Wave OS could reach less than it can from a phone.
//
// WHY NOT JUST OPEN THE PORT. Because then ANY website you visit could fetch
// http://127.0.0.1:47616 and read your home directory. The CORS allowlist
// narrows that, but CORS is a browser courtesy, not an access control, and it
// would still hand whole-disk read to anything running on an allowlisted origin -
// including an XSS on oswave.io. An open loopback port IS the vulnerability
// class; it must not be the design.
//
// THE CONSENT IS A HUMAN TYPING A CODE THAT ONLY APPEARS IN HARBOR'S WINDOW.
// That is the whole security argument, and it is out-of-band by construction: a
// website cannot read Harbor's UI, cannot script it, and cannot guess the code.
// Nothing a page can do on its own produces access.
//
// PROPERTIES, EACH DELIBERATE:
//   - The code is single-use, 120s TTL, crypto-random over an unambiguous
//     alphabet (no O/0/I/1), and dies after 3 wrong attempts.
//   - Redeeming returns a SEPARATE grant token, not the whole-disk local token,
//     so a grant can be revoked without invalidating the bridge.
//   - Grants live in MEMORY ONLY. Quitting Harbor revokes every one of them.
//     That costs the user a re-consent after each restart, which is the correct
//     trade: this credential reads your entire disk and must not be sitting in a
//     settings file for the next process to find.
//   - Bounded: MAX_GRANTS at once, so the surface cannot accumulate.
//   - Grants are accepted ONLY by the local listener, which is never tunnelled.
// ===========================================================================
const GRANT_CODE_TTL_MS = 120 * 1000;
const GRANT_TTL_MS = 8 * 60 * 60 * 1000;
const GRANT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
const MAX_GRANTS = 8;
const MAX_CODE_ATTEMPTS = 3;

const grants = new Map();        // token -> { id, origin, label, issuedAt, expiresAt }
let pendingCode = null;          // { code, expiresAt, attempts }

function randomCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += GRANT_CODE_ALPHABET[bytes[i] % GRANT_CODE_ALPHABET.length];
  return out.slice(0, 4) + '-' + out.slice(4);
}

function pruneGrants() {
  const now = Date.now();
  for (const [tok, g] of grants) if (g.expiresAt <= now) grants.delete(tok);
  if (pendingCode && pendingCode.expiresAt <= now) pendingCode = null;
}

// Called from Harbor's OWN UI over IPC. Never reachable over HTTP - if a page
// could mint a code, the code would not be consent.
function mintGrantCode() {
  pruneGrants();
  if (grants.size >= MAX_GRANTS) {
    return { ok: false, error: 'Too many active grants. Revoke one first.' };
  }
  pendingCode = { code: randomCode(), expiresAt: Date.now() + GRANT_CODE_TTL_MS, attempts: 0 };
  return { ok: true, code: pendingCode.code, expiresAt: pendingCode.expiresAt,
           ttlSeconds: Math.round(GRANT_CODE_TTL_MS / 1000) };
}

function redeemGrantCode(submitted, origin) {
  pruneGrants();
  if (!pendingCode) return { ok: false, status: 403, error: 'No pending consent. Generate a code in Harbor first.' };
  const given = String(submitted || '').trim().toUpperCase().replace(/\s+/g, '');
  const want = pendingCode.code.toUpperCase();
  // Normalise the dash so "ABCD-EFGH" and "ABCDEFGH" both work - a human is
  // retyping this, and rejecting a correct code on punctuation is user-hostile.
  const norm = (v) => v.replace(/-/g, '');
  if (!given || !timingSafeEqualStr(norm(given), norm(want))) {
    pendingCode.attempts++;
    const left = MAX_CODE_ATTEMPTS - pendingCode.attempts;
    if (left <= 0) { pendingCode = null; return { ok: false, status: 403, error: 'Too many wrong attempts. Generate a new code in Harbor.' }; }
    return { ok: false, status: 403, error: 'Incorrect code. ' + left + ' attempt(s) left.' };
  }
  pendingCode = null;                                  // single use
  if (grants.size >= MAX_GRANTS) return { ok: false, status: 429, error: 'Too many active grants.' };
  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomBytes(4).toString('hex');
  const g = { id, origin: origin || null, label: origin || 'unknown origin',
              issuedAt: Date.now(), expiresAt: Date.now() + GRANT_TTL_MS };
  grants.set(token, g);
  return { ok: true, token, id, expiresAt: g.expiresAt, origin: g.origin };
}

// ORIGIN IS ENFORCED WHEN PRESENT, AND ITS ABSENCE IS TOLERATED ONLY ON /stream.
// A <video> or <audio> element without a crossorigin attribute sends NO Origin
// header, so strict enforcement would break the one case the HTTP endpoint exists
// to serve. Origin here is defence-in-depth rather than the primary control - the
// primary control is that the grant token is unguessable and was handed out only
// after a human typed a code from Harbor's window. Narrow relaxation, stated
// rather than silently assumed, same shape as the ?token= concession.
function validateGrant(token, origin, route) {
  pruneGrants();
  if (!token) return false;
  const g = grants.get(token);
  if (!g) return false;
  if (g.expiresAt <= Date.now()) { grants.delete(token); return false; }
  if (g.origin && origin && origin !== g.origin) return false;
  if (g.origin && !origin && route !== '/stream') return false;
  return true;
}

function listGrants() {
  pruneGrants();
  return [...grants.values()].map(g => ({
    id: g.id, origin: g.origin, issuedAt: g.issuedAt, expiresAt: g.expiresAt,
    expiresInSeconds: Math.max(0, Math.round((g.expiresAt - Date.now()) / 1000)),
  }));
}

function revokeGrant(id) {
  for (const [tok, g] of grants) if (g.id === id) { grants.delete(tok); return { ok: true }; }
  return { ok: false, error: 'No such grant' };
}

function revokeAllGrants() {
  const n = grants.size; grants.clear(); pendingCode = null; return { ok: true, revoked: n };
}

function pendingCodeStatus() {
  pruneGrants();
  if (!pendingCode) return { pending: false };
  return { pending: true, code: pendingCode.code, expiresAt: pendingCode.expiresAt,
           expiresInSeconds: Math.max(0, Math.round((pendingCode.expiresAt - Date.now()) / 1000)) };
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hash both first so the compared buffers are always the same size.
  const ha = crypto.createHash('sha256').update(ba).digest();
  const hb = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Boundary test. NOT a bare startsWith: root '/home/e/shared' must NOT match
// '/home/e/shared-secrets'. Requiring the separator (or exact equality) is what
// makes a sibling directory with a shared prefix fail closed.
function isInside(root, target) {
  if (root === target) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(withSep);
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return null;
  }
}

// Resolves a requested path against the shared roots, or returns null.
// Exported so it can be tested directly - this is the function that decides
// whether the whole feature is a file share or a security hole.
// LOCAL scope. Deliberately unrestricted: the user is sitting at this machine,
// and Eddie's model is "everything on the PC locally, only shared_folders over
// the web". Still not a free-for-all - the NUL check stays (a truncation trick
// that turns "/etc/passwd\0.png" into a different path for different readers),
// and the path must resolve and exist.
function resolveLocal(requested) {
  if (!requested || typeof requested !== 'string') return null;
  if (requested.indexOf('\0') !== -1) return null;
  const target = path.resolve(requested);
  return realOrNull(target) || target;
}

// One entry point so a caller cannot pick the wrong resolver by accident. The
// scope decides; there is no default that silently widens.
function resolveForScope(requested, scope, folders) {
  if (scope === 'local') return resolveLocal(requested);
  return resolveShared(requested, folders);
}

function resolveShared(requested, folders) {
  if (!requested || typeof requested !== 'string') return null;
  if (requested.indexOf('\0') !== -1) return null;
  const roots = (folders || [])
    .map(f => (f && f.path) || null)
    .filter(Boolean)
    .map(r => realOrNull(path.resolve(r)) || path.resolve(r));
  if (!roots.length) return null;

  const target = path.resolve(requested);
  // Check the lexical form first so a nonexistent traversal target is rejected
  // even when realpath cannot resolve it.
  const lexicalOk = roots.some(r => isInside(r, target));
  if (!lexicalOk) return null;

  // Then re-check the REAL path, so a symlink inside a shared folder that points
  // outside it is refused. Skipping this is the classic way scoping gets bypassed.
  const real = realOrNull(target);
  if (real && !roots.some(r => isInside(r, real))) return null;

  return real || target;
}

// ===========================================================================
// WRITE RESOLUTION. The most dangerous function in Harbor, so the reasoning is
// here rather than in a commit message.
//
// THE RULE: read scope is determined by WHERE YOU ARE; write scope is determined
// by WHAT YOU DECLARED.
//
// Reads differ by scope - the local listener may read the whole disk because the
// person is sitting at the machine, while the tunnelled listener may only read
// shared_folders. WRITES DO NOT DIFFER BY SCOPE AT ALL. They are confined to
// folders explicitly marked read-write, whichever listener asked.
//
// SO THIS FUNCTION TAKES NO SCOPE PARAMETER, AND THAT ABSENCE IS THE GUARANTEE:
// there is no argument any caller can pass to make it accept a whole-disk path.
// A boolean or a scope string here would be a switch someone could later flip by
// accident; a missing parameter cannot be flipped. Whole-disk WRITE does not
// exist in this program.
//
// Until now the read-only 405 guard was doing this work for free, and a path
// traversal bug could only ever leak a file. From here the same bug would
// OVERWRITE one, so every check below is load-bearing.
// ===========================================================================
const MAX_WRITE_BYTES = 512 * 1024 * 1024;   // per file, stated rather than implied

// The ONLY routes any write method may reach. A Set rather than a scattered
// series of method checks, so the writable surface is one greppable list.
const WRITE_ROUTES = new Set(['/write', '/mkdir']);

function writableRoots(folders) {
  return (folders || [])
    .filter(f => f && f.path && f.permissions === 'read-write')
    .map(f => realOrNull(path.resolve(f.path)) || path.resolve(f.path));
}

function resolveForWrite(requested, folders) {
  if (!requested || typeof requested !== 'string') return null;
  if (requested.indexOf('\0') !== -1) return null;

  // An empty writable list is the DEFAULT state, and it must mean "no writes
  // anywhere" rather than "no restriction". Getting this branch backwards is how
  // an allowlist becomes a no-op.
  const roots = writableRoots(folders);
  if (!roots.length) return null;

  const target = path.resolve(requested);

  // Lexical check first, so a traversal aimed at a path that does not exist is
  // refused even though realpath cannot resolve it.
  if (!roots.some(r => isInside(r, target))) return null;

  // THE PART THAT IS DIFFERENT FROM READING, and the easiest thing to get wrong.
  // A file being written usually DOES NOT EXIST yet, so realpath(target) is null
  // and a copied-from-reads realpath check would silently pass. The PARENT must
  // therefore be resolved and re-checked: that is what catches a symlinked
  // directory inside the share pointing somewhere else on the disk.
  const realParent = realOrNull(path.dirname(target));
  if (!realParent) return null;                                  // parent must exist
  if (!roots.some(r => isInside(r, realParent))) return null;

  // And if the target itself already exists as a symlink out of the share,
  // writing "into the share" would land outside it.
  const realTarget = realOrNull(target);
  if (realTarget && !roots.some(r => isInside(r, realTarget))) return null;

  return target;
}

// ---------------------------------------------------------------------------
// CORS. Wave OS fetches this server DIRECTLY FROM THE BROWSER, cross-origin, so
// without these headers every authorised request dies as a bare
// `TypeError: Failed to fetch` with no way to tell it from the network being
// down. Measured against the live tunnel 2026-09-14: zero
// Access-Control-Allow-Origin on any response, and the preflight answered 405.
//
// NOT '*'. This server is reachable from the open internet whenever the tunnel
// is on, and it serves a folder out of somebody's home directory. An allowlist
// means a hostile page cannot even attempt to replay a token from the user's own
// browser, which the bearer check alone does not prevent.
const ALLOWED_ORIGIN_SUFFIXES = ['oswave.io', 'base44.app', 'base44.com'];

function originAllowed(origin) {
  if (!origin) return false;
  let host;
  try { host = new URL(origin).hostname; } catch (e) { return false; }
  if (host === 'localhost' || host === '127.0.0.1') return true; // local dev
  // Suffix match must be on a DOT boundary. Plain endsWith('oswave.io') would
  // also accept 'notoswave.io', which is the classic allowlist bypass.
  return ALLOWED_ORIGIN_SUFFIXES.some((sfx) => host === sfx || host.endsWith('.' + sfx));
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  // Vary unconditionally, allowed or not: the response genuinely differs by
  // Origin, and a cache that misses that hands the wrong Allow-Origin to the
  // next caller.
  res.setHeader('Vary', 'Origin');
  if (!originAllowed(origin)) {
    // Logged so a future "Failed to fetch" can be read off the console instead
    // of guessed at. A silent refusal here is indistinguishable from a network
    // fault at the caller, which is the whole failure this fix exists to end.
    if (origin) console.warn('[harbor] CORS refused origin:', origin);
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Harbor-Token, Content-Type, Range');
  // Expose-Headers matters for media: without it a player cannot read
  // Content-Length or Content-Range off the response, so SEEKING BREAKS even
  // though the bytes arrive correctly. That failure looks like a codec problem.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  res.setHeader('Access-Control-Max-Age', '600');
  // PRIVATE NETWORK ACCESS. app.oswave.io is a PUBLIC origin; 127.0.0.1 is LOCAL
  // address space. Chrome therefore classes this as a private-network request and
  // sends a preflight carrying `Access-Control-Request-Private-Network: true`. If
  // the response does not carry the matching allow header the request is BLOCKED -
  // surfacing as a bare "TypeError: Failed to fetch", the exact same symptom as
  // the missing CORS in v3.4.4. Second time this class of failure would have hit
  // this feature, so it is answered here up front rather than debugged later.
  // Only echoed when actually asked for, and only for an allowlisted origin.
  if (String(req.headers['access-control-request-private-network']).toLowerCase() === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  // Deliberately NO Access-Control-Allow-Credentials. Auth here is a header,
  // never a cookie, so allowing credentials would widen exposure for nothing.
  return true;
}

// ---------------------------------------------------------------------------
// Content-Type by extension. Until v3.4.5 EVERY file streamed as
// application/octet-stream - a PNG, an mp4 and a .txt were indistinguishable to
// the caller. That breaks a viewer in two independent ways: a Blob built from the
// response carries the wrong type so an <img>/<video> refuses to decode it, and
// any client that switches on Content-Type to choose a renderer cannot tell an
// image from a binary. Measured 2026-09-14: /stream returned byte-perfect
// content with correct 200/206/Content-Range and still octet-stream for a PNG.
const MIME = {
  // images
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  heic: 'image/heic', tif: 'image/tiff', tiff: 'image/tiff',
  // video
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/mp4',
  // audio
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
  // documents
  pdf: 'application/pdf',
  // text and code - charset matters or accented characters mojibake
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', ini: 'text/plain; charset=utf-8',
  cfg: 'text/plain; charset=utf-8', env: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8',
  js: 'text/plain; charset=utf-8', mjs: 'text/plain; charset=utf-8',
  cjs: 'text/plain; charset=utf-8', ts: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8', tsx: 'text/plain; charset=utf-8',
  css: 'text/plain; charset=utf-8', py: 'text/plain; charset=utf-8',
  sh: 'text/plain; charset=utf-8', rs: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8', java: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8', h: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8', sol: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8', sql: 'text/plain; charset=utf-8',
  // archives
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
};

// DELIBERATELY SERVED AS text/plain, NOT their real type. An HTML or SVG file
// sitting in a shared folder is untrusted input: served as text/html or
// image/svg+xml the browser EXECUTES its script. The tunnel is a different
// origin from Wave OS so it cannot touch the app's session, and the bearer token
// lives in a header rather than a cookie so a script there has nothing to steal
// - but "the blast radius happens to be small" is not a reason to hand a file
// out of someone's home directory an execution context. Cost of this choice: an
// .svg will not render as an image, it will show as source. Reversible if that
// ever matters more than the guarantee.
const NEVER_EXECUTE = new Set(['html', 'htm', 'xhtml', 'svg', 'xml', 'xsl', 'mhtml']);

function contentTypeFor(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(file);
  if (!m) return 'application/octet-stream';
  const ext = m[1].toLowerCase();
  if (NEVER_EXECUTE.has(ext)) return 'text/plain; charset=utf-8';
  return MIME[ext] || 'application/octet-stream';
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function handle(req, res, scope, getConfig) {
  const cfg = getConfig() || {};
  // Set via setHeader BEFORE any writeHead, because Node merges setHeader values
  // into writeHead. One call site therefore covers every response including the
  // 401, the 403, the 404, the 206 and the 416 - and the error responses are the
  // ones that MUST carry it. Without CORS on a 401 the browser masks the auth
  // failure as "Failed to fetch", so "wrong token" and "server unreachable"
  // become the same message. Same family of bug as the dock reporting
  // "On (starting...)" for a process that did not exist.
  applyCors(req, res);

  // A PREFLIGHT IS NOT A WRITE. The read-only guard below answered OPTIONS with
  // 405 "Read-only server", and since browsers send the preflight before any
  // cross-origin request carrying an Authorization header, that single line
  // turned every correct, authorised, fully-scoped request into
  // "Failed to fetch". It must also be answered BEFORE the token check, because
  // browsers deliberately do not send credentials on a preflight.
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (e) {
    return send(res, 400, { error: 'Bad request' });
  }
  const route = url.pathname;

  // METHOD GUARD, NOW ROUTE-AWARE rather than a blanket refusal. Parsing the URL
  // has moved ABOVE this so the guard can see which route was asked for: a write
  // method is accepted on exactly two routes and refused everywhere else, so
  // adding writes did not widen any existing endpoint by a single verb.
  // DELETE is still refused everywhere. Removing files on someone's home PC over
  // a network is a different risk class from adding them, and nothing needs it
  // yet.
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const isWrite = (req.method === 'PUT' || req.method === 'POST') && WRITE_ROUTES.has(route);
  if (!isRead && !isWrite) {
    return send(res, 405, {
      error: WRITE_ROUTES.has(route) ? 'Use PUT or POST' : 'Read-only endpoint',
      // Named explicitly so a caller can tell "this server cannot write" from
      // "this route cannot write", which a bare 405 collapses.
      writable_routes: Array.from(WRITE_ROUTES),
    });
  }
  // The shared scope genuinely needs pairing - it exists to serve Wave OS. The
  // local scope does not: files on this PC are readable by the person at this PC
  // whether or not a cloud account was ever connected.
  if (scope !== 'local' && !cfg.token) return send(res, 503, { error: 'Not paired' });

  // TWO valid credentials, because two different peers call this server and the
  // credentials travel in opposite directions:
  //   device_token  - what Harbor itself holds; Wave OS stores only its HASH, so
  //                   the backend CANNOT present this one.
  //   relay_secret  - what Wave OS's harborRelay presents; Wave OS stores it
  //                   encrypted-at-rest precisely so it CAN present it.
  // Accepting only the device token, as v3.2.0 did, 401s every relayed request.
  // Parsed BEFORE the auth check, because one narrow case below needs the route
  // to decide whether a query-string credential is acceptable.
  let presented = req.headers['x-harbor-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  // QUERY-STRING CREDENTIAL, DELIBERATELY NARROW. A <video> or <audio> element
  // cannot send an Authorization header - you hand it a URL and it issues its own
  // range requests - so header-only auth means media can never stream, only be
  // buffered whole through IPC. That is a real capability loss for large video.
  // The concession is therefore fenced on three sides at once:
  //   - LOCAL SCOPE ONLY. The shared scope is TUNNELLED, and a token in a query
  //     string there would traverse a third-party edge network and land in its
  //     request logs. Header-only, always, on 47615.
  //   - /stream ONLY. /list and /roots are called by fetch(), which can set
  //     headers, so they have no need of this and do not get it.
  //   - Header form still preferred; the query is consulted only when no header
  //     was presented at all.
  // Residual cost, stated rather than hidden: the token appears in the element's
  // src and therefore in the DOM. It is loopback-only, per-launch, in-memory and
  // read-only, so what it grants dies with the process - but it is a wider
  // exposure than a header and should not be widened further.
  if (!presented && scope === 'local' && route === '/stream') {
    presented = url.searchParams.get('token') || '';
  }
  // CREDENTIALS ARE PER-SCOPE AND MUST NOT OVERLAP. The local token authorises the
  // WHOLE DISK, so it is accepted ONLY by the local listener - which is never
  // tunnelled. device_token and relay_secret authorise the shared scope only, so
  // possession of a cloud credential can never widen into local access. This is
  // the same "two credentials, opposite directions" split as the pairing design.
  const accepted = scope === 'local'
    ? [cfg.localToken].filter(Boolean)
    : [cfg.token, cfg.relaySecret].filter(Boolean);
  // Compare against BOTH unconditionally rather than short-circuiting, so the
  // number of comparisons does not vary with which credential was presented.
  let authed = false;
  for (const candidate of accepted) {
    if (presented && timingSafeEqualStr(presented, candidate)) authed = true;
  }
  // A consent grant is a second way to satisfy the LOCAL scope only. It is never
  // in `accepted` for the shared scope, so a grant can never reach the tunnelled
  // listener however it was obtained.
  if (!authed && scope === 'local' && validateGrant(presented, req.headers.origin, route)) {
    authed = true;
  }
  // The consent redemption itself cannot require a credential - the code IS the
  // credential, and it is checked inside redeemGrantCode with its own attempt
  // limit. Placed after the read-only guard and the CORS handling above, so it
  // is still GET-only and still origin-gated.
  if (!authed && scope === 'local' && route === '/grant/redeem') {
    const r = redeemGrantCode(url.searchParams.get('code'), req.headers.origin);
    if (!r.ok) return send(res, r.status || 403, { error: r.error });
    return send(res, 200, {
      token: r.token, grantId: r.id, expiresAt: r.expiresAt, origin: r.origin,
      scope: 'local',
      notice: 'Full local read access, in memory only. Revoked when Harbor quits.',
    });
  }
  if (!authed) return send(res, 401, { error: 'Unauthorized' });

  if (route === '/grants') {
    if (scope !== 'local') return send(res, 404, { error: 'Not found' });
    // Deliberately NOT readable with a grant token - a granted browser must not
    // be able to enumerate or reason about the other grants on the machine.
    if (!cfg.localToken || !timingSafeEqualStr(presented, cfg.localToken)) {
      return send(res, 403, { error: 'Only Harbor itself can list grants' });
    }
    return send(res, 200, { grants: listGrants(), pending: pendingCodeStatus() });
  }

  if (route === '/health') {
    return send(res, 200, { ok: true, folders: (cfg.folders || []).length });
  }

  // The shared roots themselves, so a client can start browsing without
  // guessing a path.
  // =========================================================================
  // WRITES. Gated three separate ways: the route-aware method guard above, the
  // credential check the same as every read, and resolveForWrite - which is the
  // only one of the three that knows about read-write folders.
  // =========================================================================
  if (route === '/write') {
    const target = resolveForWrite(url.searchParams.get('path'), cfg.folders);
    if (!target) {
      // ONE refusal for every reason: outside the share, inside a read-only
      // folder, traversal, symlink-out, or no writable folder configured at all.
      // Distinct messages here would tell an unauthorised caller WHICH of those
      // it hit, which is a map of the share.
      return send(res, 403, {
        error: 'Not a writable location',
        hint: 'Writes are only allowed inside a shared folder marked read-write.',
      });
    }

    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (Number.isFinite(declared) && declared > MAX_WRITE_BYTES) {
      return send(res, 413, { error: 'File too large', maxBytes: MAX_WRITE_BYTES });
    }

    // NO IMPLICIT OVERWRITE. A save that silently replaces a file the user did
    // not mean to touch is indistinguishable from data loss, so replacing takes
    // an explicit flag and the default answers 409.
    const overwrite = url.searchParams.get('overwrite') === 'true';
    let existed = false;
    try { existed = fs.statSync(target).isFile(); } catch (e) { existed = false; }
    if (existed && !overwrite) {
      return send(res, 409, { error: 'File exists', path: target, hint: 'Pass overwrite=true to replace it.' });
    }

    // ATOMIC. Bytes go to a temp file in the SAME DIRECTORY - same directory
    // because rename is only atomic within a filesystem - and only a completed,
    // flushed temp file is renamed over the destination. A connection dropped
    // mid-upload therefore leaves the original file untouched and a stray
    // .harbor-tmp-* behind, rather than a truncated document. Writing straight to
    // the destination would destroy the previous version to store a partial one.
    const tmp = path.join(path.dirname(target), '.harbor-tmp-' + crypto.randomBytes(8).toString('hex'));
    let ws;
    try {
      ws = fs.createWriteStream(tmp, { flags: 'wx' });
    } catch (e) {
      return send(res, 500, { error: 'Could not open a temporary file' });
    }

    let bytes = 0;
    let failed = false;
    const abort = (status, body) => {
      if (failed) return;
      failed = true;
      try { ws.destroy(); } catch (e) {}
      try { fs.unlinkSync(tmp); } catch (e) {}   // never leave the temp behind on a refusal
      send(res, status, body);
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      // Enforced on the STREAM, not just on Content-Length: a client may lie about
      // or omit the header, and a cap that trusts a declared value is not a cap.
      if (bytes > MAX_WRITE_BYTES) abort(413, { error: 'File too large', maxBytes: MAX_WRITE_BYTES });
    });
    req.on('error', () => abort(400, { error: 'Upload interrupted' }));
    ws.on('error', () => abort(500, { error: 'Could not write the file' }));

    req.pipe(ws);

    ws.on('close', () => {
      if (failed) return;
      try {
        fs.renameSync(tmp, target);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        return send(res, 500, { error: 'Could not finalise the file' });
      }
      return send(res, existed ? 200 : 201, {
        ok: true, path: target, bytes, replaced: existed,
      });
    });
    return;
  }

  if (route === '/mkdir') {
    const target = resolveForWrite(url.searchParams.get('path'), cfg.folders);
    if (!target) {
      return send(res, 403, {
        error: 'Not a writable location',
        hint: 'Folders can only be created inside a shared folder marked read-write.',
      });
    }
    try {
      // recursive:true so it is idempotent - creating a folder that already exists
      // is a success, because the caller's intent ("this folder should exist") is
      // already satisfied and an error would make retries fail.
      fs.mkdirSync(target, { recursive: true });
    } catch (e) {
      return send(res, 500, { error: 'Could not create the folder' });
    }
    return send(res, 201, { ok: true, path: target });
  }

  // SEARCH. The whole reason this exists on the server rather than in Wave OS:
  // answering "where is invoice-2024.pdf" by listing directories over the relay
  // would be thousands of round trips. It is computed on the machine that holds
  // the files and one answer is returned.
  //
  // TWO INDEPENDENT GUARANTEES, because a filename is itself a disclosure -
  // `divorce-settlement-draft.docx` tells you something even if the bytes never
  // move.
  //   1. STRUCTURAL: the index only ever contains paths inside shared_folders, so
  //      there is nothing outside the share for it to return.
  //   2. PER-HIT: every result must still survive resolveForScope for the
  //      REQUESTING scope. Redundant against the index as it stands today, and
  //      that is exactly the point - it is what keeps the guarantee true if
  //      someone later widens what gets indexed.
  // A hit the scope may not read is dropped silently rather than refused, since
  // the existence of the match is the thing being withheld.
  if (route === '/search') {
    const q = url.searchParams.get('q') || '';
    const rawLimit = parseInt(url.searchParams.get('limit') || '200', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1), 500);
    const validate = (p) => !!resolveForScope(p, scope, cfg.folders);
    const r = fileindex.search(q, { validate, limit });
    const st = fileindex.getStats();
    return send(res, 200, {
      query: q,
      results: r.results,
      truncated: r.truncated,
      // Reported so a caller can tell "no matches" from "the index is not built
      // yet", which look identical from an empty result array.
      index: { built: st.built, building: st.building, fileCount: st.fileCount, builtAt: st.builtAt },
    });
  }

  // Totals for the Cloud card, and for anything in Wave OS that wants to show
  // how much of this PC is actually reachable.
  if (route === '/stats') {
    const st = fileindex.getStats();
    return send(res, 200, {
      fileCount: st.fileCount,
      totalBytes: st.totalBytes,
      folderCount: (cfg.folders || []).length,
      built: st.built,
      building: st.building,
      builtAt: st.builtAt,
      truncated: st.truncated,
    });
  }

  if (route === '/roots') {
    return send(res, 200, {
      roots: (cfg.folders || []).map(f => ({
        path: f.path, name: f.name, label: f.label || f.name,
        // Defaulting to read-only matters: a folder saved before this version has no
        // permissions field, and it must read as read-only rather than as writable.
        permissions: f.permissions === 'read-write' ? 'read-write' : 'read-only',
      })),
    });
  }

  // Wave OS's relay advertises a 'drives' endpoint. Refused deliberately, and
  // with an explicit reason rather than a bare 404, so nobody later reads the
  // 404 as "not implemented yet" and helpfully implements it. Enumerating whole
  // disks is exactly the whole-filesystem exposure the shared-folder model
  // exists to replace.
  if (route === '/drives') {
    // REFUSED ON THE SHARED SCOPE, ALLOWED ON THE LOCAL ONE - the same endpoint
    // name, two opposite answers, because the scopes mean different things.
    // Whole-disk enumeration through the tunnel is the exposure the shared-folder
    // model exists to prevent. On the local scope it is the entire point, and the
    // caller already holds either the bridge token or a human-approved grant.
    if (scope !== 'local') {
      return send(res, 403, {
        error: 'Whole-disk enumeration is not available over a share',
        refused_by_design: true,
        hint: 'Use /roots for the folders this device actually shares.',
      });
    }
    const out = [];
    if (process.platform === 'win32') {
      for (let i = 65; i <= 90; i++) {
        const root = String.fromCharCode(i) + ':\\';
        try { fs.accessSync(root); out.push({ path: root, label: String.fromCharCode(i) + ':' }); }
        catch (e) { /* drive letter not present */ }
      }
    } else {
      out.push({ path: '/', label: '/' });
    }
    return send(res, 200, { drives: out });
  }

  if (route === '/list' || route === '/read-dir') {
    const dir = resolveForScope(url.searchParams.get('path'), scope, cfg.folders);
    if (!dir) return send(res, 403, { error: scope === 'local' ? 'Path could not be resolved' : 'Path is not inside a shared folder' });
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch (e) {
      return send(res, 404, { error: 'Not found' });
    }
    if (!stat.isDirectory()) return send(res, 400, { error: 'Not a directory' });
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return send(res, 403, { error: 'Cannot read directory' });
    }
    const items = entries.map(d => {
      const full = path.join(dir, d.name);
      let size = 0, mtime = null;
      try {
        const st = fs.statSync(full);
        size = st.size; mtime = st.mtime.toISOString();
      } catch (e) { /* unreadable child: report it with zeroes rather than failing the listing */ }
      return { name: d.name, path: full, isDir: d.isDirectory(), size, mtime };
    });
    return send(res, 200, { path: dir, items });
  }

  if (route === '/stream') {
    const file = resolveForScope(url.searchParams.get('path'), scope, cfg.folders);
    if (!file) return send(res, 403, { error: scope === 'local' ? 'Path could not be resolved' : 'Path is not inside a shared folder' });
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      return send(res, 404, { error: 'Not found' });
    }
    if (stat.isDirectory()) return send(res, 400, { error: 'Is a directory' });

    // Range support, so video seeking works rather than re-downloading.
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? null : parseInt(m[1], 10);
        let end = m[2] === '' ? null : parseInt(m[2], 10);
        if (start === null && end !== null) { start = Math.max(0, stat.size - end); end = stat.size - 1; }
        if (start !== null && end === null) end = stat.size - 1;
        if (start === null || start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, {
          'Content-Type': contentTypeFor(file),
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          // nosniff so the browser cannot second-guess the type above and
          // execute something NEVER_EXECUTE deliberately downgraded.
          'X-Content-Type-Options': 'nosniff',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      'Content-Type': contentTypeFor(file),
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  return send(res, 404, { error: 'Unknown route' });
}

function startFileServer(configFn, port = DEFAULT_PORT, scope = 'shared') {
  if (scope !== 'shared' && scope !== 'local') {
    return Promise.resolve({ ok: false, error: 'Unknown scope: ' + scope });
  }
  // Guard PER SCOPE. A shared server already running must not make the local one
  // silently no-op and report the wrong port back, which is what the single
  // `if (server)` check did.
  if (servers[scope]) return Promise.resolve({ ok: true, port: ports[scope], already: true });
  getConfig = configFn;
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => handle(req, res, scope, configFn));
    s.on('error', (e) => {
      servers[scope] = null; ports[scope] = null;
      resolve({ ok: false, error: e.message });
    });
    // 127.0.0.1 ONLY. Nothing off-machine can reach this until a transport is
    // deliberately pointed at it, and even then the token gate still applies.
    s.listen(port, '127.0.0.1', () => {
      servers[scope] = s; ports[scope] = port;
      resolve({ ok: true, port, scope });
    });
  });
}

// Defaults to stopping BOTH, preserving the behaviour of the existing no-arg
// caller, which shuts the feature down rather than one socket of it.
function stopFileServer(scope) {
  const targets = scope ? [scope] : ['shared', 'local'];
  let stopped = 0;
  for (const sc of targets) {
    if (!servers[sc]) continue;
    try { servers[sc].close(); } catch (e) { /* already-dead is fine */ }
    servers[sc] = null; ports[sc] = null;
    stopped++;
  }
  return { ok: true, stopped, already: stopped === 0 };
}

// Reports the SHARED server, deliberately and by default. Every existing caller
// feeds this into startFileTunnel, so "status" must mean the tunnellable one -
// making the safe answer the default rather than something a caller has to
// remember to ask for.
function fileServerStatus() {
  return { running: !!servers.shared, port: ports.shared, scope: 'shared' };
}

function localServerStatus() {
  return { running: !!servers.local, port: ports.local, scope: 'local' };
}

module.exports = {
  resolveForWrite, writableRoots, MAX_WRITE_BYTES,
  startFileServer, stopFileServer, fileServerStatus, resolveShared, isInside, DEFAULT_PORT,
  contentTypeFor, resolveLocal, resolveForScope, LOCAL_PORT, localServerStatus,
  mintGrantCode, listGrants, revokeGrant, revokeAllGrants, pendingCodeStatus,
};
