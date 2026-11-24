# Settings, i18n, scheduler, tray

## settings.json (userData)
Managed by `settings.js` (main only). Shape = `DEFAULTS`; only known keys with the same type are accepted, values are sanitized. Keys: `language` (ka|en, default ka), `theme` (system|light|dark), `scan.scope`, `scan.include` (skip-group id → true to scan it), `schedule {mode off|startup|daily, time HH:MM, lastRun}`, `tray.enabled`, `updates {check, lastCheck, skipVersion, notified}`, `index.maxMb` (content indexing size limit, 5-1000, default 50), `ui {view, preview, searchMode name|content, previewWidth, treeWidth, cols}`.

## i18n
`locales/ka.json`, `locales/en.json` (identical keys). Renderer fetches a dictionary with `i18n:get`; main uses the same files for tray labels and the window title. Dates/numbers use `ka-GE` / `en-US`.

## Theme
`theme` → `nativeTheme.themeSource` in main; CSS follows `prefers-color-scheme`. The toolbar button toggles explicit light/dark.

## Scheduler (main.js)
`startup`: run a scan 3s after launch. `daily`: every 60s check; if now ≥ today's HH:MM and `lastRun` is before that moment, scan (also catches a missed run). Scheduled scans use `scan.scope` (the scope selected on the Files tab) and the current skip-group settings.

## Tray
Enabled by `tray.enabled`. With the tray on, closing the window hides it; Quit is in the tray menu. Turning it off shows the window. Some Linux desktops (GNOME) need an extension to show tray icons.
