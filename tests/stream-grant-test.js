// Can a stream grant be turned into anything wider than "read this one file"?
//
// The grant exists because a <video> element cannot send an Authorization header, so
// header-only auth on the tunnelled scope means remote media cannot stream at all and
// has to be buffered whole through the relay (~1.9 MB/s, no partial content). The
// device token is still refused in a query string there, because it is long-lived and
// authorises the whole share. Every check below is an attempt to widen a grant back
// into something that resembles the credential it deliberately is not.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fsv = require('/tmp/hb2/electron/fileserver.js');
const sg = require('/tmp/hb2/electron/streamgrant.js');

let pass = 0, fail = 0;
const chk = (n, ok, x) => { if (ok) { console.log('  PASS  ' + n); pass++; }
                            else { console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); fail++; } };

const TOKEN = 'dev-token-abc';
const LOCALTOK = 'tok-local-xyz';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-'));
const shared = path.join(root, 'shared');
const secret = path.join(root, 'secret');
fs.mkdirSync(shared); fs.mkdirSync(secret);
const vid = path.join(shared, 'movie.mp4');
const other = path.join(shared, 'other.mp4');
fs.writeFileSync(vid, Buffer.alloc(4096, 7));
fs.writeFileSync(other, Buffer.alloc(2048, 9));
fs.writeFileSync(path.join(secret, 'private.txt'), 'not shared');
const folders = [{ path: shared, label: 'Shared', permissions: 'read-only' }];
const cfg = () => ({ token: TOKEN, relaySecret: null, localToken: LOCALTOK, folders });

const PORT_SHARED = 48355, PORT_LOCAL = 48356;

function req(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const bufs = [];
      res.on('data', d => bufs.push(d));
      res.on('end', () => {
        const body = Buffer.concat(bufs);
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    r.on('error', () => resolve({ status: 0 }));
    r.end();
  });
}

(async () => {
  const s1 = await fsv.startFileServer(cfg, PORT_SHARED, 'shared');
  const s2 = await fsv.startFileServer(cfg, PORT_LOCAL, 'local');
  const AUTH = { Authorization: 'Bearer ' + TOKEN };
  const P = encodeURIComponent(vid);

  console.log('  --- minting requires a REAL credential; a grant cannot mint a grant ---');
  let r = await req(PORT_SHARED, '/sign?path=' + P);
  chk('/sign with no credential is 401', r.status === 401, String(r.status));
  r = await req(PORT_SHARED, '/sign?path=' + P, { headers: AUTH });
  chk('/sign with the device token is 200', r.status === 200, String(r.status));
  const grant = r.json && r.json.grant;
  chk('it returns a grant token', typeof grant === 'string' && grant.length >= 43);
  chk('it returns the byte count', r.json && r.json.bytes === 4096, String(r.json && r.json.bytes));
  chk('it names both expiry windows', r.json && r.json.idle_seconds === 600 && r.json.absolute_seconds === 43200);
  r = await req(PORT_SHARED, '/sign?path=' + P + '&grant=' + grant);
  chk('a GRANT cannot mint another grant (401)', r.status === 401, String(r.status));

  console.log('\n  --- the grant streams the file it was minted for ---');
  r = await req(PORT_SHARED, '/stream?path=' + P);
  chk('/stream with no credential is 401', r.status === 401, String(r.status));
  r = await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + grant);
  chk('/stream WITH the grant is 200', r.status === 200, String(r.status));
  chk('it returns the real bytes', r.body.length === 4096, String(r.body.length));
  chk('Accept-Ranges is advertised', r.headers['accept-ranges'] === 'bytes');

  console.log('\n  --- and RANGE requests work, which is the whole point for video ---');
  r = await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + grant,
                { headers: { Range: 'bytes=100-199' } });
  chk('a ranged request returns 206', r.status === 206, String(r.status));
  chk('it returns exactly 100 bytes', r.body.length === 100, String(r.body.length));
  chk('Content-Range is correct', r.headers['content-range'] === 'bytes 100-199/4096', r.headers['content-range']);

  console.log('\n  --- a grant is ONE FILE. It must not widen. ---');
  r = await req(PORT_SHARED, '/stream?path=' + encodeURIComponent(other) + '&grant=' + grant);
  chk('REFUSES another file in the SAME shared folder', r.status === 401, String(r.status));
  r = await req(PORT_SHARED, '/stream?path=' + encodeURIComponent(path.join(secret, 'private.txt')) + '&grant=' + grant);
  chk('REFUSES a file outside every shared folder', r.status === 401, String(r.status));
  r = await req(PORT_SHARED, '/stream?path=' + encodeURIComponent(path.join(shared, '..', 'secret', 'private.txt')) + '&grant=' + grant);
  chk('REFUSES a traversal out of the shared folder', r.status === 401, String(r.status));

  console.log('\n  --- a grant is READ ONLY and works on ONE ROUTE ---');
  for (const route of ['/list', '/roots', '/drives', '/search?q=a', '/stats']) {
    const sep = route.includes('?') ? '&' : '?';
    const rr = await req(PORT_SHARED, route + sep + 'path=' + P + '&grant=' + grant);
    chk('REFUSES ' + route.split('?')[0], rr.status === 401, String(rr.status));
  }
  for (const m of ['PUT', 'POST']) {
    const rr = await req(PORT_SHARED, '/write?path=' + encodeURIComponent(path.join(shared, 'new.txt')) + '&grant=' + grant, { method: m });
    chk('REFUSES a ' + m + ' to /write', rr.status === 401 || rr.status === 403, String(rr.status));
  }
  for (const m of ['PUT', 'POST', 'DELETE']) {
    const rr = await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + grant, { method: m });
    chk('REFUSES ' + m + ' on /stream itself', rr.status !== 200, String(rr.status));
  }

  console.log('\n  --- the two credential worlds stay disjoint ---');
  r = await req(PORT_LOCAL, '/stream?path=' + P + '&grant=' + grant);
  chk('a shared grant is REFUSED by the local listener', r.status === 401, String(r.status));
  r = await req(PORT_LOCAL, '/sign?path=' + P, { headers: { Authorization: 'Bearer ' + LOCALTOK } });
  chk('/sign is NOT available on the local scope (404)', r.status === 404, String(r.status));
  r = await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + LOCALTOK);
  chk('the LOCAL token is not usable as a grant', r.status === 401, String(r.status));
  r = await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + TOKEN);
  chk('the DEVICE token is not usable as a grant either', r.status === 401, String(r.status));

  console.log('\n  --- garbage and tampering ---');
  for (const bad of ['', 'x', grant.slice(0, -1), grant + 'A', grant.toUpperCase()]) {
    const rr = await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + encodeURIComponent(bad));
    chk('REFUSES a tampered grant (' + (bad ? bad.slice(0, 12) + '…' : 'empty') + ')', rr.status === 401, String(rr.status));
  }

  console.log('\n  --- /sign validates its target like every other route ---');
  r = await req(PORT_SHARED, '/sign?path=' + encodeURIComponent(path.join(secret, 'private.txt')), { headers: AUTH });
  chk('refuses to sign a path outside a shared folder (403)', r.status === 403, String(r.status));
  r = await req(PORT_SHARED, '/sign?path=' + encodeURIComponent(shared), { headers: AUTH });
  chk('refuses to sign a directory (400)', r.status === 400, String(r.status));
  r = await req(PORT_SHARED, '/sign?path=' + encodeURIComponent(path.join(shared, 'nope.mp4')), { headers: AUTH });
  chk('refuses to sign a missing file (404)', r.status === 404, String(r.status));

  console.log('\n  --- revoking access revokes the grants with it ---');
  const fresh = (await req(PORT_SHARED, '/sign?path=' + P, { headers: AUTH })).json.grant;
  chk('the fresh grant works', (await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + fresh)).status === 200);
  sg.revokeAll();
  chk('after revokeAll it is refused', (await req(PORT_SHARED, '/stream?path=' + P + '&grant=' + fresh)).status === 401);

  try { s1.close && s1.close(); } catch (e) {}
  try { s2.close && s2.close(); } catch (e) {}
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
