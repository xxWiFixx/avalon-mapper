const { contextBridge, ipcRenderer } = require('electron');

// A fixed, read-only language channel for every window; no additional app actions.
contextBridge.exposeInMainWorld('appLocale', {
  language: ipcRenderer.sendSync('get-language'),
  onChange(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_, language) => callback(language);
    ipcRenderer.on('language-changed', handler);
    return () => ipcRenderer.removeListener('language-changed', handler);
  },
});

contextBridge.exposeInMainWorld('api', {
  getMetrics: () => ipcRenderer.invoke('get-metrics'),
  metricsAction: action => ipcRenderer.invoke('metrics-action', action),
  resizeMetrics: corner => ipcRenderer.invoke('metrics-resize', corner),
  metricsPointer: interactive => ipcRenderer.send('metrics-pointer', interactive === true),
  on(channel, callback) {
    if (channel !== 'metrics-updated') return () => {};
    const handler = (_, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
