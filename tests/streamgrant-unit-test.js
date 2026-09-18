// Can a stream grant do anything OTHER than read the one file it was minted for?
const assert = require('assert');
const sg = require('/tmp/hb2/electron/streamgrant.js');
let pass = 0, fail = 0;
const chk = (n, ok, x) => { if (ok) { console.log('  PASS  ' + n); pass++; }
                            else { console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); fail++; } };
const F = process.platform === 'win32' ? 'C:\\shared\\a.mp4' : '/shared/a.mp4';
const G = process.platform === 'win32' ? 'C:\\shared\\b.mp4' : '/shared/b.mp4';

console.log('  --- a grant reads exactly one file ---');
sg.revokeAll();
const { token } = sg.mint(F);
chk('redeems for the file it was minted for', sg.redeem(token, F) === true);
chk('REFUSES a different file in the same folder', sg.redeem(token, G) === false);
chk('REFUSES a prefix of the real path', sg.redeem(token, F.slice(0, -1)) === false);
chk('REFUSES the path with a suffix appended', sg.redeem(token, F + 'x') === false);
chk('REFUSES an unknown token', sg.redeem('not-a-real-token', F) === false);
chk('REFUSES an empty token', sg.redeem('', F) === false);
chk('REFUSES a null token', sg.redeem(null, F) === false);
chk('REFUSES an empty path', sg.redeem(token, '') === false);

console.log('\n  --- mint rejects anything not a resolved absolute path ---');
chk('refuses a relative path', (() => { try { sg.mint('shared/a.mp4'); return false; } catch (e) { return /ABSOLUTE/.test(e.message); } })());
chk('refuses empty', (() => { try { sg.mint(''); return false; } catch (e) { return true; } })());
chk('refuses a non-string', (() => { try { sg.mint(42); return false; } catch (e) { return true; } })());

console.log('\n  --- tokens are unguessable and unique ---');
sg.revokeAll();
const toks = new Set();
for (let i = 0; i < 200; i++) toks.add(sg.mint(F).token);
chk('200 mints produce 200 distinct tokens', toks.size === 200, String(toks.size));
const one = [...toks][0];
chk('a token is >= 43 chars (256 bits base64url)', one.length >= 43, String(one.length));
chk('a token is base64url only - safe in a query string', /^[A-Za-z0-9_-]+$/.test(one), one);

console.log('\n  --- the map is bounded, so minting in a loop cannot exhaust memory ---');
chk('never exceeds MAX_GRANTS', sg.stats().total <= sg.MAX_GRANTS, String(sg.stats().total));
chk('MAX_GRANTS is a sane bound', sg.MAX_GRANTS === 256);

console.log('\n  --- the idle window SLIDES on use, which is the whole point ---');
sg.revokeAll();
const t2 = sg.mint(F).token;
const realNow = Date.now;
try {
  // 9 minutes pass, then a use, then another 9. A fixed 10-minute expiry would have
  // died at the second one; a sliding window must not, because that is exactly the
  // long-video case this was built for.
  let clock = realNow();
  Date.now = () => clock;
  clock += 9 * 60 * 1000;
  chk('alive after 9 idle minutes', sg.redeem(t2, F) === true);
  clock += 9 * 60 * 1000;
  chk('STILL alive 9 min after that use (window slid)', sg.redeem(t2, F) === true);
  clock += 11 * 60 * 1000;
  chk('dead after 11 idle minutes', sg.redeem(t2, F) === false);

  console.log('\n  --- but the absolute cap beats continuous use ---');
  sg.revokeAll();
  const t3 = sg.mint(F).token;
  for (let i = 0; i < 100; i++) { clock += 8 * 60 * 1000; sg.redeem(t3, F); }
  chk('continuous use for 13h+ is refused by the absolute cap', sg.redeem(t3, F) === false);
  chk('the cap is 12h', sg.ABSOLUTE_MS === 12 * 60 * 60 * 1000);
} finally { Date.now = realNow; }

console.log('\n  --- revoking actually revokes ---');
sg.revokeAll();
const t4 = sg.mint(F).token;
chk('valid before revoke', sg.redeem(t4, F) === true);
sg.revokeAll();
chk('refused after revokeAll', sg.redeem(t4, F) === false);
chk('stats reports nothing live', sg.stats().live === 0);

console.log('\n  --- stats must not leak tokens or paths ---');
sg.mint(F);
const s = JSON.stringify(sg.stats());
chk('stats contains no token', !/[A-Za-z0-9_-]{43,}/.test(s), s);
chk('stats contains no path', !s.includes('a.mp4'), s);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
