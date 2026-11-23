const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['scan:progress', 'scan:inserted', 'scan:done', 'scan:error']);

contextBridge.exposeInMainWorld('api', {
  query: (q) => ipcRenderer.invoke('files:query', q),
  count: (q) => ipcRenderer.invoke('files:count', q),
  total: () => ipcRenderer.invoke('files:total'),
  startScan: (opts) => ipcRenderer.invoke('scan:start', opts),
  stopScan: () => ipcRenderer.invoke('scan:stop'),
  scanStatus: () => ipcRenderer.invoke('scan:status'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openFile: (p) => ipcRenderer.invoke('file:open', p),
  showInFolder: (p) => ipcRenderer.invoke('file:showInFolder', p),
  getIcon: (ext, p) => ipcRenderer.invoke('icon:get', ext, p),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) return () => {};
    const handler = (_e, data) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
