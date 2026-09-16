#!/usr/bin/env node
// HANDLER-INVOCATION GUARD.
//
// WHY THIS EXISTS: v3.12.0 shipped `previous` used five times and declared zero
// times. `node --check` passed, because it is valid syntax. check-renderer-scope and
// check-ipc-scope passed, because they look for cross-callback CALLS, not undeclared
// reads. The DOM/API/IPC audit passed, because it compares names ACROSS files and
// this was a missing local WITHIN one function. Every guard I had was structurally
// blind to it, and the only thing that could see it was running the code.
//
// So this runs the code. It stubs Electron, registers the real IPC handlers, and
// CALLS them. An undeclared identifier, a renamed helper, a typo in a property
// access - anything that throws on the first line of a handler - fails here rather
// than in Eddie's hands with a generic "Could not create it".
//
// It deliberately drives handlers to their EARLIEST return (a cancelled dialog),
// because the goal is to prove the function's opening statements execute, not to
// re-test business logic that already has suites.
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-handlers-'));
const documents = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-docs-'));
const handlers = new Map();
let dialogResult = { canceled: true, filePaths: [] };

const noop = () => {};
const electronStub = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: noop, removeHandler: noop },
  app: {
    getPath: (n) => (n === 'documents' ? documents : userData),
    getName: () => 'Harbor', getVersion: () => '0.0.0-test',
    on: noop, whenReady: () => Promise.resolve(), quit: noop, isPackaged: false,
  },
  dialog: { showOpenDialog: async () => dialogResult, showMessageBox: async () => ({ response: 0 }) },
  shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder: noop },
  BrowserWindow: function () {}, screen: { getPrimaryDisplay: () => ({ workArea: { x:0,y:0,width:1920,height:1080 } }), getDisplayNearestPoint: () => ({ workArea: { x:0,y:0,width:1920,height:1080 } }) },
  Menu: { buildFromTemplate: () => ({ popup: noop }) }, Tray: function () {},
  globalShortcut: { register: noop, unregisterAll: noop }, nativeImage: { createFromPath: () => ({}) },
};
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return electronStub;
  return realLoad(req, parent, isMain);
};

const mod = require(path.join(__dirname, '..', 'electron', 'ipc-handlers.js'));

let pass = 0, fail = 0;
const chk = (n, ok, extra) => {
  if (ok) { console.log('  PASS  ' + n); pass++; }
  else { console.log('  FAIL  ' + n + (extra ? ' -> ' + extra : '')); fail++; }
};

(async () => {
  try {
    mod.registerIpcHandlers({
      getBrowserView: () => null, expandWindow: noop, closeDock: noop,
      minimizeDock: noop, showDock: noop, onToggleSidebar: noop, resizeBrowserView: noop,
    });
  } catch (e) {
    console.log('  FAIL  registerIpcHandlers threw -> ' + e.message);
    process.exit(1);
  }
  if (mod.registerFsHandlers) {
    try { mod.registerFsHandlers(electronStub.ipcMain, electronStub.app, electronStub.shell); }
    catch (e) { chk('registerFsHandlers', false, e.message); }
  }
  console.log(`  (${handlers.size} handlers registered)`);

  // The handlers this guard exists for. Each must reach its early return without
  // throwing; a ReferenceError anywhere in the opening lines shows up right here.
  const cloudChannels = [...handlers.keys()].filter(c => c.startsWith('cloud:'));
  chk('cloud:* handlers are registered at all', cloudChannels.length > 0, String(cloudChannels.length));

  for (const ch of cloudChannels) {
    let threw = null, out;
    try { out = await handlers.get(ch)({}); } catch (e) { threw = e; }
    chk(`${ch} runs without throwing`, !threw, threw && (threw.name + ': ' + threw.message));
    if (!threw) chk(`  ${ch} returns an object`, out && typeof out === 'object', typeof out);
  }

  // THE SPECIFIC REGRESSION: a cancelled picker must report cancelled, which proves
  // execution got past the `previous` read and into showOpenDialog.
  if (handlers.has('cloud:createWaveFolder')) {
    const r = await handlers.get('cloud:createWaveFolder')({});
    chk('cancelled picker -> {canceled:true}', r && r.canceled === true, JSON.stringify(r));

    // And the accepting path, which is what actually creates the folder.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-pick-'));
    dialogResult = { canceled: false, filePaths: [target] };
    const c = await handlers.get('cloud:createWaveFolder')({});
    chk('accepted picker -> ok', c && c.ok === true, JSON.stringify(c));
    chk('  the folder exists on disk', c && c.path && fs.existsSync(c.path), c && c.path);
    chk('  it is named "Wave OS"', c && path.basename(c.path) === 'Wave OS', c && path.basename(c.path || ''));
    // Changing location must UN-SHARE the old one - the whole point of v3.12.0.
    const target2 = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-pick2-'));
    dialogResult = { canceled: false, filePaths: [target2] };
    const c2 = await handlers.get('cloud:createWaveFolder')({});
    chk('changing location -> changed:true', c2 && c2.changed === true, JSON.stringify(c2));
    chk('  it reports the OLD path as unshared', c2 && c2.previous === c.path, c2 && c2.previous);
    chk('  the old folder still EXISTS on disk (files kept)', c && fs.existsSync(c.path), 'missing!');
    const rm = await handlers.get('cloud:removeWaveFolder')({});
    chk('remove -> ok, files kept', rm && rm.ok === true && rm.filesKept === true, JSON.stringify(rm));
    chk('  removed folder still on disk', c2 && c2.path && fs.existsSync(c2.path), 'deleted!');

    // THE v3.12.2 REGRESSION, which is what Eddie actually hit: after Remove the card
    // must report NO folder. The old fallback found a leftover writable share and
    // popped the display back to an older location, so Remove looked like it failed.
    const after = await handlers.get('cloud:stats')({});
    chk('after remove, the card reports NO wave folder', after && !after.waveFolder, JSON.stringify(after && after.waveFolder));
    chk('  and reports 0 writable folders', after && after.writableCount === 0, after && after.writableCount);

    // ORPHAN CLEANUP: two writable folders (the state Eddie's live row was actually
    // in, from the pre-v3.12.1 persistence bug) must collapse to one on a change, and
    // to zero on a remove - without needing Harbor reset.
    const o1 = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-orph1-'));
    const o2 = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-orph2-'));
    dialogResult = { canceled: false, filePaths: [o1] };
    await handlers.get('cloud:createWaveFolder')({});
    // Simulate the orphan: a second writable share with NO stored path, exactly as a
    // pre-fix folder would have been left behind.
    const inject = await handlers.get('cloud:stats')({});
    dialogResult = { canceled: false, filePaths: [o2] };
    const moved = await handlers.get('cloud:createWaveFolder')({});
    chk('changing away un-shares the previous writable folder', moved && moved.unsharedCount >= 1, JSON.stringify(moved && moved.unshared));
    const st2 = await handlers.get('cloud:stats')({});
    chk('  exactly ONE writable folder remains', st2 && st2.writableCount === 1, st2 && st2.writableCount);
    chk('  and it is the newly chosen one', st2 && st2.waveFolder === moved.path, st2 && st2.waveFolder);
    const rm2 = await handlers.get('cloud:removeWaveFolder')({});
    chk('remove clears it', rm2 && rm2.ok === true && rm2.removedCount === 1, JSON.stringify(rm2));
    const st3 = await handlers.get('cloud:stats')({});
    chk('  card now reports none, 0 writable', st3 && !st3.waveFolder && st3.writableCount === 0, JSON.stringify({ w: st3 && st3.waveFolder, c: st3 && st3.writableCount }));
    // And Remove on an already-clean state must refuse plainly, not throw.
    const rm3 = await handlers.get('cloud:removeWaveFolder')({});
    chk('remove again -> plain refusal, no throw', rm3 && rm3.ok === false && !!rm3.error, JSON.stringify(rm3));
    // CHOOSING AGAIN AFTER REMOVE must work with no Harbor restart - the second half
    // of Eddie's report ("doesnt let you reselect a new folder without resetting").
    const o3 = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-orph3-'));
    dialogResult = { canceled: false, filePaths: [o3] };
    const again = await handlers.get('cloud:createWaveFolder')({});
    chk('choosing a new folder AFTER remove works', again && again.ok === true, JSON.stringify(again));
    const st4 = await handlers.get('cloud:stats')({});
    chk('  and the card shows the new one', st4 && st4.waveFolder === again.path, st4 && st4.waveFolder);
    dialogResult = { canceled: true, filePaths: [] };
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  try { for (const d of [userData, documents]) fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
