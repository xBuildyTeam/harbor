#!/usr/bin/env node
/**
 * Renderer scope guard for src/dock.js.
 *
 * WHY THIS EXISTS: dock.js has THREE regions - a module prologue, the
 * DOMContentLoaded callback, and the separate initPairing IIFE. A helper
 * declared in one callback and called from the other is a ReferenceError that
 * no syntax check catches and no DOM-less test catches. v3.4.0 shipped exactly
 * that, and it hid behind a broad try/catch: the throw was relabelled
 * "Status unavailable" on a correctly-paired device and aborted the refresh
 * chain, so the Remote access row never rendered and the file tunnel could not
 * be turned on at all.
 *
 * DELIBERATELY NARROW. This is a regex guard, not a parser, so it checks only
 * what it can check without false positives:
 *   1. Named helpers that MUST be module scope are declared in the prologue.
 *   2. Function declarations in one callback are not called from the other.
 * Comments and string literals are stripped first - the first version of this
 * guard flagged its own explanatory comment, which is a good reminder that a
 * checker reporting noise gets switched off.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'dock.js');
let src = fs.readFileSync(file, 'utf8');

// --- strip comments and string/template literals, preserving offsets ---
function blank(match) {
  return match.replace(/[^\n]/g, ' ');
}
src = src
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)))
  .replace(/`(?:\\[\s\S]|[^\\`])*`/g, blank)
  .replace(/'(?:\\.|[^\\'])*'/g, blank)
  .replace(/"(?:\\.|[^\\"])*"/g, blank);

const domIdx = src.indexOf("document.addEventListener(");
const pairIdx = src.indexOf("(function initPairing()");
if (domIdx === -1 || pairIdx === -1 || pairIdx < domIdx) {
  console.error('scope-guard: could not locate the three regions of dock.js');
  process.exit(1);
}

const regions = {
  prologue: src.slice(0, domIdx),
  domReady: src.slice(domIdx, pairIdx),
  initPairing: src.slice(pairIdx),
};

const failures = [];

// ---- Check 1: helpers both callbacks need must live in the prologue ----
const MUST_BE_MODULE_SCOPE = ['applyMasks', 'setMasked', 'revealLocal'];
for (const name of MUST_BE_MODULE_SCOPE) {
  const declRe = new RegExp('\\b(?:const|let|var|function|async\\s+function)\\s+' + name + '\\b');
  if (!declRe.test(regions.prologue)) {
    failures.push(`${name} must be declared at module scope (before the DOMContentLoaded listener) - both callbacks use it`);
  }
  for (const r of ['domReady', 'initPairing']) {
    if (declRe.test(regions[r])) {
      failures.push(`${name} is re-declared inside ${r}, which shadows the module-scope copy`);
    }
  }
}

// ---- Check 2: a function declared in one callback, called from the other ----
function declaredFunctions(text) {
  const names = new Set();
  const re = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return names;
}

const pairs = [
  ['domReady', 'initPairing'],
  ['initPairing', 'domReady'],
];
for (const [from, to] of pairs) {
  for (const name of declaredFunctions(regions[from])) {
    if (declaredFunctions(regions[to]).has(name)) continue; // each has its own
    const declRe = new RegExp('\\b(?:const|let|var|function|async\\s+function)\\s+' + name + '\\b');
    if (declRe.test(regions.prologue)) continue; // module scope: fine
    // a CALL, not a mere mention
    const callRe = new RegExp('\\b' + name + '\\s*\\(', 'g');
    let m;
    while ((m = callRe.exec(regions[to]))) {
      const before = regions[to].slice(Math.max(0, m.index - 40), m.index);
      if (/\b(?:function|async\s+function)\s+$/.test(before)) continue; // its declaration
      failures.push(`${name}() is declared in ${from} but called from ${to} - ReferenceError at runtime`);
      break;
    }
  }
}

if (failures.length) {
  console.error('scope-guard: FAILED');
  for (const f of failures) console.error('  - ' + f);
  console.error('\nFix: move the shared helper to module scope, or resolve the DOM node locally.');
  process.exit(1);
}
console.log('scope-guard: OK - module-scope helpers present, no cross-callback function calls');
