# Packaging & CI

- `package.json > build`: NSIS (Windows), AppImage + deb (Linux). Only app files are packaged (`files` whitelist).
- better-sqlite3 is native: `postinstall` runs `electron-builder install-app-deps` so it is compiled for Electron's ABI. Plain `node` cannot load it after that.
- CI: `.github/workflows/build.yml` — matrix `windows-latest`, `ubuntu-latest`; `npm ci` (triggers postinstall) → `npm run dist` → upload `dist/*.exe|*.AppImage|*.deb`.
- Placeholders to replace before release: `appId`, `author`, `linux.maintainer`.
- Open items: Windows NSIS build and a Windows run of the scanner are untested locally; the worker loads from inside the asar (verified on a Linux `--dir` build).
