# File Finder

Electron app that scans your drives for `.doc .docx .xls .xlsx .pdf`, stores them in a local SQLite DB and lets you search, open the file or show it in its folder. Windows is the primary target; Linux also works.

## Run

```bash
npm install        # also runs `electron-builder install-app-deps` (rebuilds better-sqlite3 for Electron)
npm start
```

Results already in the DB are shown at startup; press **Scan** (becomes **Rescan**) to refresh. Use **Folder…** to limit the scan to one folder (× returns to all drives). **Stop** aborts a scan (a stopped scan does not delete anything).

If you launch from a terminal that sets `ELECTRON_RUN_AS_NODE` (e.g. the VS Code integrated terminal in some setups), run `env -u ELECTRON_RUN_AS_NODE npm start`.

## Build installers

```bash
npm run dist          # current OS
npm run dist:win      # NSIS installer  -> dist/*.exe   (run on Windows)
npm run dist:linux    # AppImage + deb  -> dist/*.AppImage, dist/*.deb
```

CI: `.github/workflows/build.yml` builds on `windows-latest` and `ubuntu-latest` and uploads the installers as artifacts.

Before releasing, change `appId`, `homepage` (required by the deb target) and the `maintainer`/`author` placeholder (`noreply@example.com`) in `package.json`.

## Where data lives

SQLite file `files.db` in Electron's `userData` folder (`%APPDATA%\file-finder` on Windows, `~/.config/file-finder` on Linux).

## Docs

Architecture notes are in [docs/](docs/). Contributor/agent notes are in [CLAUDE.md](CLAUDE.md).
