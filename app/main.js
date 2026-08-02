// Avalon Mapper — главный процесс Electron.
// Горячая клавиша → МГНОВЕННЫЙ снимок экрана → очередь OCR → ребро на карте.
// Фоновый опрос (1.5 c) → текущая зона по плашке у миникарты → след игрока.
//
// Ключевое правило: захват кадра и его распознавание — разные стадии.
// Тултип портала живёт на экране, только пока курсор на портале, поэтому кадр снимаем
// сразу в момент нажатия, а тяжёлый OCR ставим в очередь на уже снятом кадре.
const { app, BrowserWindow, globalShortcut, desktopCapturer, screen, ipcMain, dialog, shell, clipboard, nativeTheme, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const recognize = require('./lib/recognize');
const store = require('./lib/store');
const privileges = require('./lib/privileges');
const F = require('./lib/frame');
const gdi = require('./lib/capture-gdi');
const place = require('./lib/overlay-place');   // геометрия оверлея: место, размер, перетаскивание
const sync = require('./lib/sync');             // общие карты: выгрузка своих порталов и приём чужих
const authLib = require('./lib/auth');          // вход через Discord: нужен только для общих карт
const origin = require('./lib/origin');         // к какой зоне привязать найденный портал
const update = require('./lib/update');         // не вышла ли новая версия
const { webPrefs } = require('./lib/win-prefs'); // настройки безопасности окон

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
  console.error(`[падение] ${where}: ${text}`);
  if (started) return;
  try {
    if (app.isReady()) {
      dialog.showErrorBox('Avalon Mapper не смог запуститься',
        `${where}.

${String((err && err.message) || err)}

Приложение закрыто, чтобы не блокировать следующий запуск.`);
    }
  } catch { /* показать окно не вышло — выходим молча, это важнее */ }
  app.exit(1);
}
process.on('uncaughtException', err => dieOnStartup('необработанная ошибка', err));
process.on('unhandledRejection', err => dieOnStartup('необработанный отказ промиса', err));

// Один экземпляр на машину. Иначе каждый запуск (из .bat, из терминала, повторный клик)
// поднимает ещё одну копию, и все они параллельно снимают экран и жгут OCR — система «виснет».
if (!app.requestSingleInstanceLock()) {
  console.log('Avalon Mapper уже запущен — активирую существующее окно и выхожу');
  app.quit();
  process.exit(0);
}

// Записываемое состояние — в userData, а НЕ в каталог приложения: после упаковки
// каталог программы (Program Files, да ещё внутри app.asar) недоступен на запись,
// и любой saveConfig упал бы. Старые данные из app/data переносим один раз.
const DATA_DIR = app.getPath('userData');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
(function migrateOldData() {
  const legacy = path.join(__dirname, 'data');
  if (!fs.existsSync(legacy) || DATA_DIR === legacy) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const f of ['config.json', 'map.json']) {
      const from = path.join(legacy, f), to = path.join(DATA_DIR, f);
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.copyFileSync(from, to); console.log('[данные] перенёс', f, '→', DATA_DIR); }
    }
  } catch (err) { console.error('[данные] перенос не удался:', err.message); }
})();
// Список тем — здесь, а не в интерфейсе: значение приходит из конфига и от окна, и то
// и другое проверяется по этому списку. Одно место — один ответ на вопрос «что бывает».
// dark — «Авалон», фактура игры (по умолчанию); coal — «Уголь», тёмная нейтральная;
// light — «Пергамент», светлая. Значение уходит прямо в data-атрибут страницы.
const THEMES = ['dark', 'coal', 'light'];
const config = Object.assign(
  {
    binding: null, nick: 'me', pollMs: 1500, zoneBarRegion: null, hotkeyDebounceMs: 350,

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
    // zoneWatch: следить за плашкой с названием зоны внизу экрана. Выключено —
    // приложение не знает, где персонаж: ни следа, ни автоматических рёбер карты
    zoneWatch: true,
    // cursorScan: снимать область вокруг курсора по хоткею (тултип портала).
    // Выключено — по хоткею открывается поиск зоны по названию, руками
    cursorScan: true,
    // saveShots: класть кадры хоткея в userData/shots. Ровно два файла, перезапись:
    // «что было у курсора» и «что было в плашке зоны» — чтобы видеть, что попало в захват
    saveShots: false,
    // имя не-авалонской зоны за порталом кладём в буфер обмена — чтобы найти её
    // в игровой карте поиском; буфер общий, поэтому это выключаемо
    copyWorldZone: true,
    // theme: оформление окна карты, 'dark' | 'light'. Плашки поверх игры это не касается:
    // она лежит на игровой картинке, и светлой ей быть нечего — засветит собой экран.
    theme: 'dark',

    // ---- куда попадает найденный портал (переключатели независимы) ----
    // своя карта — файл на этом компьютере, никуда не уходит
    saveLocal: true,
    // Комнаты, в которые игрок вошёл: [{ id, title, upload }]. Их может быть несколько —
    // гильдия, друзья, разовая вылазка, — и у каждой свой переключатель выгрузки.
    // Прежние поля groupId/uploadGroup оставлены только ради переноса старых настроек.
    rooms: [],
    // общая карта — одна на всех; ник в неё не передаётся
    uploadPublic: false,
    groupId: null,
    uploadGroup: false,
    // адрес проекта Supabase и его публичный ключ anon: вводятся в панели,
    // потому что у каждой компании друзей проект свой
    syncUrl: '', syncKey: '',
    // где лежит файл с номером последней версии (см. lib/update.js). Пусто — не проверяем
    updateUrl: '',
  },
  fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {},
);
// Конфиг — обычный файл, его правят руками и он переживает обновления приложения.
// Поэтому значения с диска нормализуем: мусор в overlayScale ушёл бы прямо в setBounds.
const { SCALE_MIN, SCALE_MAX, clamp } = place;
function normConfig() {
  config.overlayScale = place.clampScale(config.overlayScale);
  // от 3 до 30 секунд: меньше трёх — не успеть прочитать, больше тридцати — плашка
  // начинает мешать игре, ради чего она вообще и гаснет
  const hold = Number(config.overlayHoldSec);
  config.overlayHoldSec = Number.isFinite(hold) ? Math.min(30, Math.max(3, Math.round(hold))) : 7;
  const p = config.overlayPos;
  config.overlayPos = p && Number.isFinite(p.x) && Number.isFinite(p.bottom)
    ? { x: Math.round(p.x), bottom: Math.round(p.bottom) } : null;
  for (const k2 of ['overlayEnabled', 'overlayMap', 'zoneWatch', 'cursorScan', 'saveShots', 'copyWorldZone',
    'saveLocal', 'uploadGroup', 'uploadPublic']) {
    config[k2] = !!config[k2];
  }
  // Тема — из списка, а не как пришло: значение уходит прямо в data-атрибут страницы,
  // и мусор из правленого руками файла оставил бы окно вообще без темы.
  config.theme = THEMES.includes(config.theme) ? config.theme : 'dark';
  // Имя в общих картах обязано быть РАЗНЫМ у разных игроков. Пока оно было 'me'
  // у всех сразу, приём чужих рёбер ломался целиком: клиент отбрасывает записи
  // со своим именем как собственное эхо — и отбрасывал бы вообще все.
  config.nick = String(config.nick || '').trim().slice(0, 24);
  if (!config.nick || config.nick === 'me') {
    config.nick = 'игрок-' + Math.random().toString(36).slice(2, 6);
    console.log('[синх] имя в общих картах не задано — беру', config.nick);
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
      role: ['viewer', 'member', 'verified', 'admin'].includes(r.role) ? r.role : null,
      isOwner: !!r.isOwner,
      confirmRequired: Number.isFinite(Number(r.confirmRequired))
        ? Math.max(0, Math.min(10, Math.round(Number(r.confirmRequired)))) : 0,
    }))
    .filter((r, i, all) => all.findIndex(x => x.id === r.id) === i);   // без дублей
  // Перенос со старой схемы «одна комната»: код лежал отдельным полем.
  // Делается один раз — дальше groupId только мешал бы, поэтому обнуляем.
  if (config.groupId && !config.rooms.some(r => r.id === config.groupId)) {
    config.rooms.push({ id: config.groupId, title: 'Карта друзей', upload: !!config.uploadGroup });
    console.log('[комнаты] прежняя карта друзей перенесена в список каналов');
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
  if (r && !sane) console.warn('[конфиг] область плашки зоны не годится, беру стандартную:', JSON.stringify(r));
  config.zoneBarRegion = sane ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}
normConfig();
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 1));
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

const BLANK_TEXT = 'Кадр пустой — проверь, что игра в режиме "оконный без рамки", а не эксклюзивный полноэкранный';

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
// Вход через Discord. Без него приложение работает целиком — но только с личной картой:
// она файл на диске и сервера не касается. Общее (комнаты и общая карта) требует входа,
// и это единственное правило доступа. Заводить аккаунт ради карты порталов никого
// не заставляют — окна входа при запуске нет, есть кнопка в настройках.
const auth = authLib.createAuth({
  file: path.join(DATA_DIR, 'auth.json'),
  log: msg => console.log(msg),
  // Страницу Discord открывает СИСТЕМНЫЙ браузер, а не наше окно: пароль вводится там,
  // и приложение его не видит и не может увидеть.
  openExternal: url => shell.openExternal(url),
  // Шифрование токена продления средствами системы: на Windows это DPAPI, ключ привязан
  // к учётной записи. Файл, унесённый на другую машину, бесполезен. Библиотека входа
  // об Electron ничего не знает и работает без этого — тогда токен лежит открыто.
  secret: safeStorage.isEncryptionAvailable() ? {
    encrypt: s => safeStorage.encryptString(s).toString('base64'),
    decrypt: s => safeStorage.decryptString(Buffer.from(s, 'base64')),
  } : null,
});
auth.configure({ url: syncUrlOf(), key: syncKeyOf() });

const net = sync.createSync({
  file: path.join(DATA_DIR, 'sync-outbox.json'),
  log: msg => console.log(msg),
  // Токен вошедшего. Вернёт null — синхронизация молча ждёт: очередь копится на диске
  // и уйдёт, как только человек войдёт. Ни одного выброшенного ребра.
  getToken: () => auth.token(),
  onMerge: (list, scope) => {
    // Чужим рёбрам не верим на слово. В общую карту пишет кто угодно — ключ лежит
    // в сборке, и это нормально, — поэтому имя зоны, которого нет в справочнике игры,
    // в карту не попадает вовсе. Проверка дешёвая (поиск в Map) и отсекает разом
    // и мусор, и попытку раздуть карту выдуманными зонами.
    const clean = (list || []).filter(e =>
      e && recognize.ZONE_INFO.has(e.a) && recognize.ZONE_INFO.has(e.b));
    const dropped = (list || []).length - clean.length;
    if (dropped) console.warn(`[синх] отброшено рёбер с незнакомыми зонами: ${dropped}`);
    const n = store.mergeRemote(clean, scope);
    if (!n) return;
    // Сравнивать надо с кодом общей карты, а не со словом 'public': scope давно стал
    // id карты, и старое сравнение не совпадало никогда — рёбра из общей карты
    // показывались как «из карты друзей».
    const where = scope === sync.PUBLIC_MAP_ID ? 'общей карты' : 'карты друзей';
    console.log(`[синх] из ${where} принято рёбер: ${n}`);
    send('toast', { text: `Из ${where}: ${n} ${n === 1 ? 'портал' : 'портала(ов)'}` });
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
  if (!st.url) return { ok: false, error: 'ссылки на новую версию нет' };
  await shell.openExternal(st.url);
  return { ok: true, url: st.url };
});

function applySync() {
  net.configure(Object.assign({}, config, { syncUrl: syncUrlOf(), syncKey: syncKeyOf() }));
  if (net.status().enabled) net.start(); else net.stop();
  send('sync-status', Object.assign(net.status(), { auth: auth.status() }));
}

let win = null;
let currentZone = null;
let pendingZone = null; // кандидат на смену зоны: фоновый опрос коммитит со 2-го подтверждения
let zoneSeenAt = 0;     // когда плашку зоны подтвердили в последний раз (см. lib/origin.js)
// порталы, для которых зона на момент нажатия была неизвестна: ждут её несколько секунд
const parking = origin.createParking();
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

// Где стоять оверлею. По умолчанию — над миникартой справа внизу, как часть HUD:
// привязываемся к ОТКАЛИБРОВАННОЙ плашке зоны (её игрок может подвинуть мышью), а не к
// углу экрана. Игрок может перетащить плашку куда угодно (config.overlayPos) и задать
// размер (config.overlayScale) — тогда автоматическая привязка не используется вовсе.
// Сама арифметика — в lib/overlay-place.js, здесь только опрос экранов.
let lostPosWarned = false;
function overlayBounds() {
  const strip = zoneStripRect();
  const p = config.overlayPos;
  const posDisplay = p ? screen.getDisplayNearestPoint({ x: p.x, y: p.bottom - 1 }) : null;
  const good = place.validPos(p, posDisplay);
  if (p && !good && !lostPosWarned) {
    lostPosWarned = true;   // место ищется перед каждым показом — в лог пишем один раз
    console.warn('[оверлей] сохранённое место вне экранов — возвращаюсь к стандартному');
  }
  const display = good ? posDisplay : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
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
    if (url !== wc.getURL()) { e.preventDefault(); console.warn('[окно] переход запрещён:', url); }
  });
  wc.on('will-attach-webview', e => e.preventDefault());
}

// Оверлей — единственное окно, которое игрок никогда не видит закрытым: оно спрятано,
// пока не нажат хоткей. Поэтому его смерть не проявляется ничем. Страница упала —
// окно живо и не destroyed, overlayReady так и остался true, showOverlay честно шлёт
// событие в пустоту и показывает прозрачный прямоугольник. Снаружи это выглядит как
// «оверлей перестал работать», при том что захват, распознавание и запись рёбер идут.
// Отсюда правило: потерянное окно поднимаем сами, а не ждём перезапуска приложения.
const OVERLAY_REVIVE_MS = 1500;   // если страница падает сразу, не крутим цикл вплотную
const OVERLAY_REVIVE_MAX = 3;     // падает раз за разом — дело не в случайности, молчим
let overlayRevive = null, overlayRevives = 0;

function reviveOverlay(why) {
  overlayReady = false;
  // окно карты закрыто — приложение уходит, поднимать нечего
  if (quitting || !win || win.isDestroyed() || overlayRevive) return;
  if (overlayRevives >= OVERLAY_REVIVE_MAX) {
    console.error('[оверлей] окно потеряно (' + why + '), поднимать больше не пробую');
    send('toast', { text: 'Оверлей не поднимается — перезапусти приложение' });
    return;
  }
  overlayRevives++;
  console.error('[оверлей] окно потеряно (' + why + ') — поднимаю заново');
  overlayRevive = setTimeout(() => {
    overlayRevive = null;
    if (quitting || !win || win.isDestroyed()) return;
    // Слушателя 'closed' снимаем ДО destroy: иначе наш же снос считается потерей окна,
    // подъём назначает следующий — и приложение пересоздаёт оверлей раз в полторы секунды.
    const dead = overlay;
    overlay = null;
    if (dead && !dead.isDestroyed()) { dead.removeAllListeners('closed'); dead.destroy(); }
    overlaySetup = false;   // режим настройки места умер вместе с окном
    setupBackup = null;
    createOverlay();
  }, OVERLAY_REVIVE_MS);
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
    webPreferences: webPrefs(path.join(__dirname, 'preload-overlay.js')),  // только два события
  });
  overlay.setAlwaysOnTop(true, 'screen-saver'); // выше окна игры в borderless
  overlay.setIgnoreMouseEvents(true);           // клики проходят сквозь оверлей в игру
  // Исключаем оверлей из захвата экрана: он висит поверх игры всегда, и наш же
  // следующий кадр иначе снимет его вместе с игрой — OCR будет читать нашу плашку.
  // На Windows это WDA_EXCLUDEFROMCAPTURE: на экране окно остаётся видимым.
  overlay.setContentProtection(true);
  w.webContents.on('did-finish-load', () => {
    if (w !== overlay) return;             // событие от окна, которое мы уже сняли
    overlayReady = true;
    overlayRevives = 0;                    // страница жива — счётчик попыток обнуляем
    w.webContents.setZoomFactor(b.zoom);   // вёрстка задана в пикселях 1080p
  });
  w.webContents.on('render-process-gone', (e, d) => {
    if (w === overlay) reviveOverlay('страница упала: ' + ((d && d.reason) || 'причина неизвестна'));
  });
  w.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    // -3 (ERR_ABORTED) — не сбой: так помечается загрузка, отменённая следующей
    if (isMain && code !== -3 && w === overlay) reviveOverlay('страница не загрузилась: ' + (desc || code));
  });
  w.on('closed', () => { if (w === overlay) reviveOverlay('окно закрыто'); });
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
function overlayBlocked() {
  if (!config.overlayEnabled) return 'оверлей выключен в настройках';
  if (overlaySetup) return 'идёт настройка места плашки — нажми «Готово»';
  if (!overlay || overlay.isDestroyed()) return 'окно оверлея потеряно';
  if (!overlayReady) return 'окно оверлея ещё не загрузилось';
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
  console.warn('[оверлей] не показываю:', why);
  send('toast', { text: 'Плашка не показана: ' + why });
  return true;
}

function showOverlay(payload) {
  const why = overlayBlocked();
  if (why) return blocked(why);
  lastBlock = '';
  placeOverlay();
  clearTimeout(overlayFadeTimer);   // показываем поверх недоигравшего исчезновения
  overlay.webContents.send('overlay-show', Object.assign({ showMap: config.overlayMap }, payload));
  overlay.showInactive(); // без перехвата фокуса у игры
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
    console.warn('[оверлей] окно потеряло «поверх всех» — возвращаю');
  }
  overlay.setAlwaysOnTop(true, 'screen-saver');
  clearTimeout(overlayTimer);
  // ошибку держим не дольше обычного, но и не меньше 3,5 с — её надо успеть прочитать
  const hold = (config.overlayHoldSec || 7) * 1000;
  overlayTimer = setTimeout(() => hideOverlay(), payload.error ? Math.max(3500, hold) : hold);
}

// Прячем в два шага: сначала вёрстка плавно гасит блок, и только когда анимация
// доиграла — убираем само окно. Раньше окно исчезало мгновенно, и это резало глаз:
// поверх живой игры любой мгновенный скачок читается как сбой, а не как «ушло».
const OVERLAY_FADE_MS = 260;   // синхронно с анимацией ov-out в ui/overlay.css
let overlayFadeTimer = null;
function hideOverlay(instant = false) {
  if (!overlay || overlay.isDestroyed()) return;
  clearTimeout(overlayFadeTimer);
  if (instant) { overlay.webContents.send('overlay-hide', { instant: true }); overlay.hide(); return; }
  overlay.webContents.send('overlay-hide', {});
  overlayFadeTimer = setTimeout(() => {
    if (overlay && !overlay.isDestroyed() && !overlaySetup) overlay.hide();
  }, OVERLAY_FADE_MS);
}

// Хоткей нажат — показываем это НЕМЕДЛЕННО, не дожидаясь распознавания. Иначе между
// нажатием и ответом проходит около секунды, в которую игрок не знает, сработало ли
// вообще, и жмёт ещё раз. Плашка встаёт на своё обычное место и сменяется результатом.
const BUSY_MAX_MS = 12000;   // страховка: ответ не пришёл вовсе — не висим вечно
function showBusy() {
  const why = overlayBlocked();
  if (why) return blocked(why);
  lastBlock = '';
  placeOverlay();
  clearTimeout(overlayFadeTimer);
  overlay.webContents.send('overlay-show', { busy: true, showMap: config.overlayMap });
  overlay.showInactive();
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
  if (!config.overlayEnabled) return { ok: false, error: 'оверлей выключен' };
  if (!overlay || overlay.isDestroyed() || !overlayReady) {
    reviveOverlay('настройка места при мёртвом окне');   // кнопка заодно и чинит
    return { ok: false, error: 'окно оверлея потеряно — поднимаю заново, повтори через пару секунд' };
  }
  if (!overlaySetup) setupBackup = { scale: config.overlayScale, pos: config.overlayPos };
  overlaySetup = true;
  clearTimeout(overlayTimer);
  overlay.setIgnoreMouseEvents(false);   // на время настройки плашку можно схватить мышью
  overlay.setFocusable(true);            // и нажать Enter/Esc
  sendSetupFrame();
  overlay.show();
  overlay.focus();
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
    // Включена ли общая карта. Интерфейс не решает это сам и не держит свою копию
    // выключателя: он один, в lib/sync.js, и сюда приезжает вместе с настройками.
    // Две копии булева значения в разных процессах разъезжаются — это вопрос времени.
    publicMap: sync.PUBLIC_MAP_ON,
  }, config);
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
//   • код клавиши СРАВНИВАЕТСЯ с одним сохранённым биндом и больше нигде не используется;
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
const heldKeys = new Set(); // зажатые клавиши: keydown автоповторяется ~30 мс, нажатие — одно

function bindingLabel() { return config.binding?.label || '—'; }
function fireHotkey() {
  const now = Date.now();
  // Антидребезг 350 мс (config.hotkeyDebounceMs). Прежние 800 мс резали легитимные
  // нажатия по соседним порталам (человек успевает перевести мышь за ~400–500 мс).
  // Автоповтор зажатой клавиши отсекается отдельно — по heldKeys, а не таймером.
  if (now - lastHotkeyAt < (config.hotkeyDebounceMs || 350)) return;
  lastHotkeyAt = now;
  hotkeyCapturing++;
  // ВАЖНО: колбэк хука обязан вернуться мгновенно. Любая долгая работа прямо здесь
  // подвешивает доставку событий uiohook → мышь в игре начинает дёргаться.
  setImmediate(() => {
    runHotkey()
      .catch(err => console.error('[hotkey] непойманная ошибка:', err))
      .finally(() => { hotkeyCapturing--; });
  });
}
function finishCapture(binding) {
  const resolve = captureResolve; captureResolve = null;
  if (binding) { config.binding = binding; saveConfig(); }
  if (resolve) resolve(bindingLabel());
  send('binding-changed', { label: bindingLabel() });
}
function setupHook() {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
  KEY_NAME = Object.fromEntries(Object.entries(UiohookKey).map(([k, v]) => [v, k]));
  uIOhook.on('keydown', e => {
    if (captureResolve) {
      if (e.keycode === UiohookKey.Escape) return finishCapture(null);
      return finishCapture({ type: 'key', code: e.keycode, label: KEY_NAME[e.keycode] || 'Key' + e.keycode });
    }
    const b = config.binding;
    if (b?.type === 'key' && e.keycode === b.code) {
      if (heldKeys.has(e.keycode)) return; // автоповтор удержания — не новое нажатие
      heldKeys.add(e.keycode);
      fireHotkey();
    }
  });
  uIOhook.on('keyup', e => { heldKeys.delete(e.keycode); });
  // Страховка перетаскивания оверлея: если кнопку отпустили там, где наше окно
  // события уже не получает, «мышь отпущена» приходит хотя бы отсюда — иначе
  // плашка так и ездила бы за курсором.
  uIOhook.on('mouseup', () => { if (dragTimer) setImmediate(() => stopDrag(true)); });
  uIOhook.on('mousedown', e => {
    if (captureResolve) {
      // ЛКМ/ПКМ не назначаем — ими кликают по интерфейсу; средняя и боковые (3/4/5) — можно
      if (e.button >= 3) return finishCapture({ type: 'mouse', button: e.button, label: 'Mouse' + e.button });
      return;
    }
    const b = config.binding;
    if (b?.type === 'mouse' && e.button === b.button) fireHotkey();
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
// Прямой захват прямоугольника (BitBlt) отвалился — остаётся desktopCapturer, а он умеет
// снимать ТОЛЬКО экран целиком, прямоугольника у него нет вовсе. То есть с этого момента
// приложение начинает фотографировать весь рабочий стол на каждый опрос и каждое нажатие:
// в сто раз больше пикселей и в сто раз дольше. Молчать об этом нельзя — человек увидит
// лишь то, что «стало тормозить», и не поймёт почему.
let gdiBroken = false;
let gdiWarned = false;
function noteGdiBroken(where, err) {
  gdiBroken = true;
  console.warn(`[gdi] ${where}: ${err && err.message ? err.message : err} — откатываюсь на снимок всего экрана`);
  if (gdiWarned) return;
  gdiWarned = true;
  send('toast', { text: 'Быстрый захват экрана отключился — приложение перешло на снимки всего экрана и будет заметно медленнее. Помогает перезапуск.' });
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
  return {
    originX: Math.round(b.x * sf), originY: Math.round(b.y * sf),
    width: Math.round(size.width * sf), height: Math.round(size.height * sf),
    scaleFactor: sf,
  };
}
function screenGeometry() { return displayGeometry(screen.getPrimaryDisplay()); }

// Прямоугольник плашки текущей зоны (правый нижний угол экрана).
function zoneStripRect() {
  const { width: W, height: H } = screenGeometry();
  const s = H / 1080;
  const r = config.zoneBarRegion;
  return r
    ? { x: r.left, y: r.top, width: r.width, height: r.height, screenHeight: H }
    : { x: W - 400 * s, y: H - 48 * s, width: 380 * s, height: 30 * s, screenHeight: H };
}

// ---------- снимки хоткея на диск (config.saveShots) ----------
// Ровно два файла с постоянными именами, каждое нажатие их перезаписывает: что было
// у курсора и что было в плашке зоны. Это ответ на вопрос «почему не распознало» —
// видно глазами, попал ли тултип в кадр и та ли область обведена.
// Кадра нет (снимок выключен настройкой) — старый файл удаляем, чтобы не врал.
const SHOTS_DIR = path.join(DATA_DIR, 'shots');
const SHOT_FILES = { cursor: '1-у-курсора.png', zone: '2-плашка-зоны.png' };
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
  }).catch(err => console.error('[снимки] не сохранил:', err.message));
  return shotChain;
}

// Кадр для фонового опроса: только полоска с плашкой зоны.
let stripLogged = false;
async function captureZoneStrip() {
  const rect = zoneStripRect();
  if (!stripLogged) {
    stripLogged = true;
    const g = screenGeometry();
    console.log(`[захват] экран ${g.width}x${g.height}, полоска зоны ${Math.round(rect.width)}x${Math.round(rect.height)} ` +
      `в (${Math.round(rect.x)}, ${Math.round(rect.y)})`);
  }
  if (!gdiBroken && gdi.available()) {
    const t0 = performance.now();
    try {
      const frame = gdi.grab(rect.x, rect.y, rect.width, rect.height);
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
      noteGdiBroken('снимок полоски зоны', err);
    }
  }
  const cap = await captureScreen();
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
function captureTooltipArea(box = TIP_BOX_WIDE) {
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
  if (gdiBroken || !gdi.available()) return null;
  const t0 = performance.now();
  let frame;
  try {
    frame = gdi.grab(x, y, w, h);
  } catch (err) {
    noteGdiBroken('снимок области у курсора', err);
    return null;
  }
  // курсор в координатах самого квадрата — по нему потом меряем, какая область реально нужна
  return { frame, screenHeight: g.height, scale: s, cursor: { x: p.x - x, y: p.y - y }, ms: Math.round(performance.now() - t0) };
}

// Курсор и его монитор — в физических ВИРТУАЛЬНЫХ координатах (см. displayGeometry).
// Точку не «локализуем» под дисплей: BitBlt ждёт именно виртуальные координаты.
function cursorOnScreen() {
  try {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    const sf = d.scaleFactor || 1;
    return { point: { x: Math.round(p.x * sf), y: Math.round(p.y * sf) }, geom: displayGeometry(d) };
  } catch {
    const g = screenGeometry();
    return { point: { x: g.originX + Math.round(g.width / 2), y: g.originY + Math.round(g.height / 2) }, geom: g };
  }
}

// Кадр целиком — запасной путь, если тултипа не оказалось в квадрате у курсора.
async function captureFull() {
  if (!gdiBroken && gdi.available()) {
    const t0 = performance.now();
    try {
      // снимаем МОНИТОР С КУРСОРОМ (там игра), а не всегда основной
      const { originX, originY, width, height } = cursorOnScreen().geom;
      const frame = gdi.grab(originX, originY, width, height);
      if (!F.stats(frame).blank) return { frame, ms: Math.round(performance.now() - t0) };
    } catch (err) {
      noteGdiBroken('снимок полоски зоны', err);
    }
  }
  return captureScreen();
}

async function captureScreen() {
  const t0 = performance.now();
  captureInFlight++;
  try {
    const d = screen.getPrimaryDisplay();
    const { width, height } = d.size;
    const sf = d.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) },
      fetchWindowIcons: false,
    });
    if (!sources.length) throw new Error('desktopCapturer не вернул ни одного экрана');
    const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[0];
    if (!src.thumbnail || src.thumbnail.isEmpty()) throw new Error('desktopCapturer вернул пустую картинку');
    const tGrab = performance.now();
    // Сырые пиксели, без PNG. Замер на 4К: toBitmap 7 мс против toPNG 1300 мс,
    // а распаковывать PNG всё равно пришлось бы нам самим.
    const size = src.thumbnail.getSize();
    const frame = F.fromBitmap(src.thumbnail.toBitmap(), size.width, size.height);
    if (process.env.AVALON_BENCH) {
      console.log(`[bench] getSources ${Math.round(tGrab - t0)}мс | toBitmap ${Math.round(performance.now() - tGrab)}мс ` +
        `(${(frame.data.length / 1e6).toFixed(1)} МБ) | ${size.width}x${size.height}`);
    }
    return { frame, ms: Math.round(performance.now() - t0) };
  } finally { captureInFlight--; }
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
let pollStable = 0;
function nextPollDelay() {
  const base = config.pollMs;
  if (pollStable > 20) return base * 4;   // ≈6 c: игрок давно стоит
  if (pollStable > 6) return base * 2;    // ≈3 c
  return base;
}

let lastBlankToastAt = 0;
function warnBlank(kind, st) {
  console.warn(`[${kind}] пустой кадр: mean=${st.mean.toFixed(1)} stdev=${st.stdev.toFixed(1)} — OCR пропущен`);
  const now = Date.now();
  // фоновый опрос не должен сыпать тост каждые 1.5 c — не чаще раза в 30 c
  if (kind !== 'hotkey' && now - lastBlankToastAt < 30000) return;
  lastBlankToastAt = now;
  send('toast', { text: BLANK_TEXT });
  if (kind === 'hotkey') showOverlay({ error: BLANK_TEXT });
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

function enqueue({ kind, frame, withTooltip = false, withZone = true, captureMs = 0, checkMs = 0, cursor = null, strip = false, screenHeight = 0, zoneFrame = null, tipBox = false }) {
  return new Promise(resolve => {
    const task = { kind, frame, withTooltip, withZone, captureMs, checkMs, cursor, strip, screenHeight, zoneFrame, tipBox, at: Date.now(), resolve };
    if (isPress(kind)) {
      // фоновые опросы уступают дорогу
      for (const t of queue.splice(0)) {
        if (t.kind === 'poll') t.resolve({ skipped: 'вытеснен хоткеем' });
        else queue.push(t);
      }
      if (queue.filter(t => isPress(t.kind)).length >= MAX_HOTKEY_TASKS) {
        const i = queue.findIndex(t => isPress(t.kind));
        queue.splice(i, 1)[0].resolve({ skipped: 'очередь переполнена' });
        console.warn('[queue] очередь хоткеев переполнена — отброшен самый старый кадр');
      }
    } else if (kind === 'poll' && (hotkeyPending() || queue.some(t => t.kind === 'poll'))) {
      resolve({ skipped: 'уступаем хоткею' });
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
    });
    const ocrMs = Math.round(performance.now() - t0);
    console.log(`[${task.kind}] capture ${task.captureMs}мс | проверка кадра ${task.checkMs}мс | ожидание ${waitMs}мс | ocr ${ocrMs}мс`
      + (out.tipMs != null ? ` (тултип ${out.tipMs}мс + зона ${out.zoneMs}мс)` : '')
      + ` | в очереди ещё ${queue.length}`);
  } catch (err) {
    console.error(`[${task.kind}] ошибка распознавания:`, err);
    const text = 'Ошибка: ' + ((err && err.message) || err);
    if (task.kind !== 'poll') send('toast', { text });
    // Плашку «Распознаю…» поднимал хоткей — гасим её здесь же. Иначе бегущие точки
    // крутятся до страховочных 12 с, и игрок жмёт ещё раз, хотя ответ уже есть.
    if (task.kind === 'hotkey') showOverlay({ error: text });
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
async function processFrame(input, { withTooltip, withZone = true, cursor = null, strip = false, screenHeight = 0, zoneFrame = null, tipBox = false, kind = '' }) {
  const frame = await F.toFrame(input);
  const result = { zone: null, tip: null };
  if (withTooltip) {
    const t = performance.now();
    result.tip = await recognize.recognizeTooltip(frame, { near: tipBox ? null : cursor, screenHeight });
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
  }
  const tz = performance.now();
  // Плашку зоны читаем, только если слежение включено: выключил — приложение
  // сознательно не знает, где персонаж, и гадать по случайному кадру не должно.
  // commit: с хоткея зону принимаем сразу, фоновый опрос — со 2-го подтверждения.
  const o = { strip, screenHeight, tz, withTooltip, kind, commit: withTooltip || kind === 'zone' };
  if (!withZone) return finishFrame(result, null, o);
  // зона распознаётся по своему кадру (полоска в углу), если он есть
  if (zoneFrame) return finishFrame(result, await F.toFrame(zoneFrame), Object.assign({}, o, { strip: true }));
  return finishFrame(result, frame, o);
}

// Сколько места вокруг курсора реально понадобилось. Тултип рисуется от полосы-якоря:
// имя выше неё, чип справа, строка таймеров ниже — границы берём из тех же констант,
// по которым режет lib/recognize. Копим максимум за сессию: по нему и подрежем квадрат.
const boxNeed = { left: 0, right: 0, up: 0, down: 0, n: 0 };
function measureTooltipBox(tip, cursor, screenHeight) {
  const bar = tip.raw && tip.raw.bar;
  if (!bar) return;
  const s = (screenHeight || 1080) / 1080;
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
  console.log(`[область] тултип занял от курсора: влево ${need.left}, вправо ${need.right}, вверх ${need.up}, вниз ${need.down} ` +
    `| максимум за ${boxNeed.n} нажатий: влево ${boxNeed.left}, вправо ${boxNeed.right}, вверх ${boxNeed.up}, вниз ${boxNeed.down} ` +
    `| снимаем влево ${Math.round(TIP_BOX_WIDE.left * s)}, вправо ${Math.round(TIP_BOX_WIDE.right * s)}, ` +
    `вверх ${Math.round(TIP_BOX_WIDE.up * s)}, вниз ${Math.round(TIP_BOX_WIDE.down * s)}` +
    (overNarrow.length ? ` | узкого квадрата не хватило бы по: ${overNarrow.join(', ')}` : '') +
    (tight.length ? ` | ВПРИТЫК по: ${tight.join(', ')}` : ''));
}

async function finishFrame(result, frame, { strip, screenHeight, tz, withTooltip, kind, commit }) {
  let zoneNow = null;   // зона, прочитанная на кадре ЭТОГО нажатия
  if (frame) {
    // Пришла вырезанная полоска — плашку ищем во всей ней, а масштаб констант
    // считаем от высоты ЭКРАНА, а не от высоты полоски.
    const zoneBarRegion = strip
      ? { left: 0, top: 0, width: frame.width, height: frame.height }
      : config.zoneBarRegion;
    const z = await recognize.recognizeZone(frame, { fast: !withTooltip, zoneBarRegion, screenHeight });
    result.zoneMs = Math.round(performance.now() - tz);
    if (z) { result.zone = z; applyZone(z, commit); }
    zoneNow = z ? z.zone : null;
  }
  // zoneTried — плашку на этом кадре СНИМАЛИ. Если она при этом не прочиталась, верить
  // памяти о зоне нельзя: см. lib/origin.js.
  if (result.tip) applyTip(result.tip, { copy: kind !== 'sim', zoneNow, zoneTried: !!frame });
  else if (withTooltip) {
    const text = 'Тултип портала не найден — наведись на портал и нажми ' + bindingLabel();
    send('toast', { text });
    showOverlay({ error: text });
  }
  send('map-updated', store.snapshot());
  return result;
}

// Смена текущей зоны. commit=false — фоновый опрос: принимаем со 2-го подтверждения
// подряд (защита от ложных срабатываний на случайном тексте, когда игра свёрнута).
// manual — зону назвал человек (Ctrl+Enter в окне поиска), а не распознавание.
function applyZone(z, commit, manual = false) {
  const now = Date.now();
  // Плашка прочиталась — значит мы точно знаем, где игрок, ПРЯМО СЕЙЧАС. Отмечаем время
  // (по нему решается, можно ли верить зоне при следующем нажатии) и разбираем отложенное.
  if (z.zone === currentZone) { pendingZone = null; zoneSeenAt = now; flushParked(z.zone); return; }
  if (!commit && pendingZone !== z.zone) { pendingZone = z.zone; return; }
  pendingZone = null;
  zoneSeenAt = now;
  currentZone = z.zone;
  // Смена зоны ребра больше НЕ создаёт. Раньше отсюда рождалось «пассивное» ребро —
  // вывод «был там, теперь тут, значит есть проход». Вывод верен, только если ни одной
  // зоны между ними мы не пропустили, а пропустить их проще простого: свёрнутая игра,
  // экран загрузки, смерть с воскрешением, выход из Туманов. Портал попадает в карту
  // только с прочитанного тултипа.
  store.setPlayerZone(config.nick, z.zone);
  pollStable = 0; // зона сменилась — снова опрашиваем часто
  send('zone-changed', { zone: z });
  flushParked(z.zone);
}

// Зона стала известна — записываем порталы, которые ждали её. Именно здесь чинится
// случай «прошёл A → B, проверил портал в C»: пока плашка не прочиталась, портал лежал
// в стороне, а лёг он уже к B, а не к A.
function flushParked(zone) {
  if (!parking.size()) return;
  const { ready, lost } = parking.take();
  for (const tip of ready) {
    const edge = saveEdge(zone, tip, tip.__manual ? 'manual' : 'ocr');
    send('edge-added', { from: zone, tip, edge, manual: !!tip.__manual });
    console.log(`[зона] отложенный портал записан: ${zone} → ${tip.name}`);
  }
  if (ready.length) {
    send('toast', {
      text: ready.length === 1
        ? `Зона распознана: портал ${zone} → ${ready[0].name} записан`
        : `Зона распознана: записано порталов — ${ready.length}`,
    });
    send('map-updated', store.snapshot());
  }
  reportLost(lost);
}
function reportLost(lost) {
  for (const tip of lost) {
    console.warn(`[зона] портал в ${tip.name} не записан: зону так и не удалось прочитать вовремя`);
    send('toast', { text: `Портал в ${tip.name} не записан — не понял, откуда он. Нажми хоткей ещё раз` });
  }
}

// Куда попадает найденный портал — решают независимые переключатели. Своя карта пишется
// сразу (файл на диске), карта друзей и общая — через очередь: сеть игру ждать не должна.
// Ничего не отмечено — портал только показывается в плашке и нигде не сохраняется.
function saveEdge(from, tip, source) {
  // Ребро принадлежит СРАЗУ всем картам, куда его отправляют, а не только своей.
  // Без этого канал комнаты показывал одни чужие порталы: наши лежали с пометкой
  // «личная» и в комнате не показывались вовсе.
  // Общую карту в список кладём только при известном времени закрытия — туда портал
  // без таймера не принимается ни клиентом, ни сервером, и обещать обратное нельзя.
  const hasTime = tip.closes != null;
  const maps = (config.saveLocal ? ['local'] : []).concat(
    (net.status().targets || []).filter(t => hasTime || t !== sync.PUBLIC_MAP_ID));
  const edge = config.saveLocal ? store.addEdge(from, tip, config.nick, source, maps) : null;
  // локальная запись выключена — собираем то же ребро на лету, иначе выгружать нечего
  net.push(edge || {
    a: from, b: tip.name,
    capMax: tip.capMaxKnown ? tip.capMax : null, capMaxKnown: !!tip.capMaxKnown,
    expiresAt: tip.closes != null ? Date.now() + tip.closes * 1000 : null,
    source, by: config.nick,
  });
  return edge;
}

// Что делать с зоной за порталом — одинаково и для прочитанного тултипа, и для
// выбранной руками зоны (окно поиска, когда снимок у курсора выключен).
// Ребро появляется, только если известно, ОТКУДА портал; оверлей — всегда:
// игрок нажал хоткей и должен увидеть ответ, даже если своя зона неизвестна.
function applyTip(tip, { copy = true, manual = false, zoneNow = null, zoneTried = false } = {}) {
  // Портал ведёт в мир (синяя/жёлтая/красная/чёрная зона или город) — кладём имя в буфер:
  // игрок вставляет его в поиск по карте игры, чтобы понять, куда его вынесет.
  // Только для НЕ-авалонских зон, чтобы не затирать буфер зря.
  let copied = null;
  if (copy && config.copyWorldZone && tip.color && tip.color !== 'avalon') {
    try { clipboard.writeText(tip.name); copied = tip.name; }
    catch (err) { console.warn('[буфер] не удалось скопировать:', err.message); }
  }
  // Откуда портал — решает lib/origin.js. Не уверены — откладываем, а не пишем наугад:
  // молчаливое «привяжу к последней известной зоне» уже приводило к рёбрам мимо карты.
  const d = origin.decide({
    zoneNow, zoneTried, currentZone, seenAt: zoneSeenAt, watching: config.zoneWatch,
  });
  if (d.park) {
    tip.__manual = manual;
    // Стоянка мала (4 места): пятый портал вытесняет первый. Об этом надо сказать —
    // тому порталу уже пообещали запись, и молча забрать обещание нельзя.
    reportLost(parking.park(tip).dropped);
    console.log(`[зона] портал в ${tip.name} отложен: ${d.why}`);
    showOverlay({ tip, from: null, copied, manual, waiting: true });
    send('toast', { text: `Не понял, где ты (${d.why}) — портал запишу, как только пойму` });
    kickPoll();      // не ждём очередного тика: плашку надо прочитать сейчас
    return;
  }
  // Ждать нечего и начала нет: слежение выключено, а свою зону игрок ещё не назвал.
  // Ребро без начала в карту не пишем — но зону за порталом показываем: игрок нажал
  // хоткей ради неё. И говорим, что именно сделать, чтобы портал записался.
  if (d.ask) {
    console.log(`[зона] портал в ${tip.name} не записан: ${d.why}`);
    showOverlay({ tip, from: null, copied, manual, noOrigin: true });
    send('toast', { text: 'Портал не записан: сначала укажи свою зону — Ctrl+Enter в окне поиска' });
    return;
  }
  const edge = saveEdge(d.origin, tip, manual ? 'manual' : 'ocr');
  send('edge-added', { from: d.origin, tip, edge, manual });
  showOverlay({ tip, from: d.origin, copied, manual }); // игрок видит ответ, не сворачивая игру
}

// Внеочередной опрос плашки: используется, когда портал ждёт свою зону.
function kickPoll() {
  if (!config.zoneWatch || quitting) return;
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
  send('toast', { text: 'Распознаю…' });
  showBusy();   // плашка поверх игры отзывается сразу, ещё до захвата кадра
  // два снимка вместо одного большого: квадрат у курсора и полоска с плашкой зоны в углу.
  // Оба берутся ЗДЕСЬ, до всякого распознавания, — то есть относятся к одному мгновению
  // нажатия. Квадрат сразу широкий: доснять его потом, по результату распознавания,
  // нельзя — курсор к тому времени уже уедет.
  let tip, zone = null, tipBox = true;
  try {
    tip = captureTooltipArea(TIP_BOX_WIDE);
    if (!tip) {
      tipBox = false;
      // GDI недоступен — снимаем экран целиком запасным путём, тултип найдётся поиском по кадру
      const full = await captureFull();
      const g = cursorOnScreen();
      tip = {
        frame: full.frame, ms: full.ms, screenHeight: full.frame.height,
        scale: full.frame.height / 1080,
        cursor: { x: g.point.x - g.geom.originX, y: g.point.y - g.geom.originY },
      };
    }
    if (config.zoneWatch) zone = await captureZoneStrip();
  } catch (err) {
    console.error('[hotkey] захват не удался:', err.message);
    // Плашку надо погасить здесь же. Иначе «Распознаю…» крутится до страховочного
    // таймера — двенадцать секунд поверх игры, — и игрок жмёт хоткей ещё раз,
    // хотя ответ уже есть. Так же поступает и обработка пустого кадра выше.
    // (err && err.message) — не педантизм: этот текст теперь виден на экране поверх игры,
    // и на не-Error исключении игрок прочитал бы «Не удалось снять кадр: undefined»
    const text = 'Не удалось снять кадр: ' + ((err && err.message) || err);
    send('toast', { text });
    showOverlay({ error: text });
    return;
  }
  saveShots({ cursor: tip.frame, zone: zone && zone.frame }); // без await — очередь ждать не должна
  const st = frameStats(tip.frame);
  if (st.blank) {
    console.log(`[hotkey] capture ${tip.ms}мс → кадр отброшен как пустой`);
    warnBlank('hotkey', st);
    return;
  }
  await enqueue({
    kind: 'hotkey', frame: tip.frame, withTooltip: true, withZone: !!zone, tipBox, cursor: tip.cursor,
    zoneFrame: zone && zone.frame, strip: zone ? zone.strip : false, screenHeight: tip.screenHeight,
    captureMs: tip.ms + (zone ? zone.ms : 0), checkMs: st.ms,
  });
}

// Хоткей без снимка курсора: окно поиска + фоновое уточнение текущей зоны.
async function runHotkeySearch() {
  openSearch();
  if (!config.zoneWatch) return;
  try {
    const zone = await captureZoneStrip();
    saveShots({ zone: zone.frame });
    const st = frameStats(zone.frame);
    if (st.blank) return;
    await enqueue({
      kind: 'zone', frame: zone.frame, withTooltip: false,
      strip: zone.strip, screenHeight: zone.screenHeight, captureMs: zone.ms, checkMs: st.ms,
    });
  } catch (err) {
    console.warn('[hotkey] плашку зоны прочитать не вышло:', err.message);
  }
}

// ---------- фоновый опрос: setTimeout-цепочка, тики не накладываются ----------
// Пока игра не запущена, опрашиваем только список процессов (~100 мс раз в 10 с)
// вместо захвата экрана с OCR. Состояние показываем в панели, чтобы не гадать.
const GAME_CHECK_MS = 10000;
let gameSeen = null, gameCheckedAt = 0, lastFullCheckAt = 0;
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
    console.log(`[игра] ${gameSeen ? 'запущена — включаю опрос экрана' : 'не запущена — опрос приостановлен'}`);
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
  if (!config.zoneWatch || quitting) return;
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
    if (!config.zoneWatch) { next = null; return; }
    // в работе хоткей — опрос пропускаем и пробуем скоро снова
    if (hotkeyPending() || captureInFlight > 0) { next = 300; return; }
    // Игра не запущена — снимать нечего: без этой проверки приложение исправно
    // фотографирует и распознаёт рабочий стол, а это ~2 с работы на каждый тик.
    // AVALON_POLL_ALWAYS=1 — не ждать игру (замеры и отладка пайплайна без Albion)
    if (!process.env.AVALON_POLL_ALWAYS && !await gameRunning()) { next = GAME_CHECK_MS; return; }
    // берём только полоску с плашкой зоны — весь экран для опроса не нужен
    const cap = await captureZoneStrip();
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
      send('toast', { text: 'Плашка зоны не читается уже три минуты. Настройки → «Слежение за экраном» → «Выбрать мышью»' });
      console.warn('[зона] плашка не читается три минуты — область, скорее всего, не совпадает');
    }
    pollStable++;
    next = nextPollDelay();
  } catch (err) {
    // игра свёрнута/экран занят — тостами не спамим, только лог
    console.warn('[poll] ' + (err?.message || err));
  } finally {
    polling = false;
    if (!quitting && next != null) pollTimer = setTimeout(runPoll, next);
  }
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
  if (!r || typeof r[method] !== 'function') return noRoute('роутер ещё не собран');
  let out;
  try {
    out = r[method].apply(r, args);
  } catch (err) {
    console.error(`[router] ${method}:`, err);
    return noRoute('ошибка роутера: ' + err.message);
  }
  if (out && typeof out.then === 'function') {
    return out.then(v => v || noRoute('роутер не вернул результат'))
      .catch(err => { console.error(`[router] ${method}:`, err); return noRoute('ошибка роутера: ' + err.message); });
  }
  return out || noRoute('роутер не вернул результат');
}

// ---------- IPC ----------
ipcMain.handle('find-route', (e, from, to) => runRouter('findRoute', [store.snapshot(), from, to, { now: Date.now() }]));
ipcMain.handle('find-nearest-exit', (e, from) => runRouter('findNearestExit', [store.snapshot(), from, { now: Date.now() }]));
// все известные имена зон для автодополнения: Авалон (zones.json) + королевство (royal-zones.json)
ipcMain.handle('get-zone-names', () => [...recognize.ZONE_INFO.entries()].map(([name, i]) => ({ name, color: i.color || null })));

// симуляция из файла — тестирование без игры (меню разработчика в UI).
// Идёт через ту же очередь: два параллельных OCR испортили бы параметры воркера.
// Читать можно ТОЛЬКО то, что игрок сам выбрал в системном диалоге: путь приходит из
// рендерера, и без белого списка это было чтение любого доступного файла с отдачей
// результата обратно в UI (и синхронное — оно вешало и хук, и опрос).
const allowedSimFiles = new Set();
ipcMain.handle('simulate-file', async (e, filePath, withTooltip) => {
  if (!allowedSimFiles.has(path.resolve(String(filePath || '')))) {
    return { error: 'файл не выбран в диалоге — открой «Файл → зона + тултип»' };
  }
  try {
    const buf = await fs.promises.readFile(filePath);
    return await enqueue({ kind: 'sim', frame: buf, withTooltip: !!withTooltip });
  } catch (err) {
    console.error('[sim] не прочитал файл:', err.message);
    return { error: 'не удалось прочитать файл: ' + err.message };
  }
});
ipcMain.handle('get-map', () => store.snapshot());
// dev включает блок «Симуляция»: он подсовывает распознавателю картинку с диска вместо
// экрана игры. Нужен разработке, игроку не говорит ничего, кроме «что это?».
// Проверки !isPackaged мало: приложение запускают и из исходников — через .bat, — и там
// блок оказался бы ровно там же, где играют. Поэтому нужен ЯВНЫЙ AVALON_DEV=1.
const DEV = !app.isPackaged && process.env.AVALON_DEV === '1';
ipcMain.handle('get-config', () => configForWindow());

// ---------- настройки ----------
// Значения приходят из рендерера, поэтому берём только известные ключи и приводим
// их к типу: overlayScale уходит прямиком в размеры окна, а zoneWatch — в цикл опроса.
const OPTIONS = {
  overlayEnabled: 'bool', overlayMap: 'bool', zoneWatch: 'bool',
  cursorScan: 'bool', saveShots: 'bool', copyWorldZone: 'bool',
  saveLocal: 'bool', uploadPublic: 'bool',
  overlayScale: 'scale', overlayHoldSec: 'sec',
  theme: 'theme',
};
ipcMain.handle('set-option', (e, key, value) => {
  const type = OPTIONS[key];
  if (!type) { console.warn('[настройки] неизвестный ключ:', key); return configForWindow(); }
  if (type === 'bool') config[key] = !!value;
  else if (type === 'theme') {
    if (!THEMES.includes(value)) return configForWindow();   // чужое значение молча не принимаем
    config[key] = value;
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
  if (!slider) console.log('[настройки]', key, '=', config[key]);

  if (key === 'zoneWatch') {
    if (config.zoneWatch) restartPoll();
    else {
      clearTimeout(pollTimer); pollTimer = null;
      currentZone = null; pendingZone = null;   // честно: где персонаж, мы больше не знаем
    }
  }
  if (key === 'overlayEnabled' && !config.overlayEnabled) {
    endOverlaySetup(true);
    if (overlay && !overlay.isDestroyed()) overlay.hide();
  }
  if (key === 'overlayScale' || key === 'overlayMap') {
    if (overlaySetup) sendSetupFrame(); else placeOverlay();
  }
  if (key === 'uploadPublic') applySync();
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

ipcMain.handle('room-create', async (e, title) => {
  try {
    const name = String(title || '').slice(0, 60);
    const id = await net.createGroup(name);
    upsertRoom(id, name || 'Моя комната', true);
    // Создатель — хранитель своей карты. Проставляем сразу, не дожидаясь rooms-sync:
    // иначе пункт «Настройки ролей» не появился бы до следующего запуска.
    const mine = config.rooms.find(r => r.id === id);
    if (mine) { mine.role = 'admin'; mine.isOwner = true; mine.confirmRequired = 0; saveConfig(); }
    return roomsReply({ id });
  } catch (err) {
    console.error('[комнаты] не создалась:', err.message);
    return { ok: false, error: err.message, status: net.status() };
  }
});

ipcMain.handle('room-join', async (e, code, title) => {
  const id = String(code || '').trim();
  if (!sync.UUID_RE.test(id)) return { ok: false, error: 'это не похоже на код комнаты' };
  try {
    const r = await net.joinGroup(id, String(title || '').slice(0, 60));
    upsertRoom(r.id, r.title || String(title || '').slice(0, 60) || 'Комната', true);
    // Новичок входит наблюдателем — так решает сервер. Пишем это и себе, чтобы окно
    // сразу сказало правду: иначе игрок ждал бы, что его порталы уходят, а они нет.
    const mine = config.rooms.find(x => x.id === r.id);
    if (mine && mine.role == null) { mine.role = 'viewer'; mine.isOwner = false; saveConfig(); }
    net.myMaps().then(list => {
      const m = list.find(x => x.id === r.id);
      if (!m || !mine) return;
      mine.role = m.role; mine.isOwner = m.isOwner; mine.confirmRequired = m.confirmRequired;
      saveConfig();
      send('rooms-changed', config.rooms);
    }).catch(() => {});
    net.tick().catch(() => {});      // сразу подтягиваем, что там уже есть
    return roomsReply({ id: r.id });
  } catch (err) {
    console.error('[комнаты] вход не удался:', err.message);
    return { ok: false, error: err.message, status: net.status() };
  }
});

ipcMain.handle('room-leave', async (e, code) => {
  const id = String(code || '').trim();
  try { await net.leaveGroup(id); } catch (err) { console.warn('[комнаты] сервер не убрал членство:', err.message); }
  config.rooms = config.rooms.filter(r => r.id !== id);
  // Рёбра этой комнаты в карте больше не нужны: смотреть их в списке каналов негде,
  // а в общей куче они выдавали бы себя за знание, которого у нас уже нет.
  const gone = Object.values(store.state.edges).filter(x => x.scope === id);
  for (const x of gone) store.removeEdge(x.a, x.b);
  saveConfig();
  applySync();
  send('rooms-changed', config.rooms);
  send('map-updated', store.snapshot());
  if (gone.length) console.log(`[комнаты] вышли из ${id}, убрано её рёбер: ${gone.length}`);
  return roomsReply();
});

ipcMain.handle('room-upload', (e, code, on) => {
  const r = config.rooms.find(x => x.id === String(code || ''));
  if (!r) return { ok: false, error: 'нет такой комнаты' };
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
    for (const m of mine) {
      if (m.kind !== 'group') continue;
      const known = config.rooms.find(r => r.id === m.id);
      // Роль и порог держим в настройках рядом с комнатой: по ним окно решает, показывать
      // ли «Настройки ролей» и можно ли вообще писать в эту карту, ещё до похода в сеть.
      if (known) {
        if (m.title) known.title = m.title;
        known.role = m.role; known.isOwner = m.isOwner; known.confirmRequired = m.confirmRequired;
      } else {
        config.rooms.push({ id: m.id, title: m.title || 'Комната', upload: false,
          role: m.role, isOwner: m.isOwner, confirmRequired: m.confirmRequired });
      }
    }
    saveConfig();
    applySync();
    send('rooms-changed', config.rooms);
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
    const st = await auth.signIn();
    await auth.ensureProfile();
    // Ник берём из Discord: по нему приложение отличает свои порталы от чужих,
    // и придумывать второе имя человеку незачем.
    const nick = auth.status().nick;
    if (nick && nick !== config.nick) { config.nick = nick; saveConfig(); pushConfig(); }
    applySync();
    net.tick().catch(() => {});   // накопленное за время без входа уходит сразу
    send('auth-changed', auth.status());
    return Object.assign({ ok: true }, st);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('auth-sign-out', () => {
  const st = auth.signOut();
  applySync();
  send('auth-changed', st);
  return st;
});

ipcMain.handle('sync-status', () => Object.assign(net.status(), { auth: auth.status() }));
// «Синхронизировать сейчас» — не ждать очередного тика
ipcMain.handle('sync-now', async () => {
  await net.tick();
  return net.status();
});
// Постоянный вход в окно поиска — кнопкой из панели.
// Раньше окно открывалось ТОЛЬКО по хоткею и только при выключенном снимке у курсора.
// В настройке «слежение выключено + снимок у курсора включён» назвать свою зону было
// нечем вовсе, а без неё портал не к чему привязать. Вход не должен зависеть от
// состояния: зону меняют и потом — прошёл портал, надо сказать, где теперь.
ipcMain.handle('open-search', () => { openSearch(); return { ok: true }; });

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
      console.log(`[карта] с сервера удалено рёбер: ${n} (${a} ⇄ ${b})`);
    } catch (err) {
      console.warn('[карта] сервер удалять не дал:', err.message);
      return { ok: false, error: err.message, snapshot: store.snapshot() };
    }
  }
  store.removeEdge(a, b);
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
  if (picker && !picker.isDestroyed()) { picker.focus(); return { ok: false, error: 'окно уже открыто' }; }
  // Своё окно ПРЯЧЕМ перед снимком. Пока оно в фокусе, игра в безрамочном полноэкранном
  // режиме перестаёт быть активной, и Windows выкатывает панель задач поверх неё — ровно
  // на низ экрана, где и живёт плашка зоны. Игрок потом обводил то, что наполовину
  // закрыто панелью. Спрятались — фокус вернулся игре, панель ушла, ждём перерисовки.
  const wasVisible = !!(win && !win.isDestroyed() && win.isVisible());
  if (wasVisible) win.hide();
  await new Promise(r => setTimeout(r, 600));
  let frame;
  try {
    frame = (await captureFull()).frame;
  } catch (err) {
    if (wasVisible && win && !win.isDestroyed()) win.show();
    return { ok: false, error: 'не удалось снять экран: ' + err.message };
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
    console.warn('[область] отклонена некорректная область:', JSON.stringify(region));
    return { ok: false, error: 'область вне экрана' };
  }

  config.zoneBarRegion = region === 'default' ? null : region;
  saveConfig();
  stripLogged = false;         // в лог уйдёт новая геометрия
  pollStable = 0;              // и опрос вернётся к частому темпу
  console.log('[область] плашка зоны:', config.zoneBarRegion || 'стандартная (правый нижний угол)');

  // сразу проверяем выбранное: снимаем и распознаём, чтобы игрок увидел результат, а не гадал
  try {
    const cap = await captureZoneStrip();
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
// Окно поиска встаёт ТУДА ЖЕ, где появляется плашка с картой зоны, — низ к низу,
// по левому краю. У курсора оно выскакивало посреди экрана и всякий раз в новом месте:
// глазу приходилось его искать, а плашку игрок уже знает где ждать.
function searchBounds() {
  const W = 340, H = 430;   // шапка + поле + эхо разбора + список + кнопки размера + подсказки
  const b = overlayBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y + b.height - 1 });
  return place.anchorTo(b, { width: W, height: H, workArea: d.workArea });
}

function openSearch() {
  if (search && !search.isDestroyed()) { search.focus(); return; }
  const g = searchBounds();
  search = new BrowserWindow({
    width: g.width, height: g.height, x: g.x, y: g.y,
    frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false, backgroundColor: '#00000000',
    webPreferences: webPrefs(path.join(__dirname, 'preload-search.js')),
  });
  search.setAlwaysOnTop(true, 'screen-saver');
  lockNavigation(search.webContents);
  search.loadFile(path.join(__dirname, 'ui', 'search.html'));
  search.webContents.once('did-finish-load', () => {
    if (!search || search.isDestroyed()) return;
    search.webContents.send('search-init', {
      zones: [...recognize.ZONE_INFO.entries()].map(([name, i]) => ({ name, color: i.color || null })),
      here: currentZone, zoneWatch: config.zoneWatch, binding: bindingLabel(),
    });
    searchOpenedAt = Date.now();
    search.show();
    search.focus();
  });
  // клик мимо окна — закрываемся: игра полноэкранная, невидимое окно поверх неё не нужно.
  // 400 мс форы: при показе Windows успевает прислать blur ещё до реального фокуса.
  search.on('blur', () => { if (Date.now() - searchOpenedAt > 400) closeSearch(); });
  search.on('closed', () => { search = null; });
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
  if (!info) { console.warn('[поиск] незнакомая зона:', name); return; }
  closeSearch();
  const zi = recognize.zoneInfo(name);
  if (payload.mode === 'here') {
    // «я сейчас здесь» — единственный способ задать точку старта, когда слежение
    // за плашкой зоны выключено; ведёт себя как обычная смена зоны
    applyZone({ zone: name, color: zi.color, tier: zi.tier, quality: zi.quality, activities: zi.activities }, true, true);
    send('toast', { text: 'Текущая зона: ' + name });
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
    return { ok: false, error: 'снимков ещё нет — включи «сохранять снимки» и нажми хоткей' };
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
    type: 'question', buttons: ['Перезапустить', 'Отмена'], defaultId: 0, cancelId: 1,
    title: 'Перезапуск от администратора',
    message: 'Перезапустить Avalon Mapper с правами администратора?',
    detail: 'Без этого горячая клавиша не работает, пока в фокусе окно игры: Albion защищён BattlEye и запущен с повышенной целостностью.',
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
  const script = [
    'Start-Sleep -Milliseconds 1200',
    `try { Start-Process -FilePath ${q(exe)} -Verb RunAs }`,
    `catch { Start-Process -FilePath ${q(exe)} }`,
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
ipcMain.handle('capture-binding', () => {
  if (!uIOhook) return bindingLabel(); // фолбэк-режим — переназначение недоступно
  // Двойной клик по «Изменить бинд» перезаписывал captureResolve, и первый промис
  // висел вечно — закрываем предыдущий ожидатель перед началом нового.
  if (captureResolve) { captureResolve(bindingLabel()); captureResolve = null; }
  return new Promise(res => { captureResolve = res; });
});

app.whenReady().then(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
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
      console.log('[карта] след игрока перенесён с', best[0], '→', config.nick);
    }
  }
  const strays = Object.keys(players).filter(n => n !== config.nick);
  for (const n of strays) delete players[n];
  if (strays.length) {
    store.save();
    console.log('[карта] удалены чужие записи игроков:', strays.join(', '));
  }
  // Миграция: выкидываем ВСЕ пассивные рёбра, записанные прежними сборками.
  // Приложение их больше не делает (см. store.setPlayerZone): это был вывод из
  // перемещений игрока, а не прочитанный портал, и врал он слишком многими способами.
  // Оставить их в карте — значит и дальше строить по ним маршруты, не отличая догадку
  // от наблюдения. Прочитанные порталы не трогаются: у них source 'ocr' или 'manual'.
  {
    const dead = Object.values(store.state.edges).filter(e => e.source === 'passive');
    for (const e of dead) store.removeEdge(e.a, e.b);
    if (dead.length) console.log(`[миграция] удалено пассивных рёбер: ${dead.length} (выводились из перемещений, а не читались)`);
  }
  // Миграция: общая карта выключена (sync.PUBLIC_MAP_ON), и её пометки надо снять с уже
  // записанных рёбер. Без этого выключение видно только на новых порталах, а старые
  // продолжают показываться ждущими подтверждений карты, которой в приложении больше нет.
  if (!sync.PUBLIC_MAP_ON) {
    const r = store.dropMap(sync.PUBLIC_MAP_ID);
    if (r.cleaned || r.removed)
      console.log(`[миграция] общая карта выключена: снята с ${r.cleaned} рёбер, удалено ${r.removed} (были известны только из неё)`);
  }
  // Рамку и заголовок рисует Windows, а не мы, и по умолчанию она берёт светлую тему
  // системы — над тёмным интерфейсом это была белая полоса. themeSource говорит Windows
  // считать приложение тёмным: заголовок и кнопки окна перекрашиваются самой системой,
  // без своей рамки и без потери привычного поведения окна.
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1280, height: 840,
    title: 'Avalon Mapper',
    // Значок окна и панели задач — тот же файл, из которого electron-builder делает иконку
    // exe и ярлыка (build/icon.png, копия лежит рядом с интерфейсом, чтобы попасть в сборку).
    // Без этого окно показывало значок самого Electron, и он не совпадал с ярлыком.
    icon: path.join(__dirname, 'ui', 'icon.png'),
    backgroundColor: '#14111a', // фон интерфейса: без него окно вспыхивает белым до отрисовки
    webPreferences: webPrefs(path.join(__dirname, 'preload.js'), {
      backgroundThrottling: false, // карта не должна замирать, когда окно за игрой
    }),
  });
  // второй запуск приложения — не плодим копию, а показываем уже открытое окно
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('toast', { text: 'Avalon Mapper уже запущен — это то самое окно' });
  });

  win.webContents.on('did-finish-load', flushOutbox);
  // скрытый оверлей — тоже окно: без явного quit закрытие главного окна не завершало бы приложение
  win.on('closed', () => {
    win = null;
    stopDrag(false);
    closeSearch();
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    app.quit();
  });
  lockNavigation(win.webContents);
  // Тему передаём СРАЗУ в адресе, а не ждём, пока окно спросит конфиг по IPC. Круг IPC
  // приходит после первой отрисовки, поэтому светлая тема открывалась вспышкой тёмного —
  // окно успевало показать себя старым оформлением и только потом перекрашивалось.
  win.loadFile(path.join(__dirname, 'ui', 'index.html'), { query: { theme: config.theme } });
  // с этого момента приложение считается поднявшимся: дальше ошибки только в журнал
  win.webContents.once('did-finish-load', () => { started = true; });
  win.setMenuBarVisibility(false);
  createOverlay();

  send('toast', { text: 'Загружаю OCR…' });
  await recognize.init();

  try {
    setupHook();
    if (!config.binding) { config.binding = { type: 'key', code: UiohookKey.F9, label: 'F9' }; saveConfig(); }
  } catch (err) {
    // хук не встал (антивирус и т.п.) — деградируем до фиксированной F9 через globalShortcut
    console.error('uiohook не запустился:', err.message);
    config.binding = { type: 'key', label: 'F9' };
    globalShortcut.register('F9', fireHotkey);
    send('toast', { text: 'Хук мыши недоступен, работает только F9' });
  }
  if (config.zoneWatch) pollTimer = setTimeout(runPoll, config.pollMs);
  else console.log('[зона] слежение за плашкой выключено настройкой');
  applySync();   // общие карты: очередь с прошлого запуска уйдёт сама
  // Профиль на сервере досоздаём при каждом запуске, если вход уже есть. Это не лишний
  // вызов: он же чинит случай «вошёл, а профиль не завёлся» — ровно так и вышло, когда
  // ensure_profile падала на неоднозначном имени столбца. Без этого профиль пришлось бы
  // добывать повторным входом, хотя аккаунт уже на руках.
  if (auth.status().signedIn) {
    auth.ensureProfile().then(p => {
      if (!p) return;
      if (p.nick && p.nick !== config.nick) { config.nick = p.nick; saveConfig(); pushConfig(); applySync(); }
      send('auth-changed', auth.status());
      console.log('[вход] профиль:', p.nick, p.trusted ? '(доверенный)' : '');
    }).catch(() => {});
  }
  // Через updateUrlOf(), а НЕ через config.updateUrl. Поле в настройках убрано вместе
  // с разделом «Подключение», и на свежей установке оно всегда пустое — значит проверка
  // обновлений не запускалась вовсе: ни часовой таймер, ни разовая проверка при старте.
  // Работала только кнопка «Открыть на GitHub», потому что она ходит через updateUrlOf().
  // То есть ровно то, ради чего заведён BUILTIN_UPDATE, молча не делалось.
  if (updateUrlOf()) updater.start();
  send('ready', { binding: bindingLabel() });

  // Права. Albion защищён BattlEye и работает с повышенной целостностью: пока фокус
  // на окне игры, Windows не доставляет события хука процессу без прав администратора —
  // хоткей молчит именно во время игры. Проверяем и подсказываем, а не гадаем.
  checkPrivileges();
});

let privWarned = false;
async function checkPrivileges() {
  const p = await privileges.checkHotkeyPrivileges();
  console.log('[права]', JSON.stringify(p));
  send('privileges', p);
  if (p.needsAdmin && !privWarned) {
    privWarned = true;
    send('toast', { text: 'Игра запущена с повышенными правами — хоткей в её окне работать не будет. Перезапусти приложение от имени администратора.' });
  }
  // игру могли запустить уже после старта приложения — проверяем и дальше, пока не предупредим
  if (!p.needsAdmin && !privWarned && !quitting) setTimeout(checkPrivileges, 60000);
}

app.on('will-quit', async () => {
  quitting = true;
  flushConfig();   // отложенная запись ползунка не должна пропасть вместе с приложением
  globalShortcut.unregisterAll();
  try { if (uIOhook) uIOhook.stop(); } catch (e) {}
  clearTimeout(pollTimer);
  stopDrag(false);
  closeSearch();
  net.stop();
  updater.stop();
  await recognize.shutdown();
});
app.on('window-all-closed', () => app.quit());
