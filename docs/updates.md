# New-version notification

Check + background update. Detection is the GitHub check below; when the app is installed (Windows NSIS, or a running Linux AppImage: `app.isPackaged` and `process.platform==='win32' || APPIMAGE`), `electron-updater` then downloads the update (`autoDownload=false`, we call `downloadUpdate()` ourselves; differential via `.blockmap`; sha512 checked against `latest.yml`/`latest-linux.yml`). Events `update:progress {percent,version}` and `update:ready {version}` drive the banner; **Restart and update** calls `update:install` (`quitAndInstall(true, true)`, main sets `quitting` first so the tray does not swallow the close). A downloaded update is also installed on a normal quit. If the updater is unavailable or fails (no yml in the release, network), the old banner with **Download** (opens the release page) is used. No code signing: `publisherName` is not set, so only the hash is verified.

`package.json > build.publish` (github owner/repo) bakes `app-update.yml` into the app; artifact names are space-free (`File-Scanner-Setup-<v>.exe`, `File-Scanner-<v>.AppImage`) because GitHub renames spaces and the yml would no longer match.

## Flow (`updates.js`, main process)
- `fetchLatest()` calls `https://api.github.com/repos/<REPO>/releases/latest` with `net.fetch` (10 s timeout, generic User-Agent `file-scanner-update-check`). `REPO` is the constant at the top of `updates.js`.
- Results: `available` (tag newer than `app.getVersion()`), `uptodate`, `none` (HTTP 404 = no release published yet), `error` (network, bad JSON, non-semver tag, or a release URL that is not under `https://github.com/<REPO>/`).
- `checkAuto()` runs 15 s after start and every 6 h; it honours `settings.updates.check` and a ~20 h minimum between checks (`updates.lastCheck`). `checkNow()` is the manual check from the About page (ignores the interval and "skip").
- A found update is sent to the renderer as `update:available {version,url}` (banner under the app bar, plus an About-page card). One OS notification per version, only when the window is not focused (`updates.notified`).
- "Skip this version" stores `updates.skipVersion`; automatic checks stay quiet for it, a manual check still reports it.
- `update:open` only opens URLs that start with `https://github.com/<REPO>/`.

## Releasing
The workflow uploads `*.exe`, `*.AppImage`, `*.blockmap` and `latest*.yml` into the release; without the yml files auto-update cannot work. Tag `vX.Y.Z` equal to `package.json` version and push it; `.github/workflows/build.yml` builds Windows + Linux and creates the GitHub Release (`gh release create`, built-in `GITHUB_TOKEN`, `contents: write`). The repository must be **public** (the check is unauthenticated; ~60 requests/hour/IP limit is irrelevant at 1/day).

## Testing
Unpackaged runs honour `FF_UPDATE_API` (point at a local fake server) and `FF_UPDATE_DELAY_MS` (shorter start-up delay). Both are ignored in packaged builds.
