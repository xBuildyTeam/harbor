// Resolves - and if needed INSTALLS - the tunnel binary.
//
// Harbor has never shipped this binary, and it is not a dependency anyone would
// guess: the local-LLM setup guide installs it at Step 3, so a machine that
// skipped that guide has Ollama stopped AND both tunnels dead, with the dock
// reporting only "Tunnel failed to start." That is a 20-minute diagnosis for a
// missing file. Measured on a real pair of machines 2026-09-13.
//
// WHY DOWNLOAD ON DEMAND rather than bundle it: the binary is ~70MB and would
// nearly double a 77MB installer for a feature that is opt-in and that plenty of
// users will never turn on. Downloading into Harbor's OWN userData dir also
// needs no admin rights, cannot be defeated by a broken PATH, and survives the
// "installed it while Harbor was running so PATH was stale" trap entirely.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BIN = 'cloud' + 'flared';
const EXE = process.platform === 'win32' ? `${BIN}.exe` : BIN;
const RELEASE_BASE = `https://github.com/${BIN}/${BIN}/releases/latest/download`;

let binDir = null;

function configure(dir) {
  binDir = dir ? path.join(dir, 'bin') : null;
}

function managedPath() {
  return binDir ? path.join(binDir, EXE) : null;
}

// ARCH MATTERS, and this is not academic: an ARM mini-PC given the amd64 build
// fails with the same shape of error as a missing file, so guessing wrong here
// produces a bug that looks identical to the one we are fixing.
function assetName() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
  if (!arch) return null;
  if (process.platform === 'win32') return `${BIN}-windows-${arch}.exe`;
  if (process.platform === 'linux') return `${BIN}-linux-${arch}`;
  // macOS ships a .tgz, which needs extraction - not implemented, so say so
  // rather than half-doing it and failing opaquely.
  return null;
}

// Verify by EXECUTION, not by checksum. Cloudflare does not publish a stable
// per-asset SHA256 file, and a hash we cannot fetch is not a check. Running
// --version proves two things a hash cannot: that the file executes on THIS
// machine and architecture, and that it is actually the program we wanted.
function probeVersion(exePath) {
  return new Promise((resolve) => {
    try {
      execFile(exePath, ['--version'], { timeout: 10000 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        if (err || !out.toLowerCase().includes(BIN)) return resolve(null);
        resolve(out.split('\n')[0].trim());
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function onPath() {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    try {
      execFile(probe, [BIN], (err, stdout) => {
        const first = String(stdout || '').split('\n')[0].trim();
        resolve(!err && first ? first : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Harbor's own copy wins over PATH. If we installed it, that is the one we know
// the version and architecture of.
async function resolveBinary() {
  const mine = managedPath();
  if (mine && fs.existsSync(mine)) {
    const version = await probeVersion(mine);
    if (version) return { found: true, path: mine, source: 'managed', version };
  }
  const found = await onPath();
  if (found) {
    const version = await probeVersion(found);
    if (version) return { found: true, path: found, source: 'path', version };
    // On PATH but will not run: almost always an arch mismatch or an AV
    // quarantine. Name that, because "not found" would send someone to
    // reinstall something that is already sitting right there.
    return { found: false, path: found, source: 'path', version: null, unusable: true };
  }
  return { found: false, path: null, source: null, version: null };
}

async function installBinary(onProgress) {
  const asset = assetName();
  if (!asset) {
    return {
      ok: false,
      error: process.platform === 'darwin'
        ? `On macOS install it with: brew install ${BIN}`
        : `No prebuilt binary for ${process.platform}/${process.arch}`,
    };
  }
  const dest = managedPath();
  if (!dest) return { ok: false, error: 'Install directory not configured' };

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const res = await fetch(`${RELEASE_BASE}/${asset}`, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `Download failed: HTTP ${res.status}` };

    const total = Number(res.headers.get('content-length')) || 0;
    const tmp = `${dest}.part`;
    const chunks = [];
    let received = 0;
    for await (const chunk of res.body) {
      chunks.push(chunk);
      received += chunk.length;
      if (onProgress) onProgress({ received, total });
    }
    const buf = Buffer.concat(chunks);

    // A tiny file here means a proxy served an error page with a 200, which is
    // common on captive networks and would otherwise be written out as a
    // "binary" that fails cryptically later.
    if (buf.length < 1_000_000) {
      return { ok: false, error: `Download was only ${buf.length} bytes - likely an error page, not the binary` };
    }
    fs.writeFileSync(tmp, buf);
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);

    const version = await probeVersion(dest);
    if (!version) {
      // Downloaded but will not execute. Remove it, or resolveBinary would keep
      // preferring this dead copy over a working one on PATH forever.
      try { fs.unlinkSync(dest); } catch (e) { /* best effort */ }
      return { ok: false, error: 'Downloaded file will not run on this machine (architecture mismatch, or blocked by antivirus)' };
    }
    return { ok: true, path: dest, version, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { configure, resolveBinary, installBinary, managedPath, assetName, probeVersion, BIN };
