#!/usr/bin/env node
/**
 * Cross-scope call guard for electron/ipc-handlers.js.
 *
 * WHY THIS EXISTS. v3.5.0 shipped an ipcMain.handle('fs:read-file-bytes') into
 * registerIpcHandlers that called isPathBlocked() - a helper declared inside
 * registerFsHandlers. Different function scope, so every invocation threw
 * "ReferenceError: isPathBlocked is not defined" the moment a user clicked a
 * file. `node --check` PASSES on that, because it is syntactically perfect and
 * only wrong at resolution time.
 *
 * This is the SECOND time this exact class shipped: v3.4.0 did it in dock.js
 * with applyMasks/setMasked/revealLocal, which is why check-renderer-scope.js
 * exists. That guard only reads src/dock.js, so it could not see this one - a
 * guard written for a bug class, then evaded by the same bug class one file
 * over. Hence this second guard, and the rule: when a helper is declared inside
 * a function, only that function may call it.
 *
 * Method: for each top-level `function registerX()`, collect the function
 * declarations nested inside it, then flag any call to one of those names that
 * occurs inside a DIFFERENT top-level function.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'electron', 'ipc-handlers.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

// Pass 1: map every line to its enclosing top-level function, and record which
// nested function declarations belong to which owner.
let depth = 0, owner = '<module>';
const lineOwner = [];
const declOwner = new Map();     // helper name -> owner that declares it
for (const line of lines) {
  if (depth === 0) {
    const m = /^\s*(?:async\s+)?function\s+(\w+)/.exec(line);
    if (m) owner = m.group ? m.group(1) : m[1];
  }
  lineOwner.push(owner);
  if (depth >= 1) {
    const d = /^\s*(?:async\s+)?function\s+(\w+)/.exec(line);
    if (d && !declOwner.has(d[1])) declOwner.set(d[1], owner);
  }
  depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
}

// Pass 2: find calls to those helpers from a different owner.
const violations = [];
lines.forEach((line, idx) => {
  const code = line.replace(/\/\/.*$/, '');
  for (const [name, declaredIn] of declOwner) {
    if (!new RegExp('\\b' + name + '\\s*\\(').test(code)) continue;
    if (/^\s*(?:async\s+)?function\s+/.test(code)) continue;   // the declaration
    const callerOwner = lineOwner[idx];
    if (callerOwner !== declaredIn) {
      violations.push({ line: idx + 1, name, declaredIn, callerOwner, text: line.trim() });
    }
  }
});

if (violations.length) {
  console.error('ipc-scope-guard: CROSS-SCOPE CALL(S) - these throw ReferenceError at runtime,');
  console.error('                 and `node --check` cannot see them.\n');
  for (const v of violations) {
    console.error(`  line ${v.line}: ${v.name}() is declared in ${v.declaredIn}(),`);
    console.error(`            but called from ${v.callerOwner}()`);
    console.error(`            ${v.text}\n`);
  }
  process.exit(1);
}
console.log(`ipc-scope-guard: OK - ${declOwner.size} nested helper(s), no cross-scope calls`);
