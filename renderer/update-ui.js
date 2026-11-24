// New-version notification UI (banner + About page card). The check itself runs in the main process (updates.js);
// nothing is installed automatically: "Download" opens the release page in the browser.
(() => {
  const App = window.App;
  const $ = (id) => document.getElementById(id);
  const t = (k, p) => App.t(k, p);
  let found = null; // {version, url}

  function showBar() {
    $('updateBar').hidden = !found;
    if (!found) return;
    $('updateText').textContent = t('update.bar', { v: found.version });
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

  window.api.on('update:available', (u) => {
    found = u;
    showBar();
    $('updGet').hidden = false;
    $('updStatus').textContent = t('update.availableLine', { v: u.version });
  });

  document.addEventListener('settings', () => { $('updAuto').checked = App.settings.updates.check; });
  document.addEventListener('langchange', showBar);
})();
