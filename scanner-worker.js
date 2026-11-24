// Runs in a worker thread. Walks the given roots and streams matches to the main process.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';
const EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.pdf']);
const IMG = new Set(workerData.images ? workerData.images.exts.map((e) => '.' + e) : []);
const IMG_MIN = workerData.images ? workerData.images.minBytes : 0;
const BATCH_SIZE = 500;
const PROGRESS_MS = 100;

// Skip rules come from the main process (skip-rules.js + user settings).
// Windows paths are compared lowercase with the drive letter stripped.
const SKIP_NAMES = new Set(workerData.skip.names);
const SKIP_ABS = new Set(workerData.skip.abs);
const SKIP_SUFFIX = workerData.skip.suffix;

function shouldSkip(fullPath, name) {
  if (SKIP_NAMES.has(isWin ? name.toLowerCase() : name)) return true;
  if (isWin) {
    const p = fullPath.toLowerCase().replace(/^[a-z]:/, '');
    return SKIP_ABS.has(p) || SKIP_SUFFIX.some((s) => p.endsWith(s));
  }
  return SKIP_ABS.has(fullPath);
}

let stopped = false;
parentPort.on('message', (m) => {
  if (m === 'stop') stopped = true;
});

let batch = [];
let found = 0;
let currentDir = '';
let lastProgress = 0;

function flush() {
  if (batch.length) {
    parentPort.postMessage({ type: 'batch', files: batch });
    batch = [];
  }
}

function progress(force) {
  const now = Date.now();
  if (force || now - lastProgress >= PROGRESS_MS) {
    lastProgress = now;
    parentPort.postMessage({ type: 'progress', found, folder: currentDir });
  }
}

async function statFile(dir, name) {
  const full = path.join(dir, name);
  try {
    const st = await fs.promises.stat(full);
    if (IMG.has(path.extname(name).toLowerCase()) && st.size < IMG_MIN) return;
    batch.push({
      path: full,
      name,
      ext: path.extname(name).slice(1).toLowerCase(),
      size: st.size,
      modified_at: Math.round(st.mtimeMs),
      folder: dir,
    });
    found++;
  } catch {
    // EPERM / EACCES / ENOENT: ignore
  }
}

async function walk(roots) {
  const stack = [...roots];
  while (stack.length && !stopped) {
    const dir = stack.pop();
    currentDir = dir;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // EPERM / EACCES / ENOENT
    }
    const hits = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        const full = path.join(dir, e.name);
        if (!shouldSkip(full, e.name)) stack.push(full);
      } else if (e.isFile()) {
        // "~$x.docx" are Office lock files, not real documents
        const x = path.extname(e.name).toLowerCase();
        if ((EXTS.has(x) || IMG.has(x)) && !e.name.startsWith('~$')) hits.push(e.name);
      }
    }
    if (hits.length) await Promise.all(hits.map((n) => statFile(dir, n)));
    if (batch.length >= BATCH_SIZE) flush();
    progress(false);
  }
  flush();
  progress(true);
  parentPort.postMessage({ type: 'done', stopped, found });
  parentPort.close(); // otherwise the 'message' listener keeps the worker thread alive
}

walk(workerData.roots).catch((err) => {
  flush();
  parentPort.postMessage({ type: 'error', message: String(err && err.message || err) });
});
