# Architecture

## Processes
- **Main** (`main.js`): owns the window, the SQLite DB (`db.js`), the scanner worker, and all OS calls (`shell`, `app.getFileIcon`, dialogs).
- **Scanner worker** (`scanner-worker.js`, `worker_threads`): walks the filesystem, posts batches to main. Never touches the DB.
- **Renderer** (`renderer/`): UI only. Sandboxed, no Node. Talks to main via `window.api` from `preload.js`.

## Data flow (scan)
```
UI Scan -> ipc scan:start -> main spawns Worker(roots)
Worker --batch(500 files)--> main -> db.upsertBatch (1 transaction) -> event scan:inserted
Worker --progress(found, folder), ~100ms--> main -> event scan:progress
Worker --done--> main -> db.deleteMissing (unless stopped) -> event scan:done
UI debounces scan:inserted (1s) -> re-query visible pages
```

## IPC contract (invoke)
`files:query`, `files:count`, `files:total`, `scan:start {mode:'all'|'folder', folder}`, `scan:stop`, `scan:status`, `dialog:pickFolder`, `file:open`, `file:showInFolder`, `icon:get(ext, path)`.
Events main→renderer: `scan:progress`, `scan:inserted`, `scan:done`, `scan:error` (whitelisted in `preload.js`).

## Security
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP (`script-src 'self'`). Renderer only gets the functions listed above; the file paths it sends are checked for existence in main before use.
