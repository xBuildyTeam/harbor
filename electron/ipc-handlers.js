const { ipcMain, app, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ollama = require('./ollama');
const tunnel = require('./tunnel');

const streamgrant = require('./streamgrant');
const settingsPath = path.join(app.getPath('userData'), 'wave-dock-settings.json');
const cfbin = require('./cfbin');
const fileindex = require('./fileindex');
// Harbor's managed binary lives beside its settings, so it needs no admin rights
// and cannot be missed by a stale PATH.
cfbin.configure(app.getPath('userData'));

// ONE SOURCE OF TRUTH for persisted keys.
//
// This whitelist has silently dropped a field FIVE separate times
// (sharedFolders, deviceToken, relaySecret, remoteAccessEnabled, and the
// original). The failure mode is nasty: the write returns fine, the value is
// simply gone on the next save, so it presents as "the setting keeps resetting"
// with no error anywhere. Declaring keys in two places is what caused that, so
// now there is one place, and an unknown key COMPLAINS instead of vanishing.
const SETTINGS_SCHEMA = {
  aiMode: (v) => v || 'auto',
  chatCollapsed: (v) => !!v,
  conversations: (v) => (Array.isArray(v) ? v : []),
  agentId: (v) => v || null,
  deviceId: (v) => v || null,
  deviceToken: (v) => v || null,
  pairedAt: (v) => v || null,
  sharedFolders: (v) => (Array.isArray(v) ? v : []),
  relaySecret: (v) => v || null,
  remoteAccessEnabled: (v) => v === true,
  // Privacy: local addresses and the public tunnel hostname are masked in the
  // dock by default so a screen recording does not leak them. Default false
  // means "hidden" - the safe state has to be the one you get by doing nothing.
  revealLocalDetails: (v) => v === true,
  // THE SIXTH SILENT-DROP OF THIS EXACT FAMILY, and the first one a guard caught
  // before Eddie did. Introduced in v3.11.0 and dead ever since: saveSettingsData
  // REFUSES keys absent from this schema, so the Wave OS folder path was never
  // persisted at all.
  //
  // WHY IT WAS INVISIBLE FOR THREE RELEASES: the card falls back to "the first
  // read-write folder" when the stored path is missing, so it displayed the right
  // location the whole time. The DISPLAY worked while the STORAGE silently failed -
  // which meant `previous` was permanently null, so Change-location could never
  // un-share the old folder and Remove always answered "No Wave OS folder is set".
  //
  // The schema guard did its job perfectly and logged a REFUSING line on every
  // save. Nobody reads a console. A warning nothing acts on is not a guard.
  waveFolderPath: (v) => v || null,
};

const SETTINGS_KEYS = Object.keys(SETTINGS_SCHEMA);

// LOCAL-SCOPE CREDENTIAL. Minted fresh every launch, held ONLY in memory, and
// never written to settings, never sent to Wave OS's backend, never published on
// the device row. That is deliberate: this token authorises the WHOLE DISK, so it
// must not be persistable, stealable from a settings file, or reachable by anyone
// who compromises the cloud side. It is handed out over the in-process preload
// bridge alone, which means only a page THIS APP loaded can ever obtain it.
const LOCAL_TOKEN = crypto.randomBytes(32).toString('hex');

function getSettingsData() {
  let raw = {};
  try {
    if (fs.existsSync(settingsPath)) {
      raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
    }
  } catch (e) {
    raw = {};
  }
  const out = {};
  for (const key of SETTINGS_KEYS) out[key] = SETTINGS_SCHEMA[key](raw[key]);
  return out;
}

function saveSettingsData(newSettings) {
  // Sixth time is not the charm. An undeclared key would be dropped on the next
  // read, so say so at the moment it happens rather than weeks later.
  for (const key of Object.keys(arguments[0] || {})) {
    if (!SETTINGS_KEYS.includes(key)) {
      console.error(`[settings] REFUSING unknown key "${key}" - add it to SETTINGS_SCHEMA or it will be silently dropped`);
    }
  }
  try {
    const current = getSettingsData();
    const updated = { ...current, ...newSettings };
    fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  } catch (e) {
    console.error('Failed to save settings:', e);
    throw e;
  }
}

function pruneConversations(conversations) {
  if (conversations.length > 100) {
    const archived = conversations.filter(c => c.archived);
    const active = conversations.filter(c => !c.archived);
    
    archived.sort((a, b) => new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0));
    
    while (active.length + archived.length > 100 && archived.length > 0) {
      archived.shift();
    }
    
    while (active.length + archived.length > 100 && active.length > 0) {
      active.sort((a, b) => new Date(a.updatedAt || a.createdAt || 0) - new Date(b.updatedAt || b.createdAt || 0));
      active.shift();
    }
    
    return [...active, ...archived];
  }
  return conversations;
}

/**
 * Registers all IPC handlers to bridge renderer calls to main process APIs
 */
function registerIpcHandlers({
  getBrowserView,
  expandWindow,
  closeDock,
  minimizeDock,
  showDock,
  onToggleSidebar,
  resizeBrowserView
}) {
  // --- Pairing Handlers (Harbor's half of the device-code handshake) ---
  const pairing = require('./pairing');
  const fileserver = require('./fileserver');
  const filetunnel = require('./filetunnel');

  function ensureAgentId() {
    const st = getSettingsData();
    if (st.agentId) return st.agentId;
    const id = crypto.randomUUID();
    saveSettingsData({ agentId: id });
    return id;
  }

  ipcMain.handle('pairing:getStatus', async () => {
    const st = getSettingsData();
    return {
      paired: !!st.deviceToken,
      deviceId: st.deviceId,
      pairedAt: st.pairedAt,
      deviceName: pairing.localDeviceName(),
      platform: pairing.localPlatform(),
    };
  });

  ipcMain.handle('pairing:start', async () => {
    const code = pairing.generateCode();
    const res = await pairing.callHarborPair('register-code', {
      code,
      agent_id: ensureAgentId(),
      device_name: pairing.localDeviceName(),
      platform: pairing.localPlatform(),
    });
    if (!res.ok) return { ok: false, error: res.error };
    // The countdown is driven by the SERVER's expires_at, never a local timer -
    // a locally invented countdown is a number the UI cannot actually know.
    return { ok: true, code, expiresAt: res.data.expires_at };
  });

  ipcMain.handle('pairing:poll', async (event, code) => {
    const st = getSettingsData();
    if (!st.agentId) return { ok: false, error: 'No agent id' };
    const res = await pairing.callHarborPair('poll-code', { code, agent_id: st.agentId });
    if (!res.ok) return { ok: false, error: res.error };
    const status = res.data.status;
    if (status === 'claimed' && res.data.device_token) {
      saveSettingsData({
        deviceId: res.data.device_id,
        deviceToken: res.data.device_token,
        // Wave OS's relay presents THIS, not the device token. The device token
        // proves Harbor to Wave OS; the relay secret proves Wave OS to Harbor.
        // Opposite directions, so they cannot be the same value.
        relaySecret: res.data.relay_secret || null,
        pairedAt: new Date().toISOString(),
      });
      startHeartbeat();
      return { ok: true, status: 'claimed', deviceId: res.data.device_id };
    }
    return { ok: true, status: status || 'pending' };
  });

  ipcMain.handle('pairing:unpair', async () => {
    // Clears the local credential only. The HarborDevice row stays in Wave OS -
    // removing it is the owner's call from the device list, not the agent's.
    await sendHeartbeat(false); // tell Wave OS before the token is discarded
    stopHeartbeat();
    saveSettingsData({ deviceId: null, deviceToken: null, relaySecret: null, pairedAt: null });
    return { ok: true };
  });

  // --- Heartbeat ---------------------------------------------------------
  // Wave OS reads a STORED is_online boolean, so a paired PC reads "offline"
  // until the agent asserts otherwise on a timer. 30s cadence.
  // Known weakness of the stored model: a crash or kill leaves the row reading
  // online forever, because the final offline sync below is best-effort. The
  // durable fix is for Wave OS to DERIVE online from last_seen; until it does,
  // this is the honest best a client can manage.
  let heartbeatTimer = null;

  async function sendHeartbeat(online) {
    const st = getSettingsData();
    if (!st.deviceToken) return { ok: false, error: 'Not paired' };
    // MEASURED 2026-09-11: Wave OS's shared_folders schema uses `label`, not
    // `name`. Sending `name` was accepted with ok:true and stored as
    // label: null - a silent drop, so folders arrived unnamed. Send both:
    // `label` for Wave OS, `name` kept for Harbor's own UI.
    const folders = (Array.isArray(st.sharedFolders) ? st.sharedFolders : []).map(f => ({
      path: f.path,
      label: f.label || f.name || f.path,
      name: f.name || f.label || f.path,
      permissions: f.permissions || 'read-only',
    }));
    return await pairing.callHarborDeviceSync({
      device_token: st.deviceToken,
      is_online: online !== false,
      shared_folders: folders,
      // null when remote access is off, which is the honest value - the relay
      // then reports the device unreachable instead of dialling a dead host.
      tunnel_url: filetunnel.getUrl() || null,
      // is_sharing is what Wave OS's Harbor tab gates its folder view on, and
      // NOTHING has ever set it - it has been false on every row since the row
      // was minted. So a device could be paired, online, tunnelled, with a
      // populated shared_folders array, and still render "Not sharing - Start
      // sharing from Harbor Agent on your PC". Measured on xBuildy 2026-09-14
      // with tunnel_url live and connection_mode 'relay' and is_sharing false.
      //
      // Semantics deliberately narrow: this means "folders are shared", matching
      // the field name and Wave OS's own copy. Reachability is a SEPARATE axis
      // already carried by tunnel_url and connection_mode, which is what the
      // Online/Offline badge reads. Conflating them would make one flag answer
      // two questions.
      is_sharing: folders.length > 0,
      // connection_mode has sat at 'pending' on every row since pairing shipped
      // because nothing ever set it, and it may be what Wave OS's Harbor tab
      // reads for its offline banner. VERIFIED 2026-09-14: the row read back as
      // connection_mode 'relay', and Wave OS's badge flipped Offline -> Online.
      connection_mode: filetunnel.getUrl() ? 'relay' : 'pending',
    });
  }

  // The file server reads its token and roots live from settings on every
  // request, so adding or removing a shared folder takes effect immediately
  // with no restart - and revoking the pairing kills access on the next call.
  function fileServerConfig() {
    const st = getSettingsData();
    return {
      token: st.deviceToken,
      relaySecret: st.relaySecret || null,
      folders: Array.isArray(st.sharedFolders) ? st.sharedFolders : [],
    };
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    // TWO LISTENERS. The local one is started here and is NEVER handed to
  // startFileTunnel below - that call receives only the SHARED server's port.
  // That wiring fact is the entire boundary between "files I share" and "my whole
  // disk", so it is stated rather than left to be inferred.
  fileserver.startFileServer(fileServerConfig, fileserver.LOCAL_PORT, 'local').then((lr) => {
    if (!lr.ok) console.error('[harbor] LOCAL file server failed to bind:', lr.error);
    else console.log('[harbor] local-scope file server on 127.0.0.1:' + lr.port + ' (never tunnelled)');
  });

  fileserver.startFileServer(fileServerConfig).then(async (r) => {
      if (!r.ok) {
        console.error('[harbor] file server failed to bind:', r.error);
        return;
      }
      // THE FIX. startFileTunnel was previously called from exactly ONE place -
      // the toggle - so remoteAccessEnabled persisted as true across a restart
      // while nothing ever restarted the tunnel. The file server auto-started
      // and the heartbeat auto-started; the tunnel did not. Result: a paired,
      // online, heartbeating device that published tunnel_url: null forever, so
      // the relay had no address and Wave OS showed the PC offline with no
      // folders. Measured on xBuildy 2026-09-14.
      const st = getSettingsData();
      if (st.remoteAccessEnabled !== true) return;
      const res = await filetunnel.startFileTunnel(r.port);
      if (res && res.ok) {
        console.log('[harbor] remote access resumed at launch');
      } else {
        console.error('[harbor] remote access could not resume:', res && res.error);
      }
      // Armed either way: a tunnel that failed at boot because the network was
      // not up yet is the normal case on a cold start, not a permanent failure.
      filetunnel.armWatchdog(r.port, () => sendHeartbeat(true));
      filetunnel.startVerifyMonitor(() => sendHeartbeat(true));
      await sendHeartbeat(true);
    });
    sendHeartbeat(true);
    heartbeatTimer = setInterval(() => sendHeartbeat(true), 30000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    fileserver.stopFileServer();
    filetunnel.stopFileTunnel();
    streamgrant.revokeAll();
  }

  if (getSettingsData().deviceToken) startHeartbeat();

  app.on('before-quit', () => {
    stopHeartbeat();
    sendHeartbeat(false); // best-effort; see the note above
  });

  ipcMain.handle('tunnelbin:status', async () => {
    const bin = await cfbin.resolveBinary();
    return {
      found: bin.found,
      source: bin.source,
      version: bin.version,
      unusable: !!bin.unusable,
      path: bin.path,
      installable: !!cfbin.assetName(),
    };
  });

  ipcMain.handle('tunnelbin:install', async () => {
    const before = await cfbin.resolveBinary();
    if (before.found) return { ok: true, already: true, version: before.version };
    return await cfbin.installBinary();
  });

  ipcMain.handle('privacy:get', async () => {
    return { reveal: getSettingsData().revealLocalDetails === true };
  });

  ipcMain.handle('privacy:set', async (event, reveal) => {
    saveSettingsData({ revealLocalDetails: reveal === true });
    return { ok: true, reveal: reveal === true };
  });

  ipcMain.handle('remote:status', async () => {
    const st = getSettingsData();
    return {
      enabled: st.remoteAccessEnabled === true,
      url: filetunnel.getUrl(),
      running: filetunnel.isRunning(),
      // Reported separately so the dock can never again invent "starting" for
      // something that is not starting.
      starting: filetunnel.isStarting(),
      gaveUp: filetunnel.gaveUp(),
      paired: !!st.deviceToken,
    };
  });

  ipcMain.handle('remote:setEnabled', async (event, enabled) => {
    const want = enabled === true;
    saveSettingsData({ remoteAccessEnabled: want });
    if (!want) {
      filetunnel.disarmWatchdog();
      filetunnel.stopFileTunnel();
      // Turning remote access off must REVOKE outstanding stream grants, not merely
      // stop issuing new ones. A grant lives on its own idle window, so without this
      // the off switch would leave live read capabilities for up to ten minutes after
      // the owner explicitly withdrew access - and "off" has to mean off.
      const revokedGrants = streamgrant.revokeAll();
      if (revokedGrants) console.log('[harbor] revoked ' + revokedGrants + ' stream grant(s) on remote-access off');
      await sendHeartbeat(true); // republish immediately with tunnel_url: null
      return { ok: true, enabled: false, url: null };
    }
    const srv = fileserver.fileServerStatus();
    if (!srv.running) return { ok: false, error: 'File server is not running - pair the device first' };
    const res = await filetunnel.startFileTunnel(srv.port);
    if (!res.ok) {
      saveSettingsData({ remoteAccessEnabled: false });
      return { ok: false, error: res.error, needsInstall: !!res.needsInstall };
    }
    filetunnel.armWatchdog(srv.port, () => sendHeartbeat(true));
    filetunnel.startVerifyMonitor(() => sendHeartbeat(true));
    await sendHeartbeat(true); // publish the new hostname without waiting 30s
    return { ok: true, enabled: true, url: res.url };
  });

  // ONE PLACE THAT REBUILDS, so "the index is stale" can never mean "one of the
  // three callers forgot". Deferred by 1500ms at launch: the walk is chunked and
  // yields, but there is no reason to compete with window creation either.
  function reindex() {
    const cfg = fileServerConfig();
    return fileindex.build(cfg.folders, app.getPath('userData'));
  }

  // Load whatever the last run persisted so search works IMMEDIATELY at launch,
  // then rebuild in the background to pick up anything changed while Harbor was
  // closed. A stale index that answers beats a correct one that is not ready.
  try { fileindex.load(app.getPath('userData')); } catch (e) { /* first run */ }
  setTimeout(() => { reindex().catch((e) => console.error('[harbor] index build failed:', e && e.message)); }, 1500);

  ipcMain.handle('cloud:stats', async () => {
    const st = fileindex.getStats();
    const cfg = fileServerConfig();
    const srv = fileserver.fileServerStatus();
    const tunnel = filetunnel.getUrl();
    return {
      paired: !!cfg.token,
      folderCount: (cfg.folders || []).length,
      fileCount: st.fileCount,
      totalBytes: st.totalBytes,
      built: st.built,
      building: st.building,
      builtAt: st.builtAt,
      truncated: st.truncated,
      // "Reachable from anywhere" is the tunnel being up, NOT remote access being
      // switched on - those differ for the whole window while a tunnel starts, and
      // conflating them is what made the dock claim readiness it did not have.
      reachable: !!tunnel,
      serverRunning: !!srv.running,
      // Reported as a COUNT and a PATH, not a boolean, so the card can say which
      // folder is writable rather than just that one is.
      writableCount: (cfg.folders || []).filter(f => f && f.permissions === 'read-write').length,
      // THE STORED PATH, AND NOTHING ELSE. There used to be a fallback here - "if no
      // path is stored, show the first read-write folder" - added in v3.11.1 to make
      // the card display something while waveFolderPath was being silently dropped by
      // the settings schema.
      //
      // THAT COMPENSATING HACK OUTLIVED THE BUG IT COMPENSATED FOR AND BECAME THE BUG.
      // Once v3.12.1 made persistence work, the fallback was not merely redundant: it
      // RESURRECTED REMOVED FOLDERS. Remove cleared the stored path, the fallback then
      // found a leftover read-write folder, and the card popped straight back to an
      // older location - exactly what Eddie saw ("once you click remove it reverts to
      // the old folder"). A workaround for a storage bug, still running after the
      // storage was fixed, reporting state that no longer existed.
      waveFolder: (() => {
        const stored = (getSettingsData() || {}).waveFolderPath;
        return (stored && (cfg.folders || []).some(f => f && f.path === stored)) ? stored : null;
      })(),
      // Surfaced so orphans can never again be invisible: if this exceeds 1 there are
      // leftover writable grants that no card was showing.
      writableCount: (cfg.folders || []).filter(f => f && f.permissions === 'read-write').length,
    };
  });

  ipcMain.handle('cloud:reindex', async () => await reindex());

  // THE WAVE OS FOLDER. Eddie's design, and it is better than a per-folder
  // read-write toggle as the primary path: one obvious place that Wave OS may
  // write, created deliberately, instead of making a folder full of existing work
  // like Dev Projects writable by a remote app. The blast radius of a write bug is
  // then a folder that exists for exactly this purpose.
  //
  // Documents/, not Desktop/ or a new root: it is where an OS already puts
  // documents and spreadsheets, so it is where a user looks for them outside
  // Wave OS.
  // THE WAVE OS FOLDER. Eddie's design, and better than a per-folder read-write
  // toggle as the primary path: one obvious place that Wave OS may write, created
  // deliberately, instead of making a folder full of existing work like Dev Projects
  // writable by a remote app.
  //
  // v3.11.1 ASKS INSTEAD OF DECIDING. v3.11.0 silently created it in Documents and
  // told the user nothing - the path existed only in a tooltip. A folder appearing
  // somewhere you did not choose, made writable from the internet, is precisely the
  // thing that should never be a surprise, and "it defaulted somewhere sensible" is
  // not consent. The picker opens ON Documents, so the old behaviour is still one
  // click away, but it is now the user's click.
  ipcMain.handle('cloud:createWaveFolder', async () => {
    // DECLARED, at last. v3.12.0 used `previous` five times and declared it zero
    // times: the two lines that defined it were supposed to be inserted by a
    // find-and-replace whose anchor no longer matched, and str.replace SILENTLY
    // NO-OPS on a miss while my patch script printed success anyway. So the *uses*
    // landed and the *declaration* did not, and every click threw
    // "ReferenceError: previous is not defined" before the picker could open.
    //
    // The comment fifteen lines below this one warns, in these words, that a bare
    // undeclared identifier throws even inside a ternary test. I then shipped
    // exactly that, in a ternary, directly underneath it. Knowing the failure mode
    // is not the same as having a check for it - hence the new handler-invocation
    // suite, which calls this function for real instead of trusting that it parses.
    const stPre = getSettingsData() || {};
    const previous = stPre.waveFolderPath || null;
    const documents = app.getPath('documents');
    // No parent window, matching the existing settings:pickFolder call below.
    // getDockWindow does not exist in this module - and note that `getDockWindow ? …`
    // would NOT have been a safe guard either: a bare undeclared identifier throws
    // ReferenceError even inside a ternary test. Only `typeof x !== 'undefined'` is
    // safe, and the honest fix is simply not to reference it. This is the third time
    // this file has nearly shipped a cross-scope ReferenceError that node --check
    // cannot see (v3.5.2 was the first).
    const picked = await dialog.showOpenDialog({
      // THE EXPLANATION LIVES IN THE TITLE, not in `message`. showOpenDialog's
      // `message` option is macOS-ONLY - on Windows it is silently ignored, so
      // v3.11.1 "said it in the dialog" and Eddie was never shown a word of it.
      // Exactly the failure this whole thread is about: information that exists
      // in the code and never reaches the person.
      title: previous
        ? 'Pick a new location for your Wave OS folder — existing files stay where they are'
        : 'Pick where Wave OS should keep your files — a "Wave OS" folder is created here',
      // Opens on the CURRENT folder when changing, so it is obvious where it is now.
      defaultPath: previous || documents,
      buttonLabel: 'Use this location',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const parent = picked.filePaths[0];

    if (isRefusedWaveParent(parent)) {
      return { ok: false, error: 'Pick a normal folder — not a drive root or a Windows system folder.' };
    }

    // Do not nest a Wave OS inside a Wave OS if they navigated into an existing one.
    const target = path.basename(parent).toLowerCase() === 'wave os'
      ? parent
      : path.join(parent, 'Wave OS');

    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'Could not create the folder' };
    }

    const st = getSettingsData();
    const folders = Array.isArray(st.sharedFolders) ? st.sharedFolders.slice() : [];
    const existing = folders.find(f => f && f.path === target);
    if (existing) {
      // Idempotent, and it REPAIRS rather than duplicating: if this folder was
      // shared read-only by hand earlier, this promotes it instead of adding a
      // second entry pointing at the same path.
      existing.permissions = 'read-write';
      existing.label = existing.label || 'Wave OS';
      existing.name = existing.name || 'Wave OS';
    } else {
      folders.push({ path: target, name: 'Wave OS', label: 'Wave OS', permissions: 'read-write' });
    }
    // UN-SHARE THE OLD ONE. Without this, changing location left the previous
    // folder shared and writable forever with no way to reach it in the UI - which
    // is the dead end Eddie hit: a Wave OS folder stuck in OneDrive that nothing
    // could disconnect.
    //
    // FILES ARE NOT MOVED, deliberately. Moving someone's documents as a side
    // effect of changing a setting is how data gets lost, and a half-finished move
    // is worse than none. The dialog title says so before they choose.
    // UN-SHARE EVERY OTHER WRITABLE FOLDER, not just the one `previous` names.
    //
    // WHY THE NARROWER VERSION WAS WRONG, proved by Eddie's live row: it had TWO
    // read-write folders, OneDrive\Documents\Wave OS and C:\Wave Cloud\Wave OS. The
    // first was created before v3.12.1, when waveFolderPath was still being dropped,
    // so at change-time `previous` was null and there was nothing to un-share. Fixing
    // the schema fixed persistence GOING FORWARD and left the pre-fix folder orphaned
    // - a migration gap I should have seen coming.
    //
    // Treating "the set of writable folders" as the thing being replaced makes this
    // SELF-HEALING: orphans from any earlier version get cleaned on the next change,
    // and waveFolderPath becomes a display convenience rather than something
    // correctness depends on. read-write has only ever come from this feature, so
    // there is nothing else here to clobber.
    const unshared = [];
    for (let i = folders.length - 1; i >= 0; i--) {
      const f = folders[i];
      if (f && f.permissions === 'read-write' && f.path !== target) {
        unshared.push(f.path);
        folders.splice(i, 1);
      }
    }

    // Remember it so the card can name THIS folder rather than assuming Documents.
    saveSettingsData({ sharedFolders: folders, waveFolderPath: target });
    reindex().catch((e) => console.error('[harbor] reindex after createWaveFolder failed:', e && e.message));
    // Awaited: the whole point of this button is that Wave OS can save here, and it
    // cannot until the row carries the read-write permission. Verified 2026-09-15
    // that shared_folders.permissions accepts 'read-write' and round-trips - the
    // same read-back check that caught `label` being silently dropped in v3.3.0.
    const sync = await sendHeartbeat(true);
    return {
      ok: true, path: target,
      previous: unshared[0] || null, unshared, unsharedCount: unshared.length,
      changed: unshared.length > 0,
      synced: !!(sync && sync.ok),
    };
  });

  // STOP SAVING TO THE PC WITHOUT DELETING ANYTHING. The folder and every file in
  // it stay exactly where they are; only the grant is withdrawn. Revoking access
  // must never be able to destroy data - otherwise nobody dares click it.
  ipcMain.handle('cloud:removeWaveFolder', async () => {
    const st = getSettingsData();
    const all = Array.isArray(st.sharedFolders) ? st.sharedFolders : [];
    // EVERY writable grant, not only the stored one. "Stop saving to this PC" has to
    // mean it, and removing one of two left the card showing the other - which read
    // as Remove silently failing. Also the only way to clear orphans left behind by
    // the v3.11.0-v3.12.0 persistence bug without asking Eddie to reset Harbor.
    const removed = all.filter(f => f && f.permissions === 'read-write').map(f => f.path);
    if (!removed.length) return { ok: false, error: 'Nothing is writable, so there is nothing to remove' };
    const folders = all.filter(f => !(f && f.permissions === 'read-write'));
    saveSettingsData({ sharedFolders: folders, waveFolderPath: null });
    reindex().catch((e) => console.error('[harbor] reindex after removeWaveFolder failed:', e && e.message));
    const sync = await sendHeartbeat(true);
    return { ok: true, path: removed[0], removed, removedCount: removed.length, filesKept: true, synced: !!(sync && sync.ok) };
  });

  // So "where is it?" is answerable by clicking, not by reading a tooltip.
  ipcMain.handle('cloud:openWaveFolder', async () => {
    const st = getSettingsData();
    const target = st.waveFolderPath
      || (Array.isArray(st.sharedFolders) ? (st.sharedFolders.find(f => f && f.permissions === 'read-write') || {}).path : null);
    if (!target) return { ok: false, error: 'No Wave OS folder yet' };
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true, path: target };
  });

  // Promote or demote any shared folder. Demotion is instant and needs no
  // confirmation; it only ever removes permission.
  ipcMain.handle('cloud:setFolderPermission', async (event, folderPath, permission) => {
    const perm = permission === 'read-write' ? 'read-write' : 'read-only';
    const st = getSettingsData();
    const folders = Array.isArray(st.sharedFolders) ? st.sharedFolders.slice() : [];
    const hit = folders.find(f => f && f.path === folderPath);
    if (!hit) return { ok: false, error: 'That folder is not shared' };
    hit.permissions = perm;
    saveSettingsData({ sharedFolders: folders });
    const sync = await sendHeartbeat(true);
    return { ok: true, path: folderPath, permissions: perm, synced: !!(sync && sync.ok) };
  });

  ipcMain.handle('fileserver:status', async () => {
    const st = fileserver.fileServerStatus();
    const cfg = fileServerConfig();
    return { ...st, folderCount: (cfg.folders || []).length, paired: !!cfg.token };
  });

  ipcMain.handle('pairing:heartbeatNow', async () => await sendHeartbeat(true));

  ipcMain.handle('pairing:listFolders', async () => {
    const st = getSettingsData();
    return Array.isArray(st.sharedFolders) ? st.sharedFolders : [];
  });

  // Adding a folder changes what is indexable, so the index follows immediately.
  // Not awaited: the picker returning promptly matters more than the walk, and the
  // card renders an honest "Indexing..." from getStats().building meanwhile.
  ipcMain.handle('pairing:addFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Share a folder with Wave OS',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const st = getSettingsData();
    const folders = Array.isArray(st.sharedFolders) ? st.sharedFolders.slice() : [];
    for (const dir of result.filePaths) {
      if (folders.some(f => f.path === dir)) continue;
      // read-only, matching the per-folder permission model already present on
      // Wave OS's device rows. Harbor must never widen this to whole-disk.
      folders.push({ path: dir, name: path.basename(dir) || dir, permissions: 'read-only' });
    }
    saveSettingsData({ sharedFolders: folders });
    // NOT awaited. The picker returning promptly matters more than the walk, and
    // the Cloud card renders an honest "Indexing..." from getStats().building in
    // the meantime. Awaiting here would freeze the dialog on a large folder.
    reindex().catch((e) => console.error('[harbor] reindex after addFolder failed:', e && e.message));
    const sync = await sendHeartbeat(true);
    return { ok: true, folders, synced: !!(sync && sync.ok) };
  });

  ipcMain.handle('pairing:removeFolder', async (event, dirPath) => {
    const st = getSettingsData();
    const folders = (Array.isArray(st.sharedFolders) ? st.sharedFolders : [])
      .filter(f => f.path !== dirPath);
    saveSettingsData({ sharedFolders: folders });
    await sendHeartbeat(true);
    return { ok: true, folders };
  });

  // Endpoint for the LOCAL scope. Returns the loopback URL plus the in-memory
  // token so the page can issue real HTTP range requests against any local file -
  // which is what a media player needs and what the old file:// fallback could
  // never provide. Only reachable over the preload bridge.
  // BROWSER CONSENT IPC REMOVED IN v3.13.0. Four handlers - mint, list, revoke,
  // revokeAll - are gone with the feature. Local files inside Harbor come from
  // local:endpoint below, which has never had anything to do with grants.

  ipcMain.handle('local:endpoint', async () => {
    const srv = fileserver.fileServerStatus();
    return {
      url: 'http://127.0.0.1:' + fileserver.LOCAL_PORT,
      token: LOCAL_TOKEN,
      scope: 'local',
      sharedRunning: !!(srv && srv.running),
    };
  });


  // --- Settings & Conversation Handlers ---
  ipcMain.handle('settings:get', async () => {
    return getSettingsData();
  });

  ipcMain.handle('settings:set', async (event, newSettings) => {
    return saveSettingsData(newSettings);
  });

  ipcMain.handle('settings:getConversations', async () => {
    const settings = getSettingsData();
    return settings.conversations || [];
  });

  ipcMain.handle('settings:saveConversation', async (event, conv) => {
    const settings = getSettingsData();
    let conversations = settings.conversations || [];
    const index = conversations.findIndex(c => c.id === conv.id);
    const now = new Date().toISOString();

    if (index >= 0) {
      conversations[index] = {
        ...conversations[index],
        ...conv,
        updatedAt: conv.updatedAt || now
      };
    } else {
      const newConv = {
        id: conv.id || 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        title: conv.title || 'New Conversation',
        messages: conv.messages || [],
        createdAt: conv.createdAt || now,
        updatedAt: conv.updatedAt || now,
        archived: !!conv.archived
      };
      conversations.unshift(newConv);
    }
    conversations = pruneConversations(conversations);
    saveSettingsData({ conversations });
    return conversations;
  });

  ipcMain.handle('settings:archiveConversation', async (event, id) => {
    const settings = getSettingsData();
    let conversations = settings.conversations || [];
    const conv = conversations.find(c => c.id === id);
    if (conv) {
      conv.archived = true;
      conv.updatedAt = new Date().toISOString();
      conversations = pruneConversations(conversations);
      saveSettingsData({ conversations });
    }
    return conversations;
  });

  // --- Chat Sidebar Toggle Handler ---
  ipcMain.on('chat:toggleSidebar', (event, collapsed) => {
    saveSettingsData({ chatCollapsed: !!collapsed });
    if (onToggleSidebar) {
      onToggleSidebar(!!collapsed);
    }
  });

  // --- Webview Resize Handler (for collapsible sidebar) ---
  ipcMain.handle('webview:resize', async (event, collapsed) => {
    if (resizeBrowserView) {
      resizeBrowserView(collapsed);
    }
    return { resized: true };
  });

  // --- Ollama Handlers ---
  // Every runtime found, for a UI that wants to say "LM Studio and Ollama are both
  // up" rather than silently choosing.
  ipcMain.handle('localai:detect', async () => await ollama.detectLocalAi({ force: true }));

  ipcMain.handle('ollama:check', async () => {
    return await ollama.checkOllama();
  });

  ipcMain.handle('ollama:start', async () => {
    // The cache must not outlive the thing it describes.
    ollama.invalidateLocalAi();
    const r = await ollama.startOllama();
    ollama.invalidateLocalAi();
    return r;
  });

  ipcMain.handle('ollama:stop', async () => {
    const r = await ollama.stopOllama();
    ollama.invalidateLocalAi();
    return r;
  });


  ipcMain.handle('ollama:pullModel', async (event, name) => {
    return await ollama.pullModel(name);
  });

  ipcMain.handle('ollama:chat', async (event, model, messages, options = {}) => {
    const settings = getSettingsData();
    const aiMode = options.aiMode || settings.aiMode || 'auto';
    const chatOptions = { ...options, aiMode };
    return await ollama.chat(model, messages, chatOptions);
  });

  // --- Local LLM Detection Handler (for Wave OS Settings → AI Models) ---
  // Exposes tunnel URL and Ollama status so Wave OS can auto-detect local LLM
  ipcMain.handle('localllm:getInfo', async () => {
    const ollamaStatus = await ollama.checkOllama();
    const tunnelUrl = tunnel.getTunnelUrl();
    return {
      ollama: {
        running: ollamaStatus.running,
        models: ollamaStatus.models || [],
        // FIFTH COPY OF THE SAME FACT, now derived. Wave OS reads this to build
        // LOCAL_LLM_URL, so a literal here would have sent storyPipeline to the
        // wrong port for anyone not running Ollama.
        endpoint: ollamaStatus.baseUrl || 'http://localhost:11434',
        provider: ollamaStatus.provider || null,
        canManage: ollamaStatus.canManage !== false
      },
      tunnel: {
        active: !!tunnelUrl,
        url: tunnelUrl || null,
        // The Wave OS-compatible endpoint (OpenAI-compatible)
        llmEndpoint: tunnelUrl ? `${tunnelUrl}/v1` : null
      },
    };
  });

  // --- Tunnel Handlers ---
  ipcMain.handle('tunnel:start', async () => {
    return await tunnel.startTunnel();
  });

  ipcMain.handle('tunnel:stop', async () => {
    return await tunnel.stopTunnel();
  });

  ipcMain.handle('tunnel:getUrl', async () => {
    return tunnel.getTunnelUrl();
  });

  // --- BrowserView Navigation Handlers (app.oswave.io) ---
  ipcMain.on('nav:goBack', () => {
    const bv = getBrowserView();
    if (bv && bv.webContents.canGoBack()) {
      bv.webContents.goBack();
    }
  });

  ipcMain.on('nav:goForward', () => {
    const bv = getBrowserView();
    if (bv && bv.webContents.canGoForward()) {
      bv.webContents.goForward();
    }
  });

  ipcMain.on('nav:reload', () => {
    const bv = getBrowserView();
    if (bv) {
      bv.webContents.reload();
    }
  });

  // --- Window Operations Handlers ---
  ipcMain.on('window:expand', () => {
    expandWindow();
  });

  ipcMain.on('window:closeDock', () => {
    closeDock();
  });

  // Bring Harbor forward from the Wave OS browser window. `send`, not `invoke`,
  // matching the sibling window controls - there is nothing to return.
  ipcMain.on('window:showDock', () => {
    if (typeof showDock === 'function') showDock();
  });

  ipcMain.on('window:minimizeDock', () => {
    minimizeDock();
  });
}

module.exports = {
  registerIpcHandlers
};

// ============================================================
// FILESYSTEM BRIDGE HANDLERS (v3 — waveDockFS)
// ============================================================
// REFUSED PARENTS for the Wave OS folder. Extracted and exported so it can be
// tested rather than trusted: the folder created below becomes writable over the
// network, so this is a security-relevant check and inline logic nobody can call is
// logic nobody verifies. Bounded either way - only the new subfolder is ever
// writable, never the parent - but C:\Windows\Wave OS is a bad idea a user should
// be stopped from making rather than merely permitted to regret.
function isRefusedWaveParent(parent) {
  if (!parent || typeof parent !== 'string') return true;
  const lower = parent.toLowerCase().replace(/[\\/]+$/, '');
  if (lower === '') return true;                    // a bare "C:\" collapses to ""
  if (/^[a-z]:$/.test(lower)) return true;          // drive root
  const systemish = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata'];
  return systemish.some(sys => lower === sys || lower.startsWith(sys + '\\'));
}

function registerFsHandlers(ipcMain, app, shell) {
  const fsPromises = require('fs').promises;
  const pathModule = require('path');

  const BLOCKED_PATHS = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information'
  ];

  function isPathBlocked(targetPath) {
    const normalized = pathModule.resolve(targetPath).toUpperCase();
    return BLOCKED_PATHS.some(b => normalized.startsWith(pathModule.resolve(b).toUpperCase()));
  }

  ipcMain.handle('fs:list-drives', async () => {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const drivePath = `${letter}:\\`;
      try {
        await fsPromises.access(drivePath);
        let totalBytes = 0, freeBytes = 0;
        try { const s = await fsPromises.statfs(drivePath); totalBytes = s.blocks * s.bsize; freeBytes = s.bfree * s.bsize; } catch {}
        drives.push({ letter: `${letter}:`, path: drivePath, label: drivePath, totalBytes, freeBytes });
      } catch {}
    }
    return drives;
  });

  ipcMain.handle('fs:read-dir', async (event, dirPath) => {
    if (isPathBlocked(dirPath)) return { error: 'Access denied: system directory' };
    try {
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        const fullPath = pathModule.join(dirPath, entry.name);
        try {
          const stat = await fsPromises.stat(fullPath);
          items.push({ name: entry.name, path: fullPath, isFolder: entry.isDirectory(), isFile: entry.isFile(), size: stat.size, modified: stat.mtime.toISOString(), extension: entry.isFile() ? pathModule.extname(entry.name).slice(1).toLowerCase() : null });
        } catch {}
      }
      return items.sort((a, b) => { if (a.isFolder && !b.isFolder) return -1; if (!a.isFolder && b.isFolder) return 1; return a.name.localeCompare(b.name); });
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:read-file', async (event, filePath) => {
    if (isPathBlocked(filePath)) return { error: 'Access denied: system directory' };
    try {
      const stat = await fsPromises.stat(filePath);
      if (stat.size > 5 * 1024 * 1024) return { error: 'File too large for inline preview', size: stat.size };
      const content = await fsPromises.readFile(filePath, 'utf-8');
      return { content, size: stat.size };
    } catch (e) { return { error: e.message }; }
  });

  // Byte channel over IPC, for callers that just want the bytes and do not need
  // range requests. The existing fs:read-file is utf-8 ONLY, which is exactly why
  // text files opened on the local drive and media did not: a decoded string
  // cannot carry an mp3. Returns a Buffer, which Electron delivers to the renderer
  // as a Uint8Array, so the page can build a correctly-typed Blob.
  // Capped, because this copies the whole file through IPC into the renderer -
  // anything larger should use local:endpoint and stream it with Range instead.
  ipcMain.handle('fs:read-file-bytes', async (event, filePath) => {
    if (isPathBlocked(filePath)) return { error: 'Access denied: system directory' };
    try {
      const stat = await fsPromises.stat(filePath);
      if (!stat.isFile()) return { error: 'Not a file' };
      if (stat.size > 100 * 1024 * 1024) {
        return { error: 'File too large for the IPC byte channel', size: stat.size, useEndpoint: true };
      }
      const bytes = await fsPromises.readFile(filePath);
      return { bytes, size: stat.size, name: path.basename(filePath) };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:write-file', async (event, filePath, content) => {
    if (isPathBlocked(filePath)) return { error: 'Access denied: system directory' };
    try { await fsPromises.writeFile(filePath, content, 'utf-8'); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:create-folder', async (event, dirPath) => {
    if (isPathBlocked(dirPath)) return { error: 'Access denied: system directory' };
    try { await fsPromises.mkdir(dirPath, { recursive: true }); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:rename', async (event, oldPath, newPath) => {
    if (isPathBlocked(oldPath) || isPathBlocked(newPath)) return { error: 'Access denied: system directory' };
    try { await fsPromises.rename(oldPath, newPath); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:delete', async (event, filePath) => {
    if (isPathBlocked(filePath)) return { error: 'Access denied: system directory' };
    try { await shell.trashItem(filePath); return { success: true }; } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('fs:get-path', async (event, type) => {
    const paths = { desktop: app.getPath('desktop'), documents: app.getPath('documents'), downloads: app.getPath('downloads'), home: app.getPath('home'), pictures: app.getPath('pictures'), music: app.getPath('music'), videos: app.getPath('videos') };
    return paths[type] || null;
  });
}

// AI ROUTING HANDLERS (v3 — waveDockAI)
function registerAiHandlers(ipcMain) {
  // Harbor is LOCAL-ONLY by design. Cloud inference belongs to Wave OS, which
  // already owns Theta key management and model routing - a second router here
  // competed with it. Note this particular handler's Theta branch was ALSO dead:
  // it called theta.thetaChat(), which the module never exported, so 'auto' threw
  // instead of degrading whenever Ollama was stopped. The working Theta path was
  // the separate one in ollama.js; both are gone. Local failure now returns a
  // clear result object rather than throwing.
  ipcMain.handle('ai:chat', async (event, messages, options = {}) => {
    const ollama = require('./ollama');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await ollama.chat(options.model || 'phi4-mini', messages, controller.signal);
      return { ...result, provider: 'ollama' };
    } catch (e) {
      return {
        error: true,
        provider: 'ollama',
        content: 'Local AI is not running. Start Ollama from the Harbor dock, or ask the Wave Assistant in Wave OS for cloud models.',
        reason: e && e.message ? e.message : String(e)
      };
    } finally {
      clearTimeout(timeout);
    }
  })
}

// Self-registering: call at bottom of registerIpcHandlers or export for main.js
module.exports.isRefusedWaveParent = isRefusedWaveParent;
module.exports.registerFsHandlers = registerFsHandlers;
module.exports.registerAiHandlers = registerAiHandlers;
