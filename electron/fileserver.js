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

const DEFAULT_PORT = 47615;

let server = null;
let boundPort = null;
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

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function handle(req, res) {
  const cfg = getConfig() || {};
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
  const presented = req.headers['x-harbor-token']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const accepted = [cfg.token, cfg.relaySecret].filter(Boolean);
  // Compare against BOTH unconditionally rather than short-circuiting, so the
  // number of comparisons does not vary with which credential was presented.
  let authed = false;
  for (const candidate of accepted) {
    if (presented && timingSafeEqualStr(presented, candidate)) authed = true;
  }
  if (!authed) return send(res, 401, { error: 'Unauthorized' });

  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (e) {
    return send(res, 400, { error: 'Bad request' });
  }
  const route = url.pathname;

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
    const dir = resolveShared(url.searchParams.get('path'), cfg.folders);
    if (!dir) return send(res, 403, { error: 'Path is not inside a shared folder' });
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
    const file = resolveShared(url.searchParams.get('path'), cfg.folders);
    if (!file) return send(res, 403, { error: 'Path is not inside a shared folder' });
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
          'Content-Type': 'application/octet-stream',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  return send(res, 404, { error: 'Unknown route' });
}

function startFileServer(configFn, port = DEFAULT_PORT) {
  if (server) return Promise.resolve({ ok: true, port: boundPort, already: true });
  getConfig = configFn;
  return new Promise((resolve) => {
    const s = http.createServer(handle);
    s.on('error', (e) => {
      server = null; boundPort = null;
      resolve({ ok: false, error: e.message });
    });
    // 127.0.0.1 ONLY. Nothing off-machine can reach this until a transport is
    // deliberately pointed at it, and even then the token gate still applies.
    s.listen(port, '127.0.0.1', () => {
      server = s; boundPort = port;
      resolve({ ok: true, port });
    });
  });
}

function stopFileServer() {
  if (!server) return { ok: true, already: true };
  try { server.close(); } catch (e) { /* closing an already-dead server is fine */ }
  server = null; boundPort = null;
  return { ok: true };
}

function fileServerStatus() {
  return { running: !!server, port: boundPort };
}

module.exports = {
  startFileServer, stopFileServer, fileServerStatus, resolveShared, isInside, DEFAULT_PORT,
};
