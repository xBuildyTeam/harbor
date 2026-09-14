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

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'Read-only server' });
  }
  if (!cfg.token) return send(res, 503, { error: 'Not paired' });

  // TWO valid credentials, because two different peers call this server and the
  // credentials travel in opposite directions:
  //   device_token  - what Harbor itself holds; Wave OS stores only its HASH, so
  //                   the backend CANNOT present this one.
  //   relay_secret  - what Wave OS's harborRelay presents; Wave OS stores it
  //                   encrypted-at-rest precisely so it CAN present it.
  // Accepting only the device token, as v3.2.0 did, 401s every relayed request.
  // Parsed BEFORE the auth check, because one narrow case below needs the route
  // to decide whether a query-string credential is acceptable.
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (e) {
    return send(res, 400, { error: 'Bad request' });
  }
  const route = url.pathname;

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
  if (!authed) return send(res, 401, { error: 'Unauthorized' });

  if (route === '/health') {
    return send(res, 200, { ok: true, folders: (cfg.folders || []).length });
  }

  // The shared roots themselves, so a client can start browsing without
  // guessing a path.
  if (route === '/roots') {
    return send(res, 200, {
      roots: (cfg.folders || []).map(f => ({
        path: f.path, name: f.name, permissions: f.permissions || 'read-only',
      })),
    });
  }

  // Wave OS's relay advertises a 'drives' endpoint. Refused deliberately, and
  // with an explicit reason rather than a bare 404, so nobody later reads the
  // 404 as "not implemented yet" and helpfully implements it. Enumerating whole
  // disks is exactly the whole-filesystem exposure the shared-folder model
  // exists to replace.
  if (route === '/drives') {
    return send(res, 403, {
      error: 'Whole-disk enumeration is not offered. Use /roots for the folders the user shared.',
      refused_by_design: true,
    });
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
  startFileServer, stopFileServer, fileServerStatus, resolveShared, isInside, DEFAULT_PORT,
  contentTypeFor, resolveLocal, resolveForScope, LOCAL_PORT, localServerStatus,
};
