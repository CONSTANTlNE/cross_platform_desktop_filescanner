# New-version notification

Notification only. There is deliberately no auto-installer (no `electron-updater`): the installers are unsigned and the user downloads new versions themselves.

## Flow (`updates.js`, main process)
- `fetchLatest()` calls `https://api.github.com/repos/<REPO>/releases/latest` with `net.fetch` (10 s timeout, generic User-Agent `file-scanner-update-check`). `REPO` is the constant at the top of `updates.js`.
- Results: `available` (tag newer than `app.getVersion()`), `uptodate`, `none` (HTTP 404 = no release published yet), `error` (network, bad JSON, non-semver tag, or a release URL that is not under `https://github.com/<REPO>/`).
- `checkAuto()` runs 15 s after start and every 6 h; it honours `settings.updates.check` and a ~20 h minimum between checks (`updates.lastCheck`). `checkNow()` is the manual check from the About page (ignores the interval and "skip").
- A found update is sent to the renderer as `update:available {version,url}` (banner under the app bar, plus an About-page card). One OS notification per version, only when the window is not focused (`updates.notified`).
- "Skip this version" stores `updates.skipVersion`; automatic checks stay quiet for it, a manual check still reports it.
- `update:open` only opens URLs that start with `https://github.com/<REPO>/`.

## Releasing
Tag `vX.Y.Z` equal to `package.json` version and push it; `.github/workflows/build.yml` builds Windows + Linux and creates the GitHub Release (`gh release create`, built-in `GITHUB_TOKEN`, `contents: write`). The repository must be **public** (the check is unauthenticated; ~60 requests/hour/IP limit is irrelevant at 1/day).

## Testing
Unpackaged runs honour `FF_UPDATE_API` (point at a local fake server) and `FF_UPDATE_DELAY_MS` (shorter start-up delay). Both are ignored in packaged builds.
