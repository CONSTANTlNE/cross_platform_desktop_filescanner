const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['scan:progress', 'scan:inserted', 'scan:done', 'scan:error', 'settings:changed', 'index:progress', 'index:done', 'update:available']);

contextBridge.exposeInMainWorld('api', {
  // files
  query: (q) => ipcRenderer.invoke('files:query', q),
  count: (q) => ipcRenderer.invoke('files:count', q),
  total: () => ipcRenderer.invoke('files:total'),
  folderSearch: (term) => ipcRenderer.invoke('folders:search', term),
  folderChildren: (parent) => ipcRenderer.invoke('folders:children', parent),
  openFile: (p) => ipcRenderer.invoke('file:open', p),
  showInFolder: (p) => ipcRenderer.invoke('file:showInFolder', p),
  preview: (p) => ipcRenderer.invoke('preview:get', p),
  ids: (q) => ipcRenderer.invoke('files:ids', q),
  describeFiles: (ids) => ipcRenderer.invoke('files:describe', ids),
  copyPaths: (ids) => ipcRenderer.invoke('files:copyPaths', ids),
  trashMany: (ids) => ipcRenderer.invoke('files:trashMany', ids),
  indexStart: () => ipcRenderer.invoke('index:start'),
  indexStop: () => ipcRenderer.invoke('index:stop'),
  indexStatus: () => ipcRenderer.invoke('index:status'),
  indexStats: () => ipcRenderer.invoke('index:stats'),
  indexClear: () => ipcRenderer.invoke('index:clear'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openRelease: (url) => ipcRenderer.invoke('update:open', url),
  skipUpdate: (version) => ipcRenderer.invoke('update:skip', version),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openFolder: (p) => ipcRenderer.invoke('folder:open', p),
  renameFile: (p, name) => ipcRenderer.invoke('file:rename', p, name),
  trashFile: (p) => ipcRenderer.invoke('file:trash', p),
  trashFolder: (p) => ipcRenderer.invoke('folder:trash', p),
  getIcon: (ext, p) => ipcRenderer.invoke('icon:get', ext, p),
  // scanning
  startScan: (opts) => ipcRenderer.invoke('scan:start', opts),
  stopScan: () => ipcRenderer.invoke('scan:stop'),
  scanStatus: () => ipcRenderer.invoke('scan:status'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  // settings / i18n / info
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getLocale: (lang) => ipcRenderer.invoke('i18n:get', lang),
  skipGroups: () => ipcRenderer.invoke('skip:groups'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
