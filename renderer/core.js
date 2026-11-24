// Shared renderer core: settings sync, i18n, formatting, tabs, theme toggle, toast.
// Feature modules (files.js, settings-ui.js) register with App.onReady(fn) and listen to
// the document events 'langchange' and 'settings'.
(() => {
  const App = (window.App = {
    settings: null,
    dict: {},
    lang: 'ka',
    ready: [],
    onReady(fn) { this.ready.push(fn); },

    t(key, params) {
      let s = this.dict[key] ?? key;
      if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] ?? m));
      return s;
    },
    apply(root = document) {
      root.querySelectorAll('[data-i18n]').forEach((e) => (e.textContent = this.t(e.dataset.i18n)));
      root.querySelectorAll('[data-i18n-title]').forEach((e) => (e.title = this.t(e.dataset.i18nTitle)));
      root.querySelectorAll('[data-i18n-ph]').forEach((e) => (e.placeholder = this.t(e.dataset.i18nPh)));
    },

    get locale() { return this.lang === 'ka' ? 'ka-GE' : 'en-US'; },
    fmtNum(n) { return Number(n).toLocaleString(this.locale); },
    fmtSize(n) {
      if (n < 1024) return this.fmtNum(n) + ' ' + this.t('unit.B');
      const u = ['KB', 'MB', 'GB', 'TB'];
      let i = -1;
      do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
      return n.toLocaleString(this.locale, { maximumFractionDigits: n < 10 ? 1 : 0 }) + ' ' + this.t('unit.' + u[i]);
    },
    fmtDate(ms) { return new Date(ms).toLocaleString(this.locale, { dateStyle: 'short', timeStyle: 'short' }); },

    toast(msg, ok, ms = 3500) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.className = ok ? 'ok' : '';
      el.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => (el.hidden = true), ms);
    },

    // Persist a settings patch (deep-merged in main). Resolves after local state is updated.
    async set(patch) {
      await handle(await window.api.setSettings(patch));
    },

    // Modal dialog. Default focus is Cancel (or the text field for `input`), Escape / outside click cancel.
    //  - confirm: resolves true only on the OK button.
    //  - input {value, suffix} + submit(value) -> error text | null: the dialog stays open and shows the
    //    error until submit succeeds; resolves with the entered value, or null when cancelled.
    confirm({ title, name, path, body, okLabel, danger = true, input, submit }) {
      const $ = (id) => document.getElementById(id);
      $('mTitle').textContent = title;
      $('mName').textContent = name || '';
      $('mPath').textContent = path || '';
      $('mBody').textContent = body || '';
      $('mError').hidden = true;
      $('mOk').textContent = okLabel;
      $('mOk').className = danger ? 'danger' : 'primary';
      $('mInputRow').hidden = !input;
      const modal = $('modal');
      modal.hidden = false;
      if (input) {
        $('mInput').value = input.value || '';
        $('mSuffix').textContent = input.suffix || '';
        $('mInput').focus();
        $('mInput').setSelectionRange(0, $('mInput').value.length);
      } else {
        $('mCancel').focus();
      }
      return new Promise((resolve) => {
        let busy = false;
        const done = (v) => {
          modal.hidden = true;
          document.removeEventListener('keydown', onKey, true);
          $('mOk').onclick = $('mCancel').onclick = modal.onmousedown = null;
          resolve(v);
        };
        const ok = async () => {
          if (busy) return;
          if (!input) return done(true);
          busy = true;
          $('mError').hidden = true;
          const value = $('mInput').value;
          const err = submit ? await submit(value) : null;
          busy = false;
          if (err) {
            $('mError').textContent = err;
            $('mError').hidden = false;
            $('mInput').focus();
          } else done(value);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); done(input ? null : false); }
          else if (e.key === 'Enter' && input && e.target === $('mInput')) { e.preventDefault(); ok(); }
        };
        document.addEventListener('keydown', onKey, true);
        $('mOk').onclick = ok;
        $('mCancel').onclick = () => done(input ? null : false);
        modal.onmousedown = (e) => { if (e.target === modal) done(input ? null : false); };
      });
    },

    // Themed context menu. items: {label, run, shortcut?, danger?, disabled?} or {sep:true}
    contextMenu(x, y, items) {
      const menu = document.getElementById('ctx');
      const close = () => {
        menu.hidden = true;
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', close);
        window.removeEventListener('resize', close);
        document.removeEventListener('scroll', close, true);
      };
      const onDown = (e) => { if (!menu.contains(e.target)) close(); };
      const buttons = () => [...menu.querySelectorAll('.ctx-item:not(:disabled)')];
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const b = buttons();
          const i = b.indexOf(document.activeElement);
          b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus();
        }
      };
      menu.replaceChildren(...items.map((it) => {
        if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; return s; }
        const b = document.createElement('button');
        b.className = 'ctx-item' + (it.danger ? ' danger' : '');
        b.disabled = !!it.disabled;
        const l = document.createElement('span');
        l.textContent = it.label;
        b.appendChild(l);
        if (it.shortcut) { const k = document.createElement('span'); k.className = 'kbd'; k.textContent = it.shortcut; b.appendChild(k); }
        b.onclick = () => { close(); it.run(); };
        return b;
      }));
      menu.hidden = false;
      menu.style.left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4)) + 'px';
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', close);
      window.addEventListener('resize', close);
      document.addEventListener('scroll', close, true);
    },

    showTab(id) {
      document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.dataset.tab === id));
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
      document.dispatchEvent(new CustomEvent('tabshown', { detail: id }));
    },
  });

  async function loadLang(lang) {
    App.dict = await window.api.getLocale(lang);
    App.lang = lang;
    document.documentElement.lang = lang;
    document.title = App.t('app.title');
    App.apply();
    document.dispatchEvent(new Event('langchange'));
  }

  // Apply a settings object (from set() or from the main process); idempotent.
  async function handle(next) {
    if (JSON.stringify(next) === JSON.stringify(App.settings)) return;
    const langChanged = !App.settings || App.settings.language !== next.language;
    App.settings = next;
    if (langChanged) await loadLang(next.language);
    document.dispatchEvent(new Event('settings'));
  }

  async function boot() {
    const s = await window.api.getSettings();
    App.settings = s;
    await loadLang(s.language);

    document.getElementById('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.tab-btn');
      if (b) App.showTab(b.dataset.tab);
    });
    document.getElementById('btnTheme').addEventListener('click', () => {
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      App.set({ theme: dark ? 'light' : 'dark' });
    });
    window.api.on('settings:changed', handle);

    for (const fn of App.ready) await fn();
    document.dispatchEvent(new Event('settings'));
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
