const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, nativeTheme, clipboard, Notification } = require('electron');
const { Worker } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const settings = require('./settings');
const { GROUPS, buildSkip } = require('./skip-rules');
const { createIndexer } = require('./indexer');
const { createUpdates } = require('./updates');

const ICON = path.join(__dirname, 'build', 'icon.png');
const locales = { ka: require('./locales/ka.json'), en: require('./locales/en.json') };
const tr = (key) => (locales[settings.get().language] || locales.ka)[key] || locales.en[key] || key;

let win = null;
let tray = null;
let quitting = false;
let scan = null; // { worker, roots, start, found, stopped }
const iconCache = new Map(); // ext -> data URL

const trf = (key, p) => tr(key).replace(/\{(\w+)\}/g, (m, k) => (p && p[k] != null ? p[k] : m));

const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
};

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 820,
    minHeight: 420,
    title: tr('app.title'),
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // With the tray enabled, closing the window only hides it so scheduled scans keep running.
  win.on('close', (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => (win = null));
}

function showWindow() {
  if (!win) createWindow();
  else {
    win.show();
    win.focus();
  }
}

// ---------- tray ----------

function updateTray() {
  const want = settings.get().tray.enabled;
  if (want && !tray) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
    tray.setToolTip('File Scanner');
    tray.on('click', showWindow);
  } else if (!want && tray) {
    tray.destroy();
    tray = null;
    if (win && !win.isVisible()) win.show(); // never leave the app with no visible way in
  }
  if (tray) {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: tr('tray.show'), click: showWindow },
        { label: tr('tray.scan'), enabled: !scan, click: () => runSavedScope() },
        { type: 'separator' },
        { label: tr('tray.quit'), click: () => { quitting = true; app.quit(); } },
      ])
    );
  }
}

// ---------- scanning ----------

async function getRoots(mode, folder) {
  if (mode === 'folder' && folder) return [path.resolve(folder)];
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const checks = await Promise.all(
      letters.map((l) => fs.promises.access(l + ':\\').then(() => l + ':\\', () => null))
    );
    return checks.filter(Boolean);
  }
  return ['/'];
}

async function startScan({ mode, folder } = {}) {
  if (scan) return { ok: false, code: 'busy' };
  const roots = await getRoots(mode, folder);
  if (!roots.length) return { ok: false, code: 'nothing' };

  const skip = buildSkip(settings.get().scan.include);
  const worker = new Worker(path.join(__dirname, 'scanner-worker.js'), { workerData: { roots, skip } });
  const s = (scan = { worker, roots, start: Date.now(), found: 0, stopped: false });
  let finished = false;
  updateTray();

  const finish = (extra) => {
    if (finished) return;
    finished = true;
    scan = null;
    updateTray();
    send('scan:done', { found: s.found, stopped: s.stopped, ...extra });
  };

  worker.on('message', (m) => {
    if (m.type === 'batch') {
      try {
        db.upsertBatch(m.files, s.start);
      } catch (e) {
        send('scan:error', { message: 'DB write failed: ' + e.message });
      }
      send('scan:inserted', null);
    } else if (m.type === 'progress') {
      s.found = m.found;
      send('scan:progress', { found: m.found, folder: m.folder });
    } else if (m.type === 'done') {
      s.found = m.found;
      let removed = 0;
      // Only prune when the scan finished completely; a stopped scan saw only part of the tree.
      if (!m.stopped) removed = db.deleteMissing(roots, s.start);
      finish({ removed });
    } else if (m.type === 'error') {
      send('scan:error', { message: m.message });
    }
  });
  worker.on('error', (e) => {
    send('scan:error', { message: e.message });
    finish({ removed: 0, stopped: true });
  });
  worker.on('exit', () => finish({ removed: 0 }));
  return { ok: true, roots };
}

const runSavedScope = () => startScan(settings.get().scan.scope);

// ---------- scheduler ----------

function runScheduled() {
  if (scan) return;
  settings.set({ schedule: { lastRun: Date.now() } });
  send('settings:changed', settings.get());
  runSavedScope();
}

function checkSchedule() {
  const { mode, time, lastRun } = settings.get().schedule;
  if (mode !== 'daily' || scan) return;
  const [h, m] = time.split(':').map(Number);
  const due = new Date();
  due.setHours(h, m, 0, 0);
  // Due today and not yet run since then (also catches a missed run when the app was closed).
  if (Date.now() >= due.getTime() && lastRun < due.getTime()) runScheduled();
}

// ---------- settings ----------

function applySettings(prev, next) {
  if (prev.theme !== next.theme) nativeTheme.themeSource = next.theme;
  if (prev.tray.enabled !== next.tray.enabled || prev.language !== next.language) updateTray();
  if (prev.language !== next.language && win) win.setTitle(tr('app.title'));
  if (prev.schedule.mode !== next.schedule.mode || prev.schedule.time !== next.schedule.time) checkSchedule();
}

// ---------- IPC ----------

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => {
  const prev = settings.get();
  const next = settings.set(patch);
  applySettings(prev, next);
  send('settings:changed', next);
  return next;
});
ipcMain.handle('i18n:get', (_e, lang) => locales[lang] || locales.ka);
ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataDir: app.getPath('userData'), platform: process.platform }));
ipcMain.handle('skip:groups', () => GROUPS.map((g) => ({ id: g.id, warn: !!g.warn })));

ipcMain.handle('files:query', (_e, q) => db.query(q || {}));
ipcMain.handle('files:count', (_e, q) => db.count(q || {}));
ipcMain.handle('files:total', () => db.total());
ipcMain.handle('folders:search', (_e, term) => db.folderSearch(typeof term === 'string' ? term.slice(0, 100) : ''));
ipcMain.handle('folders:children', (_e, parent) => db.folderChildren(typeof parent === 'string' ? parent : ''));

ipcMain.handle('scan:start', (_e, opts) => startScan(opts));
ipcMain.handle('scan:stop', () => {
  if (scan) {
    scan.stopped = true;
    scan.worker.postMessage('stop');
  }
});
ipcMain.handle('scan:status', () => ({ running: !!scan, found: scan ? scan.found : 0 }));

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

const exists = (p) => fs.promises.access(p).then(() => true, () => false);

ipcMain.handle('file:open', async (_e, p) => {
  if (typeof p !== 'string' || !(await exists(p))) return { ok: false, code: 'missing' };
  const err = await shell.openPath(p);
  return err ? { ok: false, code: 'open', message: err } : { ok: true };
});

ipcMain.handle('file:showInFolder', async (_e, p) => {
  if (typeof p !== 'string' || !(await exists(p))) return { ok: false, code: 'missing' };
  shell.showItemInFolder(p);
  return { ok: true };
});

// ---- quick view: parse one document in an isolated worker (size cap, timeout, memory limit) ----
const PREVIEW_EXTS = ['doc', 'docx', 'xls', 'xlsx', 'pdf'];
const PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
let previewJob = null; // { worker, cancel }

ipcMain.handle('preview:get', async (_e, p) => {
  if (typeof p !== 'string' || !db.hasPath(p)) return { ok: false, code: 'notIndexed' };
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!PREVIEW_EXTS.includes(ext)) return { ok: false, code: 'unsupported' };
  let st;
  try {
    st = await fs.promises.stat(p);
  } catch {
    return { ok: false, code: 'missing' };
  }
  if (ext === 'pdf') return { ok: true, kind: 'pdf' }; // rendered by Chromium's built-in viewer in an iframe
  if (st.size > PREVIEW_MAX_BYTES) return { ok: false, code: 'tooBig', size: st.size };

  if (previewJob) previewJob.cancel(); // only the latest request matters
  return new Promise((resolve) => {
    const worker = new Worker(path.join(__dirname, 'preview-worker.js'), {
      workerData: { path: p, ext },
      resourceLimits: { maxOldGenerationSizeMb: 768 },
    });
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (previewJob && previewJob.worker === worker) previewJob = null;
      worker.terminate();
      resolve(res);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), 15000);
    previewJob = { worker, cancel: () => finish({ ok: false, code: 'cancelled' }) };
    worker.on('message', (m) => finish(m));
    worker.on('error', (e) => finish({ ok: false, code: 'failed', message: e.message }));
    worker.on('exit', () => finish({ ok: false, code: 'failed' }));
  });
});

ipcMain.handle('clipboard:write', (_e, text) => {
  if (typeof text === 'string' && text.length <= 4096) clipboard.writeText(text);
});

// Open a scanned folder in the OS file manager (only folders that contain indexed files).
ipcMain.handle('folder:open', async (_e, p) => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || db.folderStats(p).n === 0) return { ok: false, code: 'notIndexed' };
  if (!(await exists(p))) return { ok: false, code: 'missing' };
  const err = await shell.openPath(p);
  return err ? { ok: false, code: 'open', message: err } : { ok: true };
});

// ---- new-version notification (notification only, no auto-install; see updates.js) ----
const updates = createUpdates({ settings, send, tr, isWindowFocused: () => !!(win && win.isVisible() && win.isFocused()) });
ipcMain.handle('update:check', () => updates.checkNow());
ipcMain.handle('update:open', (_e, url) => updates.openRelease(url));
ipcMain.handle('update:skip', (_e, version) => updates.skip(version));

// ---- content indexing (separate background task; see indexer.js) ----
const indexer = createIndexer({
  db,
  getMaxBytes: () => settings.get().index.maxMb * 1024 * 1024,
  send,
  onDone(s) {
    // OS notification only when the user is not looking at the window
    if (s.stopped || !Notification.isSupported() || (win && win.isVisible() && win.isFocused())) return;
    new Notification({
      title: tr('index.doneTitle'),
      body: trf('index.doneBody', { ok: s.ok, empty: s.empty, error: s.error, toobig: s.tooBig }),
      icon: ICON,
    }).show();
  },
});

ipcMain.handle('index:start', () => (scan ? { ok: false, code: 'scanning' } : indexer.start()));
ipcMain.handle('index:stop', () => indexer.stop());
ipcMain.handle('index:status', () => indexer.status());
ipcMain.handle('index:stats', () => db.contentStats(settings.get().index.maxMb * 1024 * 1024));
ipcMain.handle('index:clear', () => {
  if (indexer.running()) return { ok: false, code: 'busy' };
  db.clearContent();
  return { ok: true };
});

// ---- multi-select helpers: the renderer only ever sends index ids, main resolves them to paths ----
const cleanIds = (ids) => (Array.isArray(ids) ? ids.filter(Number.isInteger).slice(0, 500000) : []);

ipcMain.handle('files:ids', (_e, q) => db.ids(q || {}));

ipcMain.handle('files:describe', (_e, ids) => {
  const rows = db.byIds(cleanIds(ids));
  return { count: rows.length, size: rows.reduce((a, r) => a + r.size, 0), names: rows.slice(0, 8).map((r) => r.name) };
});

ipcMain.handle('files:copyPaths', (_e, ids) => {
  const rows = db.byIds(cleanIds(ids));
  clipboard.writeText(rows.map((r) => r.path).join('\n').slice(0, 1000000));
  return rows.length;
});

// Move many indexed files to the OS trash. Continues past individual failures and reports them.
ipcMain.handle('files:trashMany', async (_e, ids) => {
  if (scan) return { ok: false, code: 'scanning' };
  const rows = db.byIds(cleanIds(ids));
  if (!rows.length) return { ok: false, code: 'notIndexed' };
  let done = 0;
  let failedCount = 0;
  const failed = [];
  const gone = []; // paths to drop from the index (trashed, or already missing)
  for (const r of rows) {
    if (!(await exists(r.path))) {
      gone.push(r.path);
      failedCount++;
      if (failed.length < 10) failed.push({ name: r.name, code: 'missing' });
      continue;
    }
    try {
      await shell.trashItem(r.path);
      gone.push(r.path);
      done++;
    } catch (e) {
      failedCount++;
      if (failed.length < 10) failed.push({ name: r.name, code: 'trash' });
    }
  }
  db.removePaths(gone);
  return { ok: true, done, failedCount, failed };
});

// ---- rename: the extension is fixed, the new name is validated, and nothing is ever overwritten ----
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validBaseName(base, ext) {
  if (!base || base === '.' || base === '..') return false;
  if (/[\/\0]/.test(base)) return false;
  const full = base + ext;
  if (process.platform === 'win32') {
    if (/[<>:"|?*\x00-\x1f]/.test(base) || /[. ]$/.test(base) || WIN_RESERVED.test(base.split('.')[0])) return false;
    return full.length <= 255;
  }
  return Buffer.byteLength(full) <= 255;
}

ipcMain.handle('file:rename', async (_e, p, newBase) => {
  if (scan) return { ok: false, code: 'scanning' };
  if (typeof p !== 'string' || typeof newBase !== 'string' || !db.hasPath(p)) return { ok: false, code: 'notIndexed' };
  const ext = path.extname(p); // fixed: keeps the file inside the scanned types
  let base = newBase.trim();
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length).trim();
  if (!validBaseName(base, ext)) return { ok: false, code: 'invalidName' };
  const dir = path.dirname(p);
  const newName = base + ext;
  const newPath = path.join(dir, newName);
  if (newPath === p) return { ok: true, path: p, name: newName, unchanged: true };
  if (!(await exists(p))) {
    db.removeByPath(p);
    return { ok: false, code: 'missing' };
  }
  // fs.rename silently overwrites on POSIX, so refuse if the target exists (a case-only rename of the same file is fine)
  const sameFileCaseOnly = process.platform === 'win32' && newPath.toLowerCase() === p.toLowerCase();
  if (!sameFileCaseOnly && (await fs.promises.lstat(newPath).then(() => true, () => false))) return { ok: false, code: 'exists' };
  try {
    await fs.promises.rename(p, newPath);
  } catch (e) {
    return { ok: false, code: 'renameFailed', message: e.code || e.message };
  }
  db.renameFile(p, newPath, newName);
  return { ok: true, path: newPath, name: newName };
});

// ---- safe delete: always the OS trash (never permanent), only things we indexed, never protected dirs ----

function isProtectedDir(p) {
  const r = path.resolve(p);
  const root = path.parse(r).root;
  if (r === root) return true;
  const rel = r.slice(root.length).split(path.sep).filter(Boolean);
  if (rel.length < 2) return true; // /home, C:\Users, C:\Windows ...
  const inside = (outer, inner) => inner === outer || inner.startsWith(outer + path.sep);
  const guarded = [os.homedir(), app.getPath('userData')];
  for (const n of ['documents', 'desktop', 'downloads', 'music', 'pictures', 'videos']) {
    try { guarded.push(app.getPath(n)); } catch {}
  }
  // the folder itself must not be (or contain) the home dir, user data, or a standard user folder
  if (guarded.slice(0, 2).some((g) => inside(r, g))) return true;
  if (guarded.slice(2).some((g) => g === r)) return true;
  const first = rel[0].toLowerCase();
  const system = process.platform === 'win32'
    ? ['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information']
    : ['usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'boot', 'etc', 'proc', 'sys', 'dev', 'run', 'var', 'snap'];
  return system.includes(first);
}

ipcMain.handle('file:trash', async (_e, p) => {
  if (scan) return { ok: false, code: 'scanning' };
  if (typeof p !== 'string' || !db.hasPath(p)) return { ok: false, code: 'notIndexed' };
  if (!(await exists(p))) {
    db.removeByPath(p); // stale row
    return { ok: false, code: 'missing' };
  }
  try {
    await shell.trashItem(p);
  } catch (e) {
    return { ok: false, code: 'trash', message: e.message };
  }
  db.removeByPath(p);
  return { ok: true };
});

ipcMain.handle('folder:trash', async (_e, p) => {
  if (scan) return { ok: false, code: 'scanning' };
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, code: 'notIndexed' };
  if (isProtectedDir(p)) return { ok: false, code: 'protected' };
  if (db.folderStats(p).n === 0) return { ok: false, code: 'notIndexed' };
  if (!(await exists(p))) {
    db.deleteUnder(p);
    return { ok: false, code: 'missing' };
  }
  try {
    await shell.trashItem(p);
  } catch (e) {
    return { ok: false, code: 'trash', message: e.message };
  }
  const removed = db.deleteUnder(p);
  return { ok: true, removed };
});

// Icons are cached per extension; the renderer passes the path of a visible row of that ext.
ipcMain.handle('icon:get', async (_e, ext, p) => {
  if (iconCache.has(ext)) return iconCache.get(ext);
  try {
    const img = await app.getFileIcon(p, { size: 'small' });
    if (img.isEmpty()) return null;
    const url = img.toDataURL();
    iconCache.set(ext, url);
    return url;
  } catch {
    return null;
  }
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  // The app used to be called "File Finder" (userData folder "file-finder"). Copy its database and settings
  // into the new folder once, so nothing has to be rescanned or re-indexed.
  function migrateLegacyData() {
    if (app.commandLine.hasSwitch('user-data-dir')) return; // tests / custom locations
    const dir = app.getPath('userData');
    const legacy = path.join(app.getPath('appData'), 'file-finder');
    if (legacy === dir || fs.existsSync(path.join(dir, 'files.db')) || !fs.existsSync(path.join(legacy, 'files.db'))) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of ['files.db', 'files.db-wal', 'files.db-shm', 'settings.json']) {
        const src = path.join(legacy, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
      }
    } catch (e) {
      console.error('legacy data migration failed:', e.message);
    }
  }

  app.whenReady().then(() => {
    migrateLegacyData();
    db.open(app.getPath('userData'));
    settings.load(app.getPath('userData'));
    nativeTheme.themeSource = settings.get().theme;
    createWindow();
    updateTray();

    const sch = settings.get().schedule;
    if (sch.mode === 'startup') setTimeout(runScheduled, 3000);
    setTimeout(checkSchedule, 5000);
    // check for a newer release shortly after start and then every few hours (the once-a-day limit is inside updates.js)
    setTimeout(() => updates.checkAuto(), !app.isPackaged && process.env.FF_UPDATE_DELAY_MS ? +process.env.FF_UPDATE_DELAY_MS : 15000);
    setInterval(() => updates.checkAuto(), 6 * 60 * 60 * 1000);
    setInterval(checkSchedule, 60 * 1000);

    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });

  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    if (scan) scan.worker.terminate();
    indexer.shutdown();
    db.close();
  });
}
