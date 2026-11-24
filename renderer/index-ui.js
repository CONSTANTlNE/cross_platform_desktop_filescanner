// Content indexing UI: toolbar button + progress row, "not searchable" notice, Settings > Content search pane.
// The work itself runs in the main process (indexer.js); this file only starts/stops it and shows state.
(() => {
  const App = window.App;
  const $ = (id) => document.getElementById(id);
  const t = (k, p) => App.t(k, p);
  let running = false;
  let filtered = false; // the 'not searchable' list is currently shown

  const mk = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };

  // ---------- statistics (Settings pane + notice) ----------
  function renderStats() {
    const s = App.indexStats;
    if (!s) return;
    const pct = s.total ? Math.round((s.ok / s.total) * 100) : 0;
    $('stOk').textContent = App.fmtNum(s.ok);
    $('stTotal').textContent = App.fmtNum(s.total);
    $('stTotal2').textContent = App.fmtNum(s.total);
    $('stPct').textContent = `(${pct}%)`;
    $('stBar').style.width = pct + '%';
    $('stPending').textContent = App.fmtNum(s.pending);
    $('stEmpty').textContent = App.fmtNum(s.empty);
    $('stEmptyPdf').textContent = App.fmtNum(s.emptyPdf);
    $('stError').textContent = App.fmtNum(s.error);
    $('stTooBig').textContent = App.fmtNum(s.tooBig);
    $('stChars').textContent = App.fmtSize(s.chars); // ~1 byte per character; a size estimate
    $('stLast').textContent = s.lastIndexedAt ? App.fmtDate(s.lastIndexedAt) : t('contents.never');
    $('stByExt').replaceChildren(
      ...s.byExt.map((r) => {
        const tr = mk('tr');
        tr.append(
          mk('td', '.' + r.ext),
          mk('td', App.fmtNum(r.total)),
          mk('td', App.fmtNum(r.ok)),
          mk('td', App.fmtNum(r.pending), r.pending ? 'warn' : ''),
          mk('td', App.fmtNum(r.empty), r.empty ? 'warn' : ''),
          mk('td', App.fmtNum(r.error + r.tooBig))
        );
        return tr;
      })
    );
  }

  // Bar above the list (Contents mode only): tells the user that some files are NOT covered by the search.
  function updateNotice() {
    const s = App.indexStats;
    const bad = s ? s.total - s.ok : 0;
    const show = !!s && App.settings && App.settings.ui.searchMode === 'content' && bad > 0;
    $('idxNotice').hidden = !show;
    if (!show) return;
    const parts = [];
    if (s.pending) parts.push(t('notice.pending', { n: App.fmtNum(s.pending) }));
    if (s.empty) parts.push(t('notice.empty', { n: App.fmtNum(s.empty) }));
    if (s.error) parts.push(t('notice.error', { n: App.fmtNum(s.error) }));
    if (s.tooBig) parts.push(t('notice.toobig', { n: App.fmtNum(s.tooBig) }));
    $('idxNoticeText').textContent = t('notice.lead', { n: App.fmtNum(bad), total: App.fmtNum(s.total) }) + ' — ' + parts.join(', ');
    $('idxNoticeIndex').hidden = running || !s.pending;
    $('idxNoticeShow').hidden = filtered;
    $('idxNoticeCancel').hidden = !filtered;
  }

  async function refreshStats() {
    App.indexStats = await window.api.indexStats();
    renderStats();
    updateNotice();
    document.dispatchEvent(new Event('indexstats'));
  }

  // ---------- running state ----------
  function setRunning(on) {
    running = on;
    $('indexProgress').hidden = !on;
    $('btnIndex').disabled = on;
    $('cIndex').disabled = on;
    $('cClear').disabled = on;
    if (!on) $('idxFill').style.width = '0';
    updateNotice();
  }

  function progress({ done, total, current }) {
    if (!running) setRunning(true); // started elsewhere (e.g. before the window was reopened)
    $('idxFill').style.width = (total ? Math.min(100, (done / total) * 100) : 0) + '%';
    $('idxText').textContent = t('index.running', { done: App.fmtNum(done), total: App.fmtNum(total), name: current || '' });
  }

  async function start() {
    const res = await window.api.indexStart();
    if (!res.ok) return App.toast(t({ nothing: 'index.nothing', busy: 'index.busy', scanning: 'index.scanning' }[res.code] || 'index.busy'));
    setRunning(true);
    progress({ done: 0, total: res.total, current: '' });
    App.toast(t('index.started', { n: App.fmtNum(res.total) }), true, 7000); // confirmation that the background task is running
  }

  $('btnIndex').addEventListener('click', start);
  $('cIndex').addEventListener('click', start);
  $('idxNoticeIndex').addEventListener('click', start);
  $('idxNoticeShow').addEventListener('click', () => document.dispatchEvent(new CustomEvent('setcfilter', { detail: 'notok' })));
  $('idxNoticeCancel').addEventListener('click', () => document.dispatchEvent(new CustomEvent('setcfilter', { detail: 'all' })));
  document.addEventListener('cfilterstate', (e) => { filtered = e.detail !== 'all'; updateNotice(); });
  $('idxStop').addEventListener('click', () => window.api.indexStop());

  $('cClear').addEventListener('click', async () => {
    const ok = await App.confirm({ title: t('contents.clearTitle'), body: t('contents.clearBody'), okLabel: t('contents.clear') });
    if (!ok) return;
    const res = await window.api.indexClear();
    if (!res.ok) return App.toast(t('index.busy'));
    App.toast(t('contents.cleared'), true);
    await refreshStats();
    document.dispatchEvent(new CustomEvent('indexcleared'));
  });

  $('setMaxMb').addEventListener('change', async (e) => {
    await App.set({ index: { maxMb: +e.target.value } });
    refreshStats();
  });

  window.api.on('index:progress', progress);
  window.api.on('index:done', (s) => {
    setRunning(false);
    refreshStats();
    App.toast(
      s.stopped
        ? t('index.stopped', { done: App.fmtNum(s.done), total: App.fmtNum(s.total) })
        : t('index.doneToast', { ok: App.fmtNum(s.ok), empty: App.fmtNum(s.empty), error: App.fmtNum(s.error) }),
      true,
      7000
    );
  });
  window.api.on('scan:done', () => refreshStats()); // new/removed files change the numbers

  document.addEventListener('settings', () => {
    const sel = $('setMaxMb');
    const v = String(App.settings.index.maxMb);
    if (![...sel.options].some((o) => o.value === v)) sel.add(new Option(v, v)); // a custom value from settings.json
    sel.value = v;
    updateNotice();
  });
  document.addEventListener('langchange', () => { renderStats(); updateNotice(); if (running) $('idxText').textContent = ''; });
  document.addEventListener('tabshown', (e) => { if (e.detail === 'settings' || e.detail === 'files') refreshStats(); });

  App.onReady(async () => {
    await refreshStats();
    const st = await window.api.indexStatus();
    if (st.running) { setRunning(true); progress(st); }
  });
})();
