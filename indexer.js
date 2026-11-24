// Background content indexer (main process side). A separate step from scanning: it reads the text of
// every indexed document that is new or changed and stores it in the content FTS table.
// Extraction happens in a small pool of long-lived worker threads (content-worker.js) with a
// per-file timeout and memory limit; a crashed or stuck worker only fails that one file.
const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const POOL_SIZE = Math.max(1, Math.min(2, os.cpus().length - 1));
const TASK_TIMEOUT_MS = 90 * 1000;
const REFILL = 500;
const FLUSH_EVERY = 25;
const PROGRESS_MS = 250;
const MIN_PDF_CHARS = 20; // fewer characters than this in a PDF = no text layer (scanned/picture PDF)

function createIndexer({ db, getMaxBytes, send, onDone }) {
  let run = null;

  function spawn(slot) {
    const w = new Worker(path.join(__dirname, 'content-worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    slot.worker = w;
    slot.task = null;
    w.on('message', (m) => onResult(slot, w, m));
    w.on('error', (e) => onFail(slot, w, e.message));
    w.on('exit', () => {
      if (run && slot.worker === w && slot.task) onFail(slot, w, 'worker exited');
    });
  }

  function record(t, m) {
    let state;
    let text = null;
    let note = null;
    let chars = 0;
    if (m.ok) {
      chars = m.chars;
      if (m.chars >= (t.ext === 'pdf' ? MIN_PDF_CHARS : 1)) {
        state = 'ok';
        text = m.text;
        run.ok++;
      } else {
        state = 'empty';
        run.empty++;
      }
    } else {
      state = 'error';
      note = m.note;
      run.error++;
    }
    run.results.push({ id: t.id, state, mtime: t.mtime, size: t.size, text, chars, note });
    run.done++;
    run.current = t.name;
    if (run.results.length >= FLUSH_EVERY || Date.now() - run.lastFlush > 2000) flush();
    progress(false);
  }

  function onResult(slot, w, m) {
    if (!run || slot.worker !== w || !slot.task) return;
    clearTimeout(slot.timer);
    const t = slot.task;
    slot.task = null;
    record(t, m);
    pump();
  }

  function onFail(slot, w, message) {
    if (!run || slot.worker !== w) return;
    clearTimeout(slot.timer);
    const t = slot.task;
    slot.task = null;
    if (t) record(t, { ok: false, note: message });
    w.terminate().catch(() => {});
    spawn(slot); // fresh worker for the next file
    pump();
  }

  function refill() {
    const rows = db.pendingBatch(run.lastId, REFILL, run.maxBytes);
    if (!rows.length) run.exhausted = true;
    else {
      run.lastId = rows[rows.length - 1].id;
      run.queue = rows;
    }
  }

  function nextTask() {
    for (;;) {
      if (!run.queue.length) {
        if (run.exhausted) return null;
        refill();
        if (!run.queue.length) return null;
      }
      const f = run.queue.shift();
      if (f.size > run.maxBytes) {
        run.results.push({ id: f.id, state: 'toobig', mtime: f.modified_at, size: f.size, text: null, chars: 0, note: null });
        run.tooBig++;
        run.done++;
        continue;
      }
      return { id: f.id, path: f.path, ext: f.ext, name: f.name, mtime: f.modified_at, size: f.size };
    }
  }

  function pump() {
    if (!run || run.finishing) return;
    for (const slot of run.slots) {
      if (slot.task) continue;
      const t = nextTask();
      if (!t) break;
      slot.task = t;
      slot.timer = setTimeout(() => onFail(slot, slot.worker, 'timeout'), TASK_TIMEOUT_MS);
      slot.worker.postMessage({ id: t.id, path: t.path, ext: t.ext });
    }
    if (!run.slots.some((s) => s.task) && !run.queue.length && run.exhausted) finish(false);
  }

  function flush() {
    if (!run) return;
    run.lastFlush = Date.now();
    if (!run.results.length) return;
    try {
      db.saveContent(run.results);
    } catch (e) {
      send('scan:error', { message: 'Index write failed: ' + e.message });
    }
    run.results = [];
  }

  let lastProgress = 0;
  function progress(force) {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_MS) return;
    lastProgress = now;
    send('index:progress', { done: run.done, total: Math.max(run.total, run.done), current: run.current });
  }

  function finish(stopped) {
    if (!run) return;
    run.finishing = true;
    flush();
    for (const s of run.slots) {
      clearTimeout(s.timer);
      s.worker.terminate().catch(() => {});
    }
    const stats = { total: Math.max(run.total, run.done), done: run.done, ok: run.ok, empty: run.empty, error: run.error, tooBig: run.tooBig, stopped };
    run = null;
    send('index:done', stats);
    if (onDone) onDone(stats);
  }

  return {
    start() {
      if (run) return { ok: false, code: 'busy' };
      const maxBytes = getMaxBytes();
      const total = db.pendingCount(maxBytes);
      if (!total) return { ok: false, code: 'nothing' };
      run = { total, done: 0, ok: 0, empty: 0, error: 0, tooBig: 0, current: '', maxBytes, queue: [], lastId: 0, exhausted: false,
              results: [], lastFlush: Date.now(), finishing: false, slots: [] };
      for (let i = 0; i < POOL_SIZE; i++) {
        const slot = { worker: null, task: null, timer: null };
        run.slots.push(slot);
        spawn(slot);
      }
      pump();
      return { ok: true, total };
    },
    stop: () => finish(true), // unfinished files simply stay "pending" and are picked up next time
    status: () => (run ? { running: true, done: run.done, total: Math.max(run.total, run.done), current: run.current } : { running: false }),
    running: () => !!run,
    shutdown() {
      if (!run) return;
      run.finishing = true;
      flush();
      for (const s of run.slots) s.worker.terminate().catch(() => {});
      run = null;
    },
  };
}

module.exports = { createIndexer };
