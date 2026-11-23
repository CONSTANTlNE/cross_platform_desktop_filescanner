const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const db = require('./db');

let win = null;
let scan = null; // { worker, roots, start, found, stopped }
const iconCache = new Map(); // ext -> data URL

const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
};

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 760,
    minHeight: 400,
    title: 'File Finder',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
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
  if (scan) return { ok: false, error: 'A scan is already running' };
  const roots = await getRoots(mode, folder);
  if (!roots.length) return { ok: false, error: 'Nothing to scan' };

  const worker = new Worker(path.join(__dirname, 'scanner-worker.js'), { workerData: { roots } });
  const s = (scan = { worker, roots, start: Date.now(), found: 0, stopped: false });
  let finished = false;

  const finish = (extra) => {
    if (finished) return;
    finished = true;
    scan = null;
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

// ---------- IPC ----------

ipcMain.handle('files:query', (_e, q) => db.query(q || {}));
ipcMain.handle('files:count', (_e, q) => db.count(q || {}));
ipcMain.handle('files:total', () => db.total());
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
  if (typeof p !== 'string' || !(await exists(p))) return { ok: false, error: 'File no longer exists' };
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('file:showInFolder', async (_e, p) => {
  if (typeof p !== 'string' || !(await exists(p))) return { ok: false, error: 'File no longer exists' };
  shell.showItemInFolder(p);
  return { ok: true };
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

app.whenReady().then(() => {
  db.open(app.getPath('userData'));
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (scan) scan.worker.terminate();
  db.close();
  app.quit();
});
