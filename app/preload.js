// Мост между main-процессом и UI карты
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
  getMap: () => ipcRenderer.invoke('get-map'),
  getMetrics: () => ipcRenderer.invoke('get-metrics'),
  metricsAction: action => ipcRenderer.invoke('metrics-action', action),
  collectorAction: (kind, enabled) => ipcRenderer.invoke('collector-action', kind, enabled),
  collectorMails: page => ipcRenderer.invoke('collector-mails', page),
  getConfig: () => ipcRenderer.invoke('get-config'),
  // scope: 'local' — только у себя; id карты — попросить сервер убрать и там
  removeEdge: (a, b, scope) => ipcRenderer.invoke('remove-edge', a, b, scope),
  authId: () => ipcRenderer.invoke('auth-id'),
  simulateFile: (p, withTooltip) => ipcRenderer.invoke('simulate-file', p, withTooltip),
  pickSimulateFiles: () => ipcRenderer.invoke('pick-simulate-files'),
  captureBinding: target => ipcRenderer.invoke('capture-binding', target),
  onboardingPractice: active => ipcRenderer.invoke('onboarding-practice', active),
  onboardingPracticeShow: (index, expiresAt) => ipcRenderer.invoke('onboarding-practice-show', index, expiresAt),
  clearOverlayToggleBinding: () => ipcRenderer.invoke('clear-overlay-toggle-binding'),
  // карточка зоны для любого узла графа: { name, color, tier, activities }
  getZoneInfo: (name) => ipcRenderer.invoke('get-zone-info', name),
  // маршрут с учётом выхода в мир: { found, steps:[{from,to,kind,expiresAt,capNum,capMax}], hops, … }
  findRoute: (from, to) => ipcRenderer.invoke('find-route', from, to),
  searchContent: request => ipcRenderer.invoke('search-content', request),
  findPlan: request => ipcRenderer.invoke('find-plan', request),
  findRouteFromCity: (to) => ipcRenderer.invoke('find-route-from-city', to),
  findNearestExit: (from) => ipcRenderer.invoke('find-nearest-exit', from),
  // PNG подготовлен в предпросмотре; путь сохранения выбирается только системным диалогом.
  exportRouteImage: (action, payload) => ipcRenderer.invoke('export-route-image', action, payload),
  // Проводник по маршруту: 'start' с найденным путём либо 'stop'. Плашка остаётся поверх
  // игры, пока идёшь, и сама вычёркивает пройденные шаги. → { on, reason? }
  routeGuide: (action, route) => ipcRenderer.invoke('route-guide', action, route),
  // имена всех зон (Авалон + королевство) для автодополнения поля «Куда»
  getZoneNames: () => ipcRenderer.invoke('get-zone-names'),
  // переключатели панели «Настройки»; возвращают конфиг целиком, уже применённый
  setOption: (key, value) => ipcRenderer.invoke('set-option', key, value),
  // 'start' — режим настройки места оверлея, 'done'/'cancel' — выход, 'reset' — вернуть стандартное место
  overlaySetup: (action) => ipcRenderer.invoke('overlay-setup', action),
  // открыть папку со снимками хоткея и временным архивом порталов (userData/shots)
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
  billingStatus: () => ipcRenderer.invoke('billing-status'),
  billingRefresh: () => ipcRenderer.invoke('billing-refresh'),
  billingRedeemCode: (code, mapId) => ipcRenderer.invoke('billing-redeem-code', code, mapId),
  billingPurchase: (product, mapId) => ipcRenderer.invoke('billing-purchase', product, mapId),
  roomsSync: () => ipcRenderer.invoke('rooms-sync'),           // подтянуть свои комнаты с сервера
  serverAccess: (action, params) => ipcRenderer.invoke('server-access', action, params),
  roomCreate: (title, code) => ipcRenderer.invoke('room-create', title, code),
  roomJoin: (code, title) => ipcRenderer.invoke('room-join', code, title),
  roomLeave: (code) => ipcRenderer.invoke('room-leave', code),
  roomUpload: (code, on) => ipcRenderer.invoke('room-upload', code, on),
  // ---- участники карты и их роли: всё право проверяет сервер ----
  mapMembers: (code) => ipcRenderer.invoke('map-members', code),
  mapLayout: (code, positions, revision, replace) => ipcRenderer.invoke('map-layout', code, positions, revision, replace),
  mapLayoutMerge: (code, bridge, positions, revision) => ipcRenderer.invoke('map-layout-merge', code, bridge, positions, revision),
  mapSetRole: (code, userId, role) => ipcRenderer.invoke('map-set-role', code, userId, role),
  mapKick: (code, userId) => ipcRenderer.invoke('map-kick', code, userId),
  mapPolicy: (code, confirmRequired) => ipcRenderer.invoke('map-policy', code, confirmRequired),
  // ---- вход через Discord (нужен только для общих карт) ----
  authStatus: () => ipcRenderer.invoke('auth-status'),
  authSignIn: () => ipcRenderer.invoke('auth-sign-in'),   // откроет системный браузер
  authSignOut: () => ipcRenderer.invoke('auth-sign-out'),
  // открыть окно поиска зоны: там Ctrl+Enter говорит «я сейчас здесь»
  openSearch: mode => ipcRenderer.invoke('open-search', mode === 'lookup' ? 'lookup' : 'portal'),
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
  'ready', 'binding-changed', 'toast', 'map-updated', 'zone-changed', 'edge-added', 'zone-preview',
  'privileges', 'game-state', 'config-changed', 'sync-status', 'update-available', 'auth-changed',
  'rooms-changed', 'metrics-updated', 'splash-start', 'onboarding-practice-hotkey',
  'billing-changed',
  // проводник выключился сам (дошёл до конца) — кнопке пора вернуться в исходное
  'route-guide-off',
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
