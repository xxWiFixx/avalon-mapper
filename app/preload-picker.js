// Мост для окна выбора области. Раньше это окно работало с nodeIntegration:true
// и contextIsolation:false — то есть с полным Node в рендерере, и именно в него
// прилетал скриншот всего рабочего стола. Node здесь не нужен: хватает двух каналов.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onShot: (cb) => ipcRenderer.on('picker-shot', (e, payload) => cb(payload)),
  done: (region) => ipcRenderer.send('picker-done', region),
});
