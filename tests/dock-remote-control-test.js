// Is the control that makes shared folders reachable actually FINDABLE?
//
// Measured on A7, 2026-09-17: the operator installed the update, pressed the
// obvious <button>Start Tunnel</button> on the Local AI card, reported
// "Cloudflare now connects" - and the device kept publishing tunnel_url: null
// while every shared folder returned 502. Remote access, the control that
// actually matters for files, was a <span> reading "Off" whose only affordance
// was a title tooltip, sitting one card away from a real button that does
// something else. Two of three devices never got a file tunnel.
const fs = require('fs');
let pass = 0, fail = 0;
const chk = (n, ok, x) => { if (ok) { console.log('  PASS  ' + n); pass++; }
                            else { console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); fail++; } };
const html = fs.readFileSync('/tmp/hb2/src/dock.html', 'utf8');
const js = fs.readFileSync('/tmp/hb2/src/dock.js', 'utf8');

const row = html.slice(html.indexOf('<div id="remote-row"'), html.indexOf('<div id="fileserver-row"'));

console.log('  --- the remote-access row must offer a real button ---');
chk('the row exists', row.length > 0);
chk('it contains a <button>, not only a clickable span', /<button[^>]*id="btn-toggle-remote"/.test(row), row.replace(/\s+/g,' ').trim());
chk('the button carries the same card-btn class as the AI tunnel button',
    /id="btn-toggle-remote"[^>]*class="card-btn"|class="card-btn"[^>]*id="btn-toggle-remote"/.test(row));
chk('the status span is still present (nothing that read it breaks)',
    /id="remote-status-text"/.test(row));

console.log('\n  --- and it must be wired to the SAME handler, not a copy ---');
chk('dock.js looks the button up', /getElementById\('btn-toggle-remote'\)/.test(js));
chk('the button delegates to the span\'s click', /btnToggleRemote\.addEventListener\('click',\s*\(\)\s*=>\s*remoteText\.click\(\)\)/.test(js));
chk('there is still exactly ONE setRemoteEnabled toggle path',
    (js.match(/api\.setRemoteEnabled\(!cur\.enabled\)/g) || []).length === 1,
    String((js.match(/api\.setRemoteEnabled\(!cur\.enabled\)/g) || []).length));
chk('the install-at-point-of-failure path is untouched',
    /res\.needsInstall && api\.installTunnelBin/.test(js));

console.log('\n  --- the label must come from the same state as the text ---');
chk('the button is labelled inside refreshRemote', /btnToggleRemote\.textContent = st\.enabled \? 'Turn Off' : 'Turn On'/.test(js));
chk('it reads st.enabled, the same field the status text reads',
    js.indexOf("btnToggleRemote.textContent = st.enabled") > js.indexOf('async function refreshRemote'));

console.log('\n  --- the honest off-state message must survive ---');
chk('off-with-shared-folders still warns they are NOT reachable',
    /NOT reachable/.test(js));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
