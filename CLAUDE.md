# CLAUDE.md — File Finder (general reference)

Electron + plain JS desktop app: scans drives for doc/docx/xls/xlsx/pdf, indexes them in SQLite (FTS5), lists them in a virtualized table with OS icons, opens the file or its folder. Windows primary, Linux supported. Keep it simple; don't over-engineer.

## Layout
| File | Role |
|---|---|
| `main.js` | Window, IPC handlers, scan orchestration (worker lifecycle), shell/icon calls |
| `preload.js` | `contextBridge` → `window.api` (only whitelisted calls/events) |
| `db.js` | better-sqlite3 + FTS5; the ONLY place with SQL. Main process only |
| `scanner-worker.js` | `worker_threads` directory walker; batches 500; skip rules per platform |
| `renderer/` | `index.html`, `app.js` (vanilla, virtual list), `styles.css` |
| `docs/` | Architecture notes (see below) |

## Commands
- `npm install` (postinstall rebuilds better-sqlite3 for Electron), `npm start`, `npm run dist[:win|:linux]`
- Plain `node` can't load better-sqlite3 (built for Electron ABI). To script it use `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron script.js`.
- Gotcha: if `ELECTRON_RUN_AS_NODE` is set in the shell (VS Code terminal), the app crashes with `Cannot read properties of undefined (reading 'handle')`. Run with `env -u ELECTRON_RUN_AS_NODE`.
- Headless check on Linux: `xvfb-run -a node_modules/electron/dist/electron . --user-data-dir=<tmp>`.

## Rules / invariants
- Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, CSP in `index.html`. Never expose `ipcRenderer` or the DB to the renderer.
- Use `path` and `process.platform`; no hardcoded separators.
- Worker must call `parentPort.close()` when done, or the thread never exits.
- Rescan prunes only rows under the scanned roots with `scanned_at < scanStart`, and only when the scan was NOT stopped.
- Search: FTS5 trigram (terms ≥3 chars); shorter terms fall back to `LIKE`.
- Icons are cached per extension (main + renderer); renderer shows a colored badge until/unless one loads.

## Docs policy (IMPORTANT)
`docs/` holds architecture notes for major things. **Whenever an important change is made (data model, IPC contract, scanner behavior, packaging/CI, security settings, major UI mechanism), update the relevant `docs/*.md` in the same change and add a one-line note in the "Change log" below.** Add a new doc for any new major subsystem.

| Doc | Covers |
|---|---|
| `docs/architecture.md` | Process model, data flow, security |
| `docs/database.md` | Schema, FTS, upsert/prune, queries |
| `docs/scanner.md` | Worker protocol, skip rules, stop/rescan |
| `docs/ui.md` | Virtual list, paging, icons, events |
| `docs/packaging.md` | electron-builder, CI, native rebuild |

## Change log
- 2026-11-23: Initial implementation (all of the above). Verified on Linux (Xvfb): scan, FTS search, virtual list, missing-file toast. Packaged Linux build (`--dir`) also verified (worker loads from asar, better-sqlite3 unpacked). Windows paths/skip rules/NSIS build written but NOT yet run on Windows.
