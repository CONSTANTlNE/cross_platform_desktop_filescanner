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
`update:check/open/skip`, `folders:search`, `index:start/stop/status/stats/clear`, `preview:get`, `file:trash`, `folder:trash`, `settings:get`, `settings:set`, `i18n:get`, `skip:groups`, `app:info`, `folders:children`, `files:query`, `files:count`, `files:total`, `scan:start {mode:'all'|'folder', folder}`, `scan:stop`, `scan:status`, `dialog:pickFolder`, `file:open`, `file:showInFolder`, `icon:get(ext, path)`.
Events main→renderer: `scan:progress`, `scan:inserted`, `scan:done`, `scan:error`, `settings:changed`, `index:progress`, `index:done`, `update:available` (whitelisted in `preload.js`).

## Settings, i18n, tray
See `settings.md`. Main owns `settings.json`, the scheduler (60s tick + startup run) and the tray; the renderer gets settings through `settings:get/set` and the `settings:changed` event. Single-instance lock: a second launch just shows the existing window.

## Content search
Separate from scanning. `index:start` runs `indexer.js`: pending files (new/changed since `content_status`) are fed to 2 worker threads (`content-worker.js`, 90 s timeout per file, 1 GB heap, restarted on crash/timeout); results are written in batches by `db.saveContent`. Events `index:progress` / `index:done`; an OS notification is shown when it finishes and the window is not focused. See `contentsearch.md`.

## Quick view
`preview:get(path)` in main: path must be in the index, ext in doc/docx/xls/xlsx, size ≤ 30 MB; spawns `preview-worker.js` (15 s timeout, 768 MB heap), cancelling any previous job. Result is plain data; see `quickview.md`.

## Multi-select and multi-delete
Renderer selection = `Set` of index ids (+ anchor index for Shift ranges; ranges and select-all use `files:ids` which returns ids in the current query order). Deleting uses `files:describe(ids)` for the confirmation text, then `files:trashMany(ids)`: main loads the rows by id, trashes each one (OS trash only), continues past failures, and drops the trashed/missing paths from the index in one transaction. Blocked while a scan runs. Changing the query clears the selection.

## Rename
`file:rename(path, newBase)` in main: file must be indexed, no scan running; extension is fixed; name validated (no separators/NUL, Windows reserved names/characters/trailing dot, length limits); refuses if the target exists (case-only rename allowed on Windows); then `fs.rename` and `db.renameFile` (FTS stays in sync via the trigger). Errors come back as codes shown inline in the dialog.

## Context menus
Custom themed menu (`App.contextMenu`) for file rows and tree folders. Extra IPC: `clipboard:write`, `folder:open` (only folders containing indexed files).

## Delete (safe)
`file:trash` / `folder:trash` in main. Always `shell.trashItem` (recoverable); the renderer shows a confirm modal first (`App.confirm`, default focus Cancel). Main refuses: while a scan runs, paths not in the index, and protected folders (filesystem roots, top-level system dirs, home, userData, standard user folders). On success the DB rows (file, or everything under the folder) are removed and the UI reloads.

## Security
`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP (`script-src 'self'`). Renderer only gets the functions listed above; the file paths it sends are checked for existence in main before use.
