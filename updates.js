// Update check + installer. GitHub's latest release is compared with the running version (fetchLatest).
// Installed Windows builds and Linux AppImages then download the update in the background with
// electron-updater (differential via .blockmap; sha512 from latest.yml) and offer "Restart and update".
// Anything else (source runs, missing latest.yml, download errors) falls back to the banner with a
// Download button that opens the release page. Only github.com / api.github.com are contacted.
const { app, net, shell, Notification } = require('electron');

const REPO = 'CONSTANTlNE/cross_platform_desktop_filescanner'; // GitHub "owner/name" that publishes the releases
const PAGE_PREFIX = `https://github.com/${REPO}/`; // only links under this prefix are ever opened
const CHECK_EVERY_MS = 20 * 60 * 60 * 1000; // automatic check at most about once a day
const TIMEOUT_MS = 10 * 1000;

// Tests may point the check at a local server; ignored in packaged builds.
const apiUrl = () => (!app.isPackaged && process.env.FF_UPDATE_API) || `https://api.github.com/repos/${REPO}/releases/latest`;

const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [+m[1], +m[2], +m[3]] : null;
};
const isNewer = (a, b) => {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// -> {status:'available'|'uptodate'|'none'|'error', version?, url?}
async function fetchLatest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(apiUrl(), {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'file-scanner-update-check' }, // generic UA: nothing about the user
      signal: ctrl.signal,
    });
    if (res.status === 404) return { status: 'none' }; // no release published yet
    if (!res.ok) return { status: 'error' };
    const j = await res.json();
    const version = String(j.tag_name || '').replace(/^v/, '');
    const url = String(j.html_url || '');
    if (!parse(version) || !url.startsWith(PAGE_PREFIX)) return { status: 'error' };
    return isNewer(version, app.getVersion()) ? { status: 'available', version, url } : { status: 'uptodate', version };
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// electron-updater only works from an installed app: NSIS install on Windows or a running AppImage on Linux
const canAuto = () => app.isPackaged && (process.platform === 'win32' || !!process.env.APPIMAGE);

function createUpdates({ settings, send, tr, isWindowFocused }) {
  let au = null;
  let ready = ''; // version already downloaded
  let busy = false;
  if (canAuto()) {
    try {
      au = require('electron-updater').autoUpdater;
      au.autoDownload = false;
      au.autoInstallOnAppQuit = true; // a downloaded update is also installed on a normal quit
      au.allowPrerelease = false;
      au.on('download-progress', (p) => send('update:progress', { percent: Math.round(p.percent || 0) }));
      au.on('update-downloaded', (info) => {
        ready = info.version;
        busy = false;
        send('update:ready', { version: info.version });
        if (Notification.isSupported() && !isWindowFocused()) {
          new Notification({ title: tr('update.notifTitle'), body: trf('update.readyBody', { v: info.version }) }).show();
        }
      });
      au.on('error', () => {}); // failures are handled where the promises are awaited
    } catch {
      au = null;
    }
  }

  // true = download started (progress/ready events follow); false = use the manual-download banner
  async function startAuto(r) {
    if (!au) return false;
    if (ready === r.version) return send('update:ready', { version: ready }) || true;
    if (busy) return true;
    busy = true;
    try {
      const c = await au.checkForUpdates();
      if (!c || !c.updateInfo || !isNewer(c.updateInfo.version, app.getVersion())) throw new Error('no update info');
      send('update:progress', { percent: 0, version: c.updateInfo.version });
      au.downloadUpdate().catch(() => {
        busy = false;
        announce(r, { manual: true }); // download failed: let the user fetch it from the release page
      });
      return true;
    } catch {
      busy = false;
      return false;
    }
  }

  const trf = (k, p) => tr(k).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] != null ? p[x] : m));

  async function handle(r, manual) {
    const u = settings.get().updates;
    if (!manual && u.skipVersion === r.version) return;
    if (await startAuto(r)) return;
    announce(r, { manual });
  }

  function announce(r, { manual }) {
    const u = settings.get().updates;
    if (!manual && u.skipVersion === r.version) return; // the user chose to skip this one
    send('update:available', { version: r.version, url: r.url });
    // one OS notification per version, and only when the user is not looking at the window
    if (!manual && u.notified !== r.version && Notification.isSupported() && !isWindowFocused()) {
      new Notification({ title: tr('update.notifTitle'), body: trf('update.notifBody', { v: r.version }) }).show();
      settings.set({ updates: { notified: r.version } });
    }
  }

  return {
    // manual check (About page): always answers, and always shows the banner when something newer exists
    async checkNow() {
      const r = await fetchLatest();
      if (r.status !== 'error') settings.set({ updates: { lastCheck: Date.now() } });
      if (r.status === 'available') await handle(r, true);
      return { ...r, current: app.getVersion() };
    },
    // background check: honours the setting, the once-a-day limit and "skip this version"
    async checkAuto() {
      const u = settings.get().updates;
      if (!u.check || Date.now() - u.lastCheck < CHECK_EVERY_MS) return;
      const r = await fetchLatest();
      if (r.status !== 'error') settings.set({ updates: { lastCheck: Date.now() } });
      if (r.status === 'available') await handle(r, false);
    },
    install() {
      if (au && ready) au.quitAndInstall(true, true); // silent install, then start the new version
    },
    openRelease(url) {
      if (typeof url === 'string' && url.startsWith(PAGE_PREFIX)) shell.openExternal(url);
    },
    skip(version) {
      if (parse(version)) settings.set({ updates: { skipVersion: String(version) } });
    },
  };
}

module.exports = { createUpdates, isNewer, parse, REPO };
