// ===========================================================================
// FILE INDEX — what turns a folder list into something that feels like a cloud.
//
// SEARCH IS THE FEATURE. Listing a directory is a file share; finding a file by
// name across 200,000 of them is a cloud. Doing that over the relay one
// directory at a time is not viable - it would be thousands of round trips - so
// the answer has to be computed on the machine that holds the files.
//
// THE DISCLOSURE RULE, AND WHY IT IS STRUCTURAL RATHER THAN A CHECK.
// A filename is sensitive on its own: `divorce-settlement-draft.docx` discloses
// something even if the bytes are never served. So this index contains ONLY
// paths inside shared_folders - never the whole disk - which makes "the index
// leaked the whole drive to the remote scope" IMPOSSIBLE BY CONSTRUCTION rather
// than prevented by a condition someone can later forget.
//
// Every hit is THEN validated a second time through the caller's own
// resolveForScope. Belt and braces on purpose: the structural guarantee is the
// real one, and the per-hit check is what catches a future change that widens
// what gets indexed.
//
// NO NATIVE DEPENDENCIES, DELIBERATELY. better-sqlite3 would be the obvious
// store and it needs prebuilt binaries per platform x arch x Electron version -
// and the v3.4.0 lesson is that such a failure is indistinguishable from a
// missing file. A flat NDJSON file plus an in-memory array handles a few hundred
// thousand entries comfortably, and it can never fail to load on the one machine
// that matters.
//
// NO RESOLVER OF ITS OWN. resolveForScope is passed IN. A second implementation
// of the path-scoping contract is exactly what dropped a settings field five
// times and shared_folders.name once, and here the cost of drift would be a
// disclosure bug rather than a missing label.
// ===========================================================================
const fs = require('fs');
const path = require('path');

// A hard cap, honestly reported. An unbounded walk of a home directory can hit
// millions of entries and the failure mode - a wedged main process holding a
// gigabyte of strings - looks like Harbor hanging for no reason.
const MAX_ENTRIES = 200000;
const MAX_DEPTH = 24;

let entries = [];        // { p: absolute path, n: lowercased basename, s: size, m: mtimeMs }
let stats = {
  built: false,
  building: false,
  builtAt: 0,
  fileCount: 0,
  totalBytes: 0,
  folderCount: 0,
  truncated: false,
  error: null,
};

function indexPath(userDataDir) {
  return path.join(userDataDir || '.', 'file-index.ndjson');
}

/**
 * CHUNKED, ASYNC WALK. The first version of this was a synchronous recursive walk,
 * which was wrong for a reason worth recording: it runs in the MAIN process, so a
 * multi-second walk of a large share would freeze the dock AND the Wave OS browser
 * window AND the tray - every window Electron owns - because they all share this
 * event loop. A user would see the whole app hang for no visible reason.
 *
 * So the walk yields. It processes a bounded batch of directory entries, then
 * hands control back via setImmediate (and, since v3.12.3, awaits async fs calls so
 * no single directory read can block the loop either). Slower in wall-clock terms and completely
 * invisible, which is the correct trade for background work.
 *
 * SYMLINKS ARE NOT FOLLOWED: lstat rather than stat, so a link inside a shared
 * folder pointing at C:\ cannot smuggle the whole disk into an index that is
 * supposed to be bounded by the share. Same reasoning as resolveShared's realpath
 * re-check, applied at index time.
 */
const BATCH = 400;

// PER-DIRECTORY TIMEOUT. A folder that never answers must cost the index one
// directory, not the whole run.
const DIR_TIMEOUT_MS = 8000;

async function readDirGuarded(dir) {
  let timer;
  try {
    return await Promise.race([
      fs.promises.readdir(dir, { withFileTypes: true }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('DIR_TIMEOUT')), DIR_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function walkAsync(roots, onDone) {
  const out = [];
  // Explicit stack rather than recursion: a recursive async walk of a deep tree
  // can exhaust the call stack, and the depth cap alone would not save it.
  const stack = roots.map(r => ({ dir: path.resolve(r), depth: 0 }));
  let timedOut = 0;

  // WHY THIS IS ASYNC NOW, and why v3.10.0's chunking was only half a fix.
  //
  // The chunked walk yields via setImmediate every 400 entries, and I described that
  // as making it impossible to freeze the dock. THAT WAS HALF TRUE. Yielding BETWEEN
  // calls does nothing about the time spent INSIDE one call: fs.readdirSync blocks
  // the event loop for its whole duration, and this walk runs in the MAIN process, so
  // for that entire time the dock, the Wave OS window and the tray are all frozen
  // together - precisely the failure the chunking was supposed to prevent.
  //
  // On a normal local folder the call is sub-millisecond and it never showed. On a
  // OneDrive Files On-Demand placeholder being hydrated on first access it can be
  // seconds. That is not hypothetical: Eddie's Wave OS folder was a fresh folder under
  // OneDrive\Documents, it returned 502 through the relay for exactly as long as it
  // took to materialise, and it has answered normally ever since.
  //
  // Same lesson as the /list rewrite in v3.12.0, one layer down: making it async IS
  // the fix, and a timeout is only possible once it is. A guard around sync I/O is
  // theatre, and yielding between blocking calls is a smaller version of the same
  // mistake.
  async function step() {
    let processed = 0;
    while (stack.length && processed < BATCH && out.length < MAX_ENTRIES) {
      const { dir, depth } = stack.pop();
      if (depth > MAX_DEPTH) continue;
      let names;
      try {
        names = await readDirGuarded(dir);
      } catch (e) {
        // An unreadable directory was already "just not indexed". A directory that
        // will not answer in time is treated identically: skipped, counted, and the
        // run continues. One stalled folder must not cost the whole index.
        if (e && e.message === 'DIR_TIMEOUT') timedOut++;
        continue;
      }
      for (const d of names) {
        if (out.length >= MAX_ENTRIES) break;
        const full = path.join(dir, d.name);
        let st;
        try { st = await fs.promises.lstat(full); } catch (e) { continue; }
        if (st.isSymbolicLink()) continue;   // never traverse or record a link
        if (st.isDirectory()) stack.push({ dir: full, depth: depth + 1 });
        else if (st.isFile()) out.push({ p: full, n: d.name.toLowerCase(), s: st.size, m: st.mtimeMs });
        processed++;
      }
    }
    if (stack.length && out.length < MAX_ENTRIES) return setImmediate(() => { step(); });
    // Surfaced rather than swallowed: an index quietly missing a folder is how "22
    // files" can look complete while a share was never read.
    onDone(out, { timedOutDirs: timedOut });
  }
  setImmediate(() => { step(); });
}

/**
 * Rebuild from the shared folder list. Resolves when the walk completes; callers
 * can read getStats().building to render an honest "Indexing..." state meanwhile.
 */
function build(folders, userDataDir) {
  if (stats.building) return Promise.resolve(getStats());
  stats.building = true;
  stats.error = null;
  const roots = (folders || []).map(f => f && f.path).filter(Boolean);
  if (!roots.length) {
    entries = [];
    stats = { built: true, building: false, builtAt: Date.now(), fileCount: 0,
              totalBytes: 0, folderCount: 0, truncated: false, error: null };
    return Promise.resolve(getStats());
  }
  return new Promise((resolve) => {
    walkAsync(roots, (out, info) => {
      entries = out;
      const timedOutDirs = (info && info.timedOutDirs) || 0;
      stats = {
        built: true,
        building: false,
        builtAt: Date.now(),
        fileCount: out.length,
        totalBytes: out.reduce((a, e) => a + (e.s || 0), 0),
        folderCount: roots.length,
        truncated: out.length >= MAX_ENTRIES,
        // CARRIED THROUGH TO THE CARD, because this is the field that would have made
        // this morning's debugging trivial. A file count alone cannot distinguish "the
        // index read everything" from "the index skipped a folder that would not
        // answer" - and I spent real time treating a completed index as proof that
        // every folder responded promptly. It was not proof; it was silence.
        timedOutDirs,
        error: null,
      };
      persist(userDataDir);
      resolve(getStats());
    });
  });
}

function persist(userDataDir) {
  if (!userDataDir) return;
  try {
    const lines = entries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(indexPath(userDataDir), lines, 'utf8');
  } catch (e) {
    // A failed persist costs a rescan at next launch and nothing else, so it is
    // logged rather than surfaced.
    console.error('[harbor] could not persist the file index:', e && e.message);
  }
}

function load(userDataDir) {
  try {
    const raw = fs.readFileSync(indexPath(userDataDir), 'utf8');
    if (!raw.trim()) return false;
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
    }
    entries = out;
    stats = {
      built: true, building: false, builtAt: 0,
      fileCount: out.length,
      totalBytes: out.reduce((a, e) => a + (e.s || 0), 0),
      folderCount: 0, truncated: false, error: null,
    };
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Search by filename substring.
 *
 * `validate` is the CALLER'S resolveForScope, bound to the requesting scope. Every
 * hit must survive it. The index already only holds shared paths, so for the
 * shared scope this is redundant today - and that is the point: it is the check
 * that keeps the guarantee true after someone widens what gets indexed.
 */
function search(q, { validate, limit = 200 } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return { results: [], truncated: false, searched: entries.length };
  const results = [];
  let scanned = 0;
  for (const e of entries) {
    scanned++;
    if (e.n.indexOf(needle) === -1) continue;
    // THE GUARD THAT MATTERS. A hit the requesting scope may not read is dropped
    // silently - not reported as forbidden, because the existence of the match is
    // itself the thing being withheld.
    if (typeof validate === 'function' && !validate(e.p)) continue;
    results.push({ path: e.p, name: path.basename(e.p), size: e.s, mtimeMs: e.m });
    if (results.length >= limit) return { results, truncated: true, searched: scanned };
  }
  return { results, truncated: false, searched: scanned };
}

function getStats() {
  return { ...stats, entries: entries.length };
}

function clear() {
  entries = [];
  stats = { built: false, building: false, builtAt: 0, fileCount: 0, totalBytes: 0, folderCount: 0, truncated: false, error: null };
}

module.exports = { build, load, search, getStats, clear, MAX_ENTRIES };
