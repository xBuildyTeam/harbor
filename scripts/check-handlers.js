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
    dialogResult = { canceled: true, filePaths: [] };
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  try { for (const d of [userData, documents]) fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
