// Мост для окна поиска зоны. Окно всплывает поверх игры по хоткею, когда снимок
// области у курсора выключен: игрок печатает название сам. Больше ему ничего не нужно —
// список зон приходит одним событием, наружу уходят только выбор и закрытие.
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


contextBridge.exposeInMainWorld('search', {
  onInit: (cb) => ipcRenderer.on('search-init', (e, payload) => cb(payload)),
  // mode: 'portal' — зона за порталом, 'here' — «я сейчас здесь»;
  // closes — секунд до закрытия портала или null, capMax — 7/20 или null
  pick: (name, mode, closes, capMax) => ipcRenderer.send('search-pick', {
    name: String(name || ''),
    mode: mode === 'lookup' ? 'lookup' : mode === 'here' ? 'here' : 'portal',
    closes: Number.isFinite(closes) ? Number(closes) : null,
    capMax: Number.isFinite(capMax) ? Number(capMax) : null,
  }),
  close: () => ipcRenderer.send('search-close'),
});
