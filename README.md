# Harbor

Harbor is the Wave OS desktop agent. It gives [Wave OS](https://app.oswave.io)
access to your local filesystem and your local AI models, from one tray app.

It is the merger of two earlier apps — Wave Dock (local AI bridge) and the
Harbor file agent — into a single install, a single pairing, and a single
update path.

## What it does

- **Local files** — exposes drives to Wave OS through a preload bridge, so the
  web app can browse, read and write local files.
- **Local AI** — manages Ollama and routes chat to it, with Theta EdgeCloud as
  a fallback.
- **Dock and full modes** — a compact always-available widget, or a full window
  with Wave OS embedded alongside a local chat panel.

## Build

Requires Node 20 and Windows for the Windows targets.

```bash
npm install
npm start                      # run from source
npm run build                  # nsis + msi installers into dist/
```

Tagging `v*` builds installers in CI and opens a draft GitHub Release with
SHA256 checksums attached.

## Notes for contributors

- `window.waveDockFS` / `window.isWaveDock` are a **live wire contract** with
  the published Wave OS bundle. `window.harborFS` / `window.isHarbor` are
  aliases pointing at the same objects. Do not remove the `waveDock*` names
  until the deployed web app stops referencing them.
- GPU telemetry was removed deliberately. The previous implementation
  fabricated VRAM, temperature and wattage whenever `nvidia-smi` was
  unavailable — including sine-wave "fluctuation" that read as live data. If
  telemetry returns, it reports real readings or nothing.
