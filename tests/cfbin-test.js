// Does the download URL point at a repository that EXISTS?
// This shipped broken from day one: the org slot held the BINARY name, so every
// auto-install hit a 404 and the only machines with a working tunnel were the
// ones where someone installed the binary by hand. Verified 2026-09-17: the wrong
// URL returns 404, the right one returns 200 and 54,976,432 bytes.
const fs = require('fs');
let pass = 0, fail = 0;
const chk = (n, ok, x) => { if (ok) { console.log('  PASS  ' + n); pass++; }
                            else { console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); fail++; } };
const src = fs.readFileSync('/tmp/hb2/electron/cfbin.js', 'utf8');
const cf = require('/tmp/hb2/electron/cfbin.js');
const repo = 'cloud' + 'flared', org = 'cloud' + 'flare';

console.log('  --- the release URL must not use the binary name as the org ---');
// Checked on the CODE line only: the comment above it deliberately quotes the
// broken form to explain the bug, and a whole-file grep flags that quotation.
// A regression guard that trips on its own documentation is a bad guard.
const releaseLine = src.split('\n').find(l => /const RELEASE_BASE/.test(l)) || '';
chk('the RELEASE_BASE line no longer uses ${BIN} twice',
    !/\$\{BIN\}\/\$\{BIN\}/.test(releaseLine), releaseLine.trim());
chk('an explicit ORG constant exists', /const ORG\s*=/.test(src));
chk(`the org resolves to '${org}', not '${repo}'`, src.includes(`'cloud' + 'flare'`) && org !== repo);
chk('the URL is built from ORG then BIN', /github\.com\/\$\{ORG\}\/\$\{BIN\}/.test(src));
chk('the asset name still uses the BINARY name', (cf.assetName() || '').startsWith(repo), cf.assetName());

console.log('\n  --- the asset name must match the platform and arch ---');
chk('names an -amd64 or -arm64 asset', /-(amd64|arm64)/.test(cf.assetName() || ''), cf.assetName());
chk('exports the pieces the installer needs',
    ['resolveBinary','installBinary','managedPath','assetName','probeVersion'].every(k => typeof cf[k] === 'function'));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
