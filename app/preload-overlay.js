// Мост для игрового оверлея. В обычной работе ему нужны РОВНО два события и ничего больше.
// Общий preload сюда вешать нельзя: у прозрачного некликабельного окна поверх игры
// оказались бы и restartAsAdmin, и simulateFile, и pickZoneRegion.
//
// На время настройки места оверлей ловит мышь, поэтому добавлены три исходящих сигнала:
// «схватил/отпустил» (окно тащит main-процесс по позиции курсора) и «крути размер».
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['overlay-show', 'overlay-hide']);

contextBridge.exposeInMainWorld('api', {
  on: (channel, cb) => {
    if (!CHANNELS.has(channel)) return () => {};
    const h = (e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  // phase: 'start' | 'end'
  drag: (phase) => ipcRenderer.send('overlay-drag', phase === 'start' ? 'start' : 'end'),
  // dir: +1 крупнее, −1 мельче (колесо мыши над плашкой)
  scale: (dir) => ipcRenderer.send('overlay-scale', dir > 0 ? 1 : -1),
  // 'done' — сохранить, 'cancel' — вернуть как было, 'reset' — стандартное место
  setup: (action) => ipcRenderer.invoke('overlay-setup', action),
});
