// Мост для окна выбора области. Раньше это окно работало с nodeIntegration:true
// и contextIsolation:false — то есть с полным Node в рендерере, и именно в него
// прилетал скриншот всего рабочего стола. Node здесь не нужен: хватает двух каналов.
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


contextBridge.exposeInMainWorld('picker', {
  onShot: (cb) => ipcRenderer.on('picker-shot', (e, payload) => cb(payload)),
  done: (region) => ipcRenderer.send('picker-done', region),
});
