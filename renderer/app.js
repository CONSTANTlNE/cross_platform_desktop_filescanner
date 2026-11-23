(() => {
  const ROW_H = 28;
  const PAGE = 200;
  const OVERSCAN = 6;
  const $ = (id) => document.getElementById(id);
  const el = {
    scan: $('btnScan'), stop: $('btnStop'), folder: $('btnFolder'), all: $('btnAll'), scope: $('scope'),
    search: $('search'), chips: $('chips'), progress: $('progress'), progressText: $('progressText'),
    header: $('header'), viewport: $('viewport'), spacer: $('spacer'), rows: $('rows'),
    empty: $('empty'), status: $('status'), toast: $('toast'),
  };

  const state = {
    search: '', exts: new Set(), sort: 'name', dir: 'asc',
    total: 0, dbTotal: 0, selected: null, scanning: false,
    scanFolder: null, // null = all drives
  };
  let pages = new Map(); // page index -> rows
  let inflight = new Set();
  let gen = 0;

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (n) => {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  };
  const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  let toastTimer;
  function toast(msg, ok) {
    el.toast.textContent = msg;
    el.toast.className = ok ? 'ok' : '';
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 3500);
  }
  const currentQuery = () => ({ search: state.search, exts: [...state.exts], sort: state.sort, dir: state.dir });

  // ---------- icons (lazy, cached per extension) ----------
  const icons = new Map(); // ext -> data URL | null (null = use badge)
  const iconPending = new Set();
  function wantIcon(row) {
    if (icons.has(row.ext) || iconPending.has(row.ext)) return;
    iconPending.add(row.ext);
    window.api.getIcon(row.ext, row.path).then((url) => {
      iconPending.delete(row.ext);
      icons.set(row.ext, url);
      if (url) render();
    });
  }

  // ---------- virtual list ----------
  function visibleRange() {
    const top = el.viewport.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(state.total - 1, Math.ceil((top + el.viewport.clientHeight) / ROW_H) + OVERSCAN);
    return { first, last };
  }

  async function fetchPage(p, g) {
    const key = p;
    if (pages.has(p) || inflight.has(key)) return;
    inflight.add(key);
    try {
      const rows = await window.api.query({ ...currentQuery(), offset: p * PAGE, limit: PAGE });
      if (g === gen) { pages.set(p, rows); render(); }
    } finally {
      inflight.delete(key);
    }
  }

  function ensureVisible() {
    if (!state.total) return;
    const { first, last } = visibleRange();
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) fetchPage(p, gen);
  }

  function rowHtml(i) {
    const r = pages.get(Math.floor(i / PAGE))?.[i % PAGE];
    if (!r) return '<div class="row loading"><div></div><div>…</div></div>';
    wantIcon(r);
    const url = icons.get(r.ext);
    const icon = url ? `<img class="icon" src="${url}" alt="">` : `<span class="badge ${esc(r.ext)}"></span>`;
    return `<div class="row${state.selected === r.id ? ' sel' : ''}" data-i="${i}" data-id="${r.id}">
      <div>${icon}</div>
      <div title="${esc(r.name)}">${esc(r.name)}</div>
      <div>${esc(r.ext)}</div>
      <div class="right">${fmtSize(r.size)}</div>
      <div>${fmtDate(r.modified_at)}</div>
      <div title="${esc(r.folder)}">${esc(r.folder)}</div>
      <div><button class="open" data-act="folder" title="Show in folder">&#128193;</button></div>
    </div>`;
  }

  let raf = 0;
  function render() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const { first, last } = visibleRange();
      let html = '';
      for (let i = first; i <= last; i++) html += rowHtml(i);
      el.rows.style.top = first * ROW_H + 'px';
      el.rows.innerHTML = html;
      el.header.style.setProperty('--sbw', el.viewport.offsetWidth - el.viewport.clientWidth + 'px');
    });
  }

  function updateStatus() {
    const f = state.search || state.exts.size ? ` (of ${state.dbTotal.toLocaleString()})` : '';
    el.status.textContent = `${state.total.toLocaleString()} files${f}`;
    el.empty.hidden = state.total > 0;
    el.empty.textContent = state.dbTotal ? 'No matching files' : 'No files yet. Press Scan.';
    el.scan.textContent = state.dbTotal ? 'Rescan' : 'Scan';
  }

  // Re-run the query. keepScroll keeps the position (used while a scan streams in rows).
  async function reload(keepScroll) {
    const g = ++gen;
    const q = currentQuery();
    const [total, dbTotal] = await Promise.all([window.api.count(q), window.api.total()]);
    if (g !== gen) return;
    if (!keepScroll) el.viewport.scrollTop = 0;
    const maxTop = Math.max(0, total * ROW_H - el.viewport.clientHeight);
    const top = Math.min(el.viewport.scrollTop, maxTop);
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(total - 1, Math.ceil((top + el.viewport.clientHeight) / ROW_H) + OVERSCAN);
    const fresh = new Map();
    const ps = [];
    for (let p = Math.floor(first / PAGE); total && p <= Math.floor(last / PAGE); p++) {
      ps.push(window.api.query({ ...q, offset: p * PAGE, limit: PAGE }).then((rows) => fresh.set(p, rows)));
    }
    await Promise.all(ps);
    if (g !== gen) return;
    pages = fresh;
    inflight.clear();
    state.total = total;
    state.dbTotal = dbTotal;
    el.spacer.style.height = total * ROW_H + 'px';
    updateStatus();
    render();
  }

  // ---------- events ----------
  el.viewport.addEventListener('scroll', () => { ensureVisible(); render(); });
  window.addEventListener('resize', () => { ensureVisible(); render(); });

  el.rows.addEventListener('click', (e) => {
    const row = e.target.closest('.row[data-i]');
    if (!row) return;
    const r = pages.get(Math.floor(row.dataset.i / PAGE))?.[row.dataset.i % PAGE];
    if (!r) return;
    if (e.target.closest('[data-act="folder"]')) return showInFolder(r);
    state.selected = r.id;
    render();
  });
  el.rows.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-i]');
    if (!row || e.target.closest('button')) return;
    const r = pages.get(Math.floor(row.dataset.i / PAGE))?.[row.dataset.i % PAGE];
    if (r) openFile(r);
  });

  async function openFile(r) {
    const res = await window.api.openFile(r.path);
    if (!res.ok) toast(`${res.error}: ${r.name}`);
  }
  async function showInFolder(r) {
    const res = await window.api.showInFolder(r.path);
    if (!res.ok) toast(`${res.error}: ${r.name}`);
  }

  let searchTimer;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.search = el.search.value; reload(false); }, 80);
  });

  el.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const ext = chip.dataset.ext;
    state.exts.has(ext) ? state.exts.delete(ext) : state.exts.add(ext);
    chip.classList.toggle('on', state.exts.has(ext));
    reload(false);
  });

  el.header.addEventListener('click', (e) => {
    const h = e.target.closest('.sortable');
    if (!h) return;
    const key = h.dataset.sort;
    state.dir = state.sort === key && state.dir === 'asc' ? 'desc' : 'asc';
    state.sort = key;
    el.header.querySelectorAll('.sortable').forEach((n) => n.classList.remove('asc', 'desc'));
    h.classList.add(state.dir);
    reload(false);
  });

  // ---------- scanning ----------
  function setScope(folder) {
    state.scanFolder = folder;
    el.scope.textContent = folder || 'All drives';
    el.scope.title = folder || 'All drives';
    el.all.hidden = !folder;
    try { folder ? localStorage.setItem('scanFolder', folder) : localStorage.removeItem('scanFolder'); } catch {}
  }
  el.folder.addEventListener('click', async () => {
    const f = await window.api.pickFolder();
    if (f) setScope(f);
  });
  el.all.addEventListener('click', () => setScope(null));

  function setScanning(on) {
    state.scanning = on;
    el.scan.disabled = on;
    el.stop.disabled = !on;
    el.folder.disabled = on;
    el.all.disabled = on;
    el.progress.hidden = !on;
  }

  el.scan.addEventListener('click', async () => {
    const res = await window.api.startScan(state.scanFolder ? { mode: 'folder', folder: state.scanFolder } : { mode: 'all' });
    if (!res.ok) return toast(res.error);
    el.progressText.textContent = 'Starting…';
    setScanning(true);
  });
  el.stop.addEventListener('click', () => window.api.stopScan());

  let reloadTimer = 0;
  window.api.on('scan:inserted', () => {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => { reloadTimer = 0; reload(true); }, 1000);
  });
  window.api.on('scan:progress', ({ found, folder }) => {
    el.progressText.textContent = `${found.toLocaleString()} files found — ${folder}`;
  });
  window.api.on('scan:done', ({ found, stopped, removed }) => {
    setScanning(false);
    reload(true);
    toast(
      stopped ? `Scan stopped (${found.toLocaleString()} files found)` : `Scan complete: ${found.toLocaleString()} files, ${(removed || 0).toLocaleString()} removed`,
      true
    );
  });
  window.api.on('scan:error', ({ message }) => toast('Scan error: ' + message));

  // ---------- init: show what is already in the DB ----------
  (async () => {
    try { const f = localStorage.getItem('scanFolder'); if (f) setScope(f); } catch {}
    el.header.querySelector('[data-sort="name"]').classList.add('asc');
    await reload(false);
    const st = await window.api.scanStatus();
    if (st.running) setScanning(true);
  })();
})();
