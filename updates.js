// "New version available" notification. This is deliberately NOT an auto-updater: it only asks GitHub
// for the latest public release, compares version numbers and tells the user; the user downloads the
// installer from the release page themselves. It is the only network access the app makes.
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

function createUpdates({ settings, send, tr, isWindowFocused }) {
  const trf = (k, p) => tr(k).replace(/\{(\w+)\}/g, (m, x) => (p && p[x] != null ? p[x] : m));

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
      if (r.status === 'available') announce(r, { manual: true });
      return { ...r, current: app.getVersion() };
    },
    // background check: honours the setting, the once-a-day limit and "skip this version"
    async checkAuto() {
      const u = settings.get().updates;
      if (!u.check || Date.now() - u.lastCheck < CHECK_EVERY_MS) return;
      const r = await fetchLatest();
      if (r.status !== 'error') settings.set({ updates: { lastCheck: Date.now() } });
      if (r.status === 'available') announce(r, { manual: false });
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
