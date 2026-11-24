// Update UI (banner + About page card). The check/download runs in the main process (updates.js).
// States: available (manual Download -> release page), downloading (progress), ready (Restart and update).
(() => {
  const App = window.App;
  const $ = (id) => document.getElementById(id);
  const t = (k, p) => App.t(k, p);
  let found = null; // {version, url}
  let dl = null; // {version, percent} while downloading
  let ready = ''; // version that is downloaded and waiting for a restart

  const setReady = () => {
    for (const id of ['updateInstall', 'updInstall']) $(id).hidden = !ready;
    if (ready) { $('updateGet').hidden = true; $('updateSkip').hidden = true; $('updGet').hidden = true; }
  };

  function showBar() {
    $('updateBar').hidden = !(found || dl || ready);
    $('updateGet').hidden = !!(dl || ready) || !found;
    $('updateSkip').hidden = !!(dl || ready) || !found;
    setReady();
    if (ready) $('updateText').textContent = t('update.ready', { v: ready });
    else if (dl) $('updateText').textContent = t('update.downloading', { v: dl.version, p: dl.percent });
    else if (found) $('updateText').textContent = t('update.bar', { v: found.version });
  }

  function showStatus(r) {
    const line = $('updStatus');
    $('updGet').hidden = !(r && r.status === 'available');
    if (!r) return (line.textContent = '');
    line.textContent =
      r.status === 'available' ? t('update.availableLine', { v: r.version })
      : r.status === 'uptodate' ? t('update.latest', { v: r.current })
      : r.status === 'none' ? t('update.none')
      : t('update.error');
  }

  const download = () => found && window.api.openRelease(found.url);
  $('updateGet').addEventListener('click', download);
  $('updGet').addEventListener('click', download);
  $('updateSkip').addEventListener('click', () => {
    if (found) window.api.skipUpdate(found.version);
    found = null;
    showBar();
  });
  const install = () => window.api.installUpdate();
  $('updateInstall').addEventListener('click', install);
  $('updInstall').addEventListener('click', install);
  $('updateClose').addEventListener('click', () => { $('updateBar').hidden = true; }); // hidden for this session only

  $('updCheck').addEventListener('click', async () => {
    $('updCheck').disabled = true;
    $('updStatus').textContent = t('update.checking');
    const r = await window.api.checkUpdate();
    $('updCheck').disabled = false;
    if (r.status === 'available') found = { version: r.version, url: r.url };
    showStatus(r);
    showBar();
  });

  $('updAuto').addEventListener('change', (e) => App.set({ updates: { check: e.target.checked } }));

  window.api.on('update:progress', (p) => {
    dl = { version: p.version || (dl && dl.version) || '', percent: p.percent };
    found = null;
    showBar();
    $('updStatus').textContent = t('update.downloading', { v: dl.version, p: dl.percent });
  });
  window.api.on('update:ready', (u) => {
    ready = u.version;
    dl = null;
    found = null;
    showBar();
    $('updStatus').textContent = t('update.ready', { v: ready });
  });

  window.api.on('update:available', (u) => {
    found = u;
    showBar();
    $('updGet').hidden = false;
    $('updStatus').textContent = t('update.availableLine', { v: u.version });
  });

  document.addEventListener('settings', () => { $('updAuto').checked = App.settings.updates.check; });
  document.addEventListener('langchange', showBar);
})();
