// Settings tab. Every control saves immediately via App.set().
(() => {
  const App = window.App;
  const $ = (id) => document.getElementById(id);
  const s = () => App.settings;
  let skipGroups = [];
  let noteTimer;

  async function save(patch) {
    await App.set(patch);
    const n = $('savedNote');
    n.classList.add('show');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => n.classList.remove('show'), 1200);
  }

  // left-hand category switcher
  $('settingsNav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#settingsNav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === b.dataset.pane));
  });

  // general
  $('setLang').addEventListener('change', (e) => save({ language: e.target.value }));
  $('setTheme').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) save({ theme: b.dataset.theme });
  });

  // scanning: checked = include this normally-skipped group
  function buildSkipList() {
    $('skipList').innerHTML = skipGroups
      .map(
        (g) => `<label class="check${g.warn ? ' warn' : ''}">
          <input type="checkbox" data-id="${g.id}"> <span data-i18n="skip.${g.id}" data-warn=""></span></label>`
      )
      .join('');
    App.apply($('skipList'));
    markWarnings();
  }
  function markWarnings() {
    document.querySelectorAll('#skipList .warn span').forEach((sp) => (sp.dataset.warn = App.t('skip.warn')));
  }
  $('skipList').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (cb) save({ scan: { include: { [cb.dataset.id]: cb.checked } } });
  });

  // schedule + tray
  $('setSchedule').addEventListener('change', (e) => {
    if (e.target.name === 'sched') save({ schedule: { mode: e.target.value } });
  });
  $('setTime').addEventListener('change', (e) => {
    if (e.target.value) save({ schedule: { time: e.target.value } });
  });
  $('setTray').addEventListener('change', (e) => save({ tray: { enabled: e.target.checked } }));

  function showValues() {
    const st = s();
    $('setLang').value = st.language;
    document.querySelectorAll('#setTheme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === st.theme));
    document.querySelectorAll('#skipList input').forEach((cb) => (cb.checked = !!st.scan.include[cb.dataset.id]));
    document.querySelectorAll('input[name=sched]').forEach((r) => (r.checked = r.value === st.schedule.mode));
    $('setTime').value = st.schedule.time;
    $('timeField').hidden = st.schedule.mode !== 'daily';
    $('setTray').checked = st.tray.enabled;
    const sc = st.scan.scope;
    $('schedScope').textContent = App.t('schedule.scope', { scope: sc.mode === 'folder' && sc.folder ? sc.folder : App.t('scope.all') });
  }

  document.addEventListener('settings', showValues);
  document.addEventListener('langchange', () => {
    markWarnings();
    showValues();
  });

  App.onReady(async () => {
    skipGroups = await window.api.skipGroups();
    buildSkipList();
    const info = await window.api.appInfo();
    $('aboutVersion').textContent = info.version;
    $('aboutData').textContent = info.dataDir;
    $('trayLinux').hidden = info.platform !== 'linux';
  });
})();
