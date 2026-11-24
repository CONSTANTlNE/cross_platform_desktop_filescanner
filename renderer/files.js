// Files tab: toolbar, scanning, virtual list, column resize, folder tree.
(() => {
  const ROW_H = 28;
  const PAGE = 200;
  const OVERSCAN = 6;
  const MIN_COL = 40;
  const $ = (id) => document.getElementById(id);
  const el = {
    scan: $('btnScan'), stop: $('btnStop'), folder: $('btnFolder'), all: $('btnAll'), scope: $('scope'),
    search: $('search'), chips: $('chips'), view: $('viewSwitch'), progress: $('progress'), progressText: $('progressText'),
    table: $('table'), header: $('header'), viewport: $('viewport'), spacer: $('spacer'), rows: $('rows'),
    empty: $('empty'), status: $('status'), tree: $('tree'), treeBody: $('treeBody'), treeSearch: $('treeSearch'),
  };
  const App = window.App;
  const t = (k, p) => App.t(k, p);

  const state = {
    search: '', exts: new Set(), sort: 'name', dir: 'asc',
    total: 0, dbTotal: 0, selected: null, scanning: false,
    sel: new Set(), anchor: null, // multi-select: ids + anchor index for Shift-ranges
    cfilter: 'all', // content-index filter (all | ok | notok | pending | empty | error | toobig)
    multi: false, // true once the selection was built with checkboxes / Ctrl / Shift: plain clicks then toggle instead of replacing
    folder: null, // folder selected in the tree (null = all files)
  };
  let pages = new Map(); // page index -> rows
  let inflight = new Set();
  let gen = 0;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ui = () => App.settings.ui;
  const inFolderView = () => ui().view === 'folders';

  function currentQuery() {
    const q = { search: state.search, exts: [...state.exts], sort: state.sort, dir: state.dir, mode: ui().searchMode };
    if (state.cfilter !== 'all') q.cfilter = state.cfilter;
    if (inFolderView() && state.folder) { q.folder = state.folder; q.recursive = true; } // a folder always includes its subfolders
    return q;
  }

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
  function visibleRange(total = state.total) {
    const top = el.viewport.scrollTop;
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(total - 1, Math.ceil((top + el.viewport.clientHeight) / ROW_H) + OVERSCAN);
    return { first, last };
  }

  async function fetchPage(p, g) {
    if (pages.has(p) || inflight.has(p)) return;
    inflight.add(p);
    try {
      const rows = await window.api.query({ ...currentQuery(), offset: p * PAGE, limit: PAGE });
      if (g === gen) { pages.set(p, rows); render(); }
    } finally {
      inflight.delete(p);
    }
  }

  function ensureVisible() {
    if (!state.total) return;
    const { first, last } = visibleRange();
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) fetchPage(p, gen);
  }

  // ---------- selection (single + multi) ----------
  // The quick view panel (preview.js) listens to 'fileselect': detail = {row (single selection only), count}.
  const emitSelect = (r) => document.dispatchEvent(new CustomEvent('fileselect', { detail: { row: r || null, count: r ? 1 : 0 } }));
  function emitSelection() {
    const n = state.sel.size;
    let r = null;
    if (n === 1) {
      const id = [...state.sel][0];
      for (const rows of pages.values()) { r = rows.find((x) => x.id === id) || null; if (r) break; }
    }
    document.dispatchEvent(new CustomEvent('fileselect', { detail: { row: r, count: n } }));
  }
  function updateSelUi() {
    const n = state.sel.size;
    $('selbar').hidden = n < 2;
    $('selCount').textContent = t('sel.count', { n: App.fmtNum(n) });
    $('selTrash').textContent = t('delete.tooltip') + '…';
    const all = $('selAll');
    all.checked = n > 0 && n === state.total;
    all.indeterminate = n > 0 && n < state.total;
    updateStatus();
  }
  function selectionChanged() {
    updateSelUi();
    emitSelection();
    render();
  }
  function selectRow(r) {
    state.sel = new Set(r ? [r.id] : []);
    state.selected = r ? r.id : null;
    state.multi = false;
    state.anchor = r ? currentIndex() : null;
    selectionChanged();
  }
  function toggleRow(r, idx) {
    state.sel.has(r.id) ? state.sel.delete(r.id) : state.sel.add(r.id);
    state.selected = r.id;
    state.anchor = idx;
    state.multi = state.sel.size > 0;
    selectionChanged();
  }
  async function rangeSelect(a, b, additive) {
    const lo = Math.min(a, b);
    const ids = await window.api.ids({ ...currentQuery(), offset: lo, limit: Math.abs(a - b) + 1 });
    if (!additive) state.sel = new Set();
    ids.forEach((i) => state.sel.add(i));
    state.multi = true;
    const r = rowAt(b);
    if (r) state.selected = r.id;
    selectionChanged();
  }
  async function selectAll() {
    state.sel = new Set(await window.api.ids(currentQuery()));
    state.multi = state.sel.size > 0;
    selectionChanged();
  }
  function clearSelection(emit = true) {
    if (!state.sel.size && state.selected == null) return;
    state.sel = new Set();
    state.selected = null;
    state.anchor = null;
    state.multi = false;
    emit ? selectionChanged() : updateSelUi();
  }
  function currentIndex() {
    for (const [p, rows] of pages) {
      const k = rows.findIndex((x) => x.id === state.selected);
      if (k >= 0) return p * PAGE + k;
    }
    return -1;
  }

  // content-search snippet: hits are wrapped in U+0001 / U+0002 by the database
  const hit = (s) => esc(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');

  // content-search status icons (one per file): see cstate.* tooltips
  const SVG = (inner) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  const CSTATE_ICON = {
    ok: SVG('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/>'),
    pending: SVG('<circle cx="12" cy="12" r="9" stroke-dasharray="3.2 3.2"/>'),
    empty: SVG('<path d="M12 3.5l10 17.5H2z"/><path d="M12 10v5M12 18.2v.3"/>'),
    error: SVG('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
    toobig: SVG('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  };

  const rowAt = (i) => pages.get(Math.floor(i / PAGE))?.[i % PAGE];

  function rowHtml(i) {
    const r = rowAt(i);
    if (!r) return '<div class="row loading"><div></div><div></div><div>…</div></div>';
    wantIcon(r);
    const url = icons.get(r.ext);
    const icon = url ? `<img class="icon" src="${url}" alt="">` : `<span class="badge ${esc(r.ext)}"></span>`;
    const on = state.sel.has(r.id);
    return `<div class="row${on ? ' sel' : ''}" data-i="${i}">
      <div class="chk"><input type="checkbox" data-act="check"${on ? ' checked' : ''}></div>
      <div>${icon}</div>
      <div title="${esc(r.name)}">${esc(r.name)}</div>
      <div class="ci ci-${r.cstate}" title="${esc(t('cstate.' + r.cstate))}">${CSTATE_ICON[r.cstate] || ''}</div>
      <div>${esc(r.ext)}</div>
      <div class="right">${App.fmtSize(r.size)}</div>
      <div>${App.fmtDate(r.modified_at)}</div>
      <div title="${esc(r.folder)}">${r.snippet ? hit(r.snippet) : esc(r.folder)}</div>
      <div><button class="open" data-act="folder" title="${esc(t('row.showFolder'))}">&#128193;</button><button class="open" data-act="rename" title="${esc(t('rename.tooltip'))}">&#9998;</button><button class="open" data-act="trash" title="${esc(t('delete.tooltip'))}">&#128465;</button></div>
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
    const filtered = state.search || state.exts.size || (inFolderView() && state.folder);
    el.status.textContent = filtered
      ? t('status.filesOf', { n: App.fmtNum(state.total), total: App.fmtNum(state.dbTotal) })
      : t('status.files', { n: App.fmtNum(state.total) });
    if (state.sel.size > 1) el.status.textContent += ' · ' + t('sel.count', { n: App.fmtNum(state.sel.size) });
    el.empty.hidden = state.total > 0;
    const noIndex = ui().searchMode === 'content' && state.search && App.indexStats && App.indexStats.ok === 0;
    el.empty.textContent = noIndex ? t('empty.noIndex') : state.dbTotal ? t('empty.none') : t('empty.noFiles');
    el.scan.textContent = state.dbTotal ? t('btn.rescan') : t('btn.scan');
  }

  // Re-run the query. keepScroll keeps the position (used while a scan streams in rows).
  // Spinner in the search box when a query takes longer than ~120 ms (big content searches).
  let busyTimer = 0;
  let busyTicket = 0;
  async function reload(keepScroll) {
    const ticket = ++busyTicket;
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => ($('searchSpin').hidden = false), 120);
    try {
      await reloadCore(keepScroll);
    } finally {
      if (ticket === busyTicket) { // only the newest request decides when the spinner stops
        clearTimeout(busyTimer);
        $('searchSpin').hidden = true;
      }
    }
  }

  async function reloadCore(keepScroll) {
    const g = ++gen;
    if (!keepScroll) clearSelection(true); // a changed query must never leave invisible files selected
    const q = currentQuery();
    const [total, dbTotal] = await Promise.all([window.api.count(q), window.api.total()]);
    if (g !== gen) return;
    if (!keepScroll) el.viewport.scrollTop = 0;
    const { first, last } = visibleRange(total);
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
    updateSelUi(); // also refreshes the status text and the select-all checkbox
    render();
  }

  // ---------- list events ----------
  el.viewport.addEventListener('scroll', () => { ensureVisible(); render(); });
  window.addEventListener('resize', () => { ensureVisible(); render(); applyWidths(); applyNarrow(); });

  el.rows.addEventListener('click', (e) => {
    const row = e.target.closest('.row[data-i]');
    const r = row && rowAt(+row.dataset.i);
    if (!r) return;
    if (e.target.closest('[data-act="folder"]')) return fileAction('showInFolder', r);
    if (e.target.closest('[data-act="rename"]')) return renameFile(r);
    if (e.target.closest('[data-act="trash"]')) return trashFile(r);
    const idx = +row.dataset.i;
    if (e.target.closest('[data-act="check"]')) return toggleRow(r, idx);
    if (e.shiftKey && state.anchor != null) return rangeSelect(state.anchor, idx, e.ctrlKey || e.metaKey);
    if (e.ctrlKey || e.metaKey) return toggleRow(r, idx);
    // an accidental click on a row must not wipe a selection that was built on purpose
    if (state.multi && state.sel.size) return toggleRow(r, idx);
    selectRow(r);
  });
  el.rows.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row[data-i]');
    const r = row && rowAt(+row.dataset.i);
    if (r && !e.target.closest('button')) fileAction('openFile', r);
  });

  async function fileAction(fn, r) {
    const res = await window.api[fn](r.path);
    if (res.ok) return;
    const msg = res.code === 'missing' ? t('err.missing') : t('err.open') + (res.message ? ': ' + res.message : '');
    App.toast(`${msg}: ${r.name}`);
  }

  // ---------- delete (always to the OS trash, after a confirmation modal) ----------
  const trashError = (res, name) => {
    const code = res.code;
    const known = ['missing', 'protected', 'notIndexed', 'scanning', 'trash'];
    const base = known.includes(code) ? t('err.' + code) : t('err.trash');
    App.toast(`${base}${res.message ? ': ' + res.message : ''}${name ? ' — ' + name : ''}`);
  };

  async function trashFile(r) {
    const ok = await App.confirm({
      title: t('delete.fileTitle'), name: r.name, path: r.path,
      body: t('delete.fileBody'), okLabel: t('delete.confirm'),
    });
    if (!ok) return;
    const res = await window.api.trashFile(r.path);
    if (!res.ok) trashError(res, r.name);
    else {
      App.toast(t('toast.deleted', { name: r.name }), true);
      if (state.selected === r.id) selectRow(null);
    }
    await reload(true);
    refreshTree();
  }

  // ---------- rename (extension stays fixed; main validates and never overwrites) ----------
  async function renameFile(r) {
    const dot = r.name.lastIndexOf('.');
    const ext = dot > 0 ? r.name.slice(dot) : '';
    const base = ext ? r.name.slice(0, dot) : r.name;
    let result = null;
    const entered = await App.confirm({
      title: t('rename.title'), name: r.name, path: r.folder, body: t('rename.hint'),
      okLabel: t('rename.confirm'), danger: false, input: { value: base, suffix: ext },
      submit: async (v) => {
        const res = await window.api.renameFile(r.path, v);
        if (res.ok) { result = res; return null; }
        const key = { invalidName: 'err.invalidName', exists: 'err.exists', missing: 'err.missing', scanning: 'err.scanning',
                      notIndexed: 'err.notIndexed' }[res.code] || 'err.renameFailed';
        return t(key) + (res.code === 'renameFailed' && res.message ? ` (${res.message})` : '');
      },
    });
    if (entered === null || !result) return;
    if (!result.unchanged) App.toast(t('toast.renamed', { name: result.name }), true);
    await reload(true);
    refreshTree();
    // keep the preview on the renamed file (same row id, new path/name)
    const id = r.id;
    for (const rows of pages.values()) {
      const nr = rows.find((x) => x.id === id);
      if (nr) { state.selected = id; emitSelect(nr); render(); break; }
    }
  }

  // Delete everything that is selected (always to the OS trash; main resolves ids to indexed paths).
  async function trashSelected() {
    const ids = [...state.sel];
    if (ids.length < 2) return;
    const info = await window.api.describeFiles(ids);
    if (!info.count) return;
    const more = info.count - info.names.length;
    const ok = await App.confirm({
      title: t('delete.manyTitle', { n: App.fmtNum(info.count) }),
      name: info.names.join('\n') + (more > 0 ? '\n' + t('delete.more', { n: App.fmtNum(more) }) : ''),
      body: t('delete.manyBody', { size: App.fmtSize(info.size) }),
      okLabel: t('delete.manyConfirm', { n: App.fmtNum(info.count) }),
    });
    if (!ok) return;
    const res = await window.api.trashMany(ids);
    if (!res.ok) trashError(res);
    else if (res.failedCount) App.toast(t('toast.deletedSome', { done: App.fmtNum(res.done), failed: App.fmtNum(res.failedCount) }));
    else App.toast(t('toast.deletedMany', { n: App.fmtNum(res.done) }), true);
    clearSelection(false);
    await reload(true);
    emitSelection();
    refreshTree();
  }

  $('selTrash').addEventListener('click', trashSelected);
  $('selClear').addEventListener('click', () => clearSelection());
  $('selAll').addEventListener('change', (e) => (e.target.checked ? selectAll() : clearSelection()));
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.tab.active')?.dataset.tab !== 'files') return;
    if (!document.getElementById('modal').hidden || !document.getElementById('ctx').hidden) return;
    if (e.target.closest('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
    else if (e.key === 'Escape' && state.sel.size) clearSelection();
  });

  async function trashFolder(node) {
    const ok = await App.confirm({
      title: t('delete.folderTitle'), name: node.name, path: node.path,
      body: t('delete.folderBody', { n: App.fmtNum(node.count), size: App.fmtSize(node.size) }),
      okLabel: t('delete.confirm'),
    });
    if (!ok) return;
    const res = await window.api.trashFolder(node.path);
    if (!res.ok) trashError(res, node.name);
    else {
      App.toast(t('toast.deleted', { name: node.name }), true);
      const sep = node.path.endsWith('/') || node.path.endsWith('\\') ? '' : (node.path.includes('\\') ? '\\' : '/');
      if (state.folder && (state.folder === node.path || state.folder.startsWith(node.path + sep))) state.folder = null;
    }
    await reload(true);
    refreshTree();
  }

  // Up/Down arrows move the selection (handy with the quick view panel)
  document.addEventListener('keydown', (e) => {
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !state.total) return;
    if (document.querySelector('.tab.active')?.dataset.tab !== 'files' || !document.getElementById('modal').hidden) return;
    if (e.target.closest('input, select, textarea')) return;
    e.preventDefault();
    const cur = currentIndex();
    const idx = Math.min(state.total - 1, Math.max(0, cur < 0 ? 0 : cur + (e.key === 'ArrowDown' ? 1 : -1)));
    const r = rowAt(idx);
    if (!r) return;
    const top = idx * ROW_H;
    if (top < el.viewport.scrollTop) el.viewport.scrollTop = top;
    else if (top + ROW_H > el.viewport.scrollTop + el.viewport.clientHeight) el.viewport.scrollTop = top + ROW_H - el.viewport.clientHeight;
    if (e.shiftKey && state.anchor != null) rangeSelect(state.anchor, idx, false);
    else selectRow(r);
  });

  const copyText = async (text) => {
    await window.api.copyText(text);
    App.toast(t('toast.copied'), true);
  };

  // Right-click menu on a file row
  el.rows.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row[data-i]');
    const r = row && rowAt(+row.dataset.i);
    if (!r) return;
    e.preventDefault();
    if (state.sel.size > 1 && state.sel.has(r.id)) {
      const n = App.fmtNum(state.sel.size);
      return App.contextMenu(e.clientX, e.clientY, [
        { label: t('sel.count', { n }), disabled: true, run: () => {} },
        { sep: true },
        { label: t('ctx.copyPaths'), run: async () => { await window.api.copyPaths([...state.sel]); App.toast(t('toast.copied'), true); } },
        { label: t('sel.clear'), shortcut: 'Esc', run: () => clearSelection() },
        { sep: true },
        { label: t('ctx.trashMany', { n }), shortcut: 'Del', danger: true, run: () => trashSelected() },
      ]);
    }
    selectRow(r);
    App.contextMenu(e.clientX, e.clientY, [
      { label: t('ctx.open'), shortcut: 'Enter', run: () => fileAction('openFile', r) },
      { label: t('row.showFolder'), run: () => fileAction('showInFolder', r) },
      { label: t('preview.toggle'), run: async () => { await App.set({ ui: { preview: true } }); emitSelect(r); } },
      { sep: true },
      { label: t('ctx.copyPath'), run: () => copyText(r.path) },
      { label: t('ctx.copyName'), run: () => copyText(r.name) },
      { sep: true },
      { label: t('rename.tooltip') + '…', shortcut: 'F2', run: () => renameFile(r) },
      { label: t('delete.tooltip') + '…', shortcut: 'Del', danger: true, run: () => trashFile(r) },
    ]);
  });

  // Enter opens the selected row, F2 renames it
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || state.sel.size !== 1 || state.selected == null || document.querySelector('.tab.active')?.dataset.tab !== 'files') return;
    if (!document.getElementById('modal').hidden || e.target.closest('input, select, textarea, button')) return;
    for (const rows of pages.values()) {
      const r = rows.find((x) => x.id === state.selected);
      if (r) { e.preventDefault(); return fileAction('openFile', r); }
    }
  });

  // F2 renames the selected row
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'F2' || state.sel.size !== 1 || state.selected == null || document.querySelector('.tab.active')?.dataset.tab !== 'files') return;
    if (!document.getElementById('modal').hidden || e.target.closest('input, select, textarea')) return;
    for (const rows of pages.values()) {
      const r = rows.find((x) => x.id === state.selected);
      if (r) { e.preventDefault(); return renameFile(r); }
    }
  });

  // Delete key on the selected row
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' || state.selected == null || document.querySelector('.tab.active')?.dataset.tab !== 'files') return;
    if (!document.getElementById('modal').hidden || e.target.closest('input, select, textarea')) return;
    if (state.sel.size > 1) { e.preventDefault(); return trashSelected(); }
    for (const rows of pages.values()) {
      const r = rows.find((x) => x.id === state.selected);
      if (r) return trashFile(r);
    }
  });

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

  // ---------- search mode: names / contents ----------
  function applyMode() {
    const content = ui().searchMode === 'content';
    el.search.placeholder = t(content ? 'search.phContent' : 'search.ph');
    $('colFolder').textContent = t(content ? 'col.match' : 'col.folder');
    $('searchMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === ui().searchMode));
  }
  $('searchMode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.mode !== ui().searchMode) App.set({ ui: { searchMode: b.dataset.mode } });
  });
  // "Show them" in the notice bar (index-ui.js) asks for a filter
  const setCfilter = (v) => {
    state.cfilter = v;
    document.dispatchEvent(new CustomEvent('cfilterstate', { detail: v })); // lets the notice bar swap Show / Cancel
    reload(false);
  };
  document.addEventListener('setcfilter', (e) => setCfilter(e.detail));
  // keep the per-file icons fresh while the indexer works in the background
  let idxTimer = 0;
  window.api.on('index:progress', () => {
    if (idxTimer) return;
    idxTimer = setTimeout(() => { idxTimer = 0; reload(true); }, 2500);
  });
  window.api.on('index:done', () => reload(true));
  document.addEventListener('indexcleared', () => reload(true));

  let lastMode = null;
  document.addEventListener('settings', () => {
    const m = ui().searchMode;
    if (m === lastMode) return;
    const first = lastMode === null;
    lastMode = m;
    applyMode();
    // the "not searchable" filter only exists in Contents mode; never leave it active invisibly
    if (m !== 'content' && state.cfilter !== 'all') return setCfilter('all');
    if (!first && state.search) reload(false); // same words, other index
    else if (!first) updateStatus();
  });
  document.addEventListener('indexstats', () => updateStatus());

  // ---------- sorting ----------
  function markSort() {
    el.header.querySelectorAll('.sortable').forEach((n) => {
      n.classList.toggle('asc', n.dataset.sort === state.sort && state.dir === 'asc');
      n.classList.toggle('desc', n.dataset.sort === state.sort && state.dir === 'desc');
    });
  }
  el.header.addEventListener('click', (e) => {
    if (e.target.closest('.rs')) return;
    const h = e.target.closest('.sortable');
    if (!h) return;
    const key = h.dataset.sort;
    state.dir = state.sort === key && state.dir === 'asc' ? 'desc' : 'asc';
    state.sort = key;
    markSort();
    reload(false);
  });

  // ---------- column resize ----------
  // The stored panel widths may not fit a smaller window: shrink the preview so the table keeps a usable width.
  function applyWidths() {
    const content = $('content');
    const treeW = inFolderView() ? ui().treeWidth : 0;
    const maxPv = Math.max(280, content.clientWidth - treeW - MIN_TABLE);
    content.style.setProperty('--pv-w', Math.min(ui().previewWidth, maxPv) + 'px');
    content.style.setProperty('--tree-w', ui().treeWidth + 'px');
  }

  function applyCols() {
    el.table.style.setProperty('--cols', colsString(ui().cols));
    // Narrow layout used while the quick view panel is open: flexible name column, no folder column.
    const c = ui().cols;
    el.table.style.setProperty('--cols-pv', `24px 28px minmax(100px, 1fr) 28px ${c.ext}px ${c.size}px ${c.modified}px 96px`);
    applyNarrow();
    setTimeout(applyNarrow, 0); // after the other modules (preview panel) have shown/hidden themselves
    applyWidths();
    $('pvSplit').hidden = !ui().preview;
    $('treeSplit').hidden = !inFolderView();
  }
  // Switch to the compact layout when the full set of columns would not fit (tree and/or preview panel open, small window).
  function applyNarrow() {
    const c = ui().cols;
    const need = 24 + 28 + c.name + 28 + c.ext + c.size + c.modified + 120 + 96 + 8 * 8 + 20 + 17; // columns + min folder + gaps + padding + scrollbar
    el.table.classList.toggle('narrow', el.table.clientWidth < need);
  }
  new ResizeObserver(applyNarrow).observe(el.table);

  el.header.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.rs');
    if (!h) return;
    e.preventDefault();
    const col = h.dataset.col;
    const startX = e.clientX;
    const startW = ui().cols[col];
    let w = startW;
    h.setPointerCapture(e.pointerId);
    h.classList.add('drag');
    const move = (ev) => {
      w = Math.max(MIN_COL, Math.min(900, startW + ev.clientX - startX));
      el.table.style.setProperty('--cols', colsString({ ...ui().cols, [col]: w }));
    };
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.classList.remove('drag');
      App.set({ ui: { cols: { [col]: w } } });
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
  const colsString = (c) => `24px 28px ${c.name}px 28px ${c.ext}px ${c.size}px ${c.modified}px minmax(120px, 1fr) 96px`;

  // ---------- folder tree ----------
  let roots = []; // [{path,name,count,size,hasChildren,expanded,children|null}]
  const nodeIndex = new Map(); // path -> node

  function wrap(infos, old, index = nodeIndex) {
    return infos.map((i) => {
      const prev = old.get(i.path);
      const n = { ...i, expanded: !!(prev && prev.expanded), children: null };
      index.set(i.path, n);
      return n;
    });
  }

  async function loadChildren(node, oldIndex, index = nodeIndex) {
    node.children = wrap(await window.api.folderChildren(node.path), oldIndex, index);
    for (const c of node.children) if (c.expanded) await loadChildren(c, oldIndex, index);
  }

  // Re-fetch the whole visible tree, keeping expanded state.
  async function refreshTree() {
    if (!inFolderView()) return;
    const old = new Map(nodeIndex);
    nodeIndex.clear();
    roots = wrap(await window.api.folderChildren(''), old);
    for (const r of roots) if (r.expanded) await loadChildren(r, old);
    // A single top-level node (Linux '/') is more useful opened.
    if (roots.length === 1 && !roots[0].expanded && roots[0].hasChildren) {
      roots[0].expanded = true;
      await loadChildren(roots[0], old);
    }
    if (treeQuery()) runTreeSearch();
    else renderTree();
  }

  // Each row has depth*IND px of vertical guide lines, then arrow, folder icon, name, count/size.
  const IND = 18;
  function nodeHtml(n, depth) {
    const arrow = n.hasChildren ? (n.expanded ? '&#9662;' : '&#9656;') : '';
    const icon = n.expanded && n.children && n.children.length ? '&#128194;' : '&#128193;';
    let html = `<div class="tn${state.folder === n.path ? ' sel' : ''}${n.expanded ? ' open' : ''}" data-path="${esc(n.path)}" title="${esc(n.path)}">
      <span class="guides" data-d="${depth}"></span>
      <span class="arrow" data-act="toggle">${arrow}</span><span class="ficon">${icon}</span><span class="name">${esc(n.name)}</span>
      <span class="meta">${App.fmtNum(n.count)} · ${App.fmtSize(n.size)}</span>${depth > 0 ? `<button class="del" data-act="del" title="${esc(t('delete.tooltip'))}">&#128465;</button>` : ''}</div>`;
    if (n.expanded && n.children) for (const c of n.children) html += nodeHtml(c, depth + 1);
    return html;
  }

  // ----- folder search (flat result list replaces the tree while the box has text) -----
  // Results are mini-trees: each matching folder can be expanded to show its subfolders. They live in their
  // own index so the normal tree keeps its expanded state.
  const searchIndex = new Map(); // path -> node (results and their loaded subfolders)
  let treeResults = []; // root nodes of the result list
  let treeToken = 0;
  const treeQuery = () => el.treeSearch.value.trim();
  const treeIndex = () => (treeQuery() ? searchIndex : nodeIndex); // which node set the clicks refer to

  async function runTreeSearch() {
    const q = treeQuery();
    if (!q) return renderTree();
    const my = ++treeToken;
    const res = await window.api.folderSearch(q);
    if (my !== treeToken) return; // a newer query is already running
    searchIndex.clear();
    treeResults = res.map((r) => {
      const n = { ...r, expanded: false, children: null };
      searchIndex.set(r.path, n);
      return n;
    });
    renderTree();
  }

  function renderResults() {
    let html = `<div class="tn${state.folder === null ? ' sel' : ''}" data-path=""><span class="ficon">&#128193;</span><span class="name">${esc(t('tree.all'))}</span><span class="meta">${App.fmtNum(state.dbTotal)}</span></div>`;
    if (!treeResults.length) html += `<div class="pv-msg">${esc(t('tree.noMatch'))}</div>`;
    for (const r of treeResults) {
      const arrow = r.hasChildren ? (r.expanded ? '&#9662;' : '&#9656;') : '';
      html += `<div class="tn res${state.folder === r.path ? ' sel' : ''}${r.expanded ? ' open' : ''}" data-path="${esc(r.path)}" title="${esc(r.path)}">
        <span class="arrow" data-act="toggle">${arrow}</span><span class="ficon">&#128193;</span><span class="rtxt"><span class="name">${esc(r.name)}</span><span class="rpath">${esc(r.parent)}</span></span>
        <span class="meta">${App.fmtNum(r.count)} · ${App.fmtSize(r.size)}</span><button class="del" data-act="del" title="${esc(t('delete.tooltip'))}">&#128465;</button></div>`;
      if (r.expanded && r.children) for (const c of r.children) html += nodeHtml(c, 1);
    }
    el.treeBody.innerHTML = html;
    el.treeBody.querySelectorAll('.guides').forEach((g) => (g.style.width = +g.dataset.d * IND + 4 + 'px'));
  }

  let treeSearchTimer = 0;
  el.treeSearch.addEventListener('input', () => {
    clearTimeout(treeSearchTimer);
    treeSearchTimer = setTimeout(runTreeSearch, 150);
  });

  function renderTree() {
    if (treeQuery()) return renderResults();
    let html = `<div class="tn${state.folder === null ? ' sel' : ''}" data-path=""><span class="guides" data-d="0"></span><span class="arrow"></span><span class="ficon">&#128193;</span><span class="name">${esc(t('tree.all'))}</span><span class="meta">${App.fmtNum(state.dbTotal)}</span></div>`;
    for (const r of roots) html += nodeHtml(r, 0);
    el.treeBody.innerHTML = html;
    // Inline style attributes are blocked by the CSP, so set widths through the DOM.
    el.treeBody.querySelectorAll('.guides').forEach((g) => (g.style.width = +g.dataset.d * IND + 4 + 'px'));
  }

  el.treeBody.addEventListener('click', async (e) => {
    const row = e.target.closest('.tn');
    if (!row) return;
    const path = row.dataset.path;
    if (e.target.closest('[data-act="del"]')) {
      const n = treeIndex().get(path);
      if (n) trashFolder(n);
      return;
    }
    if (e.target.closest('[data-act="toggle"]')) {
      const n = treeIndex().get(path);
      if (!n || !n.hasChildren) return;
      n.expanded = !n.expanded;
      if (n.expanded && !n.children) await loadChildren(n, new Map(), treeIndex());
      return renderTree();
    }
    state.folder = path || null;
    renderTree();
    reload(false);
  });
  el.treeBody.addEventListener('dblclick', async (e) => {
    const row = e.target.closest('.tn');
    const n = row && treeIndex().get(row.dataset.path);
    if (!n || !n.hasChildren || e.target.closest('[data-act="toggle"]')) return;
    n.expanded = !n.expanded;
    if (n.expanded && !n.children) await loadChildren(n, new Map(), treeIndex());
    renderTree();
  });
  el.treeBody.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tn');
    const n = row && row.dataset.path && treeIndex().get(row.dataset.path);
    if (!n) return;
    e.preventDefault();
    const items = [
      { label: t('ctx.openFolder'), run: async () => { const res = await window.api.openFolder(n.path); if (!res.ok) App.toast(res.code === 'missing' ? t('err.missing') : t('err.open')); } },
      { label: t('ctx.copyPath'), run: () => copyText(n.path) },
      {
        label: t('ctx.scanFolder'), disabled: state.scanning,
        run: async () => {
          const res = await window.api.startScan({ mode: 'folder', folder: n.path });
          if (!res.ok) return App.toast(errText(res.code));
          el.progressText.textContent = t('progress.starting');
          setScanning(true);
        },
      },
    ];
    if (treeQuery() || !roots.includes(n)) items.push({ sep: true }, { label: t('delete.tooltip') + '…', danger: true, run: () => trashFolder(n) });
    App.contextMenu(e.clientX, e.clientY, items);
  });

  // ---------- resizable side panels ----------
  const MIN_TABLE = 680; // keep the table usable in its compact layout (name/status/type/size/date/actions)
  function splitter(handle, key, sign) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const content = $('content');
      const startX = e.clientX;
      const startW = ui()[key];
      const other = key === 'previewWidth' ? (inFolderView() ? ui().treeWidth : 0) : (ui().preview ? ui().previewWidth : 0);
      const max = Math.max(240, content.clientWidth - other - MIN_TABLE);
      let w = startW;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('drag');
      content.classList.add('dragging');
      const move = (ev) => {
        w = Math.round(Math.min(max, Math.max(200, startW + sign * (ev.clientX - startX))));
        content.style.setProperty(key === 'previewWidth' ? '--pv-w' : '--tree-w', w + 'px');
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.classList.remove('drag');
        content.classList.remove('dragging');
        App.set({ ui: { [key]: w } });
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  splitter($('pvSplit'), 'previewWidth', -1); // panel is on the right: dragging left widens it
  splitter($('treeSplit'), 'treeWidth', +1);

  // ---------- view mode ----------
  function applyView() {
    const folders = inFolderView();
    el.tree.hidden = !folders;
    el.view.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === ui().view));
    if (!folders) state.folder = null;
  }
  el.view.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.view !== ui().view) App.set({ ui: { view: b.dataset.view } });
  });

  // ---------- scanning ----------
  const scope = () => App.settings.scan.scope;
  function showScope() {
    const f = scope().mode === 'folder' ? scope().folder : null;
    el.scope.textContent = f || t('scope.all');
    el.scope.title = f || t('scope.all');
    el.all.hidden = !f;
  }
  el.folder.addEventListener('click', async () => {
    const f = await window.api.pickFolder();
    if (f) App.set({ scan: { scope: { mode: 'folder', folder: f } } });
  });
  el.all.addEventListener('click', () => App.set({ scan: { scope: { mode: 'all', folder: null } } }));

  function setScanning(on) {
    state.scanning = on;
    el.scan.disabled = on;
    el.stop.disabled = !on;
    el.folder.disabled = on;
    el.all.disabled = on;
    el.progress.hidden = !on;
  }

  const errText = (code) => t('err.' + code);

  el.scan.addEventListener('click', async () => {
    const res = await window.api.startScan(scope());
    if (!res.ok) return App.toast(errText(res.code));
    el.progressText.textContent = t('progress.starting');
    setScanning(true);
  });
  el.stop.addEventListener('click', () => window.api.stopScan());

  let reloadTimer = 0;
  window.api.on('scan:inserted', () => {
    if (reloadTimer) return;
    reloadTimer = setTimeout(() => { reloadTimer = 0; reload(true); }, 1000);
  });
  window.api.on('scan:progress', ({ found, folder }) => {
    if (!state.scanning) setScanning(true); // scan started by the scheduler or the tray
    el.progressText.textContent = t('progress.found', { found: App.fmtNum(found), folder });
  });
  window.api.on('scan:done', async ({ found, stopped, removed }) => {
    setScanning(false);
    await reload(true);
    refreshTree();
    App.toast(
      stopped ? t('toast.stopped', { found: App.fmtNum(found) })
              : t('toast.done', { found: App.fmtNum(found), removed: App.fmtNum(removed || 0) }),
      true
    );
  });
  window.api.on('scan:error', ({ message }) => App.toast(t('toast.scanError', { message })));

  // ---------- wiring ----------
  let lastView = null;
  document.addEventListener('settings', () => {
    applyCols();
    showScope();
    const v = ui().view;
    if (v !== lastView) {
      const first = lastView === null;
      lastView = v;
      applyView();
      if (!first) reload(false);
      refreshTree();
    }
  });
  document.addEventListener('langchange', () => {
    applyMode();
    showScope();
    updateStatus();
    render();
    if (inFolderView()) renderTree();
  });

  App.onReady(async () => {
    markSort();
    await reload(false);
    const st = await window.api.scanStatus();
    if (st.running) setScanning(true);
  });
})();
