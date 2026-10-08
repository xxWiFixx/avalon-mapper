const i18nText = require("./lib/i18n").t;
// Avalon Mapper — главный процесс Electron.
// Горячая клавиша → МГНОВЕННЫЙ снимок экрана → очередь OCR → ребро на карте.
// Фоновый опрос (1.5 c) → текущая зона по плашке у миникарты → след игрока.
//
// Ключевое правило: захват кадра и его распознавание — разные стадии.
// Тултип портала живёт на экране, только пока курсор на портале, поэтому кадр снимаем
// сразу в момент нажатия, а тяжёлый OCR ставим в очередь на уже снятом кадре.
const { app, BrowserWindow, globalShortcut, desktopCapturer, screen, powerMonitor, ipcMain, dialog, shell, clipboard, nativeImage, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const recognize = require('./lib/recognize');
const store = require('./lib/store');
const jsonFile = require('./lib/json-file');
const privileges = require('./lib/privileges');
const F = require('./lib/frame');
const gdi = require('./lib/capture-gdi');
const captureRecovery = require('./lib/capture-recovery');
const overlayCapture = require('./lib/overlay-capture');
const overlayHealth = require('./lib/overlay-health');
const windowCapture = require('./lib/window-capture');
const place = require('./lib/overlay-place');   // геометрия оверлея: место, размер, перетаскивание
const routeGuide = require('./lib/route-guide');  // где игрок относительно найденного пути
const routeImageFile = require('./lib/route-image-file'); // PNG маршрута: системный диалог или буфер обмена
const { createPortalShotArchive } = require('./lib/portal-shot-archive');
const sync = require('./lib/sync');             // общие карты: выгрузка своих порталов и приём чужих
const authLib = require('./lib/auth');          // вход через Discord: нужен только для общих карт
const origin = require('./lib/origin');         // к какой зоне привязать найденный портал
const portalTime = require('./lib/portal-time'); // срок портала отсчитывается от снимка, а не конца OCR
const update = require('./lib/update');         // не вышла ли новая версия
const zoneTraffic = require('./lib/zone-watch'); // зона игрока из трафика игры
const captureSocket = require('./lib/capture-socket');
const combatMetrics = require('./lib/combat-metrics');
const foodBuff = require('./lib/food-buff');
const metricsOptions = require('./lib/metrics-options');
const collectorService = require('./lib/collectors');
const metricsWindowControls = require('./lib/metrics-window-controls');
const gameWindow = require('./lib/game-window');
const trafficHealth = require('./lib/traffic-health'); // сторож: не умер ли сокет молча
const { webPrefs } = require('./lib/win-prefs'); // настройки безопасности окон
const launchProfile = require('./lib/launch-profile');

// Windows: DXGI Output Duplication регулярно не инициализируется
// («Cannot initialize any DxgiOutputDuplicator instance» в логе) — на ноутбуках с двумя
// видеоадаптерами, при переключении полноэкранного режима и при смене сессии.
// Итог — чёрный кадр вместо картинки. Просим Chromium брать Windows Graphics Capture:
// это современный путь захвата, который такие переключения переживает.
// Неизвестные имена фич Chromium молча игнорирует, так что на старых сборках это no-op,
// а настоящая защита от чёрного кадра — проверка frameStats() ниже.
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('enable-features', 'AllowWgcScreenCapturer,AllowWgcDesktopCapturer');
}

// ---------- падение при запуске не должно пережить само приложение ----------
// Electron держит замок «один экземпляр», пока процесс жив. Если запуск падает, а
// процесс остаётся, то мёртвое приложение БЕЗ ЕДИНОГО ОКНА блокирует все следующие
// запуски: игрок жмёт ярлык, ничего не происходит, и сделать он ничего не может —
// в диспетчере задач висит electron.exe, который он не запускал.
// Ровно это и случилось 27 июля: сломанная сборка упала на создании окна, три процесса
// с правами администратора остались висеть, и дальше не запускалась уже исправленная.
//
// Поэтому: ошибка ДО того, как окно поднялось, — смертельная и громкая. Ошибка после —
// только в журнал, как раньше: ронять работающее приложение из-за случайного сбоя
// в обработчике посреди игры нельзя.
let started = false;   // главное окно создано и загрузилось
function dieOnStartup(where, err) {
  const text = String((err && (err.stack || err.message)) || err);
  console.error(i18nText("[падение] {0}: {1}", [where, text]));
  if (started) return;
  try {
    if (app.isReady()) {
      dialog.showErrorBox(i18nText("Avalon Mapper не смог запуститься"),
        i18nText("{0}.\n\n{1}\n\nПриложение закрыто, чтобы не блокировать следующий запуск.", [where, String((err && err.message) || err)]));
    }
  } catch { /* показать окно не вышло — выходим молча, это важнее */ }
  app.exit(1);
}
process.on('uncaughtException', err => dieOnStartup(i18nText("необработанная ошибка"), err));
process.on('unhandledRejection', err => dieOnStartup(i18nText("необработанный отказ промиса"), err));

const profile = launchProfile.initialize(app);
// One instance per data profile. The explicit second account gets its own lock;
// ordinary repeated launches still focus their existing window.
if (!app.requestSingleInstanceLock()) {
  console.log(i18nText("Avalon Mapper уже запущен — активирую существующее окно и выхожу"));
  app.quit();
  process.exit(0);
}

// Записываемое состояние — в userData, а НЕ в каталог приложения: после упаковки
// каталог программы (Program Files, да ещё внутри app.asar) недоступен на запись,
// и любой saveConfig упал бы. Старые данные из app/data переносим один раз.
const DATA_DIR = profile.dataDir;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
(function migrateOldData() {
  if (profile.secondary) return;
  const legacy = path.join(__dirname, 'data');
  if (!fs.existsSync(legacy) || DATA_DIR === legacy) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const f of ['config.json', 'map.json']) {
      const from = path.join(legacy, f), to = path.join(DATA_DIR, f);
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.copyFileSync(from, to); console.log(i18nText("[данные] перенёс"), f, '→', DATA_DIR); }
    }
  } catch (err) { console.error(i18nText("[данные] перенос не удался:"), err.message); }
})();
// Список тем — здесь, а не в интерфейсе: значение приходит из конфига и от окна, и то
// и другое проверяется по этому списку. Одно место — один ответ на вопрос «что бывает».
// dark — «Авалон», фактура игры (по умолчанию); coal — «Уголь», тёмная нейтральная;
// light — «Пергамент», светлая. Значение уходит прямо в data-атрибут страницы.
const THEMES = ['dark', 'coal', 'light'];
// Откуда приложение узнаёт зону игрока. Источник ровно один: включённый выключает другой.
// 'screen'  — снимок полоски с названием внизу экрана и OCR. Не читает ничего, кроме
//             своего экрана, но зависит от читаемости плашки: длинное имя, свой масштаб
//             интерфейса, экран загрузки — и зона на секунды пропадает.
// 'traffic' — ответ игры на смену кластера (lib/cluster.js). Имя приходит от сервера
//             как есть, без снимков зоны. Нужны права
//             администратора, и до первого перехода зона неизвестна.
// 'off'     — не знаем ничего: ни следа, ни автоматических рёбер; зону игрок называет сам.
const ZONE_SOURCES = ['screen', 'traffic', 'off'];
const OUTLANDS_PORTAL_CITIES = ['Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford'];
const savedConfig = jsonFile.readObject(CONFIG_PATH);
if (profile.secondary && !fs.existsSync(CONFIG_PATH)) {
  Object.assign(savedConfig, launchProfile.initialConfig(
    jsonFile.readObject(path.join(profile.primaryDataDir, 'config.json'))));
}
const config = Object.assign(
  {
    binding: null, manualBinding: null, searchBinding: null, overlayToggleBinding: null, nick: 'me', pollMs: 1500, zoneBarRegion: null, hotkeyDebounceMs: 350,
    onboardingSeen: false, language: 'ru',

    // ---- что приложение делает (всё переключается в панели «Настройки») ----
    // overlayEnabled: показывать плашку поверх игры по хоткею
    overlayEnabled: true,
    // overlayMap: рисовать в ней карту зоны. Выключено — остаются имя и активности,
    // блок становится втрое ниже и почти не закрывает игру
    overlayMap: true,
    // overlayScale: размер плашки, 1 = как интерфейс игры на этом разрешении
    overlayScale: 1,
    // сколько секунд плашка висит поверх игры после нажатия хоткея
    overlayHoldSec: 7,
    // overlayPos: { x, bottom } в точках экрана (DIP) — куда игрок перетащил плашку.
    // Держим НИЖНИЙ край: содержимое разной высоты и рост от масштаба тянутся вверх,
    // а низ остаётся там, где его поставили. null — стандартное место над миникартой.
    overlayPos: null,
    // zoneSource: откуда берётся зона игрока, см. ZONE_SOURCES выше
    zoneSource: 'screen',
    outlandsPortalCity: null,
    fameEnabled: false, damageEnabled: false, foodEnabled: false, foodWarnMinutes: 1,
    fameOverlayBounds: null, damageOverlayBounds: null,
    // zoneWatch: ВЫЧИСЛЯЕМОЕ — «зона отслеживается хоть как-нибудь» (zoneSource !== 'off').
    // Держится в конфиге только ради старых файлов настроек, где слежение было галочкой;
    // значение с диска пересчитывается в normConfig и наружу уходит уже правильным.
    zoneWatch: true,
    // cursorScan: снимать область вокруг курсора по хоткею (тултип портала).
    // Выключено — по хоткею открывается поиск зоны по названию, руками
    cursorScan: true,
    // saveShots: класть кадры хоткея в userData/shots. Ровно два файла, перезапись:
    // «что было у курсора» и «что было в плашке зоны» — чтобы видеть, что попало в захват
    saveShots: false,
    // Временный локальный сбор снимков для разбора OCR включается пользователем.
    // Неудачи дополнительно копируются в shots/portal-archive/failed.
    portalAudit: false,
    // имя не-авалонской зоны за порталом кладём в буфер обмена — чтобы найти её
    // в игровой карте поиском; буфер общий, поэтому это выключаемо
    copyWorldZone: true,
    // theme: оформление окна карты, 'dark' | 'light'. Плашки поверх игры это не касается:
    // она лежит на игровой картинке, и светлой ей быть нечего — засветит собой экран.
    theme: 'dark',

    // ---- куда попадает найденный портал (переключатели независимы) ----
    // своя карта — файл на этом компьютере, никуда не уходит
    saveLocal: true,
    autoRecordPortals: true,
    portalRecordingRevision: 0,
    personalSeededFor: null,
    personalSeededAt: 0,
    // Комнаты, в которые игрок вошёл: [{ id, title, upload }]. Их может быть несколько —
    // гильдия, друзья, разовая вылазка, — и у каждой свой переключатель выгрузки.
    // Прежние поля groupId/uploadGroup оставлены только ради переноса старых настроек.
    rooms: [],
    // общая карта — одна на всех; ник в неё не передаётся
    groupId: null,
    uploadGroup: false,
    // адрес проекта Supabase и его публичный ключ anon: вводятся в панели,
    // потому что у каждой компании друзей проект свой
    syncUrl: '', syncKey: '',
    // где лежит файл с номером последней версии (см. lib/update.js). Пусто — не проверяем
    updateUrl: '',
  },
  savedConfig,
);
// Конфиг — обычный файл, его правят руками и он переживает обновления приложения.
// Поэтому значения с диска нормализуем: мусор в overlayScale ушёл бы прямо в setBounds.
const { SCALE_MIN, SCALE_MAX, clamp } = place;
function normConfig() {
  Object.assign(config, metricsOptions.normalize(savedConfig));
  config.foodEnabled = savedConfig.foodEnabled === true;
  config.foodWarnMinutes = foodBuff.warningMinutes(savedConfig.foodWarnMinutes);
  config.onboardingSeen = savedConfig.onboardingSeen === true;
  delete config.metricsEnabled;
  config.overlayScale = place.clampScale(config.overlayScale);
  // от 3 до 30 секунд: меньше трёх — не успеть прочитать, больше тридцати — плашка
  // начинает мешать игре, ради чего она вообще и гаснет
  const hold = Number(config.overlayHoldSec);
  config.overlayHoldSec = Number.isFinite(hold) ? Math.min(30, Math.max(3, Math.round(hold))) : 7;
  const p = config.overlayPos;
  config.overlayPos = p && Number.isFinite(p.x) && Number.isFinite(p.bottom)
    ? { x: Math.round(p.x), bottom: Math.round(p.bottom) } : null;
  for (const k2 of ['overlayEnabled', 'overlayMap', 'cursorScan', 'saveShots', 'portalAudit', 'copyWorldZone',
    'saveLocal', 'uploadGroup', 'autoRecordPortals']) {
    config[k2] = !!config[k2];
  }
  // Personal portals are always kept on this computer, including while offline.
  config.saveLocal = true;
  config.portalRecordingRevision = Number.isSafeInteger(config.portalRecordingRevision) && config.portalRecordingRevision >= 0
    ? config.portalRecordingRevision : 0;
  delete config.uploadPublic;
  config.rooms = (config.rooms || []).filter(r => r.id !== sync.PUBLIC_MAP_ID);
  // Источник зоны. У настроек, написанных до появления выбора, ключа нет вовсе — там
  // решает старая галочка: снятая значила «не следить», поставленная — чтение с экрана.
  // Переключиться на трафик молча нельзя: он требует прав администратора, и человек
  // должен сам решить, что готов их дать.
  if (!Object.hasOwn(savedConfig, 'zoneSource') || !ZONE_SOURCES.includes(config.zoneSource)) {
    config.zoneSource = savedConfig.zoneWatch === false ? 'off' : 'screen';
  }
  // zoneWatch наружу — всегда вычисляемое, что бы ни лежало в файле
  config.zoneWatch = config.zoneSource !== 'off';
  // Тема — из списка, а не как пришло: значение уходит прямо в data-атрибут страницы,
  // и мусор из правленого руками файла оставил бы окно вообще без темы.
  config.theme = THEMES.includes(config.theme) ? config.theme : 'dark';
  config.outlandsPortalCity = OUTLANDS_PORTAL_CITIES.includes(config.outlandsPortalCity)
    ? config.outlandsPortalCity : null;
  // Имя в общих картах обязано быть РАЗНЫМ у разных игроков. Пока оно было 'me'
  // у всех сразу, приём чужих рёбер ломался целиком: клиент отбрасывает записи
  // со своим именем как собственное эхо — и отбрасывал бы вообще все.
  config.nick = String(config.nick || '').trim().slice(0, 24);
  if (!config.nick || config.nick === 'me') {
    config.nick = i18nText("игрок-") + Math.random().toString(36).slice(2, 6);
    console.log(i18nText("[синх] имя в общих картах не задано — беру"), config.nick);
    saveConfig();   // иначе каждый запуск придумывал бы новое имя
  }
  config.groupId = sync.UUID_RE.test(String(config.groupId || '')) ? String(config.groupId) : null;
  // Комнаты: только записи с настоящим кодом. Название подрезаем — оно идёт в интерфейс.
  config.rooms = (Array.isArray(config.rooms) ? config.rooms : [])
    .filter(r => r && sync.UUID_RE.test(String(r.id || '')))
    // Роль, владение и порог ПЕРЕНОСИМ. Их кладут сюда room-create, room-join, rooms-sync
    // и map-policy, а нормализация конфига пересобирала запись из трёх полей и молча их
    // теряла при каждом запуске. Последствий два, и оба тихие: у владельца до ответа
    // rooms-sync пропадает пункт «Настройки ролей», а разжалованный наблюдатель проходит
    // фильтр в sync.js (роль-то стёрта) — сервер отвечает 403, и после трёх отказов
    // порция рёбер выбрасывается. Ради этого фильтр и писался.
    .map(r => ({
      id: String(r.id),
      title: String(r.title || '').slice(0, 80) || null,
      upload: !!r.upload,
      role: ['viewer', 'member', 'verified', 'moderator', 'admin'].includes(r.role) ? r.role : null,
      isOwner: !!r.isOwner,
      confirmRequired: Number.isFinite(Number(r.confirmRequired))
        ? Math.max(0, Math.min(10, Math.round(Number(r.confirmRequired)))) : 0,
    }))
    .filter((r, i, all) => all.findIndex(x => x.id === r.id) === i);   // без дублей
  // Перенос со старой схемы «одна комната»: код лежал отдельным полем.
  // Делается один раз — дальше groupId только мешал бы, поэтому обнуляем.
  if (config.groupId && !config.rooms.some(r => r.id === config.groupId)) {
    config.rooms.push({ id: config.groupId, title: i18nText("Карта друзей"), upload: !!config.uploadGroup });
    console.log(i18nText("[комнаты] прежняя карта друзей перенесена в список каналов"));
  }
  config.groupId = null;
  config.uploadGroup = false;
  // адрес обрезаем до origin: дальше к нему приписывается /rest/v1/rpc/...
  config.syncUrl = /^https:\/\/[\w.-]+/i.test(String(config.syncUrl || '')) ? String(config.syncUrl).trim().replace(/\/+$/, '') : '';
  config.syncKey = String(config.syncKey || '').trim();
  config.updateUrl = update.normalizeUrl(config.updateUrl);
  // Область плашки уходит прямиком в BitBlt, а тот выделяет w*h*4 байт. При выборе
  // мышью она проверяется по экрану, но в config.json могла попасть и другим путём —
  // от старой версии, от чужой правки файла, от сбоя записи. Проверяем при каждой
  // загрузке: четыре целых числа в разумных пределах, иначе возвращаемся к стандартной.
  const r = config.zoneBarRegion;
  const int = v => Number.isFinite(v) && Number.isInteger(v);
  const sane = r && typeof r === 'object'
    && int(r.left) && int(r.top) && int(r.width) && int(r.height)
    && r.width >= 20 && r.width <= 8000 && r.height >= 8 && r.height <= 2000
    && Math.abs(r.left) <= 20000 && Math.abs(r.top) <= 20000;
  if (r && !sane) console.warn(i18nText("[конфиг] область плашки зоны не годится, беру стандартную:"), JSON.stringify(r));
  config.zoneBarRegion = sane ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}
normConfig();
config.language = require('./lib/i18n').setLanguage(config.language);
ipcMain.on('get-language', event => { event.returnValue = config.language; });
function saveConfig() {
  jsonFile.writeObject(CONFIG_PATH, config);
}
// ОТЛОЖЕННАЯ ЗАПИСЬ — только для непрерывных настроек (ползунки).
//
// Ползунок размера плашки шлёт значение на каждый пиксель движения, и на каждое из них
// главный процесс СИНХРОННО писал конфиг на диск: mkdir + writeFileSync. Пока диск
// отвечает, главный процесс стоит — а именно он двигает окно плашки. Отсюда и рывки:
// плашка ехала не за мышью, а за диском.
//
// Тумблеры пишем как раньше, сразу: там одно нажатие — одна запись, откладывать нечего,
// а лишний отложенный хвост — лишний способ потерять настройку при вылете.
let saveTimer = null;
function saveConfigSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveConfig(); }, 400);
}
function flushConfig() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveConfig();
}

const BLANK_TEXT = i18nText("Кадр пустой — проверь, что игра в режиме \"оконный без рамки\", а не эксклюзивный полноэкранный");

// ---------- общие карты ----------
// Адрес проекта и ключ ЗАШИТЫ В СБОРКУ: игроку нечего вставлять руками, он просто
// ставит приложение и жмёт «Создать карту». Ключ publishable для того и сделан, чтобы
// лежать открыто в клиенте — защищают не он, а правила доступа в самой базе
// (таблицы закрыты наглухо, наружу торчат три функции, работающие по коду карты).
// Поля в панели остаются: кто захочет свой проект — впишет свои значения, пустые
// означают «взять зашитые».
const BUILTIN_SYNC = {
  url: 'https://qmcnvhufsadnkudtymjc.supabase.co',
  key: 'sb_publishable_S2iVb80RoMu6lgwm3xMS6w_zmG3DMH_',
};
const syncUrlOf = () => config.syncUrl || BUILTIN_SYNC.url;
const syncKeyOf = () => config.syncKey || BUILTIN_SYNC.key;

// Где приложение ищет новые версии. ЗАШИТО В СБОРКУ — игроку нечего настраивать: он
// ставит приложение и раз в час оно само смотрит, не вышло ли обновление. Поля в панели
// для этого больше нет: спрашивать у человека адрес репозитория программы, которую он
// только что скачал, — бессмысленно.
// 'owner/repo' на GitHub — приложение спрашивает про новые версии у GitHub API.
// Пусто — не проверяет вовсе.
const BUILTIN_UPDATE = 'xxWiFixx/avalon-mapper';
const updateUrlOf = () => config.updateUrl || update.normalizeUrl(BUILTIN_UPDATE);

// Свои порталы уходят в карту друзей и/или в общую, чужие доливаются в нашу.
// Сеть не должна мешать игре: выгрузка идёт очередью на диске, ответа никто не ждёт,
// а без интернета приложение работает ровно как раньше — на своей карте.
// Личная карта хранится локально и синхронизируется с гостевой облачной картой.
// Discord нужен для карт друзей и восстановления карты на другом устройстве.
let auth = null;
let discordAuth = null;
let guestAuth = null;
let cloudPolicy = null;
let cloudError = null;
function initAuth() {
  // На Windows safeStorage доступен только после app.ready. Создание auth также
  // читает сохранённый вход, поэтому весь этот шаг выполняется после готовности.
  if (!app.isReady()) throw new Error(i18nText("Хранилище входа ещё не готово"));
  const authOptions = {
    log: msg => console.log(msg),
    openExternal: url => shell.openExternal(url),
    secret: {
      encrypt: s => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s).toString('base64') : null,
      decrypt: s => safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(s, 'base64')) : null,
    },
  };
  discordAuth = authLib.createAuth({ ...authOptions, file: path.join(DATA_DIR, 'auth.json') });
  guestAuth = authLib.createAuth({ ...authOptions, file: path.join(DATA_DIR, 'guest-auth.json') });
  for (const account of [discordAuth, guestAuth]) account.configure({ url: syncUrlOf(), key: syncKeyOf() });
  auth = discordAuth.status().signedIn ? discordAuth : guestAuth;
}

const net = sync.createSync({
  compactReads: true,
  file: path.join(DATA_DIR, 'sync-outbox.json'),
  log: msg => console.log(msg),
  // Токен вошедшего. Вернёт null — синхронизация молча ждёт: очередь копится на диске
  // и уйдёт, как только человек войдёт. Ни одного выброшенного ребра.
  getToken: () => auth.token(),
  onSnapshot: (list, scope, pending) => {
    const clean = list.filter(e => e && recognize.ZONE_INFO.has(e.a) && recognize.ZONE_INFO.has(e.b));
    const changed = cloudPolicy && scope === cloudPolicy.personalMap
      ? store.replacePersonal(clean, scope, pending)
      : store.replaceRemote(clean, scope, pending);
    if (changed) send('map-updated', store.snapshot());
    return changed;
  },
  onAccess: (id, access) => {
    const room = config.rooms.find(r => r.id === id);
    if (!room) return;
    if (access.paused) {
      if (!room.paused) { room.paused = true; saveConfig(); applySync(); send('rooms-changed', config.rooms); }
      return;
    }
    if (access.role === 'none') {
      config.rooms = config.rooms.filter(r => r.id !== id);
      store.dropMap(id);
      send('map-updated', store.snapshot());
    } else {
      if (room.role === access.role && room.confirmRequired === access.confirmRequired) return;
      room.role = access.role;
      room.confirmRequired = access.confirmRequired;
    }
    saveConfig(); applySync(); send('rooms-changed', config.rooms);
  },
  onMerge: (list, scope) => {
    // Чужим рёбрам не верим на слово. В общую карту пишет кто угодно — ключ лежит
    // в сборке, и это нормально, — поэтому имя зоны, которого нет в справочнике игры,
    // в карту не попадает вовсе. Проверка дешёвая (поиск в Map) и отсекает разом
    // и мусор, и попытку раздуть карту выдуманными зонами.
    const clean = (list || []).filter(e =>
      e && recognize.ZONE_INFO.has(e.a) && recognize.ZONE_INFO.has(e.b));
    const dropped = (list || []).length - clean.length;
    if (dropped) console.warn(i18nText("[синх] отброшено рёбер с незнакомыми зонами: {0}", [dropped]));
    const n = store.mergeRemote(clean, scope);
    if (!n) return;
    // Сравнивать надо с кодом общей карты, а не со словом 'public': scope давно стал
    // id карты, и старое сравнение не совпадало никогда — рёбра из общей карты
    // показывались как «из карты друзей».
    const where = i18nText("карты друзей");
    console.log(i18nText("[синх] из {0} принято рёбер: {1}", [where, n]));
    send('toast', { text: i18nText("Из {0}: {1} {2}", [where, n, n === 1 ? i18nText("портал") : i18nText("портала(ов)")]) });
    send('map-updated', store.snapshot());
  },
});
// Проверка обновлений. Приложение раздаётся файлом, значит само должно сказать,
// что вышло новое: иначе половина друзей останется на старой сборке навсегда.
// Скачивает и ставит человек руками — автоматически подсовывать exe мы не будем.
const updater = update.createChecker({
  currentVersion: app.getVersion(),
  getUrl: () => updateUrlOf(),
  log: msg => console.log(msg),
  onFound: info => send('update-available', info),
});
ipcMain.handle('update-status', () => updater.status());
ipcMain.handle('update-check', async () => { await updater.check(true); return updater.status(); });
// Открываем ссылку в браузере — и только ту, что прошла проверку в lib/update.js
// (https и тот же хост, что у файла версий, либо его поддомен). Ничего не скачиваем
// и не запускаем сами.
ipcMain.handle('update-open', async () => {
  const st = updater.status();
  if (!st.url) return { ok: false, error: i18nText("ссылки на новую версию нет") };
  await shell.openExternal(st.url);
  return { ok: true, url: st.url };
});

const subscriptions = require('./lib/subscriptions').createSubscriptions({
  accountId: () => auth?.status().userId || null,
  status: () => net.billingStatus(),
  onChange: status => {
    let changed = false;
    if (status.ready) for (const group of status.groups || []) {
      const room = config.rooms.find(r => r.id === group.mapId);
      const paused = !!status.enabled && !group.active;
      if (room && group.title && room.title !== group.title) { room.title = group.title; changed = true; }
      if (room && !!room.paused !== paused) { room.paused = paused; changed = true; }
    }
    if (changed) { saveConfig(); applySync(); send('rooms-changed', config.rooms); }
    send('billing-changed', status);
  },
});

function applySync() {
  net.configure(Object.assign({}, config, {
    syncUrl: syncUrlOf(), syncKey: syncKeyOf(), syncAccountId: auth.status().userId,
    accountPolicy: cloudPolicy,
    rooms: auth.status().guest ? [] : config.rooms,
  }));

    const dropped = store.dropMap(sync.PUBLIC_MAP_ID);
    if (dropped.cleaned || dropped.removed) send('map-updated', store.snapshot());
  if (net.status().enabled) net.start(); else net.stop();
  send('sync-status', Object.assign(net.status(), { auth: auth.status() }));
}

async function refreshAccountPolicy() {
  const userId = auth.status().userId;
  if (!userId) return null;
  const policy = await net.accountPolicy();
  if (auth.status().userId !== userId || policy?.personalMap !== userId) return null;
  cloudPolicy = policy;
  cloudError = null;
  applySync();
  await subscriptions.refresh();
  // A guest and the linked Discord login share this device map. Keep a separate
  // high-water mark per account so switching between them sends only new observations.
  const seeds = config.personalSeededAtBy && typeof config.personalSeededAtBy === 'object'
    ? config.personalSeededAtBy : {};
  const previousGuest = config.personalSeededFor === guestAuth?.status().userId;
  const currentGuest = auth.status().guest;
  if (!config.personalSeededFor || config.personalSeededFor === userId || previousGuest || currentGuest) {
    const since = Number(seeds[userId]) || (config.personalSeededFor === userId
      ? Number(config.personalSeededAt) || 0 : 0);
    for (const edge of store.snapshot().edges) {
      if (store.mapsOf(edge).includes('local') && (edge.updatedAt || 0) > since) net.pushPersonal(edge, { restore: true });
    }
    seeds[userId] = Date.now();
    config.personalSeededAtBy = seeds;
    config.personalSeededFor = userId;
    config.personalSeededAt = seeds[userId];
    saveConfig();
  } else {
    config.personalSeededFor = userId;
    config.personalSeededAt = Date.now();
    saveConfig();
  }
  pushConfig();
  await net.tick(true);
  return policy;
}

async function activateGuest() {
  if (auth !== guestAuth) return null;
  if (!await guestAuth.token()) await guestAuth.signInAnonymously(config.nick);
  if (auth !== guestAuth) return null;
  await guestAuth.ensureProfile(config.nick);
  if (auth !== guestAuth) return null;
  cloudPolicy = null;
  subscriptions.reset();
  cloudError = null;
  applySync();
  send('auth-changed', guestAuth.status());
  await refreshAccountPolicy();
  return guestAuth.status();
}

let win = null;
let currentZone = null;
let zoneRevision = 0; // результаты старых кадров не должны откатывать новый переход
let pendingZone = null; // кандидат на смену зоны: фоновый опрос коммитит со 2-го подтверждения
let zoneSeenAt = 0;     // когда плашку зоны подтвердили в последний раз (см. lib/origin.js)
// порталы, для которых зона на момент нажатия была неизвестна: ждут её несколько секунд
const parking = origin.createParking();
let parkedSequence = 0;
let lastHotkeyAt = 0; // защита от автоповтора зажатой клавиши
let quitting = false;

// ---------- отправка в UI с буфером до готовности окна ----------
// webContents.send до did-finish-load теряется — копим и досылаем.
let uiReady = false;
const outbox = [];
function send(ch, payload) {
  if (!win || win.isDestroyed()) return;
  if (!uiReady) { if (outbox.length < 50) outbox.push([ch, payload]); return; }
  win.webContents.send(ch, payload);
}

// ---------- игровой оверлей: некликабельная плашка поверх игры ----------
let overlay = null, overlayReady = false, overlayTimer = null;
let practiceOverlayUntil = 0;
let manualOverlaysHidden = false, gameOverlaysInactive = false, gameWindowSeen = false;
let gameWindowBounds = null;
let suspendedOverlay = false, gameWindowTimer = null, gameWindowCheckRunning = false, overlayHealthTimer = null;
function overlaysHidden() { return manualOverlaysHidden || gameOverlaysInactive; }
const overlayHealthEvents = [];
let overlayHealthWrite = Promise.resolve();
const overlayRuntime = overlayHealth.create({
  paused: () => overlaysHidden(), stopped: () => quitting || !win || win.isDestroyed(),
  log: event => {
    // Local diagnostics contain window kinds and failure codes only: no names,
    // coordinates, game traffic, screenshots or account credentials.
    overlayHealthEvents.push({ at: Date.now(), ...event });
    if (overlayHealthEvents.length > 128) overlayHealthEvents.shift();
    const text = JSON.stringify(overlayHealthEvents);
    overlayHealthWrite = overlayHealthWrite.catch(() => {}).then(() =>
      fs.promises.writeFile(path.join(DATA_DIR, 'overlay-health.json'), text));
    overlayHealthWrite.catch(() => {});
    console.warn('[overlay-health]', event.kind, event.event, event.reason);
  },
});

// Предпросмотр принадлежит конкретному нажатию. OCR старого кадра может ещё идти,
// когда игрок уже открыл поиск, спрятал плашку или снял следующий портал.
// Это управляет только показом: запись полностью прочитанного портала живёт отдельно.
let portalPreviewSequence = 0, portalPreview = null;
function beginPortalPreview() {
  // Старый таймер не должен погасить новое нажатие, пока запасной захват ещё ждёт кадр.
  clearTimeout(overlayTimer);
  const id = ++portalPreviewSequence;
  portalPreview = { id, complete: false };
  return id;
}
function cancelPortalPreview() {
  portalPreview = null;
}
function portalPreviewCurrent(id) {
  return !!portalPreview && portalPreview.id === id && !portalPreview.complete;
}
function showPortalPreview(id, tip) {
  if (!portalPreviewCurrent(id) || quitting || overlaySetup || (search && !search.isDestroyed())) return;
  showOverlay({ tip, partial: true }, id);
}

// Где стоять оверлею. По умолчанию — над миникартой справа внизу, как часть HUD:
// привязываемся к ОТКАЛИБРОВАННОЙ плашке зоны (её игрок может подвинуть мышью), а не к
// углу экрана. Игрок может перетащить плашку куда угодно (config.overlayPos) и задать
// размер (config.overlayScale) — тогда автоматическая привязка не используется вовсе.
// Сама арифметика — в lib/overlay-place.js, здесь только опрос экранов.
let lostPosWarned = false;
function overlayBounds() {
  const p = config.overlayPos;
  const posDisplay = p ? screen.getDisplayNearestPoint({ x: p.x, y: p.bottom - 1 }) : null;
  const good = place.validPos(p, posDisplay);
  if (p && !good && !lostPosWarned) {
    lostPosWarned = true;   // место ищется перед каждым показом — в лог пишем один раз
    console.warn(i18nText("[оверлей] сохранённое место вне экранов — возвращаюсь к стандартному"));
  }
  const displays = screen.getAllDisplays().map(display => ({ ...display,
    physicalBounds: screen.dipToScreenRect(null, display.bounds) }));
  const region = config.zoneBarRegion;
  const regionRect = region && { left: region.left, top: region.top,
    right: region.left + region.width, bottom: region.top + region.height };
  const gameDisplay = place.displayForRect(gameWindowBounds, displays);
  const regionDisplay = place.displayForRect(regionRect, displays);
  const display = good ? posDisplay : (gameDisplay || regionDisplay ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  const strip = zoneStripRect(display, !region || regionDisplay?.id === display.id);
  return place.bounds({ strip, scale: config.overlayScale, pos: good ? p : null, display });
}

// Ни одно наше окно не должно уметь открыть новое или уйти на чужой адрес.
// Сейчас это недостижимо (страницы локальные, есть CSP, удалённое содержимое не
// грузится), но по умолчанию Electron разрешает и то и другое, а окно, открытое
// через window.open, наследует наш preload вместе с доступом к IPC. Одна дыра в
// вёрстке — и это стало бы прямой дорогой наружу. Закрываем заранее.
function lockNavigation(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) { e.preventDefault(); console.warn(i18nText("[окно] переход запрещён:"), url); }
  });
  wc.on('will-attach-webview', e => e.preventDefault());
}

// Оверлей — единственное окно, которое игрок никогда не видит закрытым: оно спрятано,
// пока не нажат хоткей. Поэтому его смерть не проявляется ничем. Страница упала —
// окно живо и не destroyed, overlayReady так и остался true, showOverlay честно шлёт
// событие в пустоту и показывает прозрачный прямоугольник. Снаружи это выглядит как
// «оверлей перестал работать», при том что захват, распознавание и запись рёбер идут.
// Отсюда правило: потерянное окно поднимаем сами, а не ждём перезапуска приложения.
function reviveOverlay(why) {
  cancelPortalPreview();
  overlayReady = false;
  if (quitting || !win || win.isDestroyed()) return;
  console.error(i18nText("[оверлей] окно потеряно (") + why + i18nText(") — поднимаю заново"));
  clearTimeout(overlayTimer); clearTimeout(overlayFadeTimer);
  stopDrag(false);
  const dead = overlay;
  overlay = null;
  if (dead && !dead.isDestroyed()) {
    if (!dead.webContents.isDestroyed() && !dead.webContents.isCrashed()) dead.webContents.forcefullyCrashRenderer();
    dead.destroy();
  }
  overlaySetup = false;
  setupBackup = null;
  suspendedOverlay = !!guide;
  lastZoom = null;
  createOverlay();
}

function createOverlay() {
  const b = overlayBounds();
  // Все обработчики ниже держатся за СВОЁ окно (w), а не за общую переменную overlay:
  // после подъёма она указывает уже на другое окно, и запоздавшее событие мёртвой
  // страницы иначе правило бы состояние живой.
  const w = overlay = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
    show: false,
    webPreferences: webPrefs(path.join(__dirname, 'preload-overlay.js'), { backgroundThrottling: false, partition: 'portal-overlay' }),
  });
  overlayCapture.register(w);
  overlay.setAlwaysOnTop(true, 'screen-saver'); // выше окна игры в borderless
  overlay.setIgnoreMouseEvents(true);           // клики проходят сквозь оверлей в игру
  w.webContents.on('did-finish-load', () => {
    if (w !== overlay) return;             // событие от окна, которое мы уже сняли
    overlayReady = true;
    w.webContents.setZoomFactor(b.zoom);   // вёрстка задана в пикселях 1080p
    // Страница пересоздана (упала и поднялась, сменился масштаб) — вернуть проводник.
    // Он живёт в main, а рисуется в окне: без этого маршрут тихо пропал бы с экрана,
    // хотя приложение считало бы, что ведёт.
    if (guide) { placeOverlay(); suspendedOverlay = true; if (!overlaysHidden()) w.showInactive(); pushGuide(); }
  });
  overlayRuntime.watch(w, { kind: 'portal', current: () => w === overlay,
    ready: () => overlayReady, lost: () => { overlayReady = false; },
    recover: reviveOverlay, recoverClosed: true });
  lockNavigation(w.webContents);
  w.loadFile(path.join(__dirname, 'ui', 'overlay.html'));
}

// Перед каждым показом пересчитываем место: игрок мог сменить разрешение, перетащить
// игру на другой монитор или заново указать плашку зоны мышью.
let lastZoom = null;   // последний применённый масштаб страницы плашки
function placeOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  const b = overlayBounds();
  const cur = overlay.getBounds();
  if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
    overlay.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }
  // Масштаб страницы ставим, только когда он ДЕЙСТВИТЕЛЬНО другой. Вызов уходит в
  // процесс отрисовки и стоит заметно; на ползунке размера он повторялся на каждый
  // пиксель движения, хотя менялся редко — а размеры окна уже подогнаны выше.
  if (overlayReady && b.zoom !== lastZoom) {
    lastZoom = b.zoom;
    overlay.webContents.setZoomFactor(b.zoom);
  }
}

// Почему плашка не показалась — вслух. Раньше оба показа просто выходили из функции,
// и все четыре разные причины выглядели одинаково: игрок жмёт хоткей, ничего не
// происходит, и понять, выключен ли оверлей, идёт ли настройка или умерло окно,
// нельзя ни из приложения, ни по журналу.
// ПРОВОДНИК ПО МАРШРУТУ.
//
// Плашка зоны живёт семь секунд и гаснет — она отвечает на «что там за порталом».
// Проводник отвечает на другое: «куда мне сейчас бежать», и потому висит, пока идёшь.
// Живёт он в том же окне: место, размер и «поверх всех» уже настроены игроком, а второе
// окно пришлось бы двигать и масштабировать отдельно.
let guide = null;   // { steps, to, at } либо null

// Сколько «пришёл» висит на экране, прежде чем плашка уйдёт сама.
// Насовсем оставлять нельзя: маршрут кончился, а поверх игры продолжает висеть окно,
// и игрок вынужден лезть в приложение, чтобы его убрать. Но и гасить мгновенно нельзя —
// подтверждение «дошёл» надо успеть увидеть, иначе непонятно, доведено дело до конца
// или проводник просто отвалился.
const GUIDE_DONE_MS = 8000;
let guideDoneTimer = null;

function pushGuide() {
  if (!overlay || overlay.isDestroyed() || !overlayReady) return;
  const b = guide ? routeGuide.board(guide, currentZone) : null;
  overlay.webContents.send('overlay-guide', b);
  clearTimeout(guideDoneTimer);
  guideDoneTimer = null;
  // Дошёл — показываем это и через несколько секунд убираем плашку сами.
  if (b && b.state === 'done') {
    guideDoneTimer = setTimeout(() => {
      guideDoneTimer = null;
      stopGuide();
      send('route-guide-off', { reason: 'done' });   // окно карты вернёт кнопку в исходное
    }, GUIDE_DONE_MS);
  }
}

function startGuide(route) {
  const steps = route && Array.isArray(route.steps) ? route.steps : [];
  if (!steps.length) return { on: false, reason: i18nText("маршрут пуст — вести некуда") };
  const why = overlayBlocked();
  if (why) return { on: false, reason: why };
  guide = { steps, to: route.to || null, at: Date.now(), planned: Array.isArray(route.waypoints) || !!route.contentGoals };
  placeOverlay();
  clearTimeout(overlayFadeTimer);
  suspendedOverlay = true;
  if (!overlaysHidden()) overlay.showInactive();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  pushGuide();
  console.log(i18nText("[маршрут] веду:"), steps.length, i18nText("шагов до"), guide.to || steps[steps.length - 1].to);
  return { on: true, zone: currentZone || null };
}

function stopGuide() {
  clearTimeout(guideDoneTimer);
  guideDoneTimer = null;
  if (!guide) return { on: false };
  guide = null;
  pushGuide();
  hideOverlay();
  return { on: false };
}

function overlayBlocked(lookup = false) {
  if (!lookup && !config.overlayEnabled) return i18nText("оверлей выключен в настройках");
  if (overlaySetup) return i18nText("идёт настройка места плашки — нажми «Готово»");
  if (!overlay || overlay.isDestroyed()) return i18nText("окно оверлея потеряно");
  if (!overlayReady) return i18nText("окно оверлея ещё не загрузилось");
  return null;
}

// Одну и ту же причину повторяем один раз: хоткей жмут десятки раз за вылазку,
// и поток одинаковых сообщений мешал бы игре сильнее, чем сама пропажа плашки.
let lastBlock = '';
function blocked(why) {
  // окно потеряно — не просто жалуемся, а поднимаем; выключенный оверлей поднимать незачем
  if (config.overlayEnabled && (!overlay || overlay.isDestroyed())) reviveOverlay(why);
  if (why === lastBlock) return true;
  lastBlock = why;
  console.warn(i18nText("[оверлей] не показываю:"), why);
  send('toast', { text: i18nText("Плашка не показана: ") + why });
  return true;
}

function showOverlay(payload, previewId = null) {
  if (previewId !== null) {
    if (!portalPreviewCurrent(previewId)) return;
    if (!payload.partial) portalPreview.complete = true;
  } else if (!payload.partial) cancelPortalPreview();
  const why = overlayBlocked(payload.lookup === true);
  if (why) return blocked(why);
  if (payload.tip && !payload.partial) payload = { ...payload, tip: portalTime.refresh(payload.tip) };
  lastBlock = '';
  placeOverlay();
  clearTimeout(overlayFadeTimer);   // показываем поверх недоигравшего исчезновения
  overlay.webContents.send('overlay-show', Object.assign({ showMap: config.overlayMap }, payload));
  suspendedOverlay = true;
  if (!overlaysHidden() || payload.practice === true) overlay.showInactive(); // без перехвата фокуса у игры
  // «Поверх всех» ПОДТВЕРЖДАЕМ НА КАЖДЫЙ ПОКАЗ, а не один раз при создании окна.
  // В Windows статус topmost не вечен: его сбивает всё, что само лезет наверх, —
  // оверлей Discord, уведомления системы, переход игры между «оконный без рамки»
  // и эксклюзивным полноэкранным, смена разрешения. Окно при этом остаётся живым,
  // overlayReady так и стоит true, событие доходит, showInactive() не жалуется —
  // а плашка рисуется ПОД игрой. Снаружи это «оверлей перестал работать», и в
  // журнале ни следа, потому что с точки зрения приложения всё удалось.
  // Отсюда и запись в журнал: если статус пришлось возвращать, это надо видеть —
  // иначе причина снова окажется невоспроизводимой.
  if (!overlay.isAlwaysOnTop()) {
    console.warn(i18nText("[оверлей] окно потеряло «поверх всех» — возвращаю"));
  }
  overlay.setAlwaysOnTop(true, 'screen-saver');
  clearTimeout(overlayTimer);
  // ошибку держим не дольше обычного, но и не меньше 3,5 с — её надо успеть прочитать
  const hold = (config.overlayHoldSec || 7) * 1000;
  overlayTimer = setTimeout(() => hideOverlay(), payload.partial ? BUSY_MAX_MS : payload.error ? Math.max(3500, hold) : hold);
}

// Прячем в два шага: сначала вёрстка плавно гасит блок, и только когда анимация
// доиграла — убираем само окно. Раньше окно исчезало мгновенно, и это резало глаз:
// поверх живой игры любой мгновенный скачок читается как сбой, а не как «ушло».
const OVERLAY_FADE_MS = 260;   // синхронно с анимацией ov-out в ui/overlay.css
let overlayFadeTimer = null;
function hideOverlay(instant = false) {
  cancelPortalPreview();
  practiceOverlayUntil = 0;
  if (!overlay || overlay.isDestroyed()) return;
  clearTimeout(overlayFadeTimer);
  if (!guide && !overlaySetup) suspendedOverlay = false;
  // Пока ведём по маршруту, окно остаётся: гаснет только плашка зоны, проводник живёт
  // дальше. Иначе он исчезал бы вместе с семисекундной плашкой — то есть почти сразу.
  if (instant) {
    overlay.webContents.send('overlay-hide', { instant: true });
    if (!guide) overlay.hide();
    return;
  }
  overlay.webContents.send('overlay-hide', {});
  overlayFadeTimer = setTimeout(() => {
    if (overlay && !overlay.isDestroyed() && !overlaySetup && !guide) overlay.hide();
  }, OVERLAY_FADE_MS);
}

// Кадр снят — показываем это сразу, не дожидаясь распознавания. Иначе между
// нажатием и ответом проходит около секунды, в которую игрок не знает, сработало ли
// вообще, и жмёт ещё раз. Плашка встаёт на своё обычное место и сменяется результатом.
const BUSY_MAX_MS = 12000;   // страховка: ответ не пришёл вовсе — не висим вечно
function showBusy(previewId = null) {
  if (previewId !== null && !portalPreviewCurrent(previewId)) return;
  const why = overlayBlocked();
  if (why) return blocked(why);
  lastBlock = '';
  placeOverlay();
  clearTimeout(overlayFadeTimer);
  overlay.webContents.send('overlay-show', { busy: true, showMap: config.overlayMap });
  suspendedOverlay = true;
  if (!overlaysHidden()) overlay.showInactive();
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => hideOverlay(), BUSY_MAX_MS);
}

// ---------- настройка оверлея: перетащить мышью и задать размер ----------
// Обычно плашка некликабельна и живёт 7 секунд. На время настройки она,
// наоборот, ловит мышь и висит, пока игрок не скажет «готово».
let overlaySetup = false, setupBackup = null;
let dragTimer = null, dragFrom = null, dragBounds = null;

// Образец для настройки: настоящая зона со всеми видами значков — чтобы игрок
// подбирал место и размер под то, что реально увидит, а не под пустую рамку.
function sampleTip() {
  const pick = ['Xiros-Aiairom', 'Oiros-Alaiam', 'Ooros-Ataltum'].find(n => recognize.ZONE_INFO.has(n));
  const name = pick || [...recognize.ZONE_INFO.keys()][0];
  const i = recognize.zoneInfo(name);
  return { name, color: i.color || 'avalon', tier: i.tier, quality: i.quality, activities: i.activities, capMax: 20, capMaxKnown: true, closes: 4920 };
}

function sendSetupFrame() {
  if (!overlaySetup || !overlay || overlay.isDestroyed()) return;
  placeOverlay();
  overlay.webContents.send('overlay-show', {
    setup: true, showMap: config.overlayMap, scale: config.overlayScale,
    custom: !!config.overlayPos, tip: sampleTip(), from: 'Cairn Camain',
  });
}

function startOverlaySetup() {
  if (!config.overlayEnabled) return { ok: false, error: i18nText("оверлей выключен") };
  if (!overlay || overlay.isDestroyed() || !overlayReady) {
    reviveOverlay(i18nText("настройка места при мёртвом окне"));   // кнопка заодно и чинит
    return { ok: false, error: i18nText("окно оверлея потеряно — поднимаю заново, повтори через пару секунд") };
  }
  cancelPortalPreview();
  if (!overlaySetup) setupBackup = { scale: config.overlayScale, pos: config.overlayPos };
  const gameDisplay = typeof gameWindowBounds !== 'undefined' && gameWindowBounds &&
    place.displayForRect(gameWindowBounds, screen.getAllDisplays());
  if (gameDisplay && config.overlayPos) {
    const posDisplay = screen.getDisplayNearestPoint({ x: config.overlayPos.x, y: config.overlayPos.bottom - 1 });
    if (posDisplay.id !== gameDisplay.id) config.overlayPos = null;
  }
  overlaySetup = true;
  clearTimeout(overlayTimer);
  overlay.setIgnoreMouseEvents(false);   // на время настройки плашку можно схватить мышью
  overlay.setFocusable(true);            // и нажать Enter/Esc
  overlay.setAlwaysOnTop?.(true, 'screen-saver'); // changing focusability can recreate the native window
  sendSetupFrame();
  suspendedOverlay = true;
  if (!manualOverlaysHidden) { overlay.show(); overlay.focus(); }
  pushConfig();
  return { ok: true };
}

function endOverlaySetup(save) {
  if (!overlaySetup) return;
  stopDrag(false);
  if (!save && setupBackup) {
    config.overlayScale = setupBackup.scale;
    config.overlayPos = setupBackup.pos;
  }
  setupBackup = null;
  overlaySetup = false;
  saveConfig();
  if (overlay && !overlay.isDestroyed()) {
    overlay.setIgnoreMouseEvents(true);
    overlay.setFocusable(false);
    overlay.setAlwaysOnTop?.(true, 'screen-saver');
    hideOverlay(true);
    placeOverlay();
  }
  pushConfig();
}

// Тащим окно из main-процесса по позиции курсора: координаты мыши в рендерере
// зависят от zoom-фактора окна, а getCursorScreenPoint — нет, и меряет он ровно
// в тех же точках (DIP), в которых задаются границы окна.
function startDrag() {
  if (!overlaySetup || !overlay || overlay.isDestroyed()) return;
  stopDrag(false);
  dragFrom = screen.getCursorScreenPoint();
  dragBounds = overlay.getBounds();
  const startedAt = Date.now();
  dragTimer = setInterval(() => {
    if (!overlay || overlay.isDestroyed()) return stopDrag(false);
    if (Date.now() - startedAt > 30000) return stopDrag(true); // потерялось «отпустил» — не ездим вечно
    const p = screen.getCursorScreenPoint();
    overlay.setBounds(place.dragTo({
      bounds: dragBounds, dx: p.x - dragFrom.x, dy: p.y - dragFrom.y,
      workArea: screen.getDisplayNearestPoint(p).workArea,
    }));
  }, 16);
}

function stopDrag(save) {
  clearInterval(dragTimer);
  dragTimer = null;
  if (!save || !overlay || overlay.isDestroyed()) return;
  const b = overlay.getBounds();
  config.overlayPos = { x: b.x, bottom: b.y + b.height };
  saveConfig();
  pushConfig();
}
// Конфиг в панель уходит вместе с признаком «идёт настройка места»: по нему
// кнопка в панели знает, показывать «Задать место» или «Готово».
// Что именно игрок успел изменить в режиме размещения. Нужно окну карты: спрашивать
// «сохранить?» имеет смысл, только когда есть что сохранять, и текст вопроса должен
// называть сделанное — «двигали», «меняли размер» или и то и другое.
function setupChanges() {
  if (!overlaySetup || !setupBackup) return { moved: false, resized: false };
  const a = setupBackup.pos, b = config.overlayPos;
  const moved = !a !== !b || (a && b && (a.x !== b.x || a.bottom !== b.bottom));
  return { moved: !!moved, resized: config.overlayScale !== setupBackup.scale };
}
// Конфиг для окна — ОДНОЙ функцией. Три пути отдавали его порознь (get-config, ответ
// set-option и рассылка config-changed), и признаки режима размещения были только
// в третьем: стоило подвигать ползунок размера прямо во время настройки, как ответ
// set-option затирал их в окне, и вопрос «сохранить?» больше не задавался.
function configForWindow() {
  return Object.assign({
    appVersion: app.getVersion(), dev: DEV,
    setupActive: overlaySetup, setupChanges: setupChanges(),
    cloudPolicy,
    billing: subscriptions.snapshot(),
    cloudError,
    // почему трафик не слушается (нет прав, не открылся сокет) — иначе выбранный
    // источник молча не работал бы, а в окне всё выглядело бы включённым
    zoneError: trafficError,
  }, config, { cloudPolicy, cloudError,
    overlaysHidden: manualOverlaysHidden, gameInactive: gameOverlaysInactive,
    secondaryAccount: profile.secondary });
}
function pushConfig() { send('config-changed', configForWindow()); }

function flushOutbox() {
  uiReady = true;
  for (const [ch, payload] of outbox.splice(0)) {
    if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
  }
}

// ---------- глобальный бинд: клавиатура ИЛИ кнопка мыши (uiohook), фолбэк — globalShortcut F9 ----------
//
// ЧТО ЗДЕСЬ ПРОИСХОДИТ С НАЖАТИЯМИ — читать внимательно, это самое подозрительное
// место во всём приложении. uiohook-napi ставит системный перехват ввода, то есть
// технически тот же механизм, что у клавиатурного шпиона. Разница в том, что делается
// дальше, и она вся видна в тридцати строках ниже:
//   • код клавиши СРАВНИВАЕТСЯ с сохранёнными биндами и больше нигде не используется;
//   • ни одно нажатие не пишется ни в файл, ни в журнал, ни в сеть — во всём обработчике
//     нет ни console.log, ни обращения к диску;
//   • единственное, что сохраняется, — код клавиши, которую игрок сам назначил хоткеем,
//     и только в режиме назначения бинда (captureResolve);
//   • heldKeys держит коды ЗАЖАТЫХ клавиш, чтобы автоповтор не считался новым нажатием,
//     и очищается на keyup.
// Если когда-нибудь понадобится что-то логировать отсюда — это ровно та правка, которую
// нельзя делать не подумав: она превращает узкий перехват в слежку.
let uIOhook = null, UiohookKey = null, KEY_NAME = {};
let captureResolve = null; // активен режим «нажми клавишу/кнопку, чтобы назначить»
let captureTarget = 'binding';
const heldKeys = new Set(); // зажатые клавиши: keydown автоповторяется ~30 мс, нажатие — одно

function bindingLabel(target = 'binding') { return profile.secondary ? '—' : config[target]?.label || '—'; }
function initializeHotkeyBindings() {
  const targets = ['binding', 'searchBinding', 'manualBinding', 'overlayToggleBinding'];
  const defaults = { binding: ['F9', 'F7', 'F6'], searchBinding: ['F10', 'F8', 'F7', 'F6'],
    manualBinding: ['F8', 'F7', 'F6', 'F5', 'F4'] };
  let changed = false;
  for (const [target, keys] of Object.entries(defaults)) {
    if (config[target]) continue;
    const key = keys.find(key => UiohookKey[key] != null && !targets.some(other =>
      matchesBinding({ type: 'key', code: UiohookKey[key] }, config[other])));
    if (!key) continue;
    config[target] = { type: 'key', code: UiohookKey[key], label: key };
    changed = true;
  }
  if (changed) saveConfig();
}
let lastManualAt = 0;
function fireManualHotkey() {
  const now = Date.now();
  if (now - lastManualAt < (config.hotkeyDebounceMs || 350)) return;
  lastManualAt = now;
  setImmediate(() => {
    if (search && !search.isDestroyed() && searchMode === 'portal') closeSearch();
    else if (!overlaysHidden()) runHotkeySearch().catch(err =>
      console.error(i18nText("[ручной ввод] не удалось открыть форму:"), err));
  });
}
let lastSearchAt = 0;
function fireSearchHotkey() {
  const now = Date.now();
  if (now - lastSearchAt < (config.hotkeyDebounceMs || 350)) return;
  lastSearchAt = now;
  setImmediate(() => {
    if (search && !search.isDestroyed() && searchMode === 'lookup') closeSearch();
    else openSearch('lookup');
  });
}
let lastOverlayToggleAt = 0;
let onboardingPractice = false;
function fireOverlayToggleHotkey() {
  const now = Date.now();
  if (now - lastOverlayToggleAt < (config.hotkeyDebounceMs || 350)) return;
  lastOverlayToggleAt = now;
  setImmediate(() => {
    manualOverlaysHidden = !manualOverlaysHidden;
    syncOverlayWindowVisibility();
  });
}
function matchesBinding(a, b) {
  return !!a && !!b && a.type === b.type &&
    (a.type === 'mouse' ? a.button === b.button : a.code === b.code);
}
function fireHotkey() {
  if (search && !search.isDestroyed()) return;
  const now = Date.now();
  // Антидребезг 350 мс (config.hotkeyDebounceMs). Прежние 800 мс резали легитимные
  // нажатия по соседним порталам (человек успевает перевести мышь за ~400–500 мс).
  // Автоповтор зажатой клавиши отсекается отдельно — по heldKeys, а не таймером.
  if (now - lastHotkeyAt < (config.hotkeyDebounceMs || 350)) return;
  lastHotkeyAt = now;
  // В учебной сцене тот же глобальный хоткей показывает пример, не снимая игру
  // и не записывая портал в карту.
  if (onboardingPractice) {
    send('onboarding-practice-hotkey', { label: bindingLabel() });
    return;
  }
  hotkeyCapturing++;
  // ВАЖНО: колбэк хука обязан вернуться мгновенно. Любая долгая работа прямо здесь
  // подвешивает доставку событий uiohook → мышь в игре начинает дёргаться.
  setImmediate(() => {
    runHotkey()
      .catch(err => console.error(i18nText("[hotkey] непойманная ошибка:"), err))
      .finally(() => { hotkeyCapturing--; });
  });
}
function finishCapture(binding) {
  const resolve = captureResolve; captureResolve = null;
  const target = captureTarget;
  const targets = ['binding', 'manualBinding', 'searchBinding', 'overlayToggleBinding'];
  if (targets.some(other => other !== target && matchesBinding(binding, config[other]))) {
    send('toast', { text: i18nText("Эта клавиша уже назначена другому действию. Выбери другую.") });
    binding = null;
  }
  if (binding) { config[target] = binding; saveConfig(); }
  if (resolve) resolve(bindingLabel(target));
  send('binding-changed', { target, label: bindingLabel(target) });
}
function setupHook() {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
  KEY_NAME = Object.fromEntries(Object.entries(UiohookKey).map(([k, v]) => [v, k]));
  uIOhook.on('keydown', e => {
    if (captureResolve) {
      heldKeys.add(e.keycode);
      if (e.keycode === UiohookKey.Escape) return finishCapture(null);
      return finishCapture({ type: 'key', code: e.keycode, label: KEY_NAME[e.keycode] || 'Key' + e.keycode });
    }
    const b = { type: 'key', code: e.keycode };
    const manual = matchesBinding(b, config.manualBinding);
    const lookup = matchesBinding(b, config.searchBinding);
    const toggle = matchesBinding(b, config.overlayToggleBinding);
    if (manual || lookup || toggle || matchesBinding(b, config.binding)) {
      if (heldKeys.has(e.keycode)) return; // автоповтор удержания — не новое нажатие
      heldKeys.add(e.keycode);
      if (toggle) fireOverlayToggleHotkey();
      else if (manual) fireManualHotkey();
      else if (lookup) fireSearchHotkey();
      else if (!search) fireHotkey();
    }
  });
  uIOhook.on('keyup', e => { heldKeys.delete(e.keycode); });
  // Страховка перетаскивания оверлея: если кнопку отпустили там, где наше окно
  // события уже не получает, «мышь отпущена» приходит хотя бы отсюда — иначе
  // плашка так и ездила бы за курсором.
  uIOhook.on('mouseup', () => {
    if (dragTimer) setImmediate(() => stopDrag(true));
    if (damageWindowControls) setImmediate(() => damageWindowControls?.stopResize());
  });
  uIOhook.on('mousedown', e => {
    if (captureResolve) {
      // ЛКМ/ПКМ не назначаем — ими кликают по интерфейсу; средняя и боковые (3/4/5) — можно
      if (e.button >= 3) return finishCapture({ type: 'mouse', button: e.button, label: 'Mouse' + e.button });
      return;
    }
    const b = { type: 'mouse', button: e.button };
    if (matchesBinding(b, config.overlayToggleBinding)) fireOverlayToggleHotkey();
    else if (matchesBinding(b, config.manualBinding)) fireManualHotkey();
    else if (matchesBinding(b, config.searchBinding)) fireSearchHotkey();
    else if (!search && matchesBinding(b, config.binding)) fireHotkey();
  });
  uIOhook.start();
}

// ---------- захват экрана ----------
// Три пути пробовали:
//   desktopCapturer — весь экран, ~520 мс, прямоугольник взять нельзя;
//   постоянный поток getDisplayMedia — 8–11 мс, но живая сессия захвата и +240 МБ (отвергнут);
//   BitBlt (lib/capture-gdi) — одиночный снимок ПРЯМОУГОЛЬНИКА, 3–4 мс на полоску зоны.
// Основной путь — BitBlt; desktopCapturer остаётся страховкой, если GDI отдаст пустой кадр
// (так бывает при эксклюзивном полноэкранном режиме и на защищённом контенте).
let captureInFlight = 0;
const gameCapture = windowCapture.create({ getGame: () => gameWindow.state(),
  getSources: options => captureOnce(() => desktopCapturer.getSources(options)) });
const captureOverlayGuard = overlayCapture.create({
  busy: delta => { captureInFlight += delta; },
  toPhysical: bounds => screen.dipToScreenRect(null, bounds),
  captureWindow: rect => gameCapture.capture(rect),
});
// Прямой захват прямоугольника (BitBlt) отвалился — остаётся desktopCapturer, а он умеет
// снимать ТОЛЬКО экран целиком, прямоугольника у него нет вовсе. То есть с этого момента
// приложение начинает фотографировать весь рабочий стол на каждый опрос и каждое нажатие:
// в сто раз больше пикселей и в сто раз дольше. Молчать об этом нельзя — человек увидит
// лишь то, что «стало тормозить», и не поймёт почему.
const gdiRecovery = captureRecovery.create({ release: () => gdi.release() });
const captureOnce = captureRecovery.singleFlight();
let gdiWarned = false;
function noteGdiBroken(where, err) {
  gdiRecovery.failed();
  console.warn(i18nText("[gdi] {0}: {1} — откатываюсь на снимок всего экрана", [where, err && err.message ? err.message : err]));
  if (gdiWarned) return;
  gdiWarned = true;
  send('toast', { text: i18nText("Быстрый захват временно недоступен. Через 30 секунд маппер автоматически попробует восстановить его.") });
}

// ВАЖНО про координаты. BitBlt берёт кадр из GetDC(null) — это ВИРТУАЛЬНЫЙ рабочий стол,
// начало отсчёта = левый верхний угол ОСНОВНОГО монитора, у мониторов слева координаты
// отрицательные. Electron отдаёт точки в DIP того же виртуального пространства.
// Поэтому наружу отдаём физические ВИРТУАЛЬНЫЕ координаты (origin + размер), а не
// «локальные для дисплея»: раньше из точки вычиталось начало дисплея, и при игре на втором
// мониторе захват уезжал на ту же область основного.
function displayGeometry(d) {
  const sf = (d && d.scaleFactor) || 1;
  const b = d ? d.bounds : { x: 0, y: 0 };
  const size = d ? d.size : { width: 1920, height: 1080 };
  const physical = screen.dipToScreenRect?.(null, { x: b.x, y: b.y,
    width: b.width ?? size.width, height: b.height ?? size.height });
  return {
    originX: physical?.x ?? Math.round(b.x * sf), originY: physical?.y ?? Math.round(b.y * sf),
    width: physical?.width ?? Math.round(size.width * sf), height: physical?.height ?? Math.round(size.height * sf),
    scaleFactor: sf,
  };
}
function screenGeometry() { return displayGeometry(screen.getPrimaryDisplay()); }

// Прямоугольник плашки текущей зоны (правый нижний угол экрана).
function zoneStripRect(display = screen.getPrimaryDisplay(), useConfigured = true) {
  const { originX, originY, width: W, height: H } = displayGeometry(display);
  const s = H / 1080;
  const r = useConfigured ? config.zoneBarRegion : null;
  return r
    ? { x: r.left, y: r.top, width: r.width, height: r.height, screenHeight: H }
    : { x: originX + W - 400 * s, y: originY + H - 48 * s,
      width: 380 * s, height: 30 * s, screenHeight: H };
}

// ---------- снимки хоткея на диск (config.saveShots) ----------
// Ровно два файла с постоянными именами, каждое нажатие их перезаписывает: что было
// у курсора и что было в плашке зоны. Это ответ на вопрос «почему не распознало» —
// видно глазами, попал ли тултип в кадр и та ли область обведена.
// Кадра нет (снимок выключен настройкой) — старый файл удаляем, чтобы не врал.
const SHOTS_DIR = path.join(DATA_DIR, 'shots');
const portalShotArchive = createPortalShotArchive(path.join(SHOTS_DIR, 'portal-archive'));
const SHOT_FILES = { cursor: '1-у-курсора.png', zone: '2-плашка-зоны.png' };
// Отдельно — последний кадр, на котором тултип НЕ распознался. Свои имена у обычных
// снимков перезаписываются каждым нажатием, а после провала игрок жмёт хоткей ещё раз —
// и удачный повтор затирал именно тот кадр, который был нужен для разбора. Файл трогает
// только провал, поэтому он доживает до взгляда разработчика.
const SHOT_FAIL = '3-не-распознан.png';
function saveFailShot(frame) {
  if (!config.saveShots || !frame) return;
  shotChain = shotChain.then(async () => {
    await fs.promises.mkdir(SHOTS_DIR, { recursive: true });
    await sharp(F.toRGBA(frame), { raw: { width: frame.width, height: frame.height, channels: 4 } })
      .png({ compressionLevel: 3 }).toFile(path.join(SHOTS_DIR, SHOT_FAIL));
  }).catch(err => console.error(i18nText("[снимки] не сохранил провал:"), err.message));
}
let shotChain = Promise.resolve();
function saveShots(frames) {
  if (!config.saveShots) return shotChain;
  shotChain = shotChain.then(async () => {
    await fs.promises.mkdir(SHOTS_DIR, { recursive: true });
    for (const [key, file] of Object.entries(SHOT_FILES)) {
      const frame = frames[key];
      const dest = path.join(SHOTS_DIR, file);
      if (!frame) { await fs.promises.rm(dest, { force: true }); continue; }
      await sharp(F.toRGBA(frame), { raw: { width: frame.width, height: frame.height, channels: 4 } })
        .png({ compressionLevel: 3 }).toFile(dest);
    }
  }).catch(err => console.error(i18nText("[снимки] не сохранил:"), err.message));
  return shotChain;
}

// Кадр для фонового опроса: только полоска с плашкой зоны.
let stripLogged = false;
async function captureZoneStrip() {
  if (!readsScreen()) return null;
  const displays = screen.getAllDisplays().map(d => {
    const g = displayGeometry(d);
    return { ...d, physicalBounds: { x: g.originX, y: g.originY, width: g.width, height: g.height } };
  });
  const display = place.displayForRect(gameWindowBounds, displays) || screen.getPrimaryDisplay();
  const region = config.zoneBarRegion;
  const regionDisplay = region && place.displayForRect({ left: region.left, top: region.top,
    right: region.left + region.width, bottom: region.top + region.height }, displays);
  const rect = zoneStripRect(display, !region || regionDisplay?.id === display.id);
  if (!stripLogged) {
    stripLogged = true;
    const g = screenGeometry();
    console.log(i18nText("[захват] экран {0}x{1}, полоска зоны {2}x{3} ", [g.width, g.height, Math.round(rect.width), Math.round(rect.height)]) +
      i18nText("в ({0}, {1})", [Math.round(rect.x), Math.round(rect.y)]));
  }
  if (gdiRecovery.available() && gdi.available()) {
    const t0 = performance.now();
    try {
      const frame = await captureOverlayGuard.run(rect, () => gdi.grab(rect.x, rect.y, rect.width, rect.height));
      const st = F.stats(frame);
      // ПУСТАЯ ПОЛОСКА — НЕ ПОВОД СНИМАТЬ ВЕСЬ ЭКРАН ПРЯМО СЕЙЧАС.
      //
      // Раньше отсюда шёл переход на desktopCapturer: снимок всего экрана, 520–990 мс
      // на 4К и 33 МБ памяти на кадр. И это происходило на КАЖДОМ опросе, то есть раз
      // в полторы секунды. А полоска бывает пустой в самом обычном случае: игру свернули
      // или переключились в Discord — процесс жив, gameRunning() отвечает «да», а GDI
      // берёт чёрный прямоугольник. Приложение начинало непрерывно фотографировать
      // рабочий стол и разбирать его. Похоже, это и есть «жрёт ресурсы, особенно
      // у друзей»: у кого игра постоянно в фокусе, тот этого не видел.
      //
      // Теперь полоску отдаём как есть, с пометкой. Решает вызывающий: OCR по чёрному
      // кадру не гоняет, а весь экран смотрит изредка и с растущей паузой.
      return {
        frame, screenHeight: rect.screenHeight, strip: true,
        blank: st.blank, ms: Math.round(performance.now() - t0),
      };
    } catch (err) {
      noteGdiBroken(i18nText("снимок полоски зоны"), err);
    }
  }
  const cap = await captureScreen(display);
  return { frame: cap.frame, screenHeight: cap.frame.height, strip: false, ms: cap.ms };
}


// Кадр для хоткея: прямоугольник вокруг курсора. Тултип портала всплывает вплотную
// к курсору, поэтому весь рабочий стол снимать незачем — и быстрее, и в захват не
// попадает ничего постороннего. Не влез — распознавание один раз переснимет экран.
//
// Размеры не выдуманы, а замерены на 11 нажатиях в живой игре (1080p, лог [область]):
// тултип отстоял от курсора максимум на 307 влево, 326 вправо, 85 вверх — и НИКОГДА
// не опускался ниже курсора (вниз выходило −2…−16, то есть нижний край выше курсора).
// По горизонтали он перекидывается через курсор у краёв экрана, поэтому нужны обе стороны.
// Запас: горизонталь +10%, вверх — с расчётом на тултип с лишней строкой «можно войти
// через», вниз — на случай курсора у самой верхней кромки экрана, где перекинуться некуда.
const TIP_BOX = { left: 360, right: 360, up: 150, down: 120 };  // в пикселях 1080p, масштабируется
// А СНИМАЕМ мы вдвое больший квадрат — вот этот. Запас нужен тем, у кого крупнее масштаб
// интерфейса, необычное соотношение сторон или тултип с лишней строкой: замеры выше сняты
// на одной машине, и подгонять захват впритык под них нельзя.
//
// Раньше широкий квадрат был ЗАПАСНЫМ: сначала снимался узкий, а широкий — только если в
// узком тултипа не нашлось. Но снимался он уже после распознавания, вокруг уехавшего
// курсора, и потому не помогал (подробнее — в processFrame). Снимать его сразу дешевле,
// чем кажется: дорогая часть распознавания (tesseract) идёт по маленьким вырезкам вокруг
// найденной полосы и от размера кадра не зависит; с площадью растёт только попиксельный
// поиск полосы, а это единицы миллисекунд. TIP_BOX остался мерой: по нему в логе видно,
// хватило бы узкого квадрата или нет.
const TIP_BOX_WIDE = { left: 720, right: 720, up: 400, down: 300 };
async function captureTooltipArea(box = TIP_BOX_WIDE) {
  const { point: p, geom: g } = cursorOnScreen();     // всё в физических виртуальных координатах
  const s = g.height / 1080;
  const w = Math.min(Math.round((box.left + box.right) * s), g.width);
  const h = Math.min(Math.round((box.up + box.down) * s), g.height);
  // край считаем по ТОМУ монитору, на котором курсор, а не по основному
  const x = Math.max(g.originX, Math.min(g.originX + g.width - w, Math.round(p.x - box.left * s)));
  const y = Math.max(g.originY, Math.min(g.originY + g.height - h, Math.round(p.y - box.up * s)));
  // GDI может быть недоступен или сломаться (эксклюзивный полноэкранный, защищённый
  // контент). У фонового опроса откат на desktopCapturer есть, а здесь его не было:
  // каждое нажатие упиралось в «Не удалось снять кадр», хотя фон продолжал работать.
  if (!gdiRecovery.available() || !gdi.available()) return null;
  const t0 = performance.now();
  let frame;
  try {
    frame = await captureOverlayGuard.run({ x, y, width: w, height: h }, () => gdi.grab(x, y, w, h));
  } catch (err) {
    noteGdiBroken(i18nText("снимок области у курсора"), err);
    return null;
  }
  // курсор в координатах самого квадрата — по нему потом меряем, какая область реально нужна
  return { frame, capturedAt: Date.now(), screenHeight: g.height, scale: s, cursor: { x: p.x - x, y: p.y - y }, ms: Math.round(performance.now() - t0) };
}

// Курсор и его монитор — в физических ВИРТУАЛЬНЫХ координатах (см. displayGeometry).
// Точку не «локализуем» под дисплей: BitBlt ждёт именно виртуальные координаты.
function cursorOnScreen() {
  try {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    const sf = d.scaleFactor || 1;
    return { point: screen.dipToScreenPoint?.(p) || { x: Math.round(p.x * sf), y: Math.round(p.y * sf) },
      display: d, geom: displayGeometry(d) };
  } catch {
    const g = screenGeometry();
    return { point: { x: g.originX + Math.round(g.width / 2), y: g.originY + Math.round(g.height / 2) }, geom: g };
  }
}

// Кадр целиком — запасной путь, если тултипа не оказалось в квадрате у курсора.
async function captureFull() {
  if (gdiRecovery.available() && gdi.available()) {
    const t0 = performance.now();
    try {
      // снимаем МОНИТОР С КУРСОРОМ (там игра), а не всегда основной
      const { originX, originY, width, height } = cursorOnScreen().geom;
      const frame = await captureOverlayGuard.run({ x: originX, y: originY, width, height },
        () => gdi.grab(originX, originY, width, height));
      const capturedAt = Date.now();
      if (!F.stats(frame).blank) return { frame, capturedAt, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      noteGdiBroken(i18nText("снимок полоски зоны"), err);
    }
  }
  return captureScreen(cursorOnScreen().display);
}

async function captureScreen(display = null) {
  const t0 = performance.now();
  const d = display || screen.getPrimaryDisplay();
  const g = displayGeometry(d);
  const result = await captureOverlayGuard.run({ x: g.originX, y: g.originY, width: g.width, height: g.height }, async () => {
    const { width, height } = d.size;
    const sf = d.scaleFactor || 1;
    const sources = await captureOnce(() => desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) },
      fetchWindowIcons: false,
    }));
    // Electron exposes no compositor timestamp: use receipt of the captured frame,
    // before bitmap conversion, rather than the start of a potentially slow request.
    const capturedAt = Date.now();
    if (!sources.length) throw new Error(i18nText("desktopCapturer не вернул ни одного экрана"));
    const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[0];
    if (!src.thumbnail || src.thumbnail.isEmpty()) throw new Error(i18nText("desktopCapturer вернул пустую картинку"));
    const tGrab = performance.now();
    // Сырые пиксели, без PNG. Замер на 4К: toBitmap 7 мс против toPNG 1300 мс,
    // а распаковывать PNG всё равно пришлось бы нам самим.
    const size = src.thumbnail.getSize();
    const frame = F.fromBitmap(src.thumbnail.toBitmap(), size.width, size.height);
    if (process.env.AVALON_BENCH) {
      console.log(i18nText("[bench] getSources {0}мс | toBitmap {1}мс ", [Math.round(tGrab - t0), Math.round(performance.now() - tGrab)]) +
        i18nText("({0} МБ) | {1}x{2}", [(frame.data.length / 1e6).toFixed(1), size.width, size.height]));
    }
    return { frame, capturedAt, ms: Math.round(performance.now() - t0) };
  });
  return result.frame ? result : { frame: result, capturedAt: result.capturedAt || Date.now(),
    ms: Math.round(performance.now() - t0) };
}

// Диагностика чёрного/однотонного кадра — по сетке прямо в сыром буфере (lib/frame.js).
// Прежний вариант гонял кадр через sharp().resize() и стоил ~90 мс на каждый опрос.
function frameStats(frame) {
  const t0 = performance.now();
  const st = F.stats(frame);
  return { ...st, ms: Math.round(performance.now() - t0) };
}

// Адаптивный темп опроса. Зона меняется раз в несколько минут, а OCR стоит ~800 мс,
// поэтому долбить экран раз в 1.5 с всё время игры — чистая трата CPU рядом с 3D-игрой.
// Стоим на месте — опрашиваем всё реже; сменилась зона — мгновенно возвращаемся к частому темпу.
// (Попиксельный «отпечаток» плашки не годится: её содержимое сдвигается, когда слева
//  появляется счётчик игроков, — одна зона давала больше отличий, чем две разные.)
// Снимать ли полоску с плашкой зоны и устаревает ли зона — решает один расчёт
// на все пять точек, где это спрашивается.
// Текущую зону назвал трафик (а не экран и не человек) — ставится в applyZone.
let zoneFromTraffic = false;
// Правило «что делать при этом источнике» живёт в lib/origin.js и покрыто тестами:
// выводить его по месту уже дважды выходило боком.
const zonePlan = () => origin.zonePlan({
  source: config.zoneSource,
  trafficLive: !!traffic && !trafficError,
  zoneFromTraffic,
});
const readsScreen = () => zonePlan().readsScreen;
const captureContext = () => ({
  revision: zoneRevision, source: config.zoneSource,
  origin: zonePlan().expires ? null : currentZone,
  autoRecordPortals: config.autoRecordPortals !== false,
  recordingRevision: config.portalRecordingRevision || 0,
});

let pollStable = 0;
// Частота опроса зоны в режиме screen.
function nextPollDelay() {
  const base = config.pollMs;
  if (pollStable > 20) return base * 4;   // ≈6 c: игрок давно стоит
  if (pollStable > 6) return base * 2;    // ≈3 c
  return base;
}

let lastBlankToastAt = 0;
function warnBlank(kind, st, previewId = null) {
  console.warn(i18nText("[{0}] пустой кадр: mean={1} stdev={2} — OCR пропущен", [kind, st.mean.toFixed(1), st.stdev.toFixed(1)]));
  const now = Date.now();
  // фоновый опрос не должен сыпать тост каждые 1.5 c — не чаще раза в 30 c
  if (kind !== 'hotkey' && now - lastBlankToastAt < 30000) return;
  lastBlankToastAt = now;
  send('toast', { text: BLANK_TEXT });
  if (kind === 'hotkey') showOverlay({ error: BLANK_TEXT }, previewId);
}

// ---------- очередь распознавания ----------
// OCR-воркер один (tesseract + общие параметры), поэтому кадры распознаются строго по очереди.
// Задача хоткея приоритетна: она выбрасывает ожидающие фоновые опросы (их кадр всё равно
// протух) и уходит в работу первой. Нажатие хоткея не теряется никогда.
const MAX_HOTKEY_TASKS = 8; // страховка от бесконечного роста памяти при спаме
const queue = [];
let ocrBusy = false;
let running = null;
let hotkeyCapturing = 0; // нажатий, для которых кадр ещё снимается

// «Нажатие в работе» — это и кадр с тултипом (hotkey), и одиночное чтение плашки
// зоны по хоткею (zone): оба порождены нажатием и обслуживаются вне очереди опроса.
const isPress = k => k === 'hotkey' || k === 'zone';
function hotkeyPending() {
  return hotkeyCapturing > 0 || isPress(running?.kind) || queue.some(t => isPress(t.kind));
}

function enqueue({ kind, frame, withTooltip = false, withZone = true, captureMs = 0, checkMs = 0, cursor = null, strip = false, screenHeight = 0, zoneFrame = null, tipBox = false, observation = captureContext(), previewId = null, capturedAt = null }) {
  return new Promise(resolve => {
    const task = { kind, frame, withTooltip, withZone, captureMs, checkMs, cursor, strip, screenHeight, zoneFrame, tipBox, observation, previewId, capturedAt, at: Date.now(), resolve };
    if (isPress(kind)) {
      // фоновые опросы уступают дорогу
      for (const t of queue.splice(0)) {
        if (t.kind === 'poll') t.resolve({ skipped: i18nText("вытеснен хоткеем") });
        else queue.push(t);
      }
      if (queue.filter(t => isPress(t.kind)).length >= MAX_HOTKEY_TASKS) {
        const i = queue.findIndex(t => isPress(t.kind));
        queue.splice(i, 1)[0].resolve({ skipped: i18nText("очередь переполнена") });
        console.warn(i18nText("[queue] очередь хоткеев переполнена — отброшен самый старый кадр"));
      }
    } else if (kind === 'poll' && (hotkeyPending() || queue.some(t => t.kind === 'poll'))) {
      resolve({ skipped: i18nText("уступаем хоткею") });
      return;
    }
    queue.push(task);
    pump();
  });
}

async function pump() {
  if (ocrBusy || !queue.length) return;
  let i = queue.findIndex(t => isPress(t.kind)); // хоткей всегда вперёд очереди
  if (i < 0) i = 0;
  const task = queue.splice(i, 1)[0];
  ocrBusy = true; running = task;
  const waitMs = Date.now() - task.at;
  const t0 = performance.now();
  let out = null;
  try {
    out = await processFrame(task.frame, {
      withTooltip: task.withTooltip, withZone: task.withZone, cursor: task.cursor, kind: task.kind,
      strip: task.strip, screenHeight: task.screenHeight, zoneFrame: task.zoneFrame, tipBox: task.tipBox,
      observation: task.observation, previewId: task.previewId, capturedAt: task.capturedAt,
    });
    const ocrMs = Math.round(performance.now() - t0);
    console.log(i18nText("[{0}] capture {1}мс | проверка кадра {2}мс | ожидание {3}мс | ocr {4}мс", [task.kind, task.captureMs, task.checkMs, waitMs, ocrMs])
      + (out.tipMs != null ? i18nText(" (тултип {0}мс + зона {1}мс)", [out.tipMs, out.zoneMs]) : '')
      + i18nText(" | в очереди ещё {0}", [queue.length]));
  } catch (err) {
    console.error(i18nText("[{0}] ошибка распознавания:", [task.kind]), err);
    const text = i18nText("Ошибка: ") + ((err && err.message) || err);
    if (task.kind !== 'poll') send('toast', { text });
    // Плашку «Распознаю…» поднимал хоткей — гасим её здесь же. Иначе бегущие точки
    // крутятся до страховочных 12 с, и игрок жмёт ещё раз, хотя ответ уже есть.
    if (task.kind === 'hotkey') showOverlay({ error: text }, task.previewId);
    out = { error: (err && err.message) || String(err) };
  } finally {
    ocrBusy = false; running = null;
    task.frame = null; task.zoneFrame = null; // отпускаем кадры сразу
    task.resolve(out);
    setImmediate(pump); // следующая задача — новым тиком, не наращивая стек
  }
}

// Пайплайн одного кадра. На вход — кадр из captureScreen или PNG-буфер из файла
// (симуляция): распаковываем один раз здесь, чтобы тултип и зона не декодировали дважды.
async function processFrame(input, { withTooltip, withZone = true, cursor = null, strip = false, screenHeight = 0, zoneFrame = null, tipBox = false, kind = '', observation = null, previewId = null, capturedAt = null }) {
  const frame = await F.toFrame(input);
  const result = { zone: null, tip: null };
  if (withTooltip) {
    const t = performance.now();
    result.tip = await recognize.recognizeTooltip(frame, {
      near: tipBox ? null : cursor, screenHeight,
      onName: kind === 'hotkey' && previewId !== null ? tip => showPortalPreview(previewId, tip) : undefined,
    });
    if (result.tip) result.tip = portalTime.fromCapture(result.tip, capturedAt);
    // ЗДЕСЬ БЫЛ ВТОРОЙ СНИМОК — «в узком квадрате не нашлось, переснимем широким».
    //
    // Он не работал по построению. Снимался он вот в этот момент: после ожидания в
    // очереди и после первого распознавания, то есть спустя сотни миллисекунд, а иногда
    // и больше секунды после нажатия. И брался он вокруг курсора ТАМ, ГДЕ МЫШЬ СТАЛА, —
    // а игрок к этому времени её уже увёл. Запасной путь срабатывал ровно тогда, когда
    // от него не было толку.
    //
    // Теперь широкий квадрат снимается сразу, в момент нажатия (см. runHotkey), и
    // распознаётся он же. Резать из него узкий незачем: tesseract работает только по
    // маленьким вырезкам вокруг найденной полосы, и его цена от размера кадра не зависит
    // вовсе. С площадью растёт лишь попиксельный проход findBar — единицы миллисекунд.
    result.tipMs = Math.round(performance.now() - t);
    if (result.tip && tipBox && cursor) measureTooltipBox(result.tip, cursor, screenHeight);
    if (!result.tip && kind !== 'sim') saveFailShot(frame);
  }
  const tz = performance.now();
  // Плашку зоны читаем, только если слежение включено: выключил — приложение
  // сознательно не знает, где персонаж, и гадать по случайному кадру не должно.
  // commit: с хоткея зону принимаем сразу, фоновый опрос — со 2-го подтверждения.
  const o = { strip, screenHeight, tz, withTooltip, kind, observation, previewId, commit: withTooltip || kind === 'zone' };
  if (!withZone) return finishFrame(result, null, o);
  // зона распознаётся по своему кадру (полоска в углу), если он есть
  // The fallback can supply a FULL screen here. Marking it as a strip makes OCR
  // enlarge/read the entire desktop instead of the small zone name, taking seconds
  // and large amounts of memory on every hotkey after a temporary GDI failure.
  if (zoneFrame) return finishFrame(result, await F.toFrame(zoneFrame), o);
  return finishFrame(result, frame, o);
}

// Сколько места вокруг курсора реально понадобилось. Тултип рисуется от полосы-якоря:
// имя выше неё, чип справа, строка таймеров ниже — границы берём из тех же констант,
// по которым режет lib/recognize. Копим максимум за сессию: по нему и подрежем квадрат.
const boxNeed = { left: 0, right: 0, up: 0, down: 0, n: 0 };
function measureTooltipBox(tip, cursor, screenHeight) {
  const bar = tip.raw && tip.raw.bar;
  if (!bar) return;
  const s = bar.scale || (screenHeight || 1080) / 1080;
  const need = {
    left: Math.round(cursor.x - (bar.bx - 20 * s)),
    right: Math.round((bar.bx + 292 * s) - cursor.x),
    up: Math.round(cursor.y - (bar.by - 28 * s)),
    down: Math.round((bar.by + bar.bh + 30 * s) - cursor.y),
  };
  boxNeed.n++;
  for (const k of ['left', 'right', 'up', 'down']) boxNeed[k] = Math.max(boxNeed[k], need[k]);
  // сигналим, если замер вплотную подошёл к границе снимаемого квадрата — пора расширять
  const tight = ['left', 'right', 'up', 'down'].filter(k => boxNeed[k] > TIP_BOX_WIDE[k] * s * 0.85);
  // а это — та самая диагностика, ради которой раньше был второй снимок: узкого квадрата
  // не хватило бы, и без широкого захвата тултип потерялся бы.
  const overNarrow = ['left', 'right', 'up', 'down'].filter(k => need[k] > TIP_BOX[k] * s);
  console.log(i18nText("[область] тултип занял от курсора: влево {0}, вправо {1}, вверх {2}, вниз {3} ", [need.left, need.right, need.up, need.down]) +
    i18nText("| максимум за {0} нажатий: влево {1}, вправо {2}, вверх {3}, вниз {4} ", [boxNeed.n, boxNeed.left, boxNeed.right, boxNeed.up, boxNeed.down]) +
    i18nText("| снимаем влево {0}, вправо {1}, ", [Math.round(TIP_BOX_WIDE.left * s), Math.round(TIP_BOX_WIDE.right * s)]) +
    i18nText("вверх {0}, вниз {1}", [Math.round(TIP_BOX_WIDE.up * s), Math.round(TIP_BOX_WIDE.down * s)]) +
    (overNarrow.length ? i18nText(" | узкого квадрата не хватило бы по: {0}", [overNarrow.join(', ')]) : '') +
    (tight.length ? i18nText(" | ВПРИТЫК по: {0}", [tight.join(', ')]) : ''));
}

async function finishFrame(result, frame, { strip, screenHeight, tz, withTooltip, kind, commit, observation = null, previewId = null }) {
  // Отложенные кадры зоны не обрабатываются после смены источника.
  if (kind !== 'sim' && config.zoneSource !== 'screen') frame = null;
  let zoneNow = null;   // зона, прочитанная на кадре ЭТОГО нажатия
  const outdated = () => observation && (observation.revision !== zoneRevision || observation.source !== config.zoneSource);
  let stale = outdated();
  if (frame) {
    // Пришла вырезанная полоска — плашку ищем во всей ней, а масштаб констант
    // считаем от высоты ЭКРАНА, а не от высоты полоски.
    const zoneBarRegion = strip
      ? { left: 0, top: 0, width: frame.width, height: frame.height }
      : config.zoneBarRegion;
    const z = await recognize.recognizeZone(frame, { fast: !withTooltip, zoneBarRegion, screenHeight });
    result.zoneMs = Math.round(performance.now() - tz);
    stale = outdated(); // за время OCR мог прийти новый переход из трафика
    if (z) { result.zone = z; if (!stale && !quitting) applyZone(z, commit); }
    zoneNow = z ? z.zone : null;
  }
  // zoneTried — плашку на этом кадре СНИМАЛИ. Если она при этом не прочиталась, верить
  // памяти о зоне нельзя: см. lib/origin.js.
  if (quitting) return result;
  if (result.tip) result.tip = portalTime.refresh(result.tip);
  const previewOnly = config.autoRecordPortals === false || observation?.autoRecordPortals === false
    || (observation?.recordingRevision != null && observation.recordingRevision !== (config.portalRecordingRevision || 0));
  if (result.tip && previewOnly) {
    applyTip(result.tip, { copy: kind !== 'sim', previewOnly: true, previewId });
  }
  else if (result.tip && stale) {
    // Старый кадр может описывать портал из прошлой зоны. Свою позицию им не меняем,
    // а ребро пишем только при известном начале именно на момент снимка.
    const from = zoneNow || observation.origin;
    if (from && observation.source === config.zoneSource) {
      await applyTip(result.tip, { copy: kind !== 'sim', simulation: kind === 'sim', zoneNow: from, zoneTried: !!frame, previewId });
    } else {
      showOverlay({ tip: result.tip, staleOrigin: true }, previewId);
      send('toast', { text: i18nText("Портал не записан: зона или источник изменились во время распознавания. Повтори хоткей.") });
    }
  }
  else if (result.tip) await applyTip(result.tip, { copy: kind !== 'sim', simulation: kind === 'sim', zoneNow, zoneTried: !!frame, previewId });
  else if (withTooltip) {
    const text = i18nText("Тултип портала не найден — наведись на портал и нажми ") + bindingLabel();
    send('toast', { text });
    showOverlay({ error: text }, previewId);
  }
  send('map-updated', store.snapshot());
  return result;
}

// Смена текущей зоны. commit=false — фоновый опрос: принимаем со 2-го подтверждения
// подряд (защита от ложных срабатываний на случайном тексте, когда игра свёрнута).
// manual — зону назвал человек (Ctrl+Enter в окне поиска), а не распознавание.
function applyZone(z, commit, manual = false) {
  const now = Date.now();
  // Сверка той же зоны экраном не отменяет уже полученное подтверждение трафика.
  // Иначе следующий промах OCR откладывал портал при исправно работающем сокете.
  // Явное ручное указание позиции, напротив, не выдаём за подтверждение сервера.
  if (z.zone === currentZone) {
    if (manual) { zoneFromTraffic = false; zoneRevision++; }
    else if (z.source === 'traffic') zoneFromTraffic = true;
    pendingZone = null;
    zoneSeenAt = now;
    flushParked(z.zone);
    return;
  }
  if (!commit && pendingZone !== z.zone) { pendingZone = z.zone; return; }
  // Источник меняется вместе с ПРИНЯТОЙ зоной, а не с первым кандидатом OCR.
  // Подтверждённая экраном другая зона по-прежнему исправляет пропущенный переход.
  zoneFromTraffic = !manual && z.source === 'traffic';
  // Плашка прочиталась — значит мы точно знаем, где игрок, ПРЯМО СЕЙЧАС. Отмечаем время
  // (по нему решается, можно ли верить зоне при следующем нажатии) и разбираем отложенное.
  pendingZone = null;
  zoneSeenAt = now;
  const from = currentZone;
  currentZone = z.zone;
  zoneRevision++;
  // Смена зоны ребра больше НЕ создаёт. Раньше отсюда рождалось «пассивное» ребро —
  // вывод «был там, теперь тут, значит есть проход». Вывод верен, только если ни одной
  // зоны между ними мы не пропустили, а пропустить их проще простого: свёрнутая игра,
  // экран загрузки, смерть с воскрешением, выход из Туманов. Портал попадает в карту
  // только с прочитанного тултипа.
  store.setPlayerZone(config.nick, z.zone);
  pollStable = 0; // зона сменилась — снова опрашиваем часто
  send('zone-changed', { from, zone: z });
  pushGuide();          // прошёл портал — вычёркиваем шаг
  flushParked(z.zone);
}

// Зона стала известна — записываем порталы, которые ждали её. Именно здесь чинится
// случай «прошёл A → B, проверил портал в C»: пока плашка не прочиталась, портал лежал
// в стороне, а лёг он уже к B, а не к A.
function flushParked(zone) {
  if (!parking.size()) return;
  const { ready, lost } = parking.take();
  const saved = [];
  const tasks = [];
  for (const parked of ready) {
    const tip = portalTime.refresh(parked);
    if (!tip.__manual && (config.autoRecordPortals === false
        || (tip.__recordingRevision != null && tip.__recordingRevision !== (config.portalRecordingRevision || 0)))) {
      updateParkedOverlay(tip, { recordingSkipped: true });
      continue;
    }
    if (portalTime.expired(tip)) {
      updateParkedOverlay(tip, { expired: true });
      send('toast', { text: i18nText("Портал в {0} уже закрылся — не записан", [tip.name]) });
      continue;
    }
    tasks.push(savePortal(zone, tip, tip.__manual || tip.__simulation ? 'manual' : 'ocr', (edge, recordingError, recordingSkipped) => {
    if (recordingSkipped) { updateParkedOverlay(tip, { recordingSkipped: true }); return; }
    if (recordingError) { updateParkedOverlay(tip, { recordingError }); return; }
    if (portalTime.expired(tip)) { updateParkedOverlay(tip, { expired: true }); return; }
    if (config.saveLocal && !edge) {
      updateParkedOverlay(tip, { notSaved: true });
      send('toast', { text: i18nText("Портал в {0} не записан — уточни время закрытия и повтори хоткей", [tip.name]) });
      return;
    }
    saved.push(tip);
    updateParkedOverlay(tip, { from: zone });
    send('edge-added', { from: zone, tip, edge, manual: !!tip.__manual });
    console.log(i18nText("[зона] отложенный портал записан: {0} → {1}", [zone, tip.name]));
    }));
  }
  return Promise.all(tasks).then(() => {
  if (saved.length) {
    send('toast', {
      text: saved.length === 1
        ? i18nText("Зона распознана: портал {0} → {1} записан", [zone, saved[0].name])
        : i18nText("Зона распознана: записано порталов — {0}", [saved.length]),
    });
    send('map-updated', store.snapshot());
  }
  reportLost(lost);
  });
}

// Обновляем только ещё открытую плашку этого отложенного портала. Renderer сверяет
// ID; чужой результат, поиск и закрытое окно от позднего подтверждения не меняются.
function updateParkedOverlay(tip, status) {
  if (!tip.__pendingId || !overlayReady || !overlay || overlay.isDestroyed()) return;
  overlay.webContents.send('overlay-origin', { pendingId: tip.__pendingId, tip: portalTime.refresh(tip), ...status });
}
// Портал на стоянке протухает по времени, и кто-то должен это замечать. У чтения
// с экрана этим занимался опрос — он же и тикал каждые полторы секунды. У трафика
// опроса нет вовсе: без отдельного тика игрок узнавал бы о непринятом портале только
// при следующем переходе, то есть мог и через полчаса. Тикаем, только пока есть кого
// ждать, и сами себя выключаем.
let parkTimer = null;
function watchParking() {
  if (parkTimer || !parking.size()) return;
  parkTimer = setInterval(() => {
    reportLost(parking.expire());
    if (!parking.size()) { clearInterval(parkTimer); parkTimer = null; }
  }, 5000);
}
function reportLost(lost) {
  for (const tip of lost) {
    updateParkedOverlay(tip, { originLost: true });
    console.warn(i18nText("[зона] портал в {0} не записан: зону так и не удалось прочитать вовремя", [tip.name]));
    send('toast', { text: i18nText("Портал в {0} не записан — не понял, откуда он. Нажми хоткей ещё раз", [tip.name]) });
  }
}

// Куда попадает найденный портал — решают независимые переключатели. Своя карта пишется
// сразу (файл на диске), карта друзей — через очередь.
// Ничего не отмечено — портал только показывается в плашке и нигде не сохраняется.
function saveEdge(from, tip, source) {
  tip = portalTime.refresh(tip);
  if (tip.expiresAt == null || portalTime.expired(tip)) return null;
  // Ребро принадлежит СРАЗУ всем картам, куда его отправляют, а не только своей.
  // Без этого канал комнаты показывал одни чужие порталы: наши лежали с пометкой
  // «личная» и в комнате не показывались вовсе.
  const maps = (config.saveLocal ? ['local'] : []).concat(
    net.status().targets || []);
  const edge = config.saveLocal ? store.addEdge(from, tip, config.nick, source, maps) : null;
  if (config.saveLocal && !edge) return null; // rejected/expired local data must not be uploaded as a fresh edge
  if (portalTime.expired(tip)) return null;
  // локальная запись выключена — собираем то же ребро на лету, иначе выгружать нечего
  net.push(edge || {
    a: from, b: tip.name,
    capMax: tip.capMaxKnown ? tip.capMax : null, capMaxKnown: !!tip.capMaxKnown,
    expiresAt: tip.expiresAt,
    source, by: config.nick,
    captureReceipt: tip.captureReceipt || null,
  });
  return edge;
}

function billingMessage(code) {
  if (code === 'account_changed') return i18nText("Аккаунт изменился. Повтори хоткей портала.");
  return i18nText("Не удалось обновить статус подписки. Проверь соединение.");
}

function savePortal(from, tip, source, done) {
  tip = portalTime.refresh(tip);
  if (source !== 'manual' && (config.autoRecordPortals === false
      || (tip.__recordingRevision != null && tip.__recordingRevision !== (config.portalRecordingRevision || 0))))
    return done(null, null, true);
  // Recording is free, including offline. Cloud synchronization and the group's
  // subscription are checked independently when the queued portal is uploaded.
  return done(saveEdge(from, tip, source));
}

// Что делать с зоной за порталом — одинаково и для прочитанного тултипа, и для
// выбранной руками зоны (окно поиска, когда снимок у курсора выключен).
// Ребро появляется, только если известно, ОТКУДА портал; оверлей — всегда:
// игрок нажал хоткей и должен увидеть ответ, даже если своя зона неизвестна.
function applyTip(tip, { copy = true, manual = false, simulation = false, previewOnly = false, zoneNow = null, zoneTried = false, previewId = null } = {}) {
  tip = portalTime.refresh(tip);
  // Портал ведёт в мир (синяя/жёлтая/красная/чёрная зона или город) — кладём имя в буфер:
  // игрок вставляет его в поиск по карте игры, чтобы понять, куда его вынесет.
  // Только для НЕ-авалонских зон, чтобы не затирать буфер зря.
  let copied = null;
  if (copy && config.copyWorldZone && tip.color && tip.color !== 'avalon') {
    try { clipboard.writeText(tip.name); copied = tip.name; }
    catch (err) { console.warn(i18nText("[буфер] не удалось скопировать:"), err.message); }
  }
  if (!manual && (previewOnly || config.autoRecordPortals === false)) {
    showOverlay({ tip, copied, recordingSkipped: true, expired: portalTime.expired(tip) }, previewId);
    return;
  }
  tip.__recordingRevision = config.portalRecordingRevision || 0;
  if (portalTime.expired(tip)) {
    showOverlay({ tip, copied, manual, expired: true }, previewId);
    send('toast', { text: i18nText("Портал в {0} уже закрылся — не записан", [tip.name]) });
    return;
  }
  if (tip.expiresAt == null) {
    showOverlay({ tip, copied, manual, notSaved: true }, previewId);
    send('toast', { text: i18nText("Портал в {0} не записан — время закрытия не прочитано", [tip.name]) });
    return;
  }
  // Откуда портал — решает lib/origin.js. Не уверены — откладываем, а не пишем наугад:
  // молчаливое «привяжу к последней известной зоне» уже приводило к рёбрам мимо карты.
  const d = origin.decide({
    zoneNow, zoneTried, currentZone, seenAt: zoneSeenAt, watching: config.zoneWatch, source: config.zoneSource,
    // Зона из трафика не устаревает: приходит событие на каждый переход, и пока его
    // нет, игрок стоит на месте. Проверять свежесть тут значило бы откладывать порталы
    // у того, кто просто десять минут фармит одну зону (см. lib/origin.js).
    // Но только если зону назвал ИМЕННО трафик и он ещё слушается. Зона, прочитанная
    // с экрана, устаревает и в этом режиме: там молчание значит «не смогли прочитать».
    expires: zonePlan().expires,
  });
  if (d.park) {
    tip.__manual = manual;
    tip.__simulation = simulation;
    tip.__pendingId = ++parkedSequence;
    // Стоянка мала (4 места): пятый портал вытесняет первый. Об этом надо сказать —
    // тому порталу уже пообещали запись, и молча забрать обещание нельзя.
    reportLost(parking.park(tip).dropped);
    watchParking();
    console.log(i18nText("[зона] портал в {0} отложен: {1}", [tip.name, d.why]));
    showOverlay({ tip, from: null, copied, manual, waiting: true, pendingId: tip.__pendingId }, previewId);
    send('toast', { text: i18nText("Не понял, где ты ({0}) — портал запишу, как только пойму", [d.why]) });
    kickPoll();      // не ждём очередного тика: плашку надо прочитать сейчас
    return;
  }
  // Ждать нечего и начала нет: слежение выключено, а свою зону игрок ещё не назвал.
  // Ребро без начала в карту не пишем — но зону за порталом показываем: игрок нажал
  // хоткей ради неё. И говорим, что именно сделать, чтобы портал записался.
  if (d.ask) {
    console.log(i18nText("[зона] портал в {0} не записан: {1}", [tip.name, d.why]));
    const originHint = d.trafficUnknown
      ? (!traffic || trafficError
        ? i18nText("Чтение трафика недоступно. Проверь настройки зоны.")
        : i18nText("Зона не получена из трафика. После перехода повтори хоткей."))
      : null;
    showOverlay({ tip, from: null, copied, manual, noOrigin: true, originHint }, previewId);
    send('toast', { text: originHint || i18nText("Портал не записан: сначала укажи свою зону — Ctrl+Enter в окне поиска") });
    return;
  }
  return savePortal(d.origin, tip, manual || simulation ? 'manual' : 'ocr', (edge, recordingError, recordingSkipped) => {
  if (recordingSkipped) { showOverlay({ tip, copied, recordingSkipped: true }, previewId); return; }
  if (recordingError) { showOverlay({ tip, copied, manual, recordingError }, previewId); return; }
  if (portalTime.expired(tip)) {
    showOverlay({ tip, copied, manual, expired: true }, previewId);
    return;
  }
  if (config.saveLocal && !edge) {
    showOverlay({ tip, copied, manual, notSaved: true }, previewId);
    send('toast', { text: i18nText("Портал в {0} не записан — уточни время закрытия и повтори хоткей", [tip.name]) });
    return;
  }
  send('edge-added', { from: d.origin, tip, edge, manual });
  showOverlay({ tip, from: d.origin, copied, manual }, previewId); // игрок видит ответ, не сворачивая игру
  });
}

// Внеочередной опрос плашки: используется, когда портал ждёт свою зону.
function kickPoll() {
  if (!readsScreen() || quitting) return;
  pollStable = 0;                     // и дальше опрашиваем часто: игрок только что менял зону
  if (polling) return;                // опрос уже идёт — он и прочитает плашку, второй не нужен
  clearTimeout(pollTimer);
  pollTimer = setTimeout(runPoll, 300);
}

// ---------- хоткей: снять кадр немедленно, распознать потом ----------
// Снимок области у курсора выключен — по хоткею открываем поиск зоны руками.
// Плашку зоны при этом всё равно перечитываем (если слежение включено): пока игрок
// печатает, распознавание успевает уточнить, откуда портал.
async function runHotkey() {
  if (!config.cursorScan) return runHotkeySearch();
  const previewId = beginPortalPreview();
  send('toast', { text: i18nText("Распознаю…") });
  // Показ также отменяет уже начавшееся исчезновение предыдущей плашки.
  // Исключённое окно остаётся видимым, а в снимке сохраняется игра под ним.
  showBusy(previewId);
  // два снимка вместо одного большого: квадрат у курсора и полоска с плашкой зоны в углу.
  // Оба берутся ЗДЕСЬ, до всякого распознавания, — то есть относятся к одному мгновению
  // нажатия. Квадрат сразу широкий: доснять его потом, по результату распознавания,
  // нельзя — курсор к тому времени уже уедет.
  let tip, zone = null, tipBox = true;
  const observation = captureContext();
  try {
    tip = await captureTooltipArea(TIP_BOX_WIDE);
    if (!tip) {
      tipBox = false;
      // GDI недоступен — снимаем экран целиком запасным путём, тултип найдётся поиском по кадру
      const full = await captureFull();
      const g = cursorOnScreen();
      tip = {
        frame: full.frame, ms: full.ms, capturedAt: full.capturedAt, screenHeight: full.frame.height,
        scale: full.frame.height / 1080,
        cursor: { x: g.point.x - g.geom.originX, y: g.point.y - g.geom.originY },
      };
    }
    if (readsScreen()) zone = await captureZoneStrip();
  } catch (err) {
    console.error(i18nText("[hotkey] захват не удался:"), err.message);
    // Плашку надо погасить здесь же. Иначе «Распознаю…» крутится до страховочного
    // таймера — двенадцать секунд поверх игры, — и игрок жмёт хоткей ещё раз,
    // хотя ответ уже есть. Так же поступает и обработка пустого кадра выше.
    // (err && err.message) — не педантизм: этот текст теперь виден на экране поверх игры,
    // и на не-Error исключении игрок прочитал бы «Не удалось снять кадр: undefined»
    const text = i18nText("Не удалось снять кадр: ") + ((err && err.message) || err);
    send('toast', { text });
    showOverlay({ error: text }, previewId);
    return;
  }
  saveShots({ cursor: tip.frame, zone: zone && zone.frame }); // без await — очередь ждать не должна
  const auditEnabled = config.portalAudit;
  const auditCapture = () => portalShotArchive.capture({
    portalFrame: tip.frame, zoneFrame: zone?.frame || null, capturedAt: tip.capturedAt,
    source: observation.source, originAtCapture: observation.origin,
    screenHeight: tip.screenHeight, cursor: tip.cursor,
  });
  const st = frameStats(tip.frame);
  if (st.blank) {
    if (auditEnabled) auditCapture()?.finish({ blank: true });
    console.log(i18nText("[hotkey] capture {0}мс → кадр отброшен как пустой", [tip.ms]));
    warnBlank('hotkey', st, previewId);
    return;
  }
  const outcome = await enqueue({
    kind: 'hotkey', frame: tip.frame, withTooltip: true, withZone: !!zone, tipBox, cursor: tip.cursor,
    observation, previewId, capturedAt: tip.capturedAt,
    zoneFrame: zone && zone.frame, strip: zone ? zone.strip : false, screenHeight: tip.screenHeight,
    captureMs: tip.ms + (zone ? zone.ms : 0), checkMs: st.ms,
  });
  // Кодирование PNG запускаем после OCR, чтобы временный сбор не тормозил чтение.
  if (auditEnabled) auditCapture()?.finish(outcome || {});
}

// Хоткей без снимка курсора: окно поиска + фоновое уточнение текущей зоны.
async function runHotkeySearch() {
  openSearch();
  if (!readsScreen()) return;   // у трафика зона и так свежая, снимать полоску незачем
  try {
    const observation = captureContext();
    const zone = await captureZoneStrip();
    if (!zone || !readsScreen()) return;
    saveShots({ zone: zone.frame });
    const st = frameStats(zone.frame);
    if (st.blank) return;
    await enqueue({
      kind: 'zone', frame: zone.frame, withTooltip: false,
      observation,
      strip: zone.strip, screenHeight: zone.screenHeight, captureMs: zone.ms, checkMs: st.ms,
    });
  } catch (err) {
    console.warn(i18nText("[hotkey] плашку зоны прочитать не вышло:"), err.message);
  }
}

// ---------- фоновый опрос: setTimeout-цепочка, тики не накладываются ----------
// Пока игра не запущена, опрашиваем только список процессов (~100 мс раз в 10 с)
// вместо захвата экрана с OCR. Состояние показываем в панели, чтобы не гадать.
const GAME_CHECK_MS = 10000;
let gameSeen = null, gameCheckedAt = 0;
// Плашка зоны не читается — с какого момента и говорили ли мы об этом. Полного снимка
// экрана тут больше нет вовсе: подсказка человеку дешевле и полезнее любого перебора.
let noZoneSince = 0;       // с какого момента зона не читается вовсе
let hintedNoZone = false;  // подсказку про область даём один раз за сеанс
async function gameRunning() {
  const now = Date.now();
  if (gameSeen !== null && now - gameCheckedAt < GAME_CHECK_MS) return gameSeen;
  gameCheckedAt = now;
  const was = gameSeen;
  gameSeen = await privileges.isGameRunning();
  if (gameSeen !== was) {
    console.log(i18nText("[игра] {0}", [gameSeen ? i18nText("запущена — включаю опрос экрана") : i18nText("не запущена — опрос приостановлен")]));
    send('game-state', { running: gameSeen });
    if (gameSeen) pollStable = 0;
    // игры нет — отпускаем поток захвата, чтобы не держать GPU впустую

  }
  return gameSeen;
}

let pollTimer = null;
// Слежение выключили — цепочка опроса просто заканчивается (никаких холостых тиков),
// включили — запускаем заново отсюда же.
function restartPoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (!readsScreen() || quitting) return;
  pollStable = 0;
  pollTimer = setTimeout(runPoll, 200);
}
let polling = false;
async function runPoll() {
  // Внеочередной опрос (kickPoll) мог совпасть с очередным — и тогда цепочка таймеров
  // раздваивалась, а два опроса начинали жечь OCR параллельно. Вход строго один.
  if (polling) return;
  polling = true;
  let next = config.pollMs;
  try {
    reportLost(parking.expire());   // портал, не дождавшийся своей зоны, молчать не должен
    if (!readsScreen()) { next = null; return; }
    // в работе хоткей — опрос пропускаем и пробуем скоро снова
    if (hotkeyPending() || captureInFlight > 0) { next = 300; return; }
    // Игра не запущена — снимать нечего: без этой проверки приложение исправно
    // фотографирует и распознаёт рабочий стол, а это ~2 с работы на каждый тик.
    // AVALON_POLL_ALWAYS=1 — не ждать игру (замеры и отладка пайплайна без Albion)
    if (!process.env.AVALON_POLL_ALWAYS && !await gameRunning()) { next = GAME_CHECK_MS; return; }
    // берём только полоску с плашкой зоны — весь экран для опроса не нужен
    const observation = captureContext();
    const cap = await captureZoneStrip();
    if (!cap || !readsScreen()) { next = null; return; }
    if (hotkeyPending()) { next = 300; return; } // пока снимали — нажали хоткей
    const st = frameStats(cap.frame);
    if (st.blank) {
      // Полоска чёрная: игру свернули, переключились в другое окно, или GDI её не видит
      // (эксклюзивный полноэкранный режим). Гонять по такому кадру OCR бессмысленно,
      // и смотреть куда-то ещё — тоже: если плашки нет, читать нечего.
      warnBlank('poll', st);
      pollStable++;              // свёрнутая игра — повод опрашивать реже, а не чаще
      next = nextPollDelay();
      return;
    }

    const out = await enqueue({
      kind: 'poll', frame: cap.frame, withTooltip: false,
      observation,
      captureMs: cap.ms, checkMs: st.ms, strip: cap.strip, screenHeight: cap.screenHeight,
    });
    // Плашки в полоске нет — игра свёрнута, идёт экран загрузки или область не совпала.
    // Никуда больше не смотрим: два снимка (полоска и квадрат у курсора) — это ВСЁ, что
    // приложение снимает в работе. Раньше отсюда уходил снимок всего экрана ради баннера
    // экрана загрузки; выигрыш он давал в пару секунд на переходе, а стоил третьего
    // снимка, отдельной ветки распознавания и — у игрока с несовпадающей областью —
    // бесконечного цикла. Портал всё равно ждёт свою зону до 25 секунд (lib/origin.js),
    // так что пары секунд там никто не заметит.
    const now = Date.now();
    if (cap.strip && out && !out.zone && !out.skipped) noZoneSince = noZoneSince || now;
    if (out && out.zone) { noZoneSince = 0; hintedNoZone = false; }
    // Молчать об этом нельзя. Игра запущена, а плашка не читается уже три минуты —
    // значит область почти наверняка не там, где надо, и человек об этом не догадается:
    // приложение просто «не работает» и греет процессор. Говорим один раз за сеанс.
    if (noZoneSince && !hintedNoZone && now - noZoneSince > 3 * 60000) {
      hintedNoZone = true;
      send('toast', { text: i18nText("Плашка зоны не читается уже три минуты. Настройки → «Слежение за экраном» → «Выбрать мышью»") });
      console.warn(i18nText("[зона] плашка не читается три минуты — область, скорее всего, не совпадает"));
    }
    pollStable++;
    next = nextPollDelay();
  } catch (err) {
    // игра свёрнута/экран занят — тостами не спамим, только лог
    console.warn('[poll] ' + (err?.message || err));
  } finally {
    polling = false;
    if (!quitting && readsScreen() && next != null) pollTimer = setTimeout(runPoll, next);
  }
}

// ---------- зона из трафика ----------
// Второй источник зоны, взаимоисключающий с экранным. Отличается тем, что не смотрит
// на экран вовсе и не может ошибиться в имени: оно приходит от сервера строкой, а не
// через OCR. Взамен нужны права администратора (сырой сокет) и до первого перехода
// зона неизвестна — событие приходит на СМЕНУ кластера, а не на «ты сейчас здесь».
const combat = combatMetrics.create(config);
const collectors = collectorService.create({
  root: DATA_DIR, user: () => auth?.status(),
  secret: {
    encrypt: value => safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : null,
    decrypt: value => safeStorage.isEncryptionAvailable() && typeof value === 'string' ? safeStorage.decryptString(Buffer.from(value, 'base64')) : null,
  },
  onTrafficChange: () => setImmediate(() => {
    if (quitting) return;
    if (needsTraffic()) { if (!traffic) startTraffic(); }
    else { stopTraffic(); trafficError = null; }
  }),
  onStatus: () => { if (!quitting) pushMetrics(); },
});
const needsTraffic = () => metricsOptions.needsTraffic(config, collectors.needsTraffic());
let collectorProofTimer = null, collectorProofPending = false;
async function confirmCollectorIdentity() {
  const account = auth, id = account?.status().userId;
  if (!account || account.status().guest || !account.status().signedIn) return null;
  const profile = await account.ensureProfile();
  return account === auth && id === account.status().userId ? profile : null;
}
async function refreshCollectors() {
  collectors.refreshAccess();
  if (!collectors.snapshot() || collectorProofPending || quitting) return;
  collectorProofPending = true;
  try { const profile = await confirmCollectorIdentity(); if (profile) collectors.acceptProfile(profile); }
  catch {} finally { collectorProofPending = false; }
}
const metricsWindows = { fame: null, damage: null, food: null };
let foodOverlayWanted = false;
let damageWindowControls = null, damageLocked = false, damageSegment = 'current';
let metricsTimer = null;
function syncOverlayWindowVisibility(notify = true) {
  if (overlaysHidden()) {
    if (overlay && !overlay.isDestroyed() && !(overlaySetup && !manualOverlaysHidden) && Date.now() >= practiceOverlayUntil) {
      suspendedOverlay = suspendedOverlay || overlay.isVisible();
      if (overlay.isVisible()) overlay.hide();
    }
    for (const window of Object.values(metricsWindows)) {
      if (window && !window.isDestroyed() && window.isVisible()) window.hide();
    }
    if (search && !search.isDestroyed()) closeSearch();
  } else {
    const reveal = window => {
      if (window.isMinimized?.()) window.restore();
      if (!window.isVisible()) {
        window.setAlwaysOnTop?.(true, 'screen-saver');
        window.showInactive();
      }
    };
    if (suspendedOverlay && overlay && !overlay.isDestroyed() && overlayReady) reveal(overlay);
    for (const [kind, window] of Object.entries(metricsWindows)) {
      if (kind === 'food' && !foodOverlayWanted) continue;
      if (window && !window.isDestroyed() && window._readyToShow) reveal(window);
    }
  }
  if (notify) pushConfig();
}
function focusedToolWindow() {
  return [overlay, search, picker, ...Object.values(metricsWindows)].some(window =>
    window && !window.isDestroyed() && window.isFocused?.());
}
async function checkGameWindowVisibility() {
  if (gameWindowCheckRunning || quitting) return;
  gameWindowCheckRunning = true;
  try {
    const state = await gameWindow.state();
    const moved = state.bounds && ['left', 'top', 'right', 'bottom'].some(key => state.bounds[key] !== gameWindowBounds?.[key]);
    gameWindowBounds = state.bounds || null;
    if (state.found) gameWindowSeen = true;
    const inactive = gameWindowSeen &&
      (!state.found || state.minimized || (!state.focused && !focusedToolWindow()));
    const changed = gameOverlaysInactive !== inactive;
    gameOverlaysInactive = inactive;
    overlayRuntime.activity(powerMonitor.getSystemIdleTime());
    // Reconcile even when focus is unchanged: Windows can hide/minimize a tool
    // window during display or fullscreen transitions without a focus transition.
    if (!inactive && changed) {
      for (const window of [overlay, ...Object.values(metricsWindows)]) {
        if (window && !window.isDestroyed()) window.setAlwaysOnTop?.(true, 'screen-saver');
      }
    }
    if (!inactive && (changed || moved) && overlay && !overlay.isDestroyed() && !overlaySetup) placeOverlay();
    syncOverlayWindowVisibility(changed);
  } catch (err) {
    console.warn(i18nText("[оверлей] проверка окна игры:"), err.message);
  } finally { gameWindowCheckRunning = false; }
}
function metricsSnapshot() {
  return { ...combat.snapshot(), enabled: metricsOptions.enabled(config),
    collectors: collectors.snapshot(),
    fameEnabled: config.fameEnabled, damageEnabled: config.damageEnabled,
    foodEnabled: config.foodEnabled === true, foodWarnMinutes: config.foodWarnMinutes ?? 1,
    foodBuff: combat.foodSnapshot?.(config.foodWarnMinutes) || { known: false, fed: null, warning: false },
    fameOverlayScale: metricsOptions.scale(config.fameOverlayScale), damageOverlayScale: metricsOptions.scale(config.damageOverlayScale),
    zoneSource: config.zoneSource, trafficRequired: needsTraffic(), listening: !!traffic,
    error: trafficError, damageLocked, damageSegment, overlays: Object.fromEntries(Object.entries(metricsWindows)
      .map(([kind, window]) => [kind, !!window && !window.isDestroyed()])), theme: config.theme };
}
function pushMetrics() {
  const data = metricsSnapshot();
  syncFoodOverlay(data);
  send('metrics-updated', data);
  for (const window of Object.values(metricsWindows)) {
    if (window && !window.isDestroyed() && window._readyToShow) { const { collectors: privateStatus, ...overlayData } = data; window.webContents.send('metrics-updated', overlayData); }
  }
}
function watchMetricsOverlay(kind, window) {
  overlayRuntime.watch(window, { kind, current: () => metricsWindows[kind] === window,
    ready: () => window._readyToShow === true,
    lost: () => { window._readyToShow = false; },
    recover: () => {
      if (quitting || metricsWindows[kind] !== window) return;
      if (kind !== 'food' && !window.isDestroyed()) {
        const bounds = metricsWindowControls.normalizeBounds(window.getBounds());
        if (bounds) { config[kind + 'OverlayBounds'] = bounds; saveConfigSoon(); }
      }
      metricsWindows[kind] = null;
      if (!window.isDestroyed()) {
        if (!window.webContents.isDestroyed() && !window.webContents.isCrashed()) window.webContents.forcefullyCrashRenderer();
        window.destroy();
      }
      if (kind === 'food') syncFoodOverlay(metricsSnapshot());
      else openMetrics(kind);
    } });
}
function foodOverlayBounds() {
  const point = gameWindowBounds ? { x: gameWindowBounds.left, y: gameWindowBounds.top } : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const width = Math.min(310, area.width), height = Math.min(76, area.height);
  return { x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + Math.min(110, Math.max(0, area.height - height)), width, height };
}
function syncFoodOverlay(data) {
  foodOverlayWanted = data.foodEnabled && data.foodBuff?.warning;
  let window = metricsWindows.food;
  if (!foodOverlayWanted) {
    if (window && !window.isDestroyed() && window.isVisible()) window.hide();
    return;
  }
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({ ...foodOverlayBounds(), frame: false, resizable: false, movable: false, focusable: false,
      alwaysOnTop: true, skipTaskbar: true, transparent: true, backgroundColor: '#00000000', hasShadow: false, show: false,
      webPreferences: webPrefs(path.join(__dirname, 'preload-metrics.js'), { backgroundThrottling: false, partition: 'metrics-food' }) });
    metricsWindows.food = window;
    overlayCapture.register(window);
    watchMetricsOverlay('food', window);
    window.setIgnoreMouseEvents(true, { forward: true });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return;
      window._readyToShow = true;
      if (foodOverlayWanted && !overlaysHidden()) window.showInactive();
    });
    window.on('closed', () => { if (metricsWindows.food === window) metricsWindows.food = null; });
    window.loadFile(path.join(__dirname, 'ui', 'food-overlay.html'));
  } else {
    const wantedBounds = foodOverlayBounds(), currentBounds = window.getBounds();
    if (Object.keys(wantedBounds).some(key => wantedBounds[key] !== currentBounds[key])) window.setBounds(wantedBounds);
    if (window._readyToShow && !overlaysHidden() && !window.isVisible()) window.showInactive();
  }
}
function openMetrics(kind) {
  if (!Object.hasOwn(metricsWindows, kind)) return;
  const existing = metricsWindows[kind];
  if (existing && !existing.isDestroyed()) { existing.close(); return; }
  if (!config[kind + 'Enabled']) return;
  const boundsKey = kind + 'OverlayBounds';
  const saved = metricsWindowControls.normalizeBounds(config[boundsKey]);
  const point = saved ? { x: saved.x, y: saved.y } : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  const fame = kind === 'fame';
  const scale = metricsOptions.scale(config[kind + 'OverlayScale']);
  const window = new BrowserWindow({ ...metricsWindowControls.restoreBounds(kind, saved, area, scale),
    minWidth: Math.round((fame ? 250 : 280) * scale), minHeight: Math.round((fame ? 48 : 140) * scale), resizable: !fame, maximizable: false,
    frame: false, alwaysOnTop: true,
    skipTaskbar: true, transparent: true, backgroundColor: '#00000000', hasShadow: false, show: false,
    webPreferences: webPrefs(path.join(__dirname, 'preload-metrics.js'), { backgroundThrottling: false, partition: 'metrics-' + kind }) });
  metricsWindows[kind] = window;
  overlayCapture.register(window);
  watchMetricsOverlay(kind, window);
  const controls = fame ? null : metricsWindowControls.create({ window, screen, locked: damageLocked,
    scale: () => metricsOptions.scale(config.damageOverlayScale),
    onLockChange: value => { damageLocked = value; } });
  if (controls) {
    damageWindowControls = controls;
    window.on('blur', () => { controls.stopResize(); controls.pointer(false); });
  }
  const rememberBounds = () => {
    if (window.isDestroyed()) return;
    const bounds = metricsWindowControls.normalizeBounds(window.getBounds());
    if (!bounds || Object.keys(bounds).every(key => config[boundsKey]?.[key] === bounds[key])) return;
    config[boundsKey] = bounds;
    saveConfigSoon();
  };
  window.on('move', rememberBounds); window.on('resize', rememberBounds);
  window.on('close', () => { controls?.stopResize(); rememberBounds(); flushConfig(); });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.webContents.setZoomFactor(scale);
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) window.webContents.setZoomFactor(metricsOptions.scale(config[kind + 'OverlayScale']));
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) {
      window._readyToShow = true;
      if (!overlaysHidden()) window.showInactive();
      pushMetrics();
    }
  });
  window.on('closed', () => {
    controls?.dispose();
    if (damageWindowControls === controls) damageWindowControls = null;
    if (metricsWindows[kind] === window) metricsWindows[kind] = null;
    pushMetrics();
  });
  window.loadFile(path.join(__dirname, 'ui', 'metrics.html'), { query: { kind } });
}

function changeMetricsScale(kind, direction) {
  const key = kind + 'OverlayScale', old = metricsOptions.scale(config[key]);
  const scale = metricsOptions.scale(direction === 'reset' ? 1 : old + (direction === 'up' ? 0.1 : -0.1));
  config[key] = scale;
  const window = metricsWindows[kind];
  if (window && !window.isDestroyed()) {
    if (kind === 'damage') damageWindowControls?.stopResize();
    const bounds = window.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    const resized = { ...bounds, width: Math.round(bounds.width * scale / old), height: Math.round(bounds.height * scale / old) };
    window.setMinimumSize(Math.round((kind === 'fame' ? 250 : 280) * scale), Math.round((kind === 'fame' ? 48 : 140) * scale));
    window.webContents.setZoomFactor(scale);
    window.setBounds(metricsWindowControls.restoreBounds(kind, resized, area, scale));
  }
  saveConfig();
}

function recoverOverlayDisplays() {
  if (quitting) return;
  if (overlay && !overlay.isDestroyed() && !overlaySetup) placeOverlay();
  for (const [kind, window] of Object.entries(metricsWindows)) {
    if (!window || window.isDestroyed()) continue;
    if (kind === 'food') { window.setBounds(foodOverlayBounds()); window.setAlwaysOnTop(true, 'screen-saver'); continue; }
    const bounds = window.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
    window.setBounds(metricsWindowControls.restoreBounds(kind, bounds, area, metricsOptions.scale(config[kind + 'OverlayScale'])));
    window.setAlwaysOnTop(true, 'screen-saver');
  }
  syncOverlayWindowVisibility();
}

function applyMetricsOptions() {
  combat.setEnabled(config);
  for (const kind of ['fame', 'damage']) {
    const window = metricsWindows[kind];
    if (!config[kind + 'Enabled'] && window && !window.isDestroyed()) window.close();
  }
  if (!metricsOptions.enabled(config) && !config.foodEnabled) combat.disconnect();
  if (!needsTraffic()) { stopTraffic(); trafficError = null; }
  else if (!traffic) startTraffic();
  saveConfig(); pushConfig();
}

let traffic = null;
// Почему трафик не слушается: показывается в настройках и в строке состояния.
// Молчать нельзя — иначе игрок выбрал источник, а приложение просто ослепло.
let trafficError = null;
let trafficGeneration = 0;

function stopTraffic({ preserveCombat = false } = {}) {
  trafficGeneration++;
  zoneRevision++;
  zoneFromTraffic = false;
  clearInterval(trafficTimer);
  trafficTimer = null;
  if (preserveCombat) combat.transportRestart();
  else combat.disconnect();
  if (!traffic) return;
  traffic.stop();
  traffic = null;
  console.log(i18nText("[зона] слушатель трафика остановлен"));
}

// ---------- сторож слушателя ----------
// Сырой сокет умеет замолкать навсегда и молча: ошибок нет, recv отвечает «пусто»,
// а пакеты не приходят больше никогда. У игрока это выглядело как «час в одной зоне»,
// и помогал только ПЕРЕЗАПУСК приложения — верный признак, что источник умер насовсем,
// а не пропустил один переход (тот бы починился сам на следующем).
//
// Экранная подстраховка тут не спасает: в полноэкранной игре GDI отдаёт чёрный кадр,
// и при источнике «трафик» приложение остаётся вообще без глаз. Поэтому чиним источник,
// а не надеемся на сверку.
//
// Правило «когда считать мёртвым» живёт в lib/traffic-health.js и покрыто тестами.
const TRAFFIC_CHECK_MS = 15000;
let trafficTimer = null;
let revives = 0;
const health = trafficHealth.createHealth();

function watchTraffic() {
  clearInterval(trafficTimer);
  health.reset();
  trafficTimer = setInterval(async () => {
    if (!traffic || !needsTraffic() || quitting) return;
    const active = traffic;
    // gameRunning() кэширует ответ на 10 с — опрашивать процессы каждые 15 с не дорого.
    const running = await gameRunning();
    if (traffic !== active || quitting || !needsTraffic()) return;
    const verdict = health.tick({ packets: active.packets(), gameRunning: running });
    if (verdict !== 'revive') return;
    revives++;
    console.warn(i18nText("[зона] слушатель трафика замолчал при запущенной игре — переоткрываю сокет (раз {0})", [revives]));
    // Тост — только на первое воскрешение и дальше изредка. Если сокет не оживает вовсе,
    // сторож будет пробовать каждые полторы минуты, и сыпать плашкой всё это время значит
    // мешать игроку вместо того, чтобы помогать. В логе остаётся каждый раз.
    if (revives === 1 || revives % 10 === 0) {
      send('toast', { text: i18nText("Слушатель трафика замолчал — переподключаюсь") });
    }
    // Переоткрываем ЧЕРЕЗ startTraffic: он заново перечисляет интерфейсы, поэтому
    // лечится и смена адаптера (Wi-Fi ↔ кабель, VPN), а не только уснувший сокет.
    await startTraffic();
  }, TRAFFIC_CHECK_MS);
}

async function startTraffic() {
  if (quitting || !needsTraffic()) return false;
  // A socket refresh is not a party leave. Retain confirmed members and the
  // Photon identity when replacing a live listener, so damage resumes at once.
  stopTraffic({ preserveCombat: !!traffic });
  const generation = trafficGeneration;
  trafficError = null;
  // Проверяем права ДО открытия сокета: так сообщение точное («нет прав»), а не
  // код ошибки Winsock, по которому игроку нечего понять.
  const elevated = await privileges.isElevated();
  // Пока проверяли права, игрок мог переключить источник обратно. Без этой проверки
  // сокет открылся бы уже после stopTraffic и слушал бы в никуда до конца сеанса.
  if (quitting || !needsTraffic() || generation !== trafficGeneration) return false;
  if (!elevated) {
    combat.disconnect();
    trafficError = i18nText("нужен запуск от администратора");
    console.warn(i18nText("[зона] трафик недоступен: нет прав администратора"));
    send('toast', { text: i18nText("Для чтения трафика, фейма, урона и баффа еды нужен запуск от администратора") });
    pushConfig();
    return false;
  }
  traffic = zoneTraffic.create({
    onPacket: (payload, meta) => {
      if (generation === trafficGeneration && !quitting) collectors.feed(payload, meta);
      if ((metricsOptions.enabled(config) || config.foodEnabled) && generation === trafficGeneration && !quitting) combat.feed(payload, meta);
    },
    onZone: hit => {
      if (generation !== trafficGeneration || quitting || config.zoneSource !== 'traffic') return;
      console.log(i18nText("[зона] из трафика: {0} [{1}]", [hit.zone, hit.id]));
      // commit=true: второе подтверждение, как у экрана, здесь не нужно. Там оно
      // защищает от промаха OCR по случайному тексту, а тут — прямой ответ сервера
      // на смену кластера, и гадать не в чем.
      // zoneInfo даёт тир, цвет и ресурсы по имени — те же, что и у чтения с экрана,
      // чтобы дальше по коду источник был неразличим.
      applyZone({ zone: hit.zone, ...recognize.zoneInfo(hit.zone), source: 'traffic' }, true);
    },
    onError: err => console.warn(i18nText("[зона] разбор пакета:"), err.message),
  });
  try {
    const st = traffic.start(captureSocket);
    console.log(i18nText("[зона] слушаю трафик:"), st.listening.join(', '));
    if (st.failed.length) console.warn(i18nText("[зона] интерфейсы не открылись:"), st.failed.join('; '));
    watchTraffic();   // с этой минуты за молчанием сокета следят
  } catch (err) {
    combat.disconnect();
    traffic = null;
    trafficError = err.message;
    console.error(i18nText("[зона] трафик не запустился:"), err.message);
    send('toast', { text: i18nText("Не удалось слушать трафик: ") + err.message });
    pushConfig();
    return false;
  }
  pushConfig();
  return true;
}

// Единственное место, где включается и выключается источник зоны. Раньше запуск опроса
// был разбросан по старту и обработчику настроек, и добавить к нему второй источник
// значило продублировать всё дважды.
function applyZoneSource() {
  clearTimeout(pollTimer);
  pollTimer = null;
  // Счётчики уже могли получить зону этим же слушателем. Перезапуск при выборе
  // источника терял её и оставлял приложение без зоны до следующего перехода.
  if (!quitting && traffic && !trafficError && needsTraffic()) {
    zoneFromTraffic = false;
    if (config.zoneSource === 'traffic' && traffic.zone) {
      applyZone({ zone: traffic.zone, ...recognize.zoneInfo(traffic.zone), source: 'traffic' }, true);
    }
    if (config.zoneSource === 'screen') restartPoll();
    return;
  }
  stopTraffic();
  trafficError = null;
  zoneFromTraffic = false;
  if (quitting) return;
  if (config.zoneSource === 'screen') { if (needsTraffic()) startTraffic(); restartPoll(); return; }
  if (config.zoneSource === 'traffic') { startTraffic(); return; }
  console.log(i18nText("[зона] источник выключен — зону называет игрок"));
  if (needsTraffic()) startTraffic();
}

// ---------- маршрутизатор ----------
// lib/router.js собирается отдельно и на диске может ещё отсутствовать, поэтому подключаем
// его лениво и молча: без роутера приложение обязано работать, а не падать при старте.
// Успешный require кэшируется самим Node, неудачный — повторится на следующем запросе,
// так что появившийся позже модуль подхватится без перезапуска.
let routerMod = null;
function getRouter() {
  if (routerMod) return routerMod;
  try { routerMod = require('./lib/router'); } catch (err) { return null; }
  return routerMod;
}
const NO_ROUTE = { found: false, steps: [], hops: 0, portalHops: 0, walkHops: 0, bottleneck: null, risky: false };
function noRoute(reason) { return Object.assign({}, NO_ROUTE, { reason }); }

// Единая точка вызова роутера: любой его отказ превращается в обычный ответ «пути нет».
// UI получает один и тот же формат и в норме, и когда модуля ещё нет.
function runRouter(method, args) {
  const r = getRouter();
  if (!r || typeof r[method] !== 'function') return noRoute(i18nText("роутер ещё не собран"));
  let out;
  try {
    out = r[method].apply(r, args);
  } catch (err) {
    console.error(`[router] ${method}:`, err);
    return noRoute(i18nText("ошибка роутера: ") + err.message);
  }
  if (out && typeof out.then === 'function') {
    return out.then(v => v || noRoute(i18nText("роутер не вернул результат")))
      .catch(err => { console.error(`[router] ${method}:`, err); return noRoute(i18nText("ошибка роутера: ") + err.message); });
  }
  return out || noRoute(i18nText("роутер не вернул результат"));
}

// ---------- IPC ----------
ipcMain.handle('find-route', (e, from, to) => runRouter('findRoute', [store.snapshot(), from, to, { now: Date.now(), outlandsPortalCity: config.outlandsPortalCity }]));
ipcMain.handle('find-route-from-city', (e, to) => runRouter('findRouteFromSafeCity', [store.snapshot(), to, { now: Date.now(), outlandsPortalCity: config.outlandsPortalCity }]));
ipcMain.handle('find-nearest-exit', (e, from) => runRouter('findNearestExit', [store.snapshot(), from, { now: Date.now(), outlandsPortalCity: config.outlandsPortalCity }]));
const contentSearch = require('./lib/content-search');
ipcMain.handle('search-content', (event, request) => {
  try { return contentSearch.search(store.snapshot(), {...request, now:Date.now()}); }
  catch(error) { return {error:i18nText(error.message),matches:[]}; }
});
ipcMain.handle('find-plan', async (event, request={}) => {
  try {
    return await require('./lib/planner-service').plan(store.snapshot(),request,
      {now:Date.now(),outlandsPortalCity:config.outlandsPortalCity,language:config.language});
  } catch(error) {return noRoute(i18nText(error.message));}
});

const exportRouteImage = routeImageFile.create({
  showSaveDialog: options => dialog.showSaveDialog(win, options),
  createNativeImage: png => nativeImage.createFromBuffer(png),
  writeClipboardImage: image => clipboard.writeImage(image),
  onError: error => console.error(i18nText("[маршрут] экспорт PNG:"), error),
});
ipcMain.handle('export-route-image', (event, action, payload) => {
  const contents = win && !win.isDestroyed() ? win.webContents : null;
  if (!contents || contents.isDestroyed() || event.sender !== contents || !event.senderFrame || event.senderFrame !== contents.mainFrame) {
    return { error: i18nText("Экспорт доступен только из главного окна приложения.") };
  }
  return exportRouteImage(action, payload);
});
// Проводник: 'start' с найденным маршрутом либо 'stop'. Отдаём наружу, включился или нет,
// и почему нет: молчаливая кнопка выглядит сломанной.
ipcMain.handle('route-guide', (e, action, route) => (action === 'start' ? startGuide(route) : stopGuide()));
// все известные имена зон для автодополнения: Авалон (zones.json) + королевство (royal-zones.json)
ipcMain.handle('get-zone-names', () => [...recognize.ZONE_INFO.entries()].map(([name, i]) => ({ name, color: i.color || null, tier: i.tier || null })));

// симуляция из файла — тестирование без игры (меню разработчика в UI).
// Идёт через ту же очередь: два параллельных OCR испортили бы параметры воркера.
// Читать можно ТОЛЬКО то, что игрок сам выбрал в системном диалоге: путь приходит из
// рендерера, и без белого списка это было чтение любого доступного файла с отдачей
// результата обратно в UI (и синхронное — оно вешало и хук, и опрос).
const allowedSimFiles = new Set();
ipcMain.handle('simulate-file', async (e, filePath, withTooltip) => {
  if (!allowedSimFiles.has(path.resolve(String(filePath || '')))) {
    return { error: i18nText("файл не выбран в диалоге — открой «Файл → зона + тултип»") };
  }
  try {
    const buf = await fs.promises.readFile(filePath);
    return await enqueue({ kind: 'sim', frame: buf, withTooltip: !!withTooltip });
  } catch (err) {
    console.error(i18nText("[sim] не прочитал файл:"), err.message);
    return { error: i18nText("не удалось прочитать файл: ") + err.message };
  }
});
ipcMain.handle('get-map', () => store.snapshot());
ipcMain.handle('get-metrics', () => metricsSnapshot());
ipcMain.handle('collector-action', async (event, kind, value) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: 'access_denied' };
  try { const result = await collectors.configure(kind, value, confirmCollectorIdentity); return { ...result, state: metricsSnapshot() }; }
  catch { return { ok: false, error: 'profile_unavailable' }; }
});
ipcMain.handle('collector-mails', (event, page) => {
  if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return { error: 'access_denied' };
  return collectors.list(page);
});
ipcMain.handle('metrics-action', (event, action) => {
  const senderOverlay = Object.values(metricsWindows).find(window => window && event.sender === window.webContents);
  if (event.sender !== win?.webContents && !senderOverlay) return { ok: false };
  if (action === 'reset') combat.reset();
  else if (action === 'pause') combat.setPaused(true);
  else if (action === 'resume') combat.setPaused(false);
  else if (action === 'overlay-fame') openMetrics('fame');
  else if (action === 'overlay-damage') openMetrics('damage');
  else if (action === 'enable-food' || action === 'disable-food') {
    if (senderOverlay) return { ok: false };
    config.foodEnabled = action === 'enable-food'; applyMetricsOptions();
  }
  else if (/^food-minutes-(?:\d|[12]\d|30)$/.test(action)) {
    if (senderOverlay) return { ok: false };
    config.foodWarnMinutes = foodBuff.warningMinutes(Number(action.slice(13)));
    saveConfig();
  }
  else if (/^scale-(fame|damage)-(up|down|reset)$/.test(action)) {
    const [, kind, direction] = action.split('-');
    changeMetricsScale(kind, direction);
  }
  else if (action === 'segment-overall' || action === 'segment-current') damageSegment = action.slice(8);
  else if (action === 'lock-damage') {
    damageLocked = !damageLocked; damageWindowControls?.setLocked(damageLocked);
  }
  else if (action === 'close-overlay' && senderOverlay) senderOverlay.close();
  else if (/^(enable|disable)-(fame|damage)$/.test(action)) {
    if (senderOverlay) return { ok: false };
    const [verb, kind] = action.split('-');
    config[kind + 'Enabled'] = verb === 'enable';
    applyMetricsOptions();
  } else if (action === 'stop-traffic') {
    if (senderOverlay) return { ok: false };
    config.fameEnabled = false; config.damageEnabled = false; config.foodEnabled = false;
    collectors.disable();
    const changeSource = config.zoneSource === 'traffic';
    if (changeSource) { config.zoneSource = 'screen'; config.zoneWatch = true; }
    applyMetricsOptions();
    if (changeSource) applyZoneSource();
  } else return { ok: false };
  pushMetrics(); return { ok: true, state: metricsSnapshot() };
});
ipcMain.handle('metrics-resize', (event, corner) => {
  if (event.sender !== metricsWindows.damage?.webContents || !damageWindowControls) return { ok: false };
  if (corner === 'end') { damageWindowControls.stopResize(); return { ok: true }; }
  return { ok: damageWindowControls.startResize(corner) };
});
ipcMain.on('metrics-pointer', (event, interactive) => {
  if (event.sender === metricsWindows.damage?.webContents && typeof interactive === 'boolean') damageWindowControls?.pointer(interactive);
});
// dev включает блок «Симуляция»: он подсовывает распознавателю картинку с диска вместо
// экрана игры. Нужен разработке, игроку не говорит ничего, кроме «что это?».
// Проверки !isPackaged мало: приложение запускают и из исходников — через .bat, — и там
// блок оказался бы ровно там же, где играют. Поэтому нужен ЯВНЫЙ AVALON_DEV=1.
const DEV = !app.isPackaged && process.env.AVALON_DEV === '1';
ipcMain.handle('get-config', () => configForWindow());
ipcMain.handle('onboarding-practice', (event, active) => {
  if (!win || event.sender !== win.webContents) return false;
  onboardingPractice = active === true;
  if (!onboardingPractice && practiceOverlayUntil) hideOverlay(true);
  return onboardingPractice;
});
ipcMain.handle('onboarding-practice-show', (event, index, expiresAt) => {
  if (!win || event.sender !== win.webContents || !onboardingPractice) return { ok: false, reason: i18nText("обучение не открыто") };
  if (!Number.isInteger(index) || index < 0 || index > 2) return { ok: false, reason: i18nText("неизвестный портал") };
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 12 * 3600 * 1000) return { ok: false, reason: i18nText("время портала истекло") };
  const why = overlayBlocked();
  if (why) return { ok: false, reason: why };
  const names = ['Spindlewood', 'Quaent-In-Nusis', 'Puros-Amayam'];
  const name = names[index];
  const info = recognize.zoneInfo(name);
  const tip = { name, ...info, capNum: 7, capMax: 7, capMaxKnown: true, expiresAt };
  practiceOverlayUntil = now + (config.overlayHoldSec || 7) * 1000 + 300;
  showOverlay({ tip, practice: true });
  return { ok: true };
});

// ---------- настройки ----------
// Значения приходят из рендерера, поэтому берём только известные ключи и приводим
// их к типу: overlayScale уходит прямиком в размеры окна, а zoneSource — в цикл опроса.
const OPTIONS = {
  overlayEnabled: 'bool', overlayMap: 'bool',
  onboardingSeen: 'bool',
  cursorScan: 'bool', saveShots: 'bool', portalAudit: 'bool', copyWorldZone: 'bool',
  autoRecordPortals: 'bool',
  overlayScale: 'scale', overlayHoldSec: 'sec',
  theme: 'theme', language: 'language',
  outlandsPortalCity: 'portal-city',
  // zoneWatch сюда больше не входит: это вычисляемое значение, а выбирается источник.
  zoneSource: 'source',
};
ipcMain.handle('set-option', (e, key, value) => {
  const type = OPTIONS[key];
  if (!type) { console.warn(i18nText("[настройки] неизвестный ключ:"), key); return configForWindow(); }
  if (type === 'bool') {
    if (key === 'autoRecordPortals' && config[key] !== false && !value)
      config.portalRecordingRevision = (config.portalRecordingRevision || 0) + 1;
    config[key] = !!value;
  }
  else if (type === 'language') {
    if (!['ru', 'en'].includes(value)) return configForWindow();
    config.language = require('./lib/i18n').setLanguage(value);
  }
  else if (type === 'source') {
    if (!ZONE_SOURCES.includes(value)) return configForWindow();
    config.zoneSource = value;
    config.zoneWatch = value !== 'off';   // держим вычисляемое в согласии с выбором
  }
  else if (type === 'theme') {
    if (!THEMES.includes(value)) return configForWindow();   // чужое значение молча не принимаем
    config[key] = value;
  }
  else if (type === 'portal-city') {
    if (value !== null && !OUTLANDS_PORTAL_CITIES.includes(value)) return configForWindow();
    config.outlandsPortalCity = value;
  }
  else if (type === 'sec') {
    const n = Number(value);
    if (!Number.isFinite(n)) return configForWindow();
    config[key] = Math.min(30, Math.max(3, Math.round(n)));
  } else {
    const n = Number(value);
    if (!Number.isFinite(n)) return configForWindow();
    config[key] = Math.round(clamp(n, SCALE_MIN, SCALE_MAX) * 100) / 100;
  }
  // ползунки (scale, sec) пишем отложенно, всё остальное — сразу
  const slider = type === 'scale' || type === 'sec';
  if (slider) saveConfigSoon(); else { flushConfig(); saveConfig(); }
  // и в журнал ползунок не сыпем: он шлёт значение на каждый пиксель движения
  if (!slider) console.log(i18nText("[настройки]"), key, '=', config[key]);

  if (key === 'zoneSource') {
    // «Выключено» — зону больше никто не подтвердит, а decide() при watching=false верит
    // ей без оглядки на давность. Значит помнить её нельзя: честно забываем.
    // Между экраном и трафиком имя сохраняется для отображения. Запись портала
    // требует подтверждения выбранным источником; applyZoneSource может взять
    // уже известную зону из работающего слушателя счётчиков.
    if (config.zoneSource === 'off') { currentZone = null; pendingZone = null; }
    applyZoneSource();
  }
  if (key === 'overlayEnabled' && !config.overlayEnabled) {
    endOverlaySetup(true);
    cancelPortalPreview();
    if (overlay && !overlay.isDestroyed()) overlay.hide();
  }
  if (key === 'overlayScale' || key === 'overlayMap') {
    if (overlaySetup) sendSetupFrame(); else placeOverlay();
  }
  if (key === 'language') {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        if (window === win) window.setTitle(i18nText(profile.title));
        window.webContents.send('language-changed', config.language);
      }
    }
  }
  return configForWindow();
});

// ---------- комнаты ----------
// Раздела «Подключение» в окне больше нет: адрес проекта и ключ приходят со сборкой,
// имя берётся из Discord, а карта друзей стала комнатой. Вместе с разделом убраны и
// ручки sync-setup / sync-create-group: звать их было уже неоткуда, а рендереру они
// давали возможность переставить адрес сервера — то есть увести выгрузку куда угодно.
//
// Комнат может быть несколько, поэтому все действия работают со СПИСКОМ, а не с
// единственным кодом: создать, войти по коду, выйти, включить выгрузку в конкретную.
// Список хранится и в настройках (чтобы каналы были видны сразу, до сети), и на сервере
// (чтобы вход с другого компьютера дал те же комнаты).
function roomsReply(extra) {
  return Object.assign({ ok: true, rooms: config.rooms, status: net.status() }, extra || {});
}
function upsertRoom(id, title, upload) {
  const i = config.rooms.findIndex(r => r.id === id);
  const row = { id, title: title || null, upload: upload !== false };
  if (i >= 0) config.rooms[i] = Object.assign({}, config.rooms[i], row);
  else config.rooms.push(row);
  saveConfig();
  applySync();
  send('rooms-changed', config.rooms);
}

ipcMain.handle('rooms-list', () => config.rooms);
ipcMain.handle('billing-status', () => subscriptions.snapshot());
ipcMain.handle('billing-refresh', () => subscriptions.refresh());
ipcMain.handle('billing-redeem-code', async (event, code, mapId = null) => {
  if (typeof code !== 'string' || code.length > 128
      || !/^AM30[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{30}$/.test(code.replace(/[-\s]/g, '').toUpperCase())
      || (mapId !== null && (typeof mapId !== 'string' || !sync.UUID_RE.test(mapId))))
    return { ok: false, code: 'invalid_code' };
  const session = auth.status();
  if (!session.signedIn || session.guest) return { ok: false, code: 'discord_required' };
  const user = session.userId;
  try {
    const result = await net.billingRedeemCode(code, mapId);
    if (auth.status().userId !== user) return { ok: false, code: 'account_changed' };
    if (!result?.ok) return { ok: false, code: result?.code || 'code_activation_failed' };
    const status = await subscriptions.refresh();
    if (auth.status().userId !== user) return { ok: false, code: 'account_changed' };
    net.tick(true).catch(() => {});
    return { ok: true, alreadyRedeemed: !!result.alreadyRedeemed, licenseId: result.licenseId,
      mapId: result.mapId, expiresAt: result.expiresAt, status };
  } catch (error) {
    // Never return/log RPC bodies: a code is a bearer secret.
    return { ok: false, code: error.code === 'account_changed' ? 'account_changed'
      : ['PGRST202', '42883'].includes(error.code) ? 'code_setup_pending' : 'code_activation_failed' };
  }
});
ipcMain.handle('billing-purchase', async (event, product, mapId = null) => {
  if (product !== 'group' || (mapId != null && (typeof mapId !== 'string' || !sync.UUID_RE.test(mapId))))
    return { ok: false, error: i18nText('Не удалось открыть оплату. Повтори попытку позже.') };
  if (!auth.status().signedIn || auth.status().guest)
    return { ok: false, error: i18nText('Для подписки войди через Discord в разделе «Аккаунт».') };
  const user = auth.status().userId;
  const status = await subscriptions.refresh();
  if (!status.paymentReady || auth.status().userId !== user)
    return { ok: false, error: i18nText('Оплата скоро появится') };
  try {
    const url = await net.checkout(product, config.language === 'en' ? 'USD' : 'RUB', mapId);
    if (auth.status().userId !== user) return { ok: false, error: billingMessage('account_changed') };
    await shell.openExternal(url);
    return { ok: true };
  } catch { return { ok: false, error: i18nText('Не удалось открыть оплату. Повтори попытку позже.') }; }
});

ipcMain.handle('server-access', async (e, action, params) => {
  const user = auth.status().userId;
  if (!user) return {ok:false,error:'account_required'};
  try { const value=await net.serverAccess(action,params); if(user!==auth.status().userId)return {ok:false,error:'account_changed'}; return {ok:true,value}; } catch { return {ok:false,error:'server_action_failed'}; }
});
ipcMain.handle('room-create', async (e, title, code) => {
  const name = typeof title === 'string' ? title.trim() : '';
  if (!name || name.length > 60) return { ok: false, code: 'invalid_title', error: i18nText('Укажи название сервера.') };
  if (typeof code !== 'string' || code.length > 128 || !/^AM30[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{30}$/.test(code.replace(/[-\s]/g, '').toUpperCase()))
    return { ok: false, code: 'invalid_code' };
  const session = auth.status();
  if (!session.signedIn || session.guest) return { ok: false, code: 'discord_required' };
  const user = session.userId;
  try {
    const result = await net.createGroup(name, code);
    if (auth.status().userId !== user) return { ok: false, code: 'account_changed' };
    if (!result?.ok) return { ok: false, code: result?.code || 'code_activation_failed' };
    const id = result.id;
    if (!sync.UUID_RE.test(String(id))) return { ok: false, code: 'code_activation_failed' };
    upsertRoom(id, result.title || name, true);
    const mine = config.rooms.find(r => r.id === id);
    if (mine) { mine.role = 'admin'; mine.isOwner = true; mine.confirmRequired ??= 0; saveConfig(); applySync(); send('rooms-changed', config.rooms); }
    await subscriptions.refresh();
    if (auth.status().userId !== user) return { ok: false, code: 'account_changed' };
    return roomsReply({ id, title: result.title || name, alreadyCreated: !!result.alreadyCreated });
  } catch (err) {
    return { ok: false, code: ['PGRST202', '42883'].includes(err.code) ? 'code_setup_pending' : 'code_activation_failed' };
  }
});

ipcMain.handle('room-join', async (e, code) => {
  const joiningUser=auth.status().userId;
  const id = String(code || '').trim();
  if (!/^AVI-[0-9A-F]{32}$/i.test(id)) return { ok: false, error: i18nText('Нужен код приглашения AVI от хранителя или модератора.') };
  try {
    const r = await net.joinGroup(id);
    if(joiningUser!==auth.status().userId)return {ok:false,error:'account_changed'};
    upsertRoom(r.id, r.title || i18nText("Сервер группы"), true);
    // Новичок входит наблюдателем — так решает сервер. Пишем это и себе, чтобы окно
    // сразу сказало правду: иначе игрок ждал бы, что его порталы уходят, а они нет.
    const mine = config.rooms.find(x => x.id === r.id);
    if (mine && mine.role == null) { mine.role = 'viewer'; mine.isOwner = false; saveConfig(); applySync(); send('rooms-changed', config.rooms); }
    net.myMaps().then(list => {
      const m = list.find(x => x.id === r.id);
      if (!m || !mine || !config.rooms.includes(mine)) return;
      mine.role = m.role; mine.isOwner = m.isOwner; mine.confirmRequired = m.confirmRequired;
      saveConfig();
      applySync();
      send('rooms-changed', config.rooms);
    }).catch(() => {});
    net.tick(true).catch(() => {});
    return roomsReply({ id: r.id });
  } catch (err) {
    console.error(i18nText("[комнаты] вход не удался:"), err.message);
    return { ok: false, error: err.message, status: net.status() };
  }
});

ipcMain.handle('room-leave', async (e, code) => {
  const id = String(code || '').trim();
  try { await net.leaveGroup(id); }
  catch (err) { return { ok: false, error: err.message, rooms: config.rooms }; }
  config.rooms = config.rooms.filter(r => r.id !== id);
  // Рёбра этой комнаты в карте больше не нужны: смотреть их в списке каналов негде,
  // а в общей куче они выдавали бы себя за знание, которого у нас уже нет.
  const gone = store.dropMap(id);
  saveConfig();
  applySync();
  send('rooms-changed', config.rooms);
  send('map-updated', store.snapshot());
  if (gone.removed) console.log(i18nText("[комнаты] вышли из {0}, убрано её рёбер: {1}", [id, gone.removed]));
  return roomsReply();
});

ipcMain.handle('room-upload', (e, code, on) => {
  const r = config.rooms.find(x => x.id === String(code || ''));
  if (!r) return { ok: false, error: i18nText("нет такой комнаты") };
  r.upload = !!on;
  saveConfig();
  applySync();
  send('rooms-changed', config.rooms);
  return roomsReply();
});

// ---------- участники и роли ----------
// Право решает сервер: эти ручки только передают вызов. Окно прячет кнопки, которых
// у игрока нет, но это удобство — отказ придёт и в обход интерфейса.
ipcMain.handle('map-members', async (e, code) => {
  try { return { ok: true, members: await net.members(String(code || '')) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('map-layout', async (e, code, positions = null, revision = null, replace = false) => {
  const userId = auth.status().userId;
  const result = await net.mapLayout(String(code || ''), positions, revision, replace);
  if (userId !== auth.status().userId) throw new Error('account_changed');
  return result;
});
ipcMain.handle('map-layout-merge', async (e, code, bridge, positions, revision) => {
  const userId=auth.status().userId;
  const result=await net.mapLayoutMerge(String(code||''),bridge,positions,revision);
  if(userId!==auth.status().userId)throw new Error('account_changed');
  return result;
});
ipcMain.handle('map-set-role', async (e, code, userId, role) => {
  try {
    await net.setRole(String(code || ''), String(userId || ''), String(role || ''));
    return { ok: true, members: await net.members(String(code || '')) };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('map-kick', async (e, code, userId) => {
  try {
    await net.kickMember(String(code || ''), String(userId || ''));
    return { ok: true, members: await net.members(String(code || '')) };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('map-policy', async (e, code, confirmRequired) => {
  try {
    const n = await net.setPolicy(String(code || ''), Number(confirmRequired) || 0);
    const r = config.rooms.find(x => x.id === String(code || ''));
    if (r) { r.confirmRequired = n; saveConfig(); send('rooms-changed', config.rooms); }
    return { ok: true, confirmRequired: n };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Список комнат с сервера: он источник истины. Вошёл с другого компьютера —
// комнаты те же, хотя в настройках на этой машине их ещё нет.
ipcMain.handle('rooms-sync', async () => {
  try {
    const mine = await net.myMaps();
    const ids = new Set(mine.filter(m => m.kind === 'group').map(m => m.id));
    for (const r of config.rooms) if (!ids.has(r.id)) store.dropMap(r.id);
    config.rooms = config.rooms.filter(r => ids.has(r.id));
    for (const m of mine) {
      if (m.kind !== 'group') continue;
      const known = config.rooms.find(r => r.id === m.id);
      // Роль и порог держим в настройках рядом с комнатой: по ним окно решает, показывать
      // ли «Настройки ролей» и можно ли вообще писать в эту карту, ещё до похода в сеть.
      if (known) {
        known.title = m.title || i18nText("Сервер группы");
        known.role = m.role; known.isOwner = m.isOwner; known.confirmRequired = m.confirmRequired;
      } else {
        config.rooms.push({ id: m.id, title: m.title || i18nText("Комната"), upload: false,
          role: m.role, isOwner: m.isOwner, confirmRequired: m.confirmRequired });
      }
    }
    saveConfig();
    applySync();
    send('rooms-changed', config.rooms);
    send('map-updated', store.snapshot());
    return roomsReply();
  } catch (err) {
    return { ok: false, error: err.message, rooms: config.rooms };
  }
});
// ---------- вход ----------
// Три ручки и ни одной больше: посмотреть, войти, выйти. Пароль сюда не приходит
// никогда — он остаётся в браузере, на стороне Discord.
ipcMain.handle('auth-status', () => auth.status());
ipcMain.handle('auth-sign-in', async () => {
  try {
    const st = await discordAuth.signIn();
    collectors.reset();
    auth = discordAuth;
    const collectorProfile = await discordAuth.ensureProfile();
    collectors.acceptProfile(collectorProfile);
    // Ник берём из Discord: по нему приложение отличает свои порталы от чужих,
    // и придумывать второе имя человеку незачем.
    const nick = auth.status().nick;
    if (nick && nick !== config.nick) { config.nick = nick; saveConfig(); pushConfig(); }
    cloudPolicy = null;
    subscriptions.reset();
    cloudError = null;
    applySync();
    try { await refreshAccountPolicy(); }
    catch (err) {
      cloudError = err.message;
      console.warn(i18nText("[личная карта] синхронизация недоступна:"), err.message);
      pushConfig();
    }
    send('auth-changed', auth.status());
    return Object.assign({ ok: true }, st);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('auth-sign-out', () => {
  collectors.reset();
  discordAuth.signOut();
  auth = guestAuth;
  const st = guestAuth.status();
  cloudPolicy = null;
  subscriptions.reset();
  cloudError = null;
  applySync();
  pushConfig();
  send('auth-changed', st);
  activateGuest().catch(err => { cloudError = err.message; pushConfig(); });
  return st;
});

ipcMain.handle('sync-status', () => Object.assign(net.status(), { auth: auth.status() }));
// «Синхронизировать сейчас» — не ждать очередного тика
ipcMain.handle('sync-now', async () => {
  await net.tick(true);
  return net.status();
});
// Постоянный вход в окно поиска — кнопкой из панели.
// Раньше окно открывалось ТОЛЬКО по хоткею и только при выключенном снимке у курсора.
// В настройке «слежение выключено + снимок у курсора включён» назвать свою зону было
// нечем вовсе, а без неё портал не к чему привязать. Вход не должен зависеть от
// состояния: зону меняют и потом — прошёл портал, надо сказать, где теперь.
ipcMain.handle('open-search', (ev, mode) => { openSearch(mode === 'lookup' ? 'lookup' : 'portal'); return { ok: true }; });

ipcMain.handle('overlay-setup', (e, action) => {
  if (action === 'start') return startOverlaySetup();
  if (action === 'reset') {
    config.overlayPos = null;
    saveConfig();
    if (overlaySetup) sendSetupFrame(); else placeOverlay();
    return { ok: true };
  }
  endOverlaySetup(action !== 'cancel');
  return { ok: true };
});
// перетаскивание и колесо — из самого оверлея (preload-overlay.js)
const fromOverlay = ev => overlay && !overlay.isDestroyed() && ev.sender === overlay.webContents;
ipcMain.on('overlay-drag', (ev, phase) => {
  if (!fromOverlay(ev) || !overlaySetup) return;
  if (phase === 'start') startDrag(); else stopDrag(true);
});
ipcMain.on('overlay-scale', (ev, dir) => {
  if (!fromOverlay(ev) || !overlaySetup) return;
  const step = dir > 0 ? 0.05 : -0.05;
  const next = Math.round(clamp(config.overlayScale + step, SCALE_MIN, SCALE_MAX) * 100) / 100;
  if (next === config.overlayScale) return;
  config.overlayScale = next;
  sendSetupFrame();
  pushConfig();
});
// Удаление ребра. Из СВОЕЙ карты — всегда: это файл на твоём компьютере.
// С общей или из комнаты — только если сервер признаёт право (владелец или доверенный),
// и решает это он, а не мы: проверка на клиенте защищает лишь от случайного нажатия.
ipcMain.handle('remove-edge', async (e, a, b, scope) => {
  const где = String(scope || 'local');
  if (где !== 'local') {
    try {
      const n = await net.deleteEdge(где, a, b);
      console.log(i18nText("[карта] с сервера удалено рёбер: {0} ({1} ⇄ {2})", [n, a, b]));
    } catch (err) {
      console.warn(i18nText("[карта] сервер удалять не дал:"), err.message);
      return { ok: false, error: err.message, snapshot: store.snapshot() };
    }
  }
  if (где === 'local') net.removePersonal(a, b, config.personalSeededFor);
  store.removeEdgeFromMap(a, b, где);
  return { ok: true, snapshot: store.snapshot() };
});

// Свой код аккаунта — чтобы владелец проекта мог выдать право удалять из общей карты.
ipcMain.handle('auth-id', () => auth.status().userId || null);
ipcMain.handle('get-zone-info', (e, name) => ({ name, ...recognize.zoneInfo(name) }));
// Выбор области с плашкой зоны мышью: снимаем экран, показываем поверх всего,
// игрок обводит плашку. UI игры у всех разный — жёсткий правый нижний угол подходит не всем.
let picker = null;

// Область приходит из рендерера и уходит прямиком в нативный BitBlt (w*h*4 байт памяти),
// а также переживает перезапуск в конфиге. Поэтому проверяем: четыре конечных целых,
// разумного размера и внутри экрана.
function validRegion(r, display) {
  if (!r || typeof r !== 'object') return false;
  const v = ['left', 'top', 'width', 'height'].map(k => r[k]);
  if (!v.every(n => Number.isFinite(n) && Number.isInteger(n))) return false;
  const [left, top, width, height] = v;
  const sf = (display && display.scaleFactor) || 1;
  const g = displayGeometry(display || screen.getPrimaryDisplay());
  const maxW = Math.round(g.width * 1.1), maxH = Math.round(g.height * 1.1);
  if (width < 20 || height < 8 || width > maxW || height > maxH) return false;
  if (left < g.originX - 2 || top < g.originY - 2) return false;
  if (left + width > g.originX + maxW || top + height > g.originY + maxH) return false;
  return sf > 0;
}

ipcMain.handle('pick-zone-region', async () => {
  if (!readsScreen()) return { ok: false, error: i18nText("Выбор области доступен только для источника «С экрана».") };
  if (picker && !picker.isDestroyed()) { picker.focus(); return { ok: false, error: i18nText("окно уже открыто") }; }
  // Своё окно ПРЯЧЕМ перед снимком. Пока оно в фокусе, игра в безрамочном полноэкранном
  // режиме перестаёт быть активной, и Windows выкатывает панель задач поверх неё — ровно
  // на низ экрана, где и живёт плашка зоны. Игрок потом обводил то, что наполовину
  // закрыто панелью. Спрятались — фокус вернулся игре, панель ушла, ждём перерисовки.
  const wasVisible = !!(win && !win.isDestroyed() && win.isVisible());
  if (wasVisible) win.hide();
  await new Promise(r => setTimeout(r, 600));
  if (!readsScreen()) {
    if (wasVisible && win && !win.isDestroyed()) win.show();
    return { ok: false, cancelled: true };
  }
  let frame;
  try {
    frame = (await captureFull()).frame;
  } catch (err) {
    if (wasVisible && win && !win.isDestroyed()) win.show();
    return { ok: false, error: i18nText("не удалось снять экран: ") + err.message };
  }
  // снимок отдаём в окно как data:URL — так не нужен временный файл на диске
  const rgba = F.toRGBA(frame);
  const png = await sharp(rgba, { raw: { width: frame.width, height: frame.height, channels: 4 } })
    .png({ compressionLevel: 1 }).toBuffer();

  // окно открываем на том мониторе, где курсор (там же и игра), а не всегда на основном
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  picker = new BrowserWindow({
    x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
    frame: false, fullscreen: true, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#000000',
    webPreferences: webPrefs(path.join(__dirname, 'preload-picker.js')),  // без Node в рендерере
  });
  picker.setAlwaysOnTop(true, 'screen-saver');
  lockNavigation(picker.webContents);
  picker.loadFile(path.join(__dirname, 'ui', 'picker.html'));
  picker.webContents.once('did-finish-load', () => {
    picker.webContents.send('picker-shot', {
      dataUrl: 'data:image/png;base64,' + png.toString('base64'),
      width: frame.width, height: frame.height,
    });
  });

  // Слушатель обязательно снимаем: раньше при отмене выбора он оставался висеть,
  // и после десятка отмен Node ругался на утечку слушателей.
  let onDone = null;
  const region = await new Promise(resolve => {
    onDone = (ev, r) => {
      // отвечать имеет право только само окно пикера
      if (!picker || picker.isDestroyed() || ev.sender !== picker.webContents) return;
      resolve(r);
    };
    ipcMain.on('picker-done', onDone);
    picker.once('closed', () => resolve(undefined));
  }).finally(() => { if (onDone) ipcMain.removeListener('picker-done', onDone); });
  if (picker && !picker.isDestroyed()) picker.destroy();
  picker = null;
  if (wasVisible && win && !win.isDestroyed()) win.show();   // возвращаем своё окно
  if (region === undefined || region === null) return { ok: false, cancelled: true };
  if (region !== 'default' && !validRegion(region, d)) {
    console.warn(i18nText("[область] отклонена некорректная область:"), JSON.stringify(region));
    return { ok: false, error: i18nText("область вне экрана") };
  }

  config.zoneBarRegion = region === 'default' ? null : region;
  saveConfig();
  stripLogged = false;         // в лог уйдёт новая геометрия
  pollStable = 0;              // и опрос вернётся к частому темпу
  console.log(i18nText("[область] плашка зоны:"), config.zoneBarRegion || i18nText("стандартная (правый нижний угол)"));

  // сразу проверяем выбранное: снимаем и распознаём, чтобы игрок увидел результат, а не гадал
  try {
    const cap = await captureZoneStrip();
    if (!cap || !readsScreen()) return { ok: true, region: config.zoneBarRegion, zone: null };
    const z = await recognize.recognizeZone(cap.frame, {
      zoneBarRegion: cap.strip ? { left: 0, top: 0, width: cap.frame.width, height: cap.frame.height } : config.zoneBarRegion,
      screenHeight: cap.screenHeight,
    });
    return { ok: true, region: config.zoneBarRegion, zone: z && z.zone, raw: z && z.raw };
  } catch (err) {
    return { ok: true, region: config.zoneBarRegion, zone: null, error: err.message };
  }
});

// ---------- окно поиска зоны ----------
// Замена снимку у курсора: игрок сам печатает, куда ведёт портал, теми же сокращениями,
// что и в поле «Куда» на карте («couexa» → Coues-Exakrom). Окно маленькое, у курсора,
// закрывается по Esc и по потере фокуса — чтобы не висеть поверх игры.
let search = null, searchOpenedAt = 0;
let searchMode = 'portal';
// Окно поиска встаёт ТУДА ЖЕ, где появляется плашка с картой зоны, — низ к низу,
// по левому краю. У курсора оно выскакивало посреди экрана и всякий раз в новом месте:
// глазу приходилось его искать, а плашку игрок уже знает где ждать.
function searchBounds() {
  const W = 340, H = 430;   // шапка + поле + эхо разбора + список + кнопки размера + подсказки
  const b = overlayBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y + b.height - 1 });
  return place.anchorTo(b, { width: W, height: H, workArea: d.workArea });
}

function openSearch(mode = 'portal') {
  if (overlaysHidden()) return;
  cancelPortalPreview();
  if (!overlaySetup) hideOverlay(true);
  if (search && !search.isDestroyed()) {
    if (searchMode === mode) { search.focus(); return; }
    closeSearch();
  }
  searchMode = mode;
  const g = searchBounds();
  search = new BrowserWindow({
    width: g.width, height: g.height, x: g.x, y: g.y,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false, backgroundColor: '#00000000',
    webPreferences: webPrefs(path.join(__dirname, 'preload-search.js')),
  });
  const opened = search;
  overlayCapture.register(opened);
  search.setAlwaysOnTop(true, 'screen-saver');
  lockNavigation(search.webContents);
  search.loadFile(path.join(__dirname, 'ui', 'search.html'));
  search.webContents.once('did-finish-load', () => {
    if (search !== opened || opened.isDestroyed()) return;
    search.webContents.send('search-init', {
      mode: searchMode,
      zones: [...recognize.ZONE_INFO.entries()]
        .filter(([, i]) => searchMode !== 'lookup' || i.color === 'avalon')
        .map(([name, i]) => ({ name, color: i.color || null })),
      here: currentZone, zoneWatch: config.zoneWatch,
      binding: bindingLabel(searchMode === 'lookup' ? 'searchBinding' : 'manualBinding'),
    });
    searchOpenedAt = Date.now();
    search.show();
    search.focus();
  });
  // клик мимо окна — закрываемся: игра полноэкранная, невидимое окно поверх неё не нужно.
  // 400 мс форы: при показе Windows успевает прислать blur ещё до реального фокуса.
  search.on('blur', () => { if (search === opened && Date.now() - searchOpenedAt > 400) closeSearch(); });
  search.on('closed', () => { if (search === opened) search = null; });
}
function closeSearch() {
  if (search && !search.isDestroyed()) search.destroy();
  search = null;
}
const fromSearch = ev => search && !search.isDestroyed() && ev.sender === search.webContents;
ipcMain.on('search-close', ev => { if (fromSearch(ev)) closeSearch(); });
ipcMain.on('search-pick', (ev, payload) => {
  if (!fromSearch(ev)) return;
  const name = String((payload && payload.name) || '');
  const info = recognize.ZONE_INFO.get(name);
  if (!info) { console.warn(i18nText("[поиск] незнакомая зона:"), name); return; }
  const lookup = searchMode === 'lookup';
  if (lookup && info.color !== 'avalon') return;
  closeSearch();
  const zi = recognize.zoneInfo(name);
  if (lookup) {
    // Просмотр справочника не меняет позицию, граф и очередь выгрузки порталов.
    const tip = { ...zi, name };
    showOverlay({ tip, lookup: true, showMap: true });
    send('zone-preview', tip);
    return;
  }
  if (payload.mode === 'here') {
    // «я сейчас здесь» — единственный способ задать точку старта, когда слежение
    // за плашкой зоны выключено; ведёт себя как обычная смена зоны
    applyZone({ zone: name, color: zi.color, tier: zi.tier, quality: zi.quality, activities: zi.activities }, true, true);
    send('toast', { text: i18nText("Текущая зона: ") + name });
  } else {
    // Время и размер приходят из рендерера — проверяем оба. closes уходит в expiresAt
    // ребра (по нему роутер решает, успеешь ли), capMax бывает только 7 или 20.
    const sec = Number(payload.closes);
    const closes = Number.isFinite(sec) && sec > 0 && sec <= 48 * 3600 ? Math.round(sec) : null;
    const capMax = payload.capMax === 7 || payload.capMax === 20 ? payload.capMax : null;
    applyTip({
      name, color: zi.color, tier: zi.tier, activities: zi.activities,
      capNum: null, capMax, capMaxKnown: capMax != null, closes,
    }, { copy: false, manual: true });
  }
  send('map-updated', store.snapshot());
});

ipcMain.handle('open-shots', async () => {
  if (!fs.existsSync(SHOTS_DIR)) {
    return { ok: false, error: i18nText("снимков ещё нет — нажми хоткей у портала") };
  }
  const err = await shell.openPath(SHOTS_DIR); // пустая строка = открылось
  return { ok: !err, path: SHOTS_DIR, error: err || null };
});
// перезапуск с правами администратора через UAC (нужен, когда игра защищена BattlEye).
// Спрашиваем подтверждение в main-процессе: сама элевация — не эксплойт (путь константный,
// UAC покажется), но триггер висел на IPC, доступном любому коду рендерера, а после
// элевации админскими правами обладают и системный хук ввода, и вызовы в user32/gdi32.
ipcMain.handle('restart-as-admin', async () => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: [i18nText("Перезапустить"), i18nText("Отмена")], defaultId: 0, cancelId: 1,
    title: i18nText("Перезапуск от администратора"),
    message: i18nText("Перезапустить Avalon Mapper с правами администратора?"),
    detail: i18nText("Без этого горячая клавиша не работает, пока в фокусе окно игры: Albion защищён BattlEye и запущен с повышенной целостностью."),
  });
  if (response !== 0) return { ok: false, cancelled: true };

  // ПЕРЕЗАПУСК ОТ АДМИНИСТРАТОРА. Две вещи, на которых он ломался, и обе не видны глазом.
  //
  // 1. ЗАМОК ЕДИНСТВЕННОГО ЭКЗЕМПЛЯРА. Приложение держит requestSingleInstanceLock, и
  //    поднятая копия натыкалась на замок ещё живого старого процесса: она молча выходила,
  //    показав старое окно, а старый процесс через полторы секунды закрывался. Со стороны
  //    это выглядит как «нажал — приложение просто закрылось». Поэтому теперь наоборот:
  //    сначала выходим сами, и только потом, с задержкой, запускается новая копия.
  //
  // 2. ОТКАЗ В ОКНЕ UAC. Раньше при отказе не оставалось НИЧЕГО: старый процесс уже
  //    завершился, новый не стартовал. Человек терял приложение из-за одного «Нет».
  //    Теперь при отказе запускается обычная, неповышенная копия — ровно то, что было.
  const exe = app.isPackaged
    ? process.execPath
    : path.join(__dirname, 'Avalon Mapper.bat');   // из исходников права поднимает .bat
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const profileArgs = profile.secondary ? " -ArgumentList '--second-account'" : '';
  const script = [
    'Start-Sleep -Milliseconds 1200',
    `try { Start-Process -FilePath ${q(exe)}${profileArgs} -Verb RunAs }`,
    `catch { Start-Process -FilePath ${q(exe)}${profileArgs} }`,
  ].join('; ');
  try {
    require('child_process').spawn('powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script],
      { detached: true, stdio: 'ignore' }).unref();
  } catch (err) { return { ok: false, error: err.message }; }
  // Выходим РАНЬШЕ, чем стартует новая копия: замок должен освободиться до неё.
  setTimeout(() => { quitting = true; app.quit(); }, 400);
  return { ok: true };
});
ipcMain.handle('pick-simulate-files', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PNG', extensions: ['png'] }] });
  for (const p of r.filePaths) allowedSimFiles.add(path.resolve(p));   // белый список для simulate-file
  return r.filePaths;
});
// режим назначения бинда: следующая клавиша или кнопка мыши (3/4/5) станет хоткеем, Esc — отмена
ipcMain.handle('capture-binding', (ev, requested) => {
  const target = ['binding', 'manualBinding', 'searchBinding', 'overlayToggleBinding'].includes(requested) ? requested : 'binding';
  if (!uIOhook) return bindingLabel(target); // фолбэк-режим — переназначение недоступно
  // Двойной клик по «Изменить бинд» перезаписывал captureResolve, и первый промис
  // висел вечно — закрываем предыдущий ожидатель перед началом нового.
  if (captureResolve) finishCapture(null);
  captureTarget = target;
  return new Promise(res => { captureResolve = res; });
});
ipcMain.handle('clear-overlay-toggle-binding', () => {
  config.overlayToggleBinding = null;
  saveConfig();
  send('binding-changed', { target: 'overlayToggleBinding', label: bindingLabel('overlayToggleBinding') });
  return bindingLabel('overlayToggleBinding');
});

app.whenReady().then(async () => {
  // Existing profiles keep Russian until the user chooses a language.
  // A fresh install follows Windows; the saved preference then takes priority.
  if (!fs.existsSync(CONFIG_PATH) && !['ru', 'en'].includes(savedConfig.language)) {
    config.language = require('./lib/i18n').setLanguage(app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en');
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  initAuth();
  store.setDataDir(DATA_DIR);        // карта пишется туда же, куда конфиг (userData)
  store.load();
  // след игрока хранится под его именем: раньше именем было 'me' у всех, теперь оно
  // В карте должна быть РОВНО ОДНА запись игрока — своя. Чужие берутся двумя путями:
  // старый ник (было 'me', пока ники не стали уникальными) и запись 'tester', которую
  // оставлял test/simulate.js — он писал в app/data, а тот однажды переехал сюда целиком.
  // Каждая такая запись висела в графе одиноким ромбом без единого ребра.
  const players = store.state.players;
  if (!players[config.nick]) {
    // своей записи нет — усыновляем самую свежую чужую: это и есть переименование
    const [best] = Object.entries(players).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
    if (best) {
      players[config.nick] = best[1];
      delete players[best[0]];
      console.log(i18nText("[карта] след игрока перенесён с"), best[0], '→', config.nick);
    }
  }
  const strays = Object.keys(players).filter(n => n !== config.nick);
  for (const n of strays) delete players[n];
  if (strays.length) {
    store.save();
    console.log(i18nText("[карта] удалены чужие записи игроков:"), strays.join(', '));
  }
  // Миграция: выкидываем ВСЕ пассивные рёбра, записанные прежними сборками.
  // Приложение их больше не делает (см. store.setPlayerZone): это был вывод из
  // перемещений игрока, а не прочитанный портал, и врал он слишком многими способами.
  // Оставить их в карте — значит и дальше строить по ним маршруты, не отличая догадку
  // от наблюдения. Прочитанные порталы не трогаются: у них source 'ocr' или 'manual'.
  {
    const dead = Object.values(store.state.edges).filter(e => e.source === 'passive');
    for (const e of dead) store.removeEdge(e.a, e.b);
    if (dead.length) console.log(i18nText("[миграция] удалено пассивных рёбер: {0} (выводились из перемещений, а не читались)", [dead.length]));
  }
  // Remove only obsolete cache membership; personal and group records survive.
  store.dropMap(sync.PUBLIC_MAP_ID);
  // Рамку и заголовок рисует Windows, а не мы, и по умолчанию она берёт светлую тему
  // системы — над тёмным интерфейсом это была белая полоса. themeSource говорит Windows
  // считать приложение тёмным: заголовок и кнопки окна перекрашиваются самой системой,
  // без своей рамки и без потери привычного поведения окна.
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1280, height: 840,
    show: false,
    title: i18nText(profile.title),
    // Значок окна и панели задач — тот же файл, из которого electron-builder делает иконку
    // exe и ярлыка (build/icon.png, копия лежит рядом с интерфейсом, чтобы попасть в сборку).
    // Без этого окно показывало значок самого Electron, и он не совпадал с ярлыком.
    icon: path.join(__dirname, 'ui', 'icon.png'),
    backgroundColor: '#141113', // первый кадр совпадает с фоном заставки
    webPreferences: webPrefs(path.join(__dirname, 'preload.js'), {
      backgroundThrottling: false, // карта не должна замирать, когда окно за игрой
    }),
  });
  if (profile.secondary) win.on('page-title-updated', event => { event.preventDefault(); win.setTitle(i18nText(profile.title)); });
  // второй запуск приложения — не плодим копию, а показываем уже открытое окно
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('toast', { text: i18nText("Avalon Mapper уже запущен — это то самое окно") });
  });

  win.webContents.on('did-finish-load', flushOutbox);
  // скрытый оверлей — тоже окно: без явного quit закрытие главного окна не завершало бы приложение
  win.on('closed', () => {
    win = null;
    stopDrag(false);
    closeSearch();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    for (const window of Object.values(metricsWindows)) {
      if (window && !window.isDestroyed()) window.destroy();
    }
    app.quit();
  });
  lockNavigation(win.webContents);
  // Тему передаём СРАЗУ в адресе, а не ждём, пока окно спросит конфиг по IPC. Круг IPC
  // приходит после первой отрисовки, поэтому светлая тема открывалась вспышкой тёмного —
  // окно успевало показать себя старым оформлением и только потом перекрашивалось.
  win.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { theme: config.theme } });
  // с этого момента приложение считается поднявшимся: дальше ошибки только в журнал
  win.webContents.once('did-finish-load', () => {
    started = true;
    win.show();
    win.webContents.send('splash-start');
  });
  win.setMenuBarVisibility(false);
  createOverlay();

  if (!profile.secondary) {
    send('toast', { text: i18nText("Загружаю OCR…") });
    try { await recognize.init(); }
    catch (err) {
      console.error(i18nText("[ocr] запуск:"), err);
      send('toast', { text: i18nText("OCR пока не готов. Хоткеи и карта работают; распознавание повторит запуск при обращении.") });
    }

    try {
      setupHook();
      initializeHotkeyBindings();
    } catch (err) {
      // хук не встал (антивирус и т.п.) — деградируем до фиксированной F9 через globalShortcut
      console.error(i18nText("uiohook не запустился:"), err.message);
      if (uIOhook) { try { uIOhook.removeAllListeners(); uIOhook.stop(); } catch (_) {} }
      uIOhook = null;
      config.binding = { type: 'key', label: 'F9' };
      config.searchBinding = { type: 'key', label: 'F10' };
      config.manualBinding = { type: 'key', label: 'F8' };
      globalShortcut.register('F9', fireHotkey);
      globalShortcut.register('F10', fireSearchHotkey);
      globalShortcut.register('F8', fireManualHotkey);
      send('toast', { text: i18nText("Хук мыши недоступен: F9 — портал, F8 — ручной ввод, F10 — справочник Авалонов") });
    }
  }
  applyZoneSource();
  metricsTimer = setInterval(pushMetrics, 1000);
  gameWindowTimer = setInterval(checkGameWindowVisibility, 750);
  overlayHealthTimer = setInterval(() => overlayRuntime.tick(), 5000);
  for (const event of ['resume', 'unlock-screen']) powerMonitor.on(event, () => {
    if (quitting) return;
    overlayRuntime.wake('system-' + event);
    checkGameWindowVisibility();
  });
  app.on('child-process-gone', (_, details) => {
    if (details.type === 'GPU' && !quitting) overlayRuntime.wake('gpu-reset');
  });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, recoverOverlayDisplays);
  checkGameWindowVisibility();
  applySync();   // общие карты: очередь с прошлого запуска уйдёт сама
  const cloudRetry = setInterval(() => {
    if (auth?.status().signedIn) subscriptions.refresh().catch(() => {});
    if (auth === guestAuth && !guestAuth.status().signedIn) {
      activateGuest().catch(err => { cloudError = err.message; pushConfig(); });
      return;
    }
    if (auth === discordAuth && !discordAuth.status().signedIn) {
      collectors.reset();
      auth = guestAuth;
      cloudPolicy = null;
      subscriptions.reset();
      applySync();
      activateGuest().catch(err => { cloudError = err.message; pushConfig(); });
      return;
    }
    if (!auth.status().signedIn || cloudPolicy) return;
    refreshAccountPolicy().catch(err => { cloudError = err.message; pushConfig(); });
  }, 60000);
  if (cloudRetry.unref) cloudRetry.unref();
  // Профиль на сервере досоздаём при каждом запуске, если вход уже есть. Это не лишний
  // вызов: он же чинит случай «вошёл, а профиль не завёлся» — ровно так и вышло, когда
  // ensure_profile падала на неоднозначном имени столбца. Без этого профиль пришлось бы
  // добывать повторным входом, хотя аккаунт уже на руках.
  if (auth.status().signedIn) {
    const startupAuth = auth;
    auth.ensureProfile(config.nick).then(p => {
      if (auth !== startupAuth) return;
      if (!p) {
        if (startupAuth === discordAuth && !discordAuth.status().signedIn) {
          auth = guestAuth;
          collectors.reset();
          cloudPolicy = null;
          subscriptions.reset();
          applySync();
          activateGuest().catch(err => { cloudError = err.message; pushConfig(); });
        }
        return;
      }
      collectors.acceptProfile(p);
      if (p.nick && p.nick !== config.nick) { config.nick = p.nick; saveConfig(); pushConfig(); applySync(); }
      send('auth-changed', auth.status());
      console.log(i18nText("[вход] профиль:"), p.nick, p.trusted ? i18nText("(доверенный)") : '');
      refreshAccountPolicy().catch(err => {
        cloudError = err.message;
        console.warn(i18nText("[личная карта] синхронизация недоступна:"), err.message);
        pushConfig();
      });
    }).catch(() => {});
  } else {
    activateGuest().catch(err => { cloudError = err.message; pushConfig(); });
  }
  collectorProofTimer = setInterval(refreshCollectors, 20 * 60 * 1000);
  collectorProofTimer.unref();
  // Через updateUrlOf(), а НЕ через config.updateUrl. Поле в настройках убрано вместе
  // с разделом «Подключение», и на свежей установке оно всегда пустое — значит проверка
  // обновлений не запускалась вовсе: ни часовой таймер, ни разовая проверка при старте.
  // Работала только кнопка «Открыть на GitHub», потому что она ходит через updateUrlOf().
  // То есть ровно то, ради чего заведён BUILTIN_UPDATE, молча не делалось.
  if (updateUrlOf()) updater.start();
  send('ready', { binding: bindingLabel(), manualBinding: bindingLabel('manualBinding'), searchBinding: bindingLabel('searchBinding'),
    overlayToggleBinding: bindingLabel('overlayToggleBinding') });

  // Права. Albion защищён BattlEye и работает с повышенной целостностью: пока фокус
  // на окне игры, Windows не доставляет события хука процессу без прав администратора —
  // хоткей молчит именно во время игры. Проверяем и подсказываем, а не гадаем.
  if (!profile.secondary) checkPrivileges();
});

let privWarned = false;
async function checkPrivileges() {
  const p = await privileges.checkHotkeyPrivileges();
  console.log(i18nText("[права]"), JSON.stringify(p));
  send('privileges', p);
  if (p.needsAdmin && !privWarned) {
    privWarned = true;
    send('toast', { text: i18nText("Игра запущена с повышенными правами — хоткей в её окне работать не будет. Перезапусти приложение от имени администратора.") });
  }
  // игру могли запустить уже после старта приложения — проверяем и дальше, пока не предупредим
  if (!p.needsAdmin && !privWarned && !quitting) setTimeout(checkPrivileges, 60000);
}

app.on('will-quit', async () => {
  quitting = true;
  // Ошибка диска не должна прерывать закрытие сокетов и освобождение хоткеев.
  for (const flush of [flushConfig, store.flush]) {
    try { flush(); } catch (err) { console.error(i18nText("[выход] данные не сохранились:"), err.message); }
  }
  globalShortcut.unregisterAll();
  try { if (uIOhook) uIOhook.stop(); } catch (e) {}
  clearTimeout(pollTimer);
  clearInterval(parkTimer);
  clearInterval(metricsTimer);
  clearInterval(collectorProofTimer);
  collectors.close();
  clearInterval(gameWindowTimer);
  clearInterval(overlayHealthTimer);
  overlayRuntime.close();
  stopTraffic();   // сырой сокет держит дескриптор и таймер — отпускаем явно
  stopDrag(false);
  closeSearch();
  net.stop();
  updater.stop();
  gdi.release();
  await recognize.shutdown();
});
app.on('before-quit', () => { quitting = true; overlayRuntime.close(); });
app.on('window-all-closed', () => app.quit());
