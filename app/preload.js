// Мост между main-процессом и UI карты
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getMap: () => ipcRenderer.invoke('get-map'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  // scope: 'local' — только у себя; id карты — попросить сервер убрать и там
  removeEdge: (a, b, scope) => ipcRenderer.invoke('remove-edge', a, b, scope),
  authId: () => ipcRenderer.invoke('auth-id'),
  simulateFile: (p, withTooltip) => ipcRenderer.invoke('simulate-file', p, withTooltip),
  pickSimulateFiles: () => ipcRenderer.invoke('pick-simulate-files'),
  captureBinding: () => ipcRenderer.invoke('capture-binding'),
  // карточка зоны для любого узла графа: { name, color, tier, activities }
  getZoneInfo: (name) => ipcRenderer.invoke('get-zone-info', name),
  // маршрут с учётом выхода в мир: { found, steps:[{from,to,kind,expiresAt,capNum,capMax}], hops, … }
  findRoute: (from, to) => ipcRenderer.invoke('find-route', from, to),
  findNearestExit: (from) => ipcRenderer.invoke('find-nearest-exit', from),
  // имена всех зон (Авалон + королевство) для автодополнения поля «Куда»
  getZoneNames: () => ipcRenderer.invoke('get-zone-names'),
  // переключатели панели «Настройки»; возвращают конфиг целиком, уже применённый
  setOption: (key, value) => ipcRenderer.invoke('set-option', key, value),
  // 'start' — режим настройки места оверлея, 'done'/'cancel' — выход, 'reset' — вернуть стандартное место
  overlaySetup: (action) => ipcRenderer.invoke('overlay-setup', action),
  // открыть папку со снимками хоткея (userData/shots, ровно два файла)
  openShots: () => ipcRenderer.invoke('open-shots'),
  // ---- общие карты ----
  // Адрес проекта и ключ приходят со сборкой и из окна не меняются: раздела
  // «Подключение» больше нет, а вместе с ним убрана и ручка, которой рендерер мог бы
  // переставить сервер. Осталось только чтение состояния и толчок синхронизации.
  syncStatus: () => ipcRenderer.invoke('sync-status'),
  syncNow: () => ipcRenderer.invoke('sync-now'),
  // ---- обновления ----
  updateStatus: () => ipcRenderer.invoke('update-status'),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateOpen: () => ipcRenderer.invoke('update-open'),   // открыть страницу загрузки в браузере
  // ---- комнаты: их может быть несколько, у каждой своя галочка выгрузки ----
  roomsList: () => ipcRenderer.invoke('rooms-list'),
  roomsSync: () => ipcRenderer.invoke('rooms-sync'),           // подтянуть свои комнаты с сервера
  roomCreate: (title) => ipcRenderer.invoke('room-create', title),
  roomJoin: (code, title) => ipcRenderer.invoke('room-join', code, title),
  roomLeave: (code) => ipcRenderer.invoke('room-leave', code),
  roomUpload: (code, on) => ipcRenderer.invoke('room-upload', code, on),
  // ---- участники карты и их роли: всё право проверяет сервер ----
  mapMembers: (code) => ipcRenderer.invoke('map-members', code),
  mapSetRole: (code, userId, role) => ipcRenderer.invoke('map-set-role', code, userId, role),
  mapKick: (code, userId) => ipcRenderer.invoke('map-kick', code, userId),
  mapPolicy: (code, confirmRequired) => ipcRenderer.invoke('map-policy', code, confirmRequired),
  // ---- вход через Discord (нужен только для общих карт) ----
  authStatus: () => ipcRenderer.invoke('auth-status'),
  authSignIn: () => ipcRenderer.invoke('auth-sign-in'),   // откроет системный браузер
  authSignOut: () => ipcRenderer.invoke('auth-sign-out'),
  // открыть окно поиска зоны: там Ctrl+Enter говорит «я сейчас здесь»
  openSearch: () => ipcRenderer.invoke('open-search'),
  // обвести мышью плашку с названием зоны: { ok, region, zone } — zone это то,
  // что удалось прочитать в выбранной области сразу после выбора
  pickZoneRegion: () => ipcRenderer.invoke('pick-zone-region'),
  // перезапуск от имени администратора (иначе хоткей не работает поверх защищённой игры)
  restartAsAdmin: () => ipcRenderer.invoke('restart-as-admin'),
  on: subscribe,
});

// Подписка только на известные каналы: раньше имя канала задавал рендерер, то есть
// это был подписчик на ВЕСЬ трафик main→renderer. Возвращаем функцию отписки.
const CHANNELS = new Set([
  'ready', 'binding-changed', 'toast', 'map-updated', 'zone-changed', 'edge-added',
  'privileges', 'game-state', 'config-changed', 'sync-status', 'update-available', 'auth-changed',
  'rooms-changed',
]);
function subscribe(channel, cb) {
  if (!CHANNELS.has(channel)) {
    console.warn('[preload] неизвестный канал:', channel);
    return () => {};
  }
  const h = (e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}
