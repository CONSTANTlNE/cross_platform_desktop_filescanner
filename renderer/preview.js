// Quick view panel for Word / Excel documents. The main process parses the file in an isolated
// worker and returns plain data; everything is rendered here with DOM APIs (no raw innerHTML).
(() => {
  const App = window.App;
  const $ = (id) => document.getElementById(id);
  const el = {
    panel: $('preview'), btn: $('btnPreview'), title: $('pvTitle'), sub: $('pvSub'), tabs: $('pvTabs'),
    body: $('pvBody'), note: $('pvNote'), hit: $('pvHit'), open: $('pvOpen'), close: $('pvClose'),
  };
  const t = (k, p) => App.t(k, p);
  let row = null;
  let count = 0;
  let token = 0;
  let timer = 0;
  let current = null; // last successful sheets result

  const isOn = () => App.settings.ui.preview;

  // ---------- sanitizer: rebuild only allow-listed elements from the parsed document ----------
  const TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'SUB', 'SUP', 'BR',
    'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'PRE', 'CODE', 'SPAN', 'DIV']);
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'SVG']);
  const IMG_OK = /^data:image\/(png|jpe?g|gif|bmp|webp);base64,[A-Za-z0-9+/=]+$/;

  function clean(src, dst) {
    for (const n of src.childNodes) {
      if (n.nodeType === 3) {
        dst.appendChild(document.createTextNode(n.textContent));
      } else if (n.nodeType === 1) {
        const tag = n.tagName;
        if (DROP.has(tag)) continue;
        if (tag === 'IMG') {
          const s = n.getAttribute('src') || '';
          if (IMG_OK.test(s)) {
            const img = document.createElement('img');
            img.src = s;
            dst.appendChild(img);
          }
        } else if (TAGS.has(tag)) {
          const e = document.createElement(tag.toLowerCase());
          if (tag === 'TD' || tag === 'TH') {
            for (const a of ['colspan', 'rowspan']) {
              const v = parseInt(n.getAttribute(a), 10);
              if (v > 0 && v < 100) e.setAttribute(a, v);
            }
          }
          clean(n, e);
          dst.appendChild(e);
        } else {
          clean(n, dst); // unknown tag (e.g. <a>): keep its text, drop the element
        }
      }
    }
  }

  // ---------- rendering ----------
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  function message(text) {
    el.body.classList.remove('flush');
    el.body.replaceChildren(mk('div', 'pv-msg', text));
    el.tabs.hidden = true;
    note('');
  }
  function note(text) {
    el.note.hidden = !text;
    el.note.textContent = text || '';
  }
  const colName = (i) => {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  };

  function showSheet(i) {
    const sh = current.sheets[i];
    el.tabs.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i));
    if (!sh.rows.length) {
      el.body.replaceChildren(mk('div', 'pv-msg', t('preview.empty')));
      return note('');
    }
    const cols = Math.max(...sh.rows.map((r) => r.length));
    const table = mk('table');
    const head = mk('tr');
    head.appendChild(mk('th', 'rn'));
    for (let c = 0; c < cols; c++) head.appendChild(mk('th', '', colName(sh.startCol + c)));
    table.appendChild(head);
    sh.rows.forEach((r, ri) => {
      const tr = mk('tr');
      tr.appendChild(mk('td', 'rn', String(sh.startRow + ri)));
      for (let c = 0; c < cols; c++) tr.appendChild(mk('td', '', r[c] ?? ''));
      table.appendChild(tr);
    });
    const wrap = mk('div', 'pv-sheet');
    wrap.appendChild(table);
    el.body.replaceChildren(wrap);
    el.body.scrollTop = 0;
    note(sh.total > sh.rows.length ? t('preview.rows', { shown: App.fmtNum(sh.rows.length), total: App.fmtNum(sh.total) }) : '');
  }

  // file:// URL for Chromium's built-in PDF viewer (drive letters kept intact on Windows)
  function fileUrl(p) {
    const parts = p.split(/[\\/]/).map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)));
    return 'file://' + (p.startsWith('/') ? '' : '/') + parts.join('/');
  }

  function render(res) {
    el.body.classList.toggle('flush', !!(res.ok && res.kind === 'pdf'));
    if (res.ok && res.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'pv-img';
      img.alt = '';
      img.src = fileUrl(row.path);
      el.tabs.hidden = true;
      el.body.replaceChildren(img);
      return note('');
    }
    if (res.ok && res.kind === 'pdf') {
      const f = document.createElement('iframe');
      f.className = 'pv-pdf';
      f.src = fileUrl(row.path) + '#toolbar=0&navpanes=0&view=FitH';
      el.tabs.hidden = true;
      el.body.replaceChildren(f);
      return note('');
    }
    if (!res.ok) {
      const known = { unsupported: 'preview.unsupported', timeout: 'preview.timeout', missing: 'err.missing' };
      if (res.code === 'cancelled') return;
      if (res.code === 'tooBig') return message(t('preview.tooBig', { size: App.fmtSize(res.size) }));
      return message(t(known[res.code] || 'preview.failed'));
    }
    if (res.kind === 'html') {
      const doc = new DOMParser().parseFromString('<body>' + res.html + '</body>', 'text/html');
      const box = mk('div', 'pv-doc');
      clean(doc.body, box);
      el.tabs.hidden = true;
      el.body.replaceChildren(box);
      el.body.scrollTop = 0;
      note(res.truncated ? t('preview.truncated') : '');
    } else if (res.kind === 'text') {
      el.tabs.hidden = true;
      el.body.replaceChildren(mk('pre', 'pv-text', res.text));
      el.body.scrollTop = 0;
      note(res.truncated ? t('preview.truncated') : t('preview.docText'));
    } else if (res.kind === 'sheets') {
      current = res;
      el.tabs.replaceChildren(...res.sheets.map((s, i) => {
        const b = mk('button', '', s.name);
        b.onclick = () => showSheet(i);
        return b;
      }));
      el.tabs.hidden = res.sheets.length < 2;
      showSheet(0);
      if (res.moreSheets) note(t('preview.moreSheets'));
    }
  }

  // matched text of a content search (hits wrapped in U+0001 / U+0002), shown above the preview
  function showHit() {
    if (!row || !row.snippet) { el.hit.hidden = true; return; }
    const parts = row.snippet.split(/([\u0001\u0002])/);
    let on = false;
    const nodes = [];
    for (const p of parts) {
      if (p === '\u0001') on = true;
      else if (p === '\u0002') on = false;
      else if (p) nodes.push(on ? mk('mark', '', p) : document.createTextNode(p));
    }
    el.hit.replaceChildren(...nodes);
    el.hit.hidden = false;
  }

  async function load() {
    if (!isOn()) return;
    showHit();
    if (!row) {
      el.title.textContent = '';
      el.sub.textContent = '';
      el.open.hidden = true;
      return message(count > 1 ? t('preview.multi', { n: App.fmtNum(count) }) : t('preview.select'));
    }
    const my = ++token;
    el.title.textContent = row.name;
    el.title.title = row.path;
    el.sub.textContent = `${App.fmtSize(row.size)} · ${App.fmtDate(row.modified_at)}`;
    el.open.hidden = false;
    message(t('preview.loading'));
    const res = await window.api.preview(row.path);
    if (my === token) render(res);
  }

  // ---------- wiring ----------
  document.addEventListener('fileselect', (e) => {
    row = e.detail.row;
    count = e.detail.count;
    clearTimeout(timer);
    timer = setTimeout(load, 120); // debounce arrow-key scrubbing
  });
  el.btn.addEventListener('click', () => App.set({ ui: { preview: !isOn() } }));
  el.close.addEventListener('click', () => App.set({ ui: { preview: false } }));
  el.open.addEventListener('click', async () => {
    if (!row) return;
    const res = await window.api.openFile(row.path);
    if (!res.ok) App.toast(res.code === 'missing' ? t('err.missing') : t('err.open'));
  });

  let was = null;
  document.addEventListener('settings', () => {
    const on = isOn();
    el.panel.hidden = !on;
    el.btn.classList.toggle('on', on);
    if (on !== was) {
      was = on;
      if (on) load();
    }
  });
  document.addEventListener('langchange', () => {
    if (isOn()) load();
  });
})();
