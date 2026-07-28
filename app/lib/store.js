// Локальное хранилище карты: узлы-зоны, рёбра-порталы (с абсолютным временем истечения),
// позиции/следы игроков и журнал событий. Этап 2 заменит персистентность на Supabase.
const fs = require('fs');
const path = require('path');

// Куда писать карту, решает main-процесс (userData): каталог приложения после упаковки
// недоступен на запись. Вне Electron (тесты, симуляция) остаётся старый путь.
let DATA = path.join(__dirname, '..', 'data', 'map.json');
function setDataDir(dir) { DATA = path.join(dir, 'map.json'); }

// Журнал рос без предела и при этом переписывался целиком каждые 500 мс.
const JOURNAL_MAX = 500;

const state = {
  edges: {},   // "A|B" (пара отсортирована) → { a, b, capNum, capMax, expiresAt, updatedAt, source, by, scope }
  players: {}, // ник → { zone, updatedAt, trail: [{zone, t}] }
  journal: [], // события: { t, type: 'visit'|'edge', ... }
};

// Откуда мы знаем ребро. Своё — увидели сами, и его нельзя «понизить» чужой записью:
// свой глаз надёжнее пересказа. Дальше идут комнаты (там знаешь, кто пишет), и в самом
// низу общая карта — туда пишет кто угодно.
//
// Комнат теперь несколько, и scope у их рёбер — ИД КОМНАТЫ, а не слово «group»: иначе
// нельзя ни отфильтровать канал в списке слева, ни сказать, из какой именно комнаты
// пришёл портал. Поэтому ранг считается функцией, а не поиском в таблице.
const PUBLIC_MAP_ID = '00000000-0000-0000-0000-0000000000a0';
function scopeRank(s) {
  if (s === 'local') return 3;
  if (!s || s === PUBLIC_MAP_ID || s === 'public') return 1;
  return 2;   // всё остальное — id комнаты
}
function bestScope(a, b) { return scopeRank(a) >= scopeRank(b) ? a : b; }

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    Object.assign(state, j);
  } catch (e) { /* первого запуска файла нет — норм */ }
  prune();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    fs.writeFileSync(DATA, JSON.stringify(state, null, 1));
  }, 500);
}

function edgeKey(a, b) { return [a, b].sort().join('|'); }

// журнал держим в пределах кэпа — так же, как след игрока (200 точек)
function logEvent(ev) {
  state.journal.push(ev);
  if (state.journal.length > JOURNAL_MAX) state.journal.splice(0, state.journal.length - JOURNAL_MAX);
}

// протухшие порталы исчезают сами; рёбра без таймера живут 6 часов с последнего подтверждения
function prune(now = Date.now()) {
  for (const [k, e] of Object.entries(state.edges)) {
    const ttl = e.expiresAt ?? e.updatedAt + 6 * 3600 * 1000;
    if (ttl < now) delete state.edges[k];
  }
}

// Фиксация портала по тултипу (хоткей). source: 'ocr' — прочитали с экрана,
// 'manual' — игрок сам выбрал зону в окне поиска (снимок у курсора выключен).
// В КАКИХ КАРТАХ ЖИВЁТ РЕБРО.
//
// Портал уходит сразу в несколько мест: в свою карту, в комнату друзей, в общую. Раньше
// у ребра было одно поле scope, и оно всегда оказывалось 'local' — своё же ребро. Из-за
// этого канал комнаты показывал ТОЛЬКО чужие рёбра: свои, ушедшие туда же, лежали
// с пометкой «личная» и в комнате не показывались. Выглядело как «выгрузка не работает»
// и «у нас с друзьями разные карты», хотя на сервере всё было на месте — проверено:
// в комнате лежало 32 ребра, 28 из них наши.
//
// Поэтому у ребра теперь СПИСОК карт. scope остаётся: он отвечает на другой вопрос —
// откуда мы про портал узнали (своим глазом или из чужой карты), и по нему решается,
// чьё знание сильнее при слиянии.
function mapsOf(e) {
  if (!e) return [];
  if (Array.isArray(e.maps) && e.maps.length) return e.maps;
  return [e.scope || 'local'];   // рёбра, записанные до появления списка
}
function addMap(e, id) {
  if (!e || !id) return;
  const list = mapsOf(e);
  if (!list.includes(id)) e.maps = list.concat(id); else e.maps = list;
}

function addEdge(from, tip, by, source = 'ocr', maps = ['local']) {
  if (!from || !tip?.name || from === tip.name) return null;
  const now = Date.now();
  const k = edgeKey(from, tip.name);
  const prev = state.edges[k];
  // Размер портала (7 или 20) — свойство самого портала, оно не меняется, поэтому
  // держим его ЛИПКО: если в этот раз не прочиталось, остаётся прежнее значение.
  // Свободные слоты, наоборот, живут минуты — храним вместе с моментом замера.
  const capMax = tip.capMaxKnown ? tip.capMax : (prev?.capMax ?? null);
  const e = {
    a: from, b: tip.name,
    capNum: tip.capNum ?? null, capMax,
    capMaxKnown: !!(tip.capMaxKnown || prev?.capMaxKnown),
    capNumApprox: !!tip.capNumApprox,
    capAt: tip.capNum != null ? now : (prev?.capAt ?? null),
    expiresAt: tip.closes != null ? now + tip.closes * 1000 : prev?.expiresAt ?? null,
    updatedAt: now, source, by, scope: 'local',
    // Карты, в которых это ребро есть. Свою карту и все включённые цели выгрузки
    // складываем СРАЗУ: ждать, пока ребро вернётся с сервера, незачем — мы его туда
    // и отправили, а до возврата канал комнаты выглядел бы пустым.
    // Прежние карты не теряем: портал могли пересканировать при других настройках.
    maps: [...new Set([...mapsOf(prev), ...maps])],
  };
  state.edges[k] = e;
  logEvent({ t: now, type: 'edge', a: e.a, b: e.b, capNum: e.capNum, capMax: e.capMax, closes: tip.closes, source, by });
  save();
  return e;
}

// Смена текущей зоны: только след игрока, никаких рёбер.
//
// Раньше отсюда рождалось «пассивное ребро»: раз игрок был в A, а теперь в B, значит
// между ними есть проход. Это домысел, а не наблюдение, и он врал слишком многими
// способами — любой перерыв в чтении плашки (свёрнутая игра, экран загрузки, смерть
// с воскрешением, выход из Туманов) склеивал зону ДО перерыва с зоной ПОСЛЕ, и в карту,
// а с ней и в общую базу, уезжал портал между зонами, которые могут быть где угодно.
// Портал попадает в карту, только если его тултип прочитали. Решение принято осознанно.
function setPlayerZone(nick, zone) {
  const now = Date.now();
  const p = state.players[nick] || (state.players[nick] = { zone: null, updatedAt: 0, trail: [] });
  if (p.zone === zone) { p.updatedAt = now; return { changed: false }; }
  const from = p.zone;
  p.zone = zone; p.updatedAt = now;
  p.trail.push({ zone, t: now });
  if (p.trail.length > 200) p.trail.splice(0, p.trail.length - 200);
  logEvent({ t: now, type: 'visit', zone, by: nick });
  save();
  return { changed: true, from };
}

// ---------- чужие рёбра (общие карты) ----------
// Приходят из lib/sync.js: карта друзей или общая. Правило слияния одно —
// ЗНАНИЕ СКЛАДЫВАЕТСЯ, а не замещается: размер портала липкий (кто прочитал, тот и прав),
// время закрытия берём более позднее (OCR округляет вниз, поэтому позднее — точнее),
// а своё локальное происхождение ребра не понижается до чужого.
// Возвращает, сколько записей реально изменилось:
// по нулю интерфейс не дёргаем.
function mergeRemote(list, scope = 'group') {
  let applied = 0;
  const now = Date.now();
  for (const r of list || []) {
    if (!r || !r.a || !r.b || r.a === r.b) continue;
    // Пассивных рёбер мы больше не делаем — и чужих не принимаем. У друга может стоять
    // сборка постарше, которая их ещё шлёт; пускать чужие догадки в свою карту незачем.
    if (r.source === 'passive') continue;
    if (r.expiresAt != null && r.expiresAt < now) continue;   // уже закрылся, пока летел
    const k = edgeKey(r.a, r.b);
    const prev = state.edges[k];
    if (!prev) {
      state.edges[k] = {
        a: r.a, b: r.b, capNum: null,
        capMax: r.capMaxKnown ? r.capMax ?? null : null,
        capMaxKnown: !!r.capMaxKnown, capAt: null,
        expiresAt: r.expiresAt ?? null,
        updatedAt: r.updatedAt || now, source: r.source || 'ocr', by: r.by || null, scope,
        maps: [scope],
        // Сколько РАЗНЫХ игроков сообщило про портал и сколько нужно этой карте.
        // Своё неподтверждённое ребро сервер отдаёт всегда — иначе игрок решил бы, что
        // выгрузка не работает, — но показывать его надо иначе, чем принятое всеми.
        confirms: r.confirms ?? null, needed: r.needed ?? null,
      };
      applied++;
      continue;
    }
    const before = JSON.stringify([prev.capMax, prev.capMaxKnown, prev.expiresAt, prev.source, prev.scope, prev.confirms, mapsOf(prev).join()]);
    if (r.capMaxKnown && !prev.capMaxKnown) { prev.capMax = r.capMax ?? null; prev.capMaxKnown = true; }
    if (r.expiresAt != null && (prev.expiresAt == null || r.expiresAt > prev.expiresAt)) prev.expiresAt = r.expiresAt;
    prev.scope = bestScope(prev.scope || 'local', scope);
    // Ребро пришло из этой карты — значит оно там есть, даже если мы сами его туда и клали
    addMap(prev, scope);
    // Счётчик подтверждений берём свежий: он растёт, пока портал живёт, и это
    // единственное поле ребра, которое меняется само по себе, без новых прочтений.
    if (r.confirms != null) { prev.confirms = r.confirms; prev.needed = r.needed ?? prev.needed ?? null; }
    if (JSON.stringify([prev.capMax, prev.capMaxKnown, prev.expiresAt, prev.source, prev.scope, prev.confirms, mapsOf(prev).join()]) === before) continue;
    prev.updatedAt = Math.max(prev.updatedAt || 0, r.updatedAt || now);
    applied++;
  }
  if (applied) save();
  return applied;
}

function removeEdge(a, b) { delete state.edges[edgeKey(a, b)]; save(); }

function snapshot() {
  prune();
  return { edges: Object.values(state.edges), players: state.players, journalLen: state.journal.length };
}

module.exports = { load, save, setDataDir, addEdge, mergeRemote, setPlayerZone, removeEdge, snapshot, prune, mapsOf, state };
