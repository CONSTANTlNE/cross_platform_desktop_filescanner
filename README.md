# File Scanner

A desktop app (Electron, plain JavaScript) that finds the documents on your computer — **Word, Excel and PDF** (`.doc .docx .xls .xlsx .pdf`) — keeps a searchable list in a local database, and lets you search, preview, open, rename and delete them. Everything stays on your machine. Windows is the primary target; Linux works too. The interface is in **Georgian (default) and English**.

## What it can do

**Find and search**
- **Scan** all drives or one chosen folder. It runs in the background; the list is saved, so the app opens instantly with the last results. **Rescan** refreshes it (files that disappeared are removed from the list; a stopped scan removes nothing).
- **Search by file name** instantly (as you type), filter by type (doc / docx / xls / xlsx / pdf), sort by name, type, size or date, resize the columns.
- **Search inside documents** (Word, Excel and text-based PDF): press **Index contents** once — it runs in the background and notifies you when it finishes — then switch the search box to **Contents**. Matches are highlighted. Each file shows an icon telling whether it is searchable by contents; a bar above the list explains which files are not (not indexed yet, scanned PDF without text, unreadable, too large).
- **Folders view**: a tree with the file count and total size of every folder, plus a folder search box. Selecting a folder lists everything inside it, including subfolders.

**Preview and manage**
- **Quick view** panel (eye button): formatted preview of Word, Excel (sheet tabs) and PDF files; arrow keys move between files. Both side panels are resizable.
- **Open** (double-click / Enter), **show in folder**, **copy path / name**, **rename** (F2; the extension stays fixed), **delete**.
- **Safe delete**: files always go to the Trash / Recycle Bin after a warning dialog, never permanently. Multi-select with checkboxes, Ctrl/Shift-click or Ctrl+A, then delete many at once. Protected folders (system folders, your home folder, Documents, …) can never be deleted from the app.
- Right-click menus on files and folders.

**Settings** (Settings tab)
- Language and light/dark theme.
- Choose which normally skipped folders (Windows, Program Files, `node_modules`, `.git`, …) to include in scans.
- Automatic scans at startup or daily, optionally running in the system tray.
- Content search options: size limit and index statistics.

**Updates**: the app can tell you when a newer version is published (see below). Nothing is installed automatically.

**Limitations** (also written on the app's About page): scanned PDFs (pictures of pages) cannot be searched by contents because there is no OCR; Georgian text is only searchable if the document uses Unicode fonts (not old fonts such as AcadNusx or LitNusx); very large files are skipped for content indexing; old `.doc` files preview as plain text.

## Run from source

```bash
npm install        # also runs `electron-builder install-app-deps` (rebuilds better-sqlite3 for Electron)
npm start
```

If you launch from a terminal that sets `ELECTRON_RUN_AS_NODE` (e.g. the VS Code integrated terminal in some setups), run `env -u ELECTRON_RUN_AS_NODE npm start`.

## Install

**Windows** — run the `.exe` from the [Releases page](https://github.com/CONSTANTlNE/cross_platform_desktop_filescanner/releases). The installer is **not code-signed** (a deliberate decision: certificates cost money and need identity verification), so Windows SmartScreen shows "Windows protected your PC" the first time: click **More info**, then **Run anyway**. Chrome/Edge may also ask you to confirm the download (**Keep**).

**Linux** — download the `.AppImage`:

```bash
chmod +x "File Scanner-1.0.0.AppImage"
./"File Scanner-1.0.0.AppImage"      # on newer Ubuntu you may need: --no-sandbox
```

## Build installers

```bash
npm run dist          # current OS
npm run dist:win      # NSIS installer  -> dist/*.exe   (run on Windows)
npm run dist:linux    # AppImage        -> dist/*.AppImage
```

Cross-building the Windows installer from Linux does not work (native SQLite module); use a Windows machine or the GitHub Actions workflow.

Before the first release, replace the placeholder `appId` and the `author` / `maintainer` address (`noreply@example.com`) in `package.json`.

## Publishing a release (and the "new version available" notice)

`.github/workflows/build.yml` builds both installers on every push (download them from the run's *Artifacts*). Pushing a **version tag** also publishes them as a GitHub Release:

```bash
npm version patch            # 1.0.0 -> 1.0.1 : edits package.json and creates the tag v1.0.1
git push --follow-tags       # GitHub builds Windows + Linux and creates the Release
```

The tag must match the version in `package.json` (the workflow checks this). No secrets are needed; the workflow uses GitHub's built-in token.

The app asks GitHub for the latest release of this repository about once a day (and when you press **Check for updates** on the About page). If a newer version exists it shows a banner with a **Download** button that opens the release page; you install the new version yourself, over the old one — your data stays. You can skip a version or switch the automatic check off in the About page. It is the only network request the app makes, and it sends nothing about you or your files. The repository address is the `REPO` constant in `updates.js`.

## Where data lives

The SQLite database `files.db` and `settings.json` are in Electron's `userData` folder: `%APPDATA%\file-scanner` on Windows, `~/.config/file-scanner` on Linux. The app used to be called "File Finder"; data from the old `file-finder` folder is copied over automatically on first start.

## Docs

Architecture notes are in [docs/](docs/) (database, scanner, UI, quick view, content search, settings, packaging, updates). Contributor/agent notes are in [CLAUDE.md](CLAUDE.md).
