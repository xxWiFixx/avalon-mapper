const { contextBridge, ipcRenderer } = require('electron');
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
