var i18nText = (globalThis.AvalonI18n?.t || ((text, values) => Array.isArray(values) ? text.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index] ?? '') : match) : text));
// Живой граф порталов на Cytoscape + карточка зоны. Работает в двух режимах:
// внутри Electron (window.api) и как статическая страница с демо-данными (для правки стилей).
const COLORS = window.ZONE_COLORS; // объявлены в graph-style.js — общий источник для приложения и стенда
const ZONE_TYPE_RU = {
  avalon: i18nText("Авалон"), blue: i18nText("Синяя"), yellow: i18nText("Жёлтая"), red: i18nText("Красная"),
  black: i18nText("Чёрная"), city: i18nText("Город"), 'city-black': i18nText("Город (чёрные земли)"),
};

// Порядок и подписи активностей общие с игровым оверлеем — ui/activities.js.
// Раньше таблица дублировалась здесь по старым плоским ключам, и при смене формы
// данных карточка молча пустела.
const ACTS = window.ZONE_ACTS;

// геометрия раскладки: расстояния подобраны так, чтобы подписи зон не слипались
const LINK_LEN = 165;  // желаемая длина ребра
const MIN_DIST = 125;  // минимальное расстояние между центрами узлов
const RECENT_MS = 5 * 60e3;  // сколько новый портал светится зелёным на графе

const demo = {
  edges: [
    { a: 'Cairn Camain', b: 'Coues-Exakrom', capNum: 6, capMax: 7, expiresAt: Date.now() + 5.6 * 3600e3, source: 'ocr' },
    { a: 'Coues-Exakrom', b: 'Qiient-Qi-Odesas', capNum: 5, capMax: 7, expiresAt: Date.now() + 5.8 * 3600e3, source: 'ocr' },
    { a: 'Coues-Exakrom', b: 'Brons Hill', capNum: 6, capMax: 7, expiresAt: Date.now() + 10 * 3600e3, source: 'ocr' },
    { a: 'Qiient-Qi-Odesas', b: 'Xiros-Aiairom', capNum: 7, capMax: 7, expiresAt: Date.now() + 2.3 * 3600e3, source: 'ocr' },
    { a: 'Xiros-Aiairom', b: 'Pen Gent', capNum: null, capMax: null, expiresAt: null, source: 'ocr' },
    // зоны мира: нужны, чтобы на стенде было видно и цвет ромбов в ленте, и дорисованные
    // связи маршрута (у шага «Coues-Exakrom → Murky Fen» своего ребра в карте нет)
    { a: 'Cairn Camain', b: 'Murky Fen', capNum: 3, capMax: 7, expiresAt: Date.now() + 3 * 3600e3, source: 'ocr' },
    { a: 'Pen Gent', b: 'Sleetwater Basin', capNum: null, capMax: null, expiresAt: null, source: 'ocr' },
  ],
  players: { me: { zone: 'Qiient-Qi-Odesas', trail: [] } },
};
const demoColors = {
  'Cairn Camain': 'yellow', 'Coues-Exakrom': 'avalon', 'Qiient-Qi-Odesas': 'avalon',
  'Brons Hill': 'yellow', 'Xiros-Aiairom': 'avalon', 'Pen Gent': 'blue',
  'Murky Fen': 'yellow', 'Drownhorse Basin': 'red', 'Windripple Fen': 'red', 'Sleetwater Basin': 'black',
};
// демо-данные для запуска вне Electron; форма — как в data-static/zone-data.json
// resTier и type задаём наравне с прочим: без них стенд оформления показывал бы
// карточку без тира ресурсов и без слоя дороги, то есть не то, что видит игрок.
const demoAct = (chests, dungeons, res, brecilien, extra) => Object.assign({
  chests: Object.assign({ green: 0, blueSmall: 0, blueBig: 0, goldSmall: 0, goldBig: 0 }, chests),
  dungeons: Object.assign({ solo: 0, group: 0, elite: 0, factions: [] }, dungeons),
  resNodes: res,
  brecilien: brecilien || 0,
}, extra || {});
const demoActs = {
  'Coues-Exakrom': demoAct({ green: 3, goldSmall: 1 }, { solo: 1, factions: ['KPR'] }, [{ main: 'rock', sub: 'wood', big: false, tier: 7 }, { main: 'ore', sub: 'rock', big: true, tier: 7 }], 0, { type: 'L1 Outer', resTier: 7 }),
  'Qiient-Qi-Odesas': demoAct({ green: 8, blueBig: 2 }, { group: 1, factions: ['MOR'] }, [{ main: 'hide', sub: 'ore', big: true, tier: 7 }, { main: 'wood', sub: 'fiber', big: false, tier: 7 }, { main: 'wood', sub: 'fiber', big: false, tier: 7 }], 0, { type: 'L2 Rest', resTier: 7 }),
  'Xiros-Aiairom': demoAct({ green: 1, blueBig: 1, goldBig: 1 }, { solo: 1, group: 1, factions: ['UND', 'HER'] }, [{ main: 'fiber', sub: 'hide', big: false, tier: 8 }, { main: 'ore', sub: 'rock', big: true, tier: 8 }], 1, { type: 'L3 Hub', resTier: 8 }),
};

// ВАЖНО: contextBridge создаёт неконфигурируемое глобальное свойство `api`,
// поэтому локальную переменную зовём иначе — `const api = …` здесь падает с SyntaxError
const ipc = window.api || null;
let zoneColorCache = {}; // имя зоны → цвет; в Electron прилетает вместе с событиями
let zoneInfoCache = {};  // имя зоны → { name, color, tier, activities }

const cy = cytoscape({
  container: document.getElementById('cy'),
  // Колесо. Было 0,2 → стало 0,6 → всё равно долго, и вот почему: 0,6 ЛЕГЧЕ умолчания
  // cytoscape (1), то есть «ускорение втрое» так и не догнало обычную прокрутку.
  // Замер щелчками до удвоения масштаба: 0,6 → около 25 щелчков, 2 → 8, 4 → 5.
  // Берём 4. Выше делать не стоит: шаг становится скачком, и попасть в нужный масштаб
  // труднее, чем докрутить.
  wheelSensitivity: 4,
  // Пределы масштаба. Без них колесо уводит граф либо в точку, либо в один узел во весь
  // экран, и вернуться можно только кнопкой «Вписать» — а до неё ещё надо догадаться.
  // 0.12 — сотня зон целиком помещается в окно; 2.5 — подпись узла крупнее уже некуда.
  minZoom: 0.12,
  maxZoom: 2.5,
  style: window.GRAPH_STYLE,
});

function fmtLeft(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return i18nText("{0}ч {1}м", [h, String(m).padStart(2, '0')]);
  if (m > 0) return i18nText("{0}м", [m]);
  return i18nText("{0}с", [s]);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- модель графа ----------
function edgeKeyOf(a, b) { return [a, b].slice().sort().join('|'); }

// подписи/флаги ребра пересчитываются от текущего времени — это единственное, что «тикает»
function edgeLabelData(e, now) {
  const left = e.expiresAt ? e.expiresAt - now : null;
  // На ребре показываем РАЗМЕР портала: он не меняется, в отличие от свободных мест.
  const cap = e.capMax != null ? i18nText("на {0}", [e.capMax]) : '';
  return {
    label: [cap, fmtLeft(left)].filter(Boolean).join(' · '),
    soon: left != null && left < 30 * 60e3,
    // откуда мы это знаем: свой глаз, карта друзей или общая (lib/store.js → scope)
    scope: e.scope || 'local', by: e.by || null, maps: edgeMaps(e),
    firstSeenByMap: e.firstSeenByMap || null, authorByMap: e.authorByMap || null,
    // Подтверждения — ПО КАЖДОЙ КАРТЕ отдельно: одно ребро живёт сразу в нескольких,
    // а порог у них разный. Что показать — решает уже панель, глядя на выбранный канал.
    conf: e.conf || null,
    // Кто сообщил про портал, тоже по картам: { код карты: [ники] }, первый внёс.
    who: e.who || null,
    // Только что появившийся портал — зелёный первые RECENT_MS. Считается от createdAt,
    // а не от updatedAt: тот обновляется при каждом подтверждении, и перепроверенный
    // старый портал вспыхивал бы как новый. Флаг живёт в ДАННЫХ, а не в классе, поэтому
    // переживает перерисовку и переключение канала и гаснет сам — тик обновляет подписи
    // раз в пять секунд и заодно снимает этот флаг.
    recent: (e.createdAt ?? e.updatedAt ?? 0) + RECENT_MS > now,
  };
}
// складываем имена по всем, сохраняя порядок первого появления: внёсший должен остаться
// первым, а повторы (один человек в двух картах) — схлопнуться, иначе выйдет
// «подтвердили Вася, Вася».
function whoOf(d, mapId) {
  const who = d && d.who;
  if (!who) return [];
  const ids = mapId && mapId !== 'all' ? [mapId] : Object.keys(who);
  const out = [];
  for (const id of ids) for (const n of who[id] || []) if (n && !out.includes(n)) out.push(n);
  return out;
}
// mapId нет — тогда отвечаем по любой карте, где ждёт: именно там его пока не видят.
function pendingFor(d, mapId) {
  const conf = d && d.conf;
  if (!conf) return null;
  const ids = mapId && mapId !== 'all' ? [mapId] : Object.keys(conf);
  for (const id of ids) {
    const c = conf[id];
    if (c && c.needed > 0 && c.confirms < c.needed) return Object.assign({ map: id }, c);
  }
  return null;
}

function nodeDataFor(name, here) {
  const color = zoneColorCache[name] || demoColors[name] || 'avalon';
  // Тир пишем ПРЯМО НА УЗЛЕ. Подпись под узлом занята именем зоны, а второй подписи
  // у cytoscape нет вовсе — поэтому число приходит картинкой (см. tierBadge в
  // graph-style.js). Тира может не быть: у зон мира его нет, пока карточку не открыли.
  const info = zoneInfoCache[name];
  const tier = info && info.tier ? Number(info.tier) : null;
  return {
    id: name, label: name, color: COLORS[color] || '#64748b',
    isAvalon: color === 'avalon', here: !!here,
    // золотая цифра — только T8 Авалона (см. graph-style.js): у зон мира T8 не редкость
    tier, tierIcon: tier ? window.tierBadge(tier, color === 'avalon' && tier === 8) : undefined,
  };
}

function buildModel(snap) {
  const now = Date.now();
  const here = new Set(Object.values(snap.players || {}).map(p => p && p.zone).filter(Boolean));
  const nodes = new Map();
  const addNode = n => { if (n && !nodes.has(n)) nodes.set(n, nodeDataFor(n, here.has(n))); };
  // Узлы — ТОЛЬКО концы рёбер. Раньше сюда добавлялась ещё и зона каждой записи игрока,
  // и в графе висели одинокие ромбы без единой связи: своя зона, если в ней порталов не
  // записано (город, например), плюс чужие записи — старый ник или следы test/simulate.js.
  // Где игрок сейчас, сказано в панели слева; граф — про порталы.
  // Отбор по каналу делается ЗДЕСЬ, до узлов: иначе в графе остались бы зоны от рёбер,
  // которых в этом канале нет, — те самые одинокие ромбы, что уже приходилось убирать.
  const visible = (snap.edges || []).filter(e => e.a && e.b && edgeInView(e));
  for (const e of visible) { addNode(e.a); addNode(e.b); }

  const edges = new Map();
  for (const e of visible) {
    const id = edgeKeyOf(e.a, e.b);
    edges.set(id, Object.assign({ id, source: e.a, target: e.b, a: e.a, b: e.b }, edgeLabelData(e, now)));
  }
  return { nodes, edges };
}

// ---------- раскладка ----------
// Мягкая релаксация позиций: двигаются ТОЛЬКО узлы из freeIds, остальные железно стоят.
// useSprings=false — чистое расталкивание (постобработка после cose).
function relaxPositions(freeIds, iters, useSprings) {
  const all = cy.nodes();
  if (all.length < 2 || !freeIds || !freeIds.size) return;
  // ПОРЯДОК ОБХОДА КАНОНИЧЕСКИЙ, и это не педантизм. Силы копятся сложением чисел
  // с плавающей точкой, а оно не коммутативно: тот же граф, обойденный в другом
  // порядке, даёт другие координаты. cy.nodes() и cy.edges() отдают элементы в порядке
  // ДОБАВЛЕНИЯ, а он у игроков разный — кто что раньше отсканировал и что раньше
  // принесла синхронизация. Из-за этого расходились и подсадка новых узлов, и хвост
  // полной раскладки (cose честно сортирует элементы сам, а это доведение — нет).
  const byName = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const P = [];
  const idx = new Map();
  all.sort((p, q) => byName(p.id(), q.id()))
    .forEach(n => { idx.set(n.id(), P.length); P.push({ n, x: n.position('x'), y: n.position('y'), free: freeIds.has(n.id()) }); });
  const freeIdx = [];
  P.forEach((p, i) => { if (p.free) freeIdx.push(i); });
  if (!freeIdx.length) return;

  const links = [];
  if (useSprings) {
    // Пара зон сортируется: портал ненаправленный, и «A→B» у одного игрока и «B→A»
    // у другого — одно и то же ребро (та же логика, что в graph-layout.js seedFrom).
    const key = e => [e.data('source'), e.data('target')].sort().join('|');
    cy.edges().sort((p, q) => byName(key(p), key(q))).forEach(e => {
      const i = idx.get(e.data('source')), j = idx.get(e.data('target'));
      if (i != null && j != null && (P[i].free || P[j].free)) links.push([i, j]);
    });
  }

  // Бюджет итераций: работа за итерацию ~ freeIdx.length * P.length.
  // Потолок работы разный. Досыпка новых узлов идёт в ответ на портал, там важно не
  // подвесить интерфейс. А «Пересобрать» — осознанное нажатие раз в сеанс, и там дороже
  // недоработать: со старым общим потолком на 400 зонах выходило 25 итераций вместо 160,
  // расталкивание не успевало развести узлы, и они оставались друг на друге.
  const work = useSprings ? 2e6 : 4e7;
  const budget = Math.min(iters, Math.max(25, Math.round(work / (freeIdx.length * P.length))));
  for (let it = 0; it < budget; it++) {
    let shift = 0;   // насколько сдвинулись за эту итерацию — по нему выходим досрочно
    for (let li = 0; li < links.length; li++) {
      const a = P[links[li][0]], b = P[links[li][1]];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const k = ((d - LINK_LEN) / d) * 0.08;
      const mx = dx * k, my = dy * k;
      if (a.free) { a.x += mx; a.y += my; }
      if (b.free) { b.x -= mx; b.y -= my; }
    }
    // расталкивание: перебираем только пары, где есть хотя бы один свободный узел
    for (let fi = 0; fi < freeIdx.length; fi++) {
      const i = freeIdx[fi], a = P[i];
      for (let j = 0; j < P.length; j++) {
        if (j === i) continue;
        const b = P[j];
        if (b.free && j < i) continue; // пару free-free обрабатываем один раз
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d > MIN_DIST) continue;
        if (d < 0.01) { dx = Math.cos(i * 2.399) * 0.5; dy = Math.sin(i * 2.399) * 0.5; d = 0.5; }
        const push = ((MIN_DIST - d) / d) * 0.5;
        const mx = dx * push, my = dy * push;
        shift += Math.abs(mx) + Math.abs(my);
        if (b.free) { a.x -= mx; a.y -= my; b.x += mx; b.y += my; }
        else { a.x -= mx * 2; a.y -= my * 2; }
      }
    }
    // Узлы разошлись — дальше крутить нечего. Без этого на «Пересобрать» тратилась
    // вся квота даже тогда, когда всё разъехалось на десятой итерации.
    if (!useSprings && shift < 0.5) break;
  }
  cy.batch(() => {
    for (const i of freeIdx) {
      const p = P[i];
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { p.x = 0; p.y = 0; }
      p.n.position({ x: p.x, y: p.y });
    }
  });
}

// ---------- показать только что появившийся портал ----------
// Раньше новое ребро просто возникало где-то в графе, и найти его можно было лишь по
// названию — при живой игре это несколько секунд возни на каждый портал. Теперь свежее
// ребро подсвечивается, а камера подводится к нему, если его не видно.
const REVEAL_MS = 4500;      // сколько держится подсветка
const REVEAL_STALE_MS = 15000;  // дольше — портал уже не «только что», не дёргаем вид
let pendingReveal = null, revealTimer = null;

function revealEdge(a, b) {
  const nb = b ? cy.$id(b) : cy.collection();
  if (!b || nb.empty()) return false;
  const na = a ? cy.$id(a) : cy.collection();
  // начало неизвестно (слежение выключено) — показываем хотя бы саму зону
  const eles = na.empty() ? nb : na.union(nb).union(na.edgesWith(nb));
  clearTimeout(revealTimer);
  cy.elements('.fresh').removeClass('fresh');
  eles.addClass('fresh');
  revealTimer = setTimeout(() => cy.elements('.fresh').removeClass('fresh'), REVEAL_MS);

  // Камеру двигаем, ТОЛЬКО если ребра не видно. Дёргать вид, который игрок выставил сам,
  // когда всё и так на экране, — хуже, чем не двигать вовсе.
  const bb = eles.boundingBox();
  const ext = cy.extent();
  const visible = bb.x1 >= ext.x1 && bb.x2 <= ext.x2 && bb.y1 >= ext.y1 && bb.y2 <= ext.y2;
  if (visible) return true;
  // не влезает по размеру — отъезжаем; влезает, но за краем — просто подводим
  const tooBig = bb.w > ext.w * 0.9 || bb.h > ext.h * 0.9;
  cy.animate(tooBig
    ? { fit: { eles, padding: 120 }, duration: 320, easing: 'ease-out' }
    : { center: { eles }, duration: 320, easing: 'ease-out' });
  return true;
}

function visibleMapArea() {
  const canvas = cy.container().getBoundingClientRect();
  const bounds = { left: 24, top: 24, right: cy.width() - 24, bottom: cy.height() - 24 };
  const obstacles = [];
  for (const selector of ['.app-header', '#left', '#graph-tools', '#route-block', '#card']) {
    const element = document.querySelector(selector);
    if (!element || element.inert) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const obstacle = {
      left: Math.max(bounds.left, rect.left - canvas.left - 18),
      top: Math.max(bounds.top, rect.top - canvas.top - 18),
      right: Math.min(bounds.right, rect.right - canvas.left + 18),
      bottom: Math.min(bounds.bottom, rect.bottom - canvas.top + 18),
    };
    if (obstacle.left < obstacle.right && obstacle.top < obstacle.bottom) obstacles.push(obstacle);
  }
  const xs = [...new Set([bounds.left, bounds.right, ...obstacles.flatMap(o => [o.left, o.right])])].sort((a, b) => a - b);
  const ys = [...new Set([bounds.top, bounds.bottom, ...obstacles.flatMap(o => [o.top, o.bottom])])].sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i < xs.length - 1; i++) for (let j = i + 1; j < xs.length; j++) {
    for (let k = 0; k < ys.length - 1; k++) for (let l = k + 1; l < ys.length; l++) {
      const area = { left: xs[i], top: ys[k], right: xs[j], bottom: ys[l] };
      const width = area.right - area.left, height = area.bottom - area.top;
      if (width < 96 || height < 96) continue;
      if (obstacles.some(o => area.left < o.right && area.right > o.left && area.top < o.bottom && area.bottom > o.top)) continue;
      const score = width * height;
      if (!best || score > best.score) best = { ...area, score };
    }
  }
  return best;
}
function visibleMapFit() {
  if (!cy.nodes().length) return null;
  const area = visibleMapArea();
  if (!area) return null;
  const bb = cy.elements().boundingBox();
  const zoom = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), 1.5,
    (area.right - area.left) / Math.max(bb.w, 1), (area.bottom - area.top) / Math.max(bb.h, 1)));
  return { zoom, pan: {
    x: (area.left + area.right) / 2 - (bb.x1 + bb.x2) / 2 * zoom,
    y: (area.top + area.bottom) / 2 - (bb.y1 + bb.y2) / 2 * zoom,
  } };
}
function visibleMapFocus(node, zoom) {
  const area = visibleMapArea();
  if (!area) return null;
  const position = node.position();
  return { zoom, pan: {
    x: (area.left + area.right) / 2 - position.x * zoom,
    y: (area.top + area.bottom) / 2 - position.y * zoom,
  } };
}
function fitGraph(animate = false) {
  const viewport = visibleMapFit();
  if (!viewport) return;
  if (animate) cy.animate({ ...viewport, duration: 250, easing: 'ease-out' });
  else cy.viewport(viewport);
}

let laidOut = false; // граф уже раскладывали хотя бы раз
// Channel changes restore that channel's saved coordinates, never rebuild them.
let viewChanged = false;
function markViewChanged() { viewChanged = true; }
// Раскладка одинакова у всех: и зерно случайности, и поле раскладки живут в
// ui/graph-layout.js — там же написано, почему. Здесь только вызов.
function fullLayout() {
  if (!cy.nodes().length) return;
  const compact=window.COMPONENT_LAYOUT.buildVariants({positions:graphPositions(),edges:cy.edges().map(e=>[e.source().id(),e.target().id()])},['compact']).variants[0];
  cy.batch(()=>cy.nodes().forEach(n=>n.position(compact.positions[n.id()])));
  window.BRIDGE_LAYOUT.apply(cy);fitGraph();return;
}

// Зона игрока из снимка. Берём САМУЮ СВЕЖУЮ запись, а не запись с именем 'me':
// имя в общих картах теперь уникальное, и после переименования в файле какое-то время
// может лежать старая запись — она не должна перебивать текущую.
function playerZone(snap) {
  const players = Object.values((snap && snap.players) || {}).filter(p => p && p.zone);
  if (!players.length) return null;
  return players.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0].zone;
}

// ---------- рендер ----------
let lastSnap = null;
let selectedEdge = null;
const stableLayout = window.STABLE_MAP_LAYOUT.create({
  storage: window.localStorage,
  remote: ipc?.mapLayout ? (...args) => ipc.mapLayout(...args) : null,
  mergeRemote: ipc?.mapLayoutMerge ? (...args)=>ipc.mapLayoutMerge(...args):null,
});
let renderRevision = 0, renderedLayoutKey = '';
let layoutCheckBusy = false;
// Shared coordinates may change without a new portal. Check their revision, but
// update the canvas only when a point actually moved.
async function checkRemoteLayout() {
  if (layoutCheckBusy || document.hidden || !cloudSignedIn || !ipc?.mapLayout || !lastSnap) return;
  const context = layoutContext(), revision = renderRevision;
  if (renderedLayoutKey !== context.key || !cy.nodes().length) return;
  layoutCheckBusy = true;
  try {
    const positions = await stableLayout.resolve({ ...context, nodeIds: cy.nodes().map(n => n.id()),
      edgePairs: cy.edges().map(e => [e.data('source'), e.data('target')]) });
    if (revision !== renderRevision || context.key !== layoutContext().key) return;
    let changed = false;
    cy.batch(() => cy.nodes().forEach(n => {
      const next = positions[n.id()], current = n.position();
      if (!next || (Math.abs(next.x - current.x) < .01 && Math.abs(next.y - current.y) < .01)) return;
      n.position(next); changed = true;
    }));
    if (changed) window.BRIDGE_LAYOUT.apply(cy);
  } finally { layoutCheckBusy = false; }
}
setInterval(() => { void checkRemoteLayout().catch(() => {}); }, 5000);
function layoutContext() {
  const mapId = cloudSignedIn ? (chanView === 'local' ? layoutAccountId : chanView) : null;
  return { key: (layoutAccountId || 'offline') + ':' + chanView, mapId };
}
async function render(snap) {
  if (!snap) return;
  lastSnap = snap;
  const revision = ++renderRevision, context = layoutContext();
  const model = buildModel(snap);
  const positions = await stableLayout.resolve({ ...context, nodeIds: [...model.nodes.keys()],
    edgePairs: [...model.edges.values()].map(e => [e.source, e.target]) });
  if (revision !== renderRevision || context.key !== layoutContext().key) return;
  const switched = renderedLayoutKey !== context.key;
  renderedLayoutKey = context.key;
  renderSnapshot(snap, positions, switched);
}
function graphPositions() {
  return Object.fromEntries(cy.nodes().map(n => [n.id(), { ...n.position() }]));
}
cy.on('dragfree', 'node', () => {
  window.BRIDGE_LAYOUT.apply(cy);
  const context = layoutContext(), positions = graphPositions();
  stableLayout.remember(context.key, positions);
  if (context.mapId) stableLayout.resolve({ ...context, nodeIds: Object.keys(positions),
    edgePairs: cy.edges().map(e => [e.data('source'), e.data('target')]), replacePositions: positions })
    .catch(() => toast(i18nText("Не удалось сохранить расположение в облаке.")));
});
function renderSnapshot(snap, positions, switched) {
  if (!snap) return;
  lastSnap = snap;
  // Точка старта маршрута переживает перезапуск: берём её из снимка, а не только из события.
  // Но если слежение за зоной выключено, старая запись в карте — не «где мы сейчас»:
  // main-процесс её забыл, и панель обязана забыть тоже.
  const pz = cfg && !cfg.zoneWatch ? null : playerZone(snap);
  if (pz) {
    setCurZone(pz);
    document.getElementById('cur-zone').textContent = pz;
  }
  const model = buildModel(snap);

  cy.batch(() => {
    // 1. убираем то, чего больше нет (и рёбра, у которых развернулось направление —
    //    source/target у cytoscape неизменяемые, такое ребро можно только пересоздать)
    const dead = cy.collection();
    cy.nodes().forEach(n => { if (!model.nodes.has(n.id())) dead.merge(n); });
    cy.edges().forEach(e => {
      const d = model.edges.get(e.id());
      if (!d || d.source !== e.data('source') || d.target !== e.data('target')) dead.merge(e);
    });
    if (dead.nonempty()) cy.remove(dead);

    // 2. существующие узлы — только обновление data (позиции не трогаем!), новые — в очередь
    const addNodes = [];
    for (const [id, data] of model.nodes) {
      const n = cy.$id(id);
      if (n.nonempty()) n.data(data);
      else addNodes.push({ group: 'nodes', data });
    }
    if (addNodes.length) cy.add(addNodes);

    // 3. рёбра
    const addEdges = [];
    for (const [id, data] of model.edges) {
      const e = cy.$id(id);
      if (e.nonempty()) e.data(data);
      else if (cy.$id(data.source).nonempty() && cy.$id(data.target).nonempty()) addEdges.push({ group: 'edges', data });
    }
    if (addEdges.length) cy.add(addEdges);

    // Stable saved coordinates; existing nodes never take part in a force layout.
    cy.nodes().forEach(n => { if (positions[n.id()]) n.position(positions[n.id()]); });
    if (chanView !== 'local') cy.nodes().ungrabify();
    else cy.nodes().grabify();
  });
  viewChanged = false;
  if ((switched || !laidOut) && cy.nodes().length) fitGraph();
  laidOut = cy.nodes().length > 0;

  // Событие о портале и перерисовка графа приходят порознь, и узла в момент события
  // может ещё не быть. Тогда показ откладывается до ближайшей отрисовки — этой.
  if (pendingReveal) {
    if (Date.now() - pendingReveal.at > REVEAL_STALE_MS) pendingReveal = null;
    else if (revealEdge(pendingReveal.a, pendingReveal.b)) pendingReveal = null;
  }

  applyRouteHighlight(); // состав графа изменился — заново красим найденный маршрут
  window.BRIDGE_LAYOUT.apply(cy);
  window.scoutRefresh?.();
  ensureZoneInfo(model.nodes.keys());
  refreshSelectedEdge();
  updateMapSearchResults();
  if (document.getElementById('changes-dialog')?.open) renderChangeJournal();
}

// лёгкий тик: пересчитываем ТОЛЬКО подписи рёбер, позиции и состав графа не трогаем
function refreshLabels() {
  if (!lastSnap) return;
  const now = Date.now();
  let changed = 0;
  cy.batch(() => {
    for (const e of lastSnap.edges || []) {
      if (!e.a || !e.b) continue;
      const el = cy.$id(edgeKeyOf(e.a, e.b));
      if (el.empty()) continue;
      const d = edgeLabelData(e, now);
      // Пишем ТОЛЬКО изменившееся. Подпись ребра — «на 7 · 5ч 47м», и меняется она раз
      // в минуту, а тик идёт каждые пять секунд. Прежний безусловный el.data() на каждое
      // ребро заставлял cytoscape перерисовывать весь холст двенадцать раз в минуту без
      // единой причины — на сотне зон это заметная доля работы приложения, которое
      // большую часть времени просто стоит открытым за игрой.
      // conf — объект по картам, поэтому сравниваем его строкой: === на объектах всегда
      // ложь, и холст пересобирался бы каждый тик, ровно ради чего эта проверка и стоит.
      // recent сравниваем тоже — иначе зелёная подсветка нового портала не погасла бы
      // сама: подпись у него к тому времени уже не меняется, и данные не переписывались.
      if (d.label === el.data('label') && d.soon === el.data('soon') && d.recent === el.data('recent')
        && JSON.stringify(d.conf) === JSON.stringify(el.data('conf'))) continue;
      el.data(d);
      changed++;
    }
  });
  if (changed) refreshSelectedEdge();
  return changed;
}

// Портал живёт по часам, а не по нашим событиям.
//
// Состав графа менялся только в render(), а render() зовётся, когда main-процесс пришлёт
// карту — то есть на новый портал, на смену зоны или на синхронизацию. Пока ничего этого
// не происходит (а между вылазками это минуты и часы), закрывшийся портал оставался
// на графе с подписью «0с»: fmtLeft зажимает отрицательное время нулём, и ребро висело
// до перезапуска приложения. Поэтому тик теперь ещё и выбрасывает истёкшие.
//
// Правило совпадает со store.prune() в main-процессе — иначе ребро, убранное здесь,
// вернулось бы со следующим снимком и замигало.
function edgeAlive(e, now) {
  return e.expiresAt != null ? e.expiresAt > now : (e.updatedAt || 0) + 6 * 3600e3 > now;
}
function dropExpired() {
  if (!lastSnap) return false;
  const now = Date.now();
  const all = lastSnap.edges || [];
  const alive = all.filter(e => edgeAlive(e, now));
  if (alive.length === all.length) return false;
  // render сам уберёт и рёбра, и зоны, оставшиеся без единой связи
  render(Object.assign({}, lastSnap, { edges: alive }));
  return true;
}

// Окно свёрнуто — тикать незачем. Таймеры рёбер живут в данных, а не в разметке:
// развернут — первый же тик покажет верное время. Приложение стоит открытым за игрой
// часами, и эта проверка снимает всю фоновую работу окна на всё это время.
// (backgroundThrottling у окна выключен нарочно — карта не должна замирать за игрой, —
// поэтому без явной проверки тик молотил бы и у свёрнутого окна.)
//
// ЧАСТОТА ПЛАВАЮЩАЯ, И ВОТ ПОЧЕМУ. Подпись портала выглядит как «5ч 47м» и меняется раз
// в минуту — смотреть на неё чаще раза в пять секунд незачем. Но на последней минуте
// fmtLeft переходит на секунды, и тот же пятисекундный шаг давал «59с», девять секунд
// тишины, «50с»: цифра прыгала через пять, а если в тот же тик что-то истекало и
// dropExpired перерисовывал карту сам, то и через десять. Ровно на это владелец и
// жаловался. Поэтому: пока до ближайшего закрытия больше полутора минут — прежние пять
// секунд, а как счёт пошёл на секунды — раз в секунду.
//
// Дорого это не выходит: refreshLabels переписывает ТОЛЬКО изменившиеся подписи, а на
// последней минуте таких порталов один-два.
const SLOW_TICK = 5000, FAST_TICK = 1000, FAST_BELOW = 90e3;
let labelTimer = null;
function tickEvery() {
  if (document.hidden || !lastSnap) return SLOW_TICK;
  const now = Date.now();
  for (const e of lastSnap.edges || []) {
    if (!e.expiresAt) continue;
    const left = e.expiresAt - now;
    if (left > 0 && left < FAST_BELOW) return FAST_TICK;
  }
  return SLOW_TICK;
}
function labelTick() {
  if (!document.hidden && !dropExpired()) refreshLabels();
  labelTimer = setTimeout(labelTick, tickEvery());
}
labelTimer = setTimeout(labelTick, tickEvery());
// Развернули окно — догоняем сразу, не дожидаясь очередного тика
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (!dropExpired()) refreshLabels();
  // Пока окно было скрыто, шаг стоял медленный. Возвращаем частый сразу, а не через
  // пять секунд — иначе первое, что игрок увидит, снова будет застывшая цифра.
  clearTimeout(labelTimer);
  labelTimer = setTimeout(labelTick, tickEvery());
});

// перекраска узлов после доезда информации о зонах (позиции не трогаются)
// Цвет и тир доезжают ПОЗЖЕ узлов: граф строится по рёбрам сразу, а справочник зоны
// приходит отдельным запросом. Поэтому и цвет, и цифру тира проставляем здесь, когда
// сведения появились, — иначе тир был бы виден только после полной пересборки графа.
function refreshNodeColors() {
  cy.batch(() => cy.nodes().forEach(n => {
    const name = n.id();
    const color = zoneColorCache[name] || demoColors[name] || 'avalon';
    const info = zoneInfoCache[name];
    const tier = info && info.tier ? Number(info.tier) : null;
    const patch = { color: COLORS[color] || '#64748b', isAvalon: color === 'avalon', tier };
    // removeData, а не tierIcon: undefined — селектор [tierIcon] проверяет НАЛИЧИЕ поля,
    // и записанный undefined оставил бы правило включённым с пустой картинкой.
    if (tier) patch.tierIcon = window.tierBadge(tier, color === 'avalon' && tier === 8);
    else n.removeData('tierIcon');
    n.data(patch);
  }));
}

// ---------- карточка зоны ----------
function rememberZone(info) {
  if (!info || !info.name) return info;
  const prev = zoneInfoCache[info.name] || {};
  const merged = {
    name: info.name,
    color: info.color || prev.color || null,
    tier: info.tier || prev.tier || null,
    quality: info.quality || prev.quality || null,   // только у чёрных зон
    activities: info.activities || prev.activities || null,
  };
  zoneInfoCache[info.name] = merged;
  if (merged.color) zoneColorCache[info.name] = merged.color;
  return merged;
}

// карточка показывает тот же обрезанный ромб, что и игровой оверлей (полноразмерные
// скриншоты карт в 29 МБ для миниатюры не нужны)
function mapUrl(name) { return '../assets/avalon-maps-crop/' + encodeURIComponent(name) + '.webp'; }
function iconUrl(key) { return '../assets/avalon-icons/' + encodeURIComponent(key) + '.webp'; }

let cardZone = null;
function showCard(info, extraHtml, reveal = true) {
  const body = document.getElementById('card-body');
  if (!body || !info || !info.name) return;
  const z = rememberZone(info);
  cardZone = z.name;
  if (reveal) { toggleCard(true); applyFold('card-body', true); }
  renderZoneDetails(body, z, extraHtml);
}

function renderZoneDetails(body, z, extraHtml) {
  const color = z.color || 'avalon';
  const acts = z.activities;
  const html = [];

  html.push(
    '<div class="card-head">' +
      '<div class="card-name">' + esc(z.name) + '</div>' +
      // (расшифровка слоя — roadTypeRu ниже по файлу)
      // Порядок «сначала тир, потом тип» — как в самой плашке игры: «VI ☠ Oiros-Alaiam».
      // Уровень зоны определяет, по зубам ли она, и читается первым.
      '<div class="card-tags">' +
        // Тир, а следом качество в скобках — «T7 (5)». Качество бывает только у чёрных
        // зон, поэтому у прочих чип остаётся прежним, без пустых скобок.
        (z.tier ? '<span class="chip chip-tier">T' + esc(z.tier) +
          (z.quality ? ' (' + esc(z.quality) + ')' : '') + '</span>' : '') +
        '<span class="chip chip-' + esc(color) + '">' + esc(ZONE_TYPE_RU[color] || i18nText("Зона")) + '</span>' +
        // Слой дороги: L1 Royal, L3 Hub и т.д. Это не украшение — по нему видно, куда
        // зона выходит и насколько глубоко сидит, а заодно предсказуем тир ресурсов.
        // Подпись расшифровывает ярлык словами: сам по себе «L3 Deep Rest» не говорит
        // ничего тому, кто не читал справочник.
        // Слой лежит в записи активностей (zone-data.json), а не в обёртке зоны:
        // обёртка знает имя, цвет и тир, всё остальное про зону — в activities.
        (acts && acts.type ? '<span class="chip chip-road" title="' + esc(ACTS.roadTypeRu(acts.type)) + '">' +
          esc(acts.type) + '</span>' : '') +
      '</div>' +
    '</div>');
  if (extraHtml) html.push('<div class="card-portal">' + extraHtml + '</div>');
  if (color === 'avalon') html.push('<div class="card-map"><img alt=""></div>');

  if (acts && acts.chests) {
    const items = ACTS.listActivities(acts);
    html.push(items.length
      // У ресурсов на чипе только значки (пара, основной крупнее); число и тир — в
      // подсказке. Та же логика, что в overlay.js chip(): расходиться им нельзя.
      ? '<div class="acts">' + items.map(it =>
          '<span class="act' + (it.big ? ' big' : '') + (it.sub ? ' pair' : '') +
            '" title="' + esc(ACTS.actTitle(it, acts)) + '">' +
            '<span class="ic">' +
            '<img data-fb="' + esc(it.ru.slice(0, 3)) + '" src="' + iconUrl(it.icon) + '" alt="">' +
            (it.sub ? '<span class="sub"><img src="' + iconUrl(it.sub) + '" alt=""></span>' : '') +
            '</span>' +
            (!it.res && it.count > 1 ? '<b>' + esc(it.count) + '</b>' : '') +
          '</span>').join('') + '</div>'
      : i18nText("<div class=\"muted small acts-empty\">активностей в этой зоне не отмечено</div>"));
  } else if (color === 'avalon') {
    html.push(i18nText("<div class=\"muted small acts-empty\">данные об активностях недоступны</div>"));
  }
  body.innerHTML = html.join('');

  // ассеты качает отдельный процесс — если файла ещё нет, аккуратно деградируем
  const wrap = body.querySelector('.card-map');
  if (wrap) {
    const img = wrap.querySelector('img');
    // Скелет гасим явно по загрузке. «Картинка сама его закроет» не работает: карта зоны —
    // ромб с ПРОЗРАЧНЫМИ углами, и мерцание было видно в них всегда, читаясь как вечная загрузка.
    img.onload = () => wrap.classList.add('ready');
    img.onerror = () => { wrap.innerHTML = i18nText("<div class=\"map-missing\">карта зоны ещё не скачана</div>"); };
    img.src = mapUrl(z.name);
    if (img.complete && img.naturalWidth) wrap.classList.add('ready');   // взялась из кэша мгновенно
  }
  body.querySelectorAll('.act img').forEach(img => {
    img.onerror = () => {
      const fb = document.createElement('i');
      fb.className = 'act-fb';
      fb.textContent = img.dataset.fb || '?';
      img.replaceWith(fb);
    };
  });
}

const askedInfo = new Set();
// подтягиваем цвет/тир/активности для узлов, о которых ещё ничего не знаем
function ensureZoneInfo(names) {
  if (!ipc || typeof ipc.getZoneInfo !== 'function') return;
  const want = [...names].filter(n => !zoneInfoCache[n] && !askedInfo.has(n));
  if (!want.length) return;
  want.forEach(n => askedInfo.add(n));
  Promise.all(want.map(n => Promise.resolve(ipc.getZoneInfo(n)).catch(() => null))).then(list => {
    let changed = false;
    for (const info of list) if (info && info.name) { rememberZone(info); changed = true; }
    if (changed) {
      refreshNodeColors();
      if (cardZone && zoneInfoCache[cardZone]) showCard(zoneInfoCache[cardZone], undefined, false);
      // цвета зон доехали — перекрашиваем ромбы в ленте маршрута
      if (lastRoute) showRoute(lastRoute.res, lastRoute.title, lastRoute.emptyText);
      updateMapSearchResults();
    }
  });
}

// карточка по произвольному узлу графа: сначала кэш, потом уточнение через IPC (если он есть)
function showCardFor(name) {
  const cached = zoneInfoCache[name];
  showCard(cached || { name, color: zoneColorCache[name] || demoColors[name] || null, tier: null, activities: demoActs[name] || null });
  if (!ipc || typeof ipc.getZoneInfo !== 'function') return;
  Promise.resolve(ipc.getZoneInfo(name)).then(info => {
    if (info && info.name) { rememberZone(info); if (cardZone === name) showCard(zoneInfoCache[name], undefined, false); }
  }).catch(() => {});
}

// ---------- маршрутизатор ----------
// Главное здесь — короткая текстовая строка: её игрок читает прямо в бою.
// Подсветка графа — дополнение: рёбра 'walk'/'exit' на графе физически отсутствуют
// (рисуем только Авалон), поэтому они живут исключительно в тексте.
let cfg = null;       // настройки из main-процесса: панель их не хранит, а отражает
let curZone = null;   // где мы сейчас — по фоновому распознаванию зоны
let selZone = null;   // последняя зона, кликнутая на графе: запасная точка старта
let zoneNames = [];   // [{ name, color }] — словарь автодополнения (Авалон + королевство)
let routeHl = null;   // { nodes:Set, edges:Set } — что сейчас подсвечено на графе

// Откуда идём — теперь обычное поле ввода, а не «там, где игрок». Так можно построить
// путь товарищу или прикинуть маршрут заранее, не будучи в этой зоне.
// Своя зона никуда не делась: подставляется сама, пока поле не тронули руками,
// и возвращается кнопкой «Подставить мою зону».
let fromTouched = false;
function routeOrigin() {
  const el = document.getElementById('route-from-input');
  if (!el) return null;
  if (/^из\s+любого\s+города$/i.test(el.value.trim()) || el.value.trim() === i18nText("Из любого города")) return i18nText("Из любого города");
  return resolveDest(el.value);
}
function setAnyCityOrigin() {
  document.getElementById('route-from-input').value = i18nText("Из любого города");
  fromTouched = true;
  updateOrigin();
}
function fillFrom(name, byHand) {
  const el = document.getElementById('route-from-input');
  if (!el || !name) return;
  el.value = name;
  if (byHand) fromTouched = false;   // подставили сами — снова следим за зоной игрока
  updateOrigin();
}
function updateOrigin() {
  const btn = document.getElementById('route-here');
  if (!btn) return;
  const el = document.getElementById('route-from-input');
  const same = curZone && el && el.value.trim() === curZone;
  btn.disabled = !curZone || !!same;
  btn.textContent = i18nText("Моя зона");
  btn.title = curZone
    ? (same ? i18nText("Это твоя зона: ") + curZone : i18nText("Подставить мою зону: ") + curZone)
    : i18nText("Твоя зона ещё не распознана");
  const cityButton=document.getElementById('route-from-city');
  const anyCity=el?.value.trim()===i18nText("Из любого города");
  cityButton?.classList.toggle('origin-selected',anyCity);
  cityButton?.setAttribute('aria-pressed',String(anyCity));
}
function setCurZone(name) {
  if (!name || name === curZone) return;
  curZone = name;
  if (!fromTouched) fillFrom(name);   // поле не трогали — держим в нём текущую зону
  updateOrigin();
}
function setSelZone(name) { selZone = name; }

function plural(n, one, few, many) {
  if (globalThis.AvalonI18n?.language === 'en') return Math.abs(n) === 1 ? one : many;
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b > 1 && b < 5) return few;
  return many;
}

// ---------- автодополнение ----------
// Разбор сокращений («couexa» → Coues-Exakrom) живёт в ui/zone-search.js: тот же код
// работает в окне поиска, которое всплывает по хоткею вместо снимка у курсора.
function searchZones(q) { return window.ZONE_SEARCH.search(zoneNames, q); }
function markName(name, marks) { return window.ZONE_SEARCH.mark(name, marks, esc); }

// Автодополнение нужно ДВУМ полям — «откуда» и «куда», — поэтому оно стало объектом
// на поле, а не набором функций с одним общим состоянием на всю панель.
let activeRouteCompletion = null;
function makeAC(inputId, boxId, onEnter) {
  const input = () => document.getElementById(inputId);
  const box = () => document.getElementById(boxId);
  let items = [], idx = -1;
  const ac = {
    render(list) {
      const b = box();
      if (activeRouteCompletion && activeRouteCompletion !== ac) activeRouteCompletion.close();
      items = list; idx = list.length ? 0 : -1;
      if (!list.length) { ac.close(); return; }
      b.innerHTML = list.map((z, i) =>
        '<div class="ac-item' + (i === idx ? ' on' : '') + '" data-i="' + i + '">' +
          '<i class="dot ' + esc(z.color || 'avalon') + '"></i>' +
          '<span>' + markName(z.name, z.marks) + '</span>' +
        '</div>').join('');
      b.hidden = false;
      activeRouteCompletion = ac;
      // Top-layer suggestions remain clickable outside the scrollable dock.
      const rect = input().getBoundingClientRect();
      b.popover = 'manual';
      Object.assign(b.style, {position:'fixed', inset:'auto', margin:'0',
        left:rect.left+'px', bottom:(innerHeight-rect.top+6)+'px', width:rect.width+'px',
        maxHeight:Math.min(220,Math.max(80,rect.top-80))+'px'});
      if (!b.matches(':popover-open')) b.showPopover();
    },
    close() {
      const b = box();
      if (b) { if (b.matches(':popover-open')) b.hidePopover(); b.hidden = true; b.innerHTML = ''; }
      items = []; idx = -1;
      if (activeRouteCompletion === ac) activeRouteCompletion = null;
    },
    contains(target) { return box()?.contains(target); },
    move(d) {
      if (!items.length) return;
      idx = (idx + d + items.length) % items.length;
      [...box().children].forEach((el, i) => el.classList.toggle('on', i === idx));
      const on = box().children[idx];
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    },
    pick(i) {
      const z = items[i];
      if (!z) return;
      input().value = z.name;
      ac.close();
      updateOrigin();
    },
    bind() {
      const el = input();
      el.addEventListener('input', () => {
        if (inputId === 'route-from-input') fromTouched = true;
        ac.render(searchZones(el.value));
        updateOrigin();
      });
      el.addEventListener('focus', () => { if (el.value.trim()) ac.render(searchZones(el.value)); });
      el.addEventListener('blur', () => ac.close());
      el.addEventListener('keydown', ev => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); ac.move(1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); ac.move(-1); }
        else if (ev.key === 'Escape') ac.close();
        else if (ev.key === 'Enter') {
          ev.preventDefault();
          if (items.length && idx >= 0) ac.pick(idx);   // сначала принимаем подсказку
          else onEnter();                               // второй Enter — действие
        }
      });
      box().addEventListener('mousedown', ev => {
        const item = ev.target.closest('.ac-item');
        if (!item) return;
        ev.preventDefault();   // не даём полю потерять фокус до выбора
        ac.pick(Number(item.dataset.i));
      });
    },
  };
  return ac;
}
window.addEventListener('resize', () => activeRouteCompletion?.close());
document.getElementById('route-block').addEventListener('scroll', ev => {
  if (activeRouteCompletion && !activeRouteCompletion.contains(ev.target)) activeRouteCompletion.close();
}, true);
let acTo = null, acFrom = null;
function acClose() { activeRouteCompletion?.close(); if (acTo) acTo.close(); if (acFrom) acFrom.close(); }
// то, что игрок имел в виду: точное имя, иначе лучшая подсказка, иначе введённый текст
function resolveDest(raw) {
  const q = String(raw || '').trim();
  if (!q) return null;
  const exact = zoneNames.find(z => z.name.toLowerCase() === q.toLowerCase());
  if (exact) return exact.name;
  const best = searchZones(q)[0];
  return best ? best.name : q;
}

// ---------- текст маршрута ----------
// Для игрока ЛЮБОЙ непеший переход — портал. Деление portal/exit важно маршрутизатору
// (у выхода в мир свои веса и правила), но в ленте шагов оно только путало: «выход»
// читался как что-то отдельное от портала, и счётчик внизу считал не то.
const KIND_RU = { portal: i18nText("портал"), exit: i18nText("портал"), walk: i18nText("пешком") };
// подряд идущие пешие переходы схлопываем в один участок «пешком N зон»
// Раньше подряд идущие пешие шаги схлопывались в один участок «пешком 3 зоны», а зоны
// перечислялись строкой через стрелки. Игрок попросил обратное: каждая зона — своя
// строка со своим ромбом на рельсе, как у порталов. Так читается сверху вниз, одним
// движением глаза, и видно, сколько всего переходов.
function groupSteps(steps) {
  return (steps || []).map(s => ({ kind: s.kind || 'portal', from: s.from, to: s.to, step: s }));
}
function groupLabel(g) { return KIND_RU[g.kind] || g.kind; }
// вместимость и остаток времени шага — прямо в строке, а не в подсказке по наведению:
// в бою никто не водит мышью, чтобы узнать, успевает ли он в портал
function stepMeta(g) {
  const s = g.step || {};
  const bits = [];
  if (s.capMax != null) bits.push(i18nText("<span class=\"num\">на ") + esc(s.capMax) + '</span>');
  if (s.expiresAt) {
    const left = s.expiresAt - Date.now();
    bits.push('<span class="num' + (left < 15 * 60e3 ? ' soon' : '') + '">' + esc(fmtLeft(left)) + '</span>');
  }
  return bits.length ? '<span class="rs-meta">' + bits.join(' · ') + '</span>' : '';
}
// Лента шагов: одна строка на переход, слева рельс с метками.
// Прежняя строка «зона → портал → зона → …» на панели в 296 px переносилась в кашу.
// цвет зоны для ромба на рельсе: тот же, что у узла на графе
function zoneTint(name) {
  const c = zoneColorCache[name] || demoColors[name] || null;
  return c ? (COLORS[c] || null) : null;
}
function rowStyle(i, name) {
  const tint = zoneTint(name);
  return 'style="--i:' + i + (tint ? ';--zc:' + tint : '') + '"';
}

function chainHtml(steps) {
  const groups = groupSteps(steps);
  if (!groups.length) return '';
  const li = ['<li class="rs start" ' + rowStyle(0, groups[0].from) + '>' +
    '<span class="rs-index" aria-hidden="true">0</span>' +
    '<span class="rz" data-zone="' + esc(groups[0].from) + '">' + esc(groups[0].from) + '</span></li>'];
  groups.forEach((g, i) => {
    li.push('<li class="rs ' + esc(g.kind) + (i === groups.length - 1 ? ' last' : '') + '" ' + rowStyle(i + 1, g.to) + '>' +
      '<span class="rs-index" aria-hidden="true">' + (i + 1) + '</span>' +
      '<span class="rs-kind">' + esc(groupLabel(g)) + '</span>' +
      '<span class="rz" data-zone="' + esc(g.to) + '">' + esc(g.to) + '</span>' +
      stepMeta(g) +
    '</li>');
  });
  return '<ol class="route-steps">' + li.join('') + '</ol>';
}
function summaryHtml(res) {
  const steps = res.steps || [];
  const hops = res.hops != null ? res.hops : steps.length;
  const walk = steps.filter(s => s.kind === 'walk').length;
  // Порталов столько, сколько НЕПЕШИХ переходов. Роутер считает отдельно portalHops
  // (только внутри Авалона) и выходы в мир — игроку эта разница не нужна, для него
  // и то и другое портал, и в счётчике он ждёт их сумму.
  const portals = steps.length - walk;
  const stat = (n, word) => '<span class="rs-stat"><b>' + esc(n) + '</b>' + esc(word) + '</span>';
  const bits = [stat(hops, plural(hops, i18nText("шаг"), i18nText("шага"), i18nText("шагов")))];
  // роутер и раньше считал время в пути, но панель его не показывала
  // время в пути — наш расчёт по средним скоростям, а не факт: помечаем тильдой
  if (res.etaSec) bits.push('<span class="rs-stat"><b>~' + esc(fmtLeft(res.etaSec * 1000)) + i18nText("</b>в пути</span>"));
  if (portals > 0) bits.push(stat(portals, plural(portals, i18nText("портал"), i18nText("портала"), i18nText("порталов"))));
  if (walk > 0) bits.push(stat(walk, i18nText("пешком")));
  const bn = res.bottleneck;
  if (bn) {
    const left = bn.minutesLeft != null ? fmtLeft(bn.minutesLeft * 60e3)
      : (bn.expiresAt ? fmtLeft(bn.expiresAt - Date.now()) : null);
    bits.push('<span class="route-bn" title="' + esc((bn.from || '?') + ' → ' + (bn.to || '?')) + '">' +
      i18nText("узкое место: портал в ") + esc(bn.to || bn.from || '?') +
      (left ? i18nText(" закроется через ") + esc(left) : i18nText(" скоро закроется")) + '</span>');
  }
  return '<div class="route-sum">' + bits.join('') + '</div>';
}

// cls: не задан — подсказка серым, '' — обычный текст маршрута, 'route-fail' — отказ
function routeMsg(html, cls) {
  const out = document.getElementById('route-out');
  out.className = 'route-out small ' + (cls == null ? 'muted' : cls);
  out.innerHTML = html;
}
let lastRoute = null;   // последний показанный маршрут: перерисовываем, когда доедут цвета зон
function discardRouteResult() {
  if (guiding && ipc && typeof ipc.routeGuide === 'function') {
    Promise.resolve(ipc.routeGuide('stop')).catch(() => {});
  }
  lastRoute = null;
  invalidateRouteImage(i18nText("Маршрут сброшен. Построй путь и открой картинку заново."));
  setRouteHighlight(null);
}
function showRoute(res, title, emptyText) {
  const head = title ? '<div class="route-title">' + esc(title) + '</div>' : '';
  if (!res || !res.found) {
    discardRouteResult();
    routeMsg(head + '<div class="route-fail">' + esc(res && res.reason ? res.reason : i18nText("путь не найден")) + '</div>', '');
    return;
  }
  // роутер нашёл путь длиной ноль — идти никуда не надо
  if (!res.steps || !res.steps.length) {
    discardRouteResult();
    routeMsg(head + '<div class="route-here">' + esc(res.provisionalExit
      ? i18nText("Ты в «{0}». Проверь выходы из этой зоны.", [res.to])
      : emptyText || i18nText("ты уже на месте")) + '</div>' +
      (res.provisionalExit ? '<div class="route-uncertain">' + esc(res.reason) + '</div>' : ''), '');
    return;
  }
  // Цвет ромба берётся из справочника зон, а зоны мира в нём могут быть ещё не спрошены —
  // спрашиваем и перерисовываем ленту, когда ответ придёт (см. ensureZoneInfo).
  if (lastRoute?.res !== res) invalidateRouteImage(i18nText("Маршрут изменился. Открой картинку заново."));
  lastRoute = { res, title, emptyText };
  const names = new Set();
  for (const st of res.steps) { if (st.from) names.add(st.from); if (st.to) names.add(st.to); }
  ensureZoneInfo(names);
  const html = [head, chainHtml(res.steps), summaryHtml(res)];
  if (res.provisionalExit) html.push('<div class="route-uncertain">' + esc(res.reason) + '</div>');
  if (res.risky) {
    html.push(i18nText("<div class=\"route-risky\">рискованно: ") +
      esc(res.reason || i18nText("таймеры на пределе — портал может закрыться, пока идёшь")) + '</div>');
  }
  routeMsg(html.join(''), '');
  setRouteHighlight(res);
}

// ---------- подсветка маршрута на графе ----------
function applyRouteHighlight() {
  cy.batch(() => {
    cy.elements().removeClass('route-hit route-dim');
    if (!routeHl) return;
    let any = false;
    cy.nodes().forEach(n => {
      if (routeHl.nodes.has(n.id())) { n.addClass('route-hit'); any = true; } else n.addClass('route-dim');
    });
    cy.edges().forEach(e => {
      if (routeHl.edges.has(e.id())) { e.addClass('route-hit'); any = true; } else e.addClass('route-dim');
    });
    // весь маршрут вне Авалона — гасить граф незачем, подсвечивать всё равно нечего
    if (!any) cy.elements().removeClass('route-dim');
  });
}
function setRouteHighlight(res) {
  cy.remove('edge.route-ghost');   // дорисованные в прошлый раз связи убираем
  if (!res || !res.found || !res.steps || !res.steps.length) routeHl = null;
  else {
    const nodes = new Set(), edges = new Set();
    const ghosts = [];
    for (const s of res.steps) {
      if (s.from) nodes.add(s.from);
      if (s.to) nodes.add(s.to);
      // Пеший переход линией не соединяем — по просьбе игрока: линия на графе означает
      // портал, и пунктир между соседними зонами мира только путал бы.
      if (s.kind === 'walk' || !s.from || !s.to) continue;
      const id = edgeKeyOf(s.from, s.to);
      edges.add(id);
      // Ребра может не быть в карте вовсе (выход в мир, чужая зона) — тогда дорисовываем
      // его на время показа маршрута: без этого путь на графе рвался и читался кусками.
      if (cy.$id(id).empty() && cy.$id(s.from).nonempty() && cy.$id(s.to).nonempty()) {
        ghosts.push({ group: 'edges', data: { id, source: s.from, target: s.to, a: s.from, b: s.to, label: '' }, classes: 'route-ghost' });
      }
    }
    if (ghosts.length) cy.add(ghosts);
    routeHl = { nodes, edges };
  }
  applyRouteHighlight();
  // Проводник и картинка появляются после расчёта; сброс доступен всегда.
  const gb = document.getElementById('route-guide');
  if (gb) gb.hidden = !routeHl;
  const imageButton = document.getElementById('route-image');
  if (imageButton) imageButton.hidden = !routeHl;
  if (!routeHl) setGuiding(false);
}

// Картинка берёт именно показанную цепочку, со всеми промежуточными зонами.
// Повторный поиск при экспорте мог бы выбрать другой путь.
let routeImageSerial = 0;
let routeImageSnapshot = null;
let routeImageSaving = false;
function routeImageStatus(text, error = false) {
  const el = document.getElementById('route-image-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}
function routeImageButtons() {
  for (const id of ['route-image-copy', 'route-image-save']) {
    document.getElementById(id).disabled = !routeImageSnapshot || routeImageSaving;
  }
}
function invalidateRouteImage(reason) {
  ++routeImageSerial;
  routeImageSnapshot = null;
  routeImageButtons();
  if (reason && !document.getElementById('modal-route-image').hidden) {
    document.getElementById('route-image-stage').setAttribute('aria-busy', 'false');
    document.getElementById('route-image-preview').hidden = true;
    routeImageStatus(reason);
  }
}
async function openRouteImage() {
  if (routeBusy || !lastRoute || !lastRoute.res?.steps?.length) return;
  const serial = ++routeImageSerial;
  const route = { ...lastRoute.res, steps: lastRoute.res.steps.map(step => ({ ...step })) };
  const names = new Set(route.steps.flatMap(step => [step.from, step.to]));
  const zoneInfo = Object.fromEntries([...names].map(name => [name, zoneInfoCache[name] || {
    color: zoneColorCache[name] || zoneNames.find(zone => zone.name === name)?.color || demoColors[name] || null,
  }]));
  const preview = document.getElementById('route-image-preview');
  const stage = document.getElementById('route-image-stage');
  routeImageSnapshot = null;
  preview.hidden = true;
  preview.removeAttribute('src');
  routeImageButtons();
  routeImageStatus(i18nText("Готовлю картинку…"));
  stage.setAttribute('aria-busy', 'true');
  openModal('modal-route-image');
  try {
    const result = await window.RouteImage.render(route, { zoneInfo, now: Date.now() });
    if (serial !== routeImageSerial) return;
    routeImageSnapshot = result;
    preview.alt = i18nText("Маршрут: ") + result.from + ' → ' + result.to + i18nText(". Все ") + route.steps.length + i18nText(" переходов по порядку.");
    preview.src = result.dataUrl;
    preview.hidden = false;
    stage.classList.toggle('wide', result.width > 760);
    stage.style.setProperty('--route-image-width', result.width + 'px');
    stage.scrollLeft = 0;
    document.querySelector('.route-image-body').scrollTop = 0;
    routeImageStatus(i18nText("Готово к отправке. Время закрытия указано на момент создания картинки."));
  } catch (err) {
    if (serial === routeImageSerial) routeImageStatus(i18nText("Не удалось создать картинку: ") + (err?.message || err), true);
  } finally {
    if (serial === routeImageSerial) {
      stage.setAttribute('aria-busy', 'false');
      routeImageButtons();
    }
  }
}
async function exportRouteImage(action) {
  if (routeImageSaving || !routeImageSnapshot) return;
  if (!ipc || typeof ipc.exportRouteImage !== 'function') {
    routeImageStatus(i18nText("Сохранение и копирование доступны внутри приложения."), true);
    return;
  }
  const serial = routeImageSerial;
  const { dataUrl, from, to } = routeImageSnapshot;
  routeImageSaving = true;
  routeImageButtons();
  routeImageStatus(action === 'copy' ? i18nText("Копирую картинку…") : i18nText("Выбери, куда сохранить картинку…"));
  try {
    const result = await ipc.exportRouteImage(action, { dataUrl, from, to });
    if (serial !== routeImageSerial) return;
    if (result?.canceled) routeImageStatus(i18nText("Сохранение отменено. Картинка готова к отправке."));
    else if (result?.ok) routeImageStatus(action === 'copy'
      ? i18nText("Картинка скопирована — вставь её в чат с помощью Ctrl+V.")
      : i18nText("Картинка сохранена. Можно отправить файл другу."));
    else routeImageStatus(result?.error || i18nText("Не удалось экспортировать картинку. Попробуй ещё раз."), true);
  } catch (err) {
    if (serial === routeImageSerial) routeImageStatus(i18nText("Не удалось экспортировать картинку: ") + (err?.message || err), true);
  } finally {
    routeImageSaving = false;
    routeImageButtons();
  }
}
// ПРОВОДНИК: плашка маршрута поверх игры.
//
// Кнопка переключательная, и это важнее, чем кажется: плашка висит постоянно, и без
// видимого «идёт» игрок не понял бы, включена она или нет, — окно карты в этот момент
// свёрнуто, а сама плашка на другом экране.
let guiding = false;
function setGuiding(on) {
  guiding = on;
  const b = document.getElementById('route-guide');
  if (!b) return;
  b.textContent = on ? i18nText("Остановить") : i18nText("Вести");
  b.title = on ? i18nText("Перестать вести") : i18nText("Вести по маршруту");
  b.setAttribute('aria-label',b.title);
  b.classList.toggle('key', on);
}
async function toggleGuide() {
  if (!ipc || typeof ipc.routeGuide !== 'function') {
    return toast(i18nText("Проводник доступен только внутри приложения."));
  }
  if (guiding) { await ipc.routeGuide('stop'); setGuiding(false); return; }
  if (!lastRoute || !lastRoute.res) return;
  const r = await ipc.routeGuide('start', lastRoute.res);
  setGuiding(!!(r && r.on));
  // Не включилось — говорим почему. Молчащая кнопка читается как сломанная, а причина
  // почти всегда бытовая: оверлей выключен в настройках или идёт настройка места.
  if (r && !r.on && r.reason) toast(i18nText("Не могу вести: ") + r.reason);
}

function clearRoute() {
  ++routeRequestSerial;
  discardRouteResult();
  document.getElementById('route-to').value = '';
  if (curZone) fillFrom(curZone, true);
  else {
    document.getElementById('route-from-input').value = '';
    fromTouched = false;
    updateOrigin();
  }
  acClose();
  routeMsg(i18nText("введи зону назначения и нажми «Найти путь»"));
}

// ---------- действия панели маршрута ----------
let routeBusy = false;
let routeRequestSerial = 0;
async function runRoute(mode) {
  if (routeBusy) return;
  const invalid = text => { discardRouteResult(); return routeMsg(text, 'route-fail'); };
  if (mode === 'city') setAnyCityOrigin();
  const cityMode = mode === 'city' || (mode === 'to' && routeOrigin() === i18nText("Из любого города"));
  const from = cityMode ? null : routeOrigin();
  if (from === i18nText("Из любого города")) return invalid(i18nText("Для ближайшего выхода укажи конкретную исходную зону."));
  if (!cityMode && !from) return invalid(i18nText("Укажи конкретную исходную зону."));
  if (from) document.getElementById('route-from-input').value = from;
  if (!ipc || typeof ipc.findRoute !== 'function' ||
    (cityMode && typeof ipc.findRouteFromCity !== 'function')) {
    return invalid(i18nText("Поиск пути доступен только внутри приложения."));
  }

  let to = null;
  if (mode === 'to' || cityMode) {
    to = resolveDest(document.getElementById('route-to').value);
    if (!to) return invalid(i18nText("Укажи, куда идти."));
    document.getElementById('route-to').value = to;
  }
  if ((mode === 'to' || cityMode) && window.scoutWaypoints?.().length) {
    return window.scoutRunPlan({from, to});
  }
  acClose();
  routeBusy = true;
  const serial = ++routeRequestSerial;
  // Отложенное получение цветов не должно вернуть предыдущий путь, пока ищется новый.
  discardRouteResult();
  const buttons = [document.getElementById('route-go'), document.getElementById('route-from-city'), document.getElementById('route-exit')];
  buttons.forEach(b => { b.disabled = true; });
  routeMsg(i18nText("ищу путь…"));
  try {
    const res = cityMode ? await ipc.findRouteFromCity(to)
      : mode === 'to' ? await ipc.findRoute(from, to) : await ipc.findNearestExit(from);
    if (serial !== routeRequestSerial) return;
    if (cityMode) showRoute(res, res.found ? i18nText("Лучший старт: ") + res.from : i18nText("Из любого города"));
    else if (mode === 'to') showRoute(res);
    else showRoute(res, res.provisionalExit
      ? i18nText("Путь до L1 Royal · выход не подтверждён")
      : i18nText("Ближайший выход в безопасную зону"), i18nText("подходящая зона уже здесь"));
  } catch (err) {
    if (serial !== routeRequestSerial) return;
    lastRoute = null;
    setRouteHighlight(null);
    routeMsg(i18nText("Ошибка поиска: ") + esc(err && err.message ? err.message : err), 'route-fail');
  } finally {
    routeBusy = false;
    buttons.forEach(b => { b.disabled = false; });
  }
}

function initRouteUI() {
  // Enter в «откуда» переводит в «куда», Enter в «куда» ищет путь
  acFrom = makeAC('route-from-input', 'route-ac-from', () => document.getElementById('route-to').focus());
  acTo = makeAC('route-to', 'route-ac', () => runRoute('to'));
  acFrom.bind();
  acTo.bind();
  document.addEventListener('click', ev => { if (!ev.target.closest('#route-block')) acClose(); });
  document.getElementById('route-here').onclick = () => {
    if (!curZone) return;
    ++routeRequestSerial;discardRouteResult();fillFrom(curZone, true);
    routeMsg(i18nText("введи зону назначения и нажми «Найти путь»"));
  };

  document.getElementById('route-go').onclick = () => runRoute('to');
  document.getElementById('route-from-city').onclick = () => {
    ++routeRequestSerial;discardRouteResult();setAnyCityOrigin();
    routeMsg(i18nText("введи зону назначения и нажми «Найти путь»"));
    document.getElementById('route-to').focus();
  };
  document.getElementById('route-exit').onclick = () => runRoute('exit');
  document.getElementById('route-portal-city').onchange = async ev => {
    const select = ev.currentTarget;
    select.disabled = true;
    try {
      applyConfig(await ipc.setOption('outlandsPortalCity', select.value || null));
      discardRouteResult();
      routeMsg(i18nText("Привязка изменена. Построй маршрут заново."));
    } catch (err) {
      toast(i18nText("Не удалось сохранить привязанный портал."));
      if (cfg) select.value = cfg.outlandsPortalCity || '';
    } finally { select.disabled = false; }
  };
  document.getElementById('route-clear').onclick = () => clearRoute();
  document.getElementById('route-guide').onclick = () => toggleGuide();
  document.getElementById('route-image').onclick = () => openRouteImage();
  document.getElementById('route-image-copy').onclick = () => exportRouteImage('copy');
  document.getElementById('route-image-save').onclick = () => exportRouteImage('save');
  // Проводник может выключиться САМ — когда дошёл. Кнопка про это узнаёт только отсюда:
  // иначе она осталась бы в положении «Перестать вести», хотя вести уже нечего.
  if (ipc && typeof ipc.on === 'function') ipc.on('route-guide-off', () => setGuiding(false));
  // клик по имени зоны в маршруте — карточка зоны и центровка графа на ней
  document.getElementById('route-out').addEventListener('click', ev => {
    const el = ev.target.closest('.rz');
    if (!el) return;
    const name = el.dataset.zone;
    showCardFor(name);
    const n = cy.$id(name);
    if (n.nonempty()) cy.animate({ center: { eles: n }, duration: 250, easing: 'ease-out' });
  });
  updateOrigin();
}

// ---------- взаимодействие с графом ----------
// Откуда знаем ребро — словами. scope теперь код карты, а не слово, поэтому имя
// приходится искать: общая одна и с постоянным кодом, комнату находим в списке каналов.
// Незнакомый код бывает у комнаты, из которой уже вышли, — так и пишем.
const SCOPE_RU = { local: i18nText("своя карта"), group: i18nText("карта друзей") };
function scopeName(s) {
  if (!s || s === 'local') return SCOPE_RU.local;
  if (s === accountId) return i18nText("личная облачная карта");
  const r = chanRooms.find(x => x.id === s);
  return r ? (r.title || i18nText("комната")) : i18nText("комната, из которой вышли");
}
// Право удалять портал — одно на все места, где появляется удаление: кнопка под ребром,
// список порталов зоны и меню по правой кнопке. У себя оно есть всегда, в комнате — у её
// смотрит my_role), поэтому кнопка не обещает несбыточного.
//
// Раньше право считалось прямо в обработчике клика по ребру, и владелец собственной
// комнаты читал под своим же порталом «удалять может хранитель», не понимая, что
// хранитель — это он. Теперь условие одно на всех, и разойтись местам негде.
function edgeDeleteScope(d) {
  return edgeMaps(d).includes(chanView) ? chanView : (d.scope || 'local');
}
function canDeleteEdge(d) {
  if (!d) return false;
  const scope = edgeDeleteScope(d);
  if (scope === 'local') return true;
  const room = chanRooms.find(r => r.id === scope);
  return !!(room && (room.isOwner || room.role === 'admin'));
}

// Удаление портала — одинаково из панели и из меню. Возвращает текст ошибки или null.
async function removeEdgeData(d) {
  if (!ipc) return i18nText("нет связи с приложением");
  const r = await ipc.removeEdge(d.a, d.b, edgeDeleteScope(d));
  if (r && r.ok === false) return r.error || i18nText("не удалось");
  render(r && r.snapshot ? r.snapshot : r);
  return null;
}

function refreshSelectedEdge() {
  if (!selectedEdge) return;
  const edge = cy.$id(selectedEdge);
  if (edge.empty()) {
    selectedEdge = null;
    document.getElementById('sel-info').textContent = i18nText("Портал больше не доступен в этой карте");
  } else showEdgeData(edge.data());
}
function showEdgeData(d) {
  const el = document.getElementById('sel-info');
  // откуда ребро — важнее, чем кажется: чужому порталу веры меньше, чем своему.
  // Название канала, а не его код: код игроку ни о чём не говорит.
  const from = d.scope && d.scope !== 'local'
    ? '<br><i>' + esc(scopeName(d.scope)) + '</i>' : '';
  // В групповой карте автор доступен только владельцу и хранителям спустя 15 минут.
  // Сервер не возвращает имена подтвердивших портал, чтобы по ним нельзя было следить
  // за перемещением игроков. Своё имя заменяем на «ты».
  const room = chanRooms.find(r => r.id === chanView);
  const firstSeen = d.firstSeenByMap?.[chanView];
  const authorVisible = chanView === 'local' || (!!room && (room.isOwner || room.role === 'admin')
    && Number.isFinite(firstSeen) && Date.now() - firstSeen >= 15 * 60e3);
  const кто = authorVisible ? whoOf(d, chanView) : [];
  const свой = (accNick || '').toLowerCase();
  const имя = n => (свой && String(n).toLowerCase() === свой ? i18nText("ты") : n);
  const внёс = кто.length
    ? i18nText("<br><i>внёс <b>") + esc(имя(кто[0])) + '</b>' +
      (кто.length > 1 ? i18nText(" · подтвердили ") + кто.slice(1).map(n => esc(имя(n))).join(', ') : '') + '</i>'
    // В новых ответах сервера список подтвердивших пуст: берём задержанного автора
    // из метаданных конкретной карты.
    : (authorVisible && (chanView === 'local' ? d.by : d.authorByMap?.[chanView])
      ? i18nText("<br><i>внёс <b>") + esc(имя(chanView === 'local' ? d.by : d.authorByMap[chanView])) + '</b></i>' : '');
  // Сколько игроков подтвердило портал. Показываем, только пока не хватает: принятое
  // всеми ребро ничем не отличается от обычного, и лишняя подпись на нём — шум.
  // А вот своё непринятое видеть обязательно: иначе игрок решит, что выгрузка не работает.
  // Подтверждения считаются весом, а не штуками: прочитанный с экрана портал — единица,
  // вписанный руками — половина. Поэтому число бывает дробным, и дробь надо объяснить
  // ровно там, где она появилась, — иначе «1,5 из 3» читается как ошибка.
  // Ждёт ли портал подтверждений — вопрос К КОНКРЕТНОЙ КАРТЕ, а не к ребру. Раньше
  // счётчик был один на ребро, и портал, который в комнате друзей видят все, показывался
  // ждущим, потому что своё «1 из 3» на него записывала общая карта. Теперь смотрим на
  const p = pendingFor(d, chanView);
  const half = p && p.confirms % 1 !== 0;
  const где = p && !chanView ? i18nText(" в карте «") + esc(scopeName(p.map)) + '»' : '';
  const ждёт = p
    ? i18nText("<br><i class=\"unconf\">Подтверждений ") + String(p.confirms).replace('.', ',') + i18nText(" из ") + p.needed +
      где + i18nText(" — остальные его пока не видят") +
      (half ? i18nText("<br>Портал, вписанный руками, весит половину") : '') + '</i>' : '';
  const можно = canDeleteEdge(d);
  el.innerHTML = '<b>' + esc(d.a) + '</b> ⇄ <b>' + esc(d.b) + '</b><br>' + esc(d.label || i18nText("таймер неизвестен")) +
    from + внёс + ждёт +
    (можно ? i18nText("<br><button id=\"del-edge\">Удалить портал</button>")
           : '');
  const del = document.getElementById('del-edge');
  if (del) del.onclick = async () => {
    if (!ipc) return;
    const r = await ipc.removeEdge(d.a, d.b, edgeDeleteScope(d));
    if (r && r.ok === false) { el.innerHTML = i18nText("<span class=\"muted small\">не удалось: ") + esc(r.error) + '</span>'; return; }
    render(r && r.snapshot ? r.snapshot : r);
    el.textContent = i18nText("удалено");
  };
}
cy.on('tap', 'edge', evt => {
  selectedEdge = evt.target.id();
  showEdgeData(evt.target.data());
});
// ---------- зона на графе: маршрут и удаление порталов ----------
// Точку старта и точку назначения раньше можно было только напечатать — а зона, от которой
// строят путь, у игрока прямо перед глазами на карте. Теперь она берётся оттуда.
function setRouteFrom(name) {
  ++routeRequestSerial; discardRouteResult();
  applyFold('route-body', true);
  routeMsg(i18nText("введи зону назначения и нажми «Найти путь»"));
  fillFrom(name);
  fromTouched = true;   // выбрали руками — своя зона это поле больше не перебивает
  if (selZone) showSelZone(selZone);
  toast(i18nText("Откуда: ") + name);
}
function setRouteTo(name) {
  const el = document.getElementById('route-to');
  if (!el) return;
  ++routeRequestSerial; discardRouteResult();
  applyFold('route-body', true);
  routeMsg(i18nText("введи зону назначения и нажми «Найти путь»"));
  el.value = name;
  if (selZone) showSelZone(selZone);
  toast(i18nText("Куда: ") + name);
}
// Через resolveDest, а не по сырому тексту: в поле бывает сокращение («couexa»), и
// подсветка «эта зона уже выбрана» иначе не сработала бы там, где выбор на самом деле есть.
function routeDest() {
  const el = document.getElementById('route-to');
  return el ? resolveDest(el.value) : null;
}

// Удаление спрашивает один раз: крестик превращается в «точно?». Тот же приём, что у
// выхода из карты, — действие необратимое, а строка узкая, и промахнуться легко.
let delArmed = null;   // id ребра, у которого удаление уже нажали

// Что показывается в «Выбрано» для зоны: имя, две кнопки маршрута и список порталов
// ИЗ ЭТОЙ ЗОНЫ. Удалять портал кликом по точке проще, чем по линии: линия тонкая, а на
// плотном графе их под курсором несколько, и попасть в нужную — отдельная задача.
function showSelZone(id) {
  const el = document.getElementById('sel-info');
  if (!el) return;
  const node = cy.$id(id);
  const edges = node.nonempty() ? node.connectedEdges() : cy.collection();
  const from = routeOrigin(), to = routeDest();
  const rows = edges.map(e => {
    const d = e.data();
    const other = d.a === id ? d.b : d.a;
    const del = canDeleteEdge(d)
      ? (delArmed === e.id()
        ? '<button type="button" class="armed" data-del="' + esc(e.id()) + i18nText("\" title=\"Нажми ещё раз — портал исчезнет\">точно?</button>")
        : '<button type="button" data-del="' + esc(e.id()) + i18nText("\" title=\"Удалить портал\">×</button>"))
      : '';
    return '<div class="row"><span class="nm">' + esc(other) + '</span>' +
      '<span class="tm">' + esc(d.label || '—') + '</span>' + del + '</div>';
  }).join('');
  el.innerHTML = '<b>' + esc(id) + '</b>' +
    '<div class="sel-acts">' +
      '<button type="button" data-route="from"' + (from === id ? ' class="on"' : '') + i18nText(">Отсюда</button>") +
      '<button type="button" data-route="to"' + (to === id ? ' class="on"' : '') + i18nText(">Сюда</button>") +
    '</div>' +
    '<div class="sel-portals">' +
      (rows
        ? i18nText("<div class=\"cap\">порталы этой зоны: ") + edges.length + '</div>' + rows
        : i18nText("<div class=\"cap\">порталов из этой зоны пока нет</div>")) +
    '</div>';
}

// Обработчик один и навешен навсегда: содержимое панели перерисовывается целиком,
// и вешать кнопкам обработчики заново на каждую отрисовку — верный способ однажды забыть.
const selInfoEl = document.getElementById('sel-info');
if (selInfoEl) selInfoEl.addEventListener('click', async ev => {
  const r = ev.target.closest('[data-route]');
  if (r && selZone) {
    delArmed = null;   // занялись маршрутом — начатое удаление больше не в силе
    return r.dataset.route === 'from' ? setRouteFrom(selZone) : setRouteTo(selZone);
  }
  const b = ev.target.closest('[data-del]');
  if (!b) return;
  const eid = b.dataset.del;
  const e = cy.$id(eid);
  if (e.empty()) return;
  if (delArmed !== eid) { delArmed = eid; return showSelZone(selZone); }   // спрашиваем один раз
  delArmed = null;
  const err = await removeEdgeData(e.data());
  if (err) return toast(i18nText("Не удалось: ") + err);
  if (selZone) showSelZone(selZone);
  toast(i18nText("Портал удалён"));
});

cy.on('tap', 'node', evt => {
  selectedEdge = null;
  const id = evt.target.id();
  delArmed = null;          // выбрали другую зону — незавершённое подтверждение снимаем
  setSelZone(id);           // и запасная точка старта маршрута, пока зона не распознана
  showSelZone(id);
  showCardFor(id);
});
cy.on('dbltap', 'node', evt => {
  const viewport = visibleMapFocus(evt.target, cy.zoom());
  if (viewport) cy.animate({ ...viewport, duration: 250, easing: 'ease-out' });
});
// Пока узел тащат — подписи рёбер погашены (edge.drag-lite в graph-style.js): текст
// с подложками — самое дорогое в кадре, а перерисовка идёт на каждое движение мыши.
// Вешаемся на первое ДВИЖЕНИЕ, а не на grab: grab случается и при обычном клике по
// узлу, и подписи мигали бы на каждое нажатие.
let dragLite = false;
cy.on('drag', 'node', () => {
  if (!dragLite) { dragLite = true; cy.edges().addClass('drag-lite'); }
});
cy.on('free', 'node', () => {
  if (dragLite) { dragLite = false; cy.edges().removeClass('drag-lite'); }
});

// Клик по пустому месту снимает выбор. Раньше выбранная зона держалась до клика по
// другой, и «просто ничего не выбрано» было недостижимым состоянием: панель и карточка
// показывали зону, к которой игрок давно потерял интерес, а маршрут молча строился от неё.
// evt.target === cy означает попадание в холст, а не в узел или ребро.
function clearSelection() {
  selectedEdge = null;
  selZone = null;
  cardZone = null;
  delArmed = null;
  cy.elements(':selected').unselect();
  document.getElementById('sel-info').textContent = i18nText("клик по зоне или порталу");
  const body = document.getElementById('card-body');
  if (body) body.innerHTML = i18nText("<div class=\"muted small\">зона не выбрана</div>");
  toggleCard(false);
  updateOrigin();   // точка старта маршрута снова считается по текущей зоне
}
cy.on('tap', evt => { if (evt.target === cy) clearSelection(); });

// ---------- меню зоны по правой кнопке ----------
// Те же действия, что в панели, но у курсора: рука уже на графе, и вести её в левый
// столбец ради «отсюда» — лишний путь. Устроено как меню канала, только своё.
let gmZone = null;
function closeGraphMenu() {
  const m = document.getElementById('graph-menu');
  if (!m || m.hidden) return;
  fadeOutEl(m, () => m.removeAttribute('style'));
  gmZone = null;
  // Незавершённое «точно?» закрывается вместе с меню. Иначе подтверждение, начатое здесь,
  // досталось бы крестику в панели, и портал исчез бы с одного клика.
  delArmed = null;
}
function graphMenuItems(id) {
  const items = [{ act: 'from', text: i18nText("Начало маршрута") }, { act: 'to', text: i18nText("Конец маршрута") },
    { act: 'via', text: i18nText("Добавить остановку"), disabled: !window.scoutCanAddWaypoint?.() }];
  const node = cy.$id(id);
  if (node.empty()) return items;
  node.connectedEdges().forEach(e => {
    const d = e.data();
    if (!canDeleteEdge(d)) return;
    const other = d.a === id ? d.b : d.a;
    items.push(delArmed === e.id()
      ? { act: 'del:' + e.id(), text: i18nText("Точно удалить портал в ") + other + '?', cls: 'danger' }
      : { act: 'del:' + e.id(), text: i18nText("Удалить портал в ") + other, cls: 'danger' });
  });
  return items;
}
function openGraphMenu(id, at) {
  const m = document.getElementById('graph-menu');
  if (!m) return;
  cancelFadeOut(m);
  gmZone = id;
  m.innerHTML = graphMenuItems(id).map(x =>
    '<button type="button" role="menuitem" data-act="' + esc(x.act) + '"' +
      (x.disabled ? ' disabled title="' + esc(i18nText("Можно добавить не больше шести остановок.")) + '"' : '') +
      (x.cls ? ' class="' + x.cls + '"' : '') + '>' + esc(x.text) + '</button>').join('');
  if (at) {
    // у курсора и по окну: граф прокручивается и масштабируется, привязка к нему уехала бы
    m.style.position = 'fixed';
    m.style.left = Math.round(at.x) + 'px';
    m.style.top = Math.round(at.y) + 'px';
    m.style.right = 'auto';
    m.style.width = '220px';
  }
  m.hidden = false;
  // меню длиннее окна снизу — поднимаем, иначе нижние пункты недоступны
  const r = m.getBoundingClientRect();
  if (at && r.bottom > window.innerHeight - 8) {
    m.style.top = Math.max(8, Math.round(window.innerHeight - 8 - r.height)) + 'px';
  }
}
cy.on('cxttap', 'node', evt => {
  const id = evt.target.id();
  const oe = evt.originalEvent;
  closeChanMenu();
  delArmed = null;                  // новое меню — новое подтверждение
  setSelZone(id);                   // ПКМ тоже выбирает зону: панель и меню про одно и то же
  showSelZone(id);
  showCardFor(id);
  openGraphMenu(id, oe ? { x: oe.clientX + 2, y: oe.clientY + 2 } : null);
});
// Любое движение графа уводит меню от зоны, к которой оно относится, — закрываем.
cy.on('tap pan zoom', closeGraphMenu);
const graphMenuEl = document.getElementById('graph-menu');
if (graphMenuEl) graphMenuEl.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]');
  if (!b || !gmZone) return;
  const act = b.dataset.act, zone = gmZone;
  if (act === 'from') { closeGraphMenu(); return setRouteFrom(zone); }
  if (act === 'to') { closeGraphMenu(); return setRouteTo(zone); }
  if (act === 'via') {
    closeGraphMenu();
    if (!window.scoutAddWaypoint?.(zone)) return;
    applyFold('route-body',true);
    const state=foldState();state['route-body']=true;foldSave(state);
    document.querySelector('.scout-waypoint:last-child')?.scrollIntoView({block:'nearest'});
    return toast(i18nText("Остановка добавлена: ")+zone);
  }
  if (act.slice(0, 4) !== 'del:') return;
  const eid = act.slice(4);
  const e = cy.$id(eid);
  if (e.empty()) return closeGraphMenu();
  if (delArmed !== eid) { delArmed = eid; return openGraphMenu(zone, null); }   // спрашиваем один раз
  delArmed = null;
  closeGraphMenu();
  const err = await removeEdgeData(e.data());
  if (err) return toast(i18nText("Не удалось: ") + err);
  if (selZone) showSelZone(selZone);
  toast(i18nText("Портал удалён"));
});
// Своё меню окна на графе не нужно: там нечего копировать, а наше оно перекрывает.
const cyEl = document.getElementById('cy');
if (cyEl) cyEl.addEventListener('contextmenu', ev => ev.preventDefault());
function canRearrangeMap(){if(chanView==='local')return true;const room=Array.isArray(chanRooms)&&chanRooms.find(r=>r.id===chanView);return !!(room&&(room.isOwner||['admin','moderator','verified'].includes(room.role)));}
document.getElementById('btn-relayout').onclick = async () => {
  if (!cy.nodes().length) return;
  if (!canRearrangeMap()) {
    toast(i18nText("Перестроить карту могут Хранитель и Проверенный.")); return;
  }
  const context = layoutContext(), before = graphPositions(), zoom = cy.zoom(), pan = { ...cy.pan() };
  const button = document.getElementById('btn-relayout');
  button.disabled = true;
  try {
    fullLayout();
    const proposed = graphPositions();
    const positions = await stableLayout.resolve({ ...context, nodeIds: Object.keys(proposed),
      edgePairs: cy.edges().map(e => [e.data('source'), e.data('target')]), replacePositions: proposed });
    if (context.key === layoutContext().key) {
      cy.batch(() => cy.nodes().forEach(n => { if (positions[n.id()]) n.position(positions[n.id()]); }));
      window.BRIDGE_LAYOUT.apply(cy);
    }
  } catch (_) {
    if (context.key === layoutContext().key) {
      cy.batch(() => cy.nodes().forEach(n => { if (before[n.id()]) n.position(before[n.id()]); }));
      cy.viewport({ zoom, pan });
      window.BRIDGE_LAYOUT.apply(cy);
      toast(i18nText("Не удалось сохранить расположение в облаке."));
    }
  } finally { button.disabled = false; }
};
document.getElementById('btn-fit').onclick = () => fitGraph(true);

// «Моя зона» — навести камеру туда, где игрок сейчас.
//
// Кнопка обязана объяснять отказ, а не молчать: зона бывает неизвестна (слежение выключено
// или плашку ещё не прочитали), а известная зона бывает не показана на графе — узлы
// строятся только из концов рёбер, и в зоне без единого записанного портала показывать
// нечего. Молчащая кнопка в обоих случаях читается как поломка.
let locateTimer = null, centerTimer = null;
function centerOnMe() {
  if (!curZone) {
    toast(cfg && !cfg.zoneWatch
      ? i18nText("Слежение за зоной выключено — приложение не знает, где ты")
      : i18nText("Зона пока не прочитана — зайди в игру и подожди пару секунд"));
    return;
  }
  const n = cy.$id(curZone);
  if (n.empty()) {
    // Зона известна, но её нет в открытом канале — это разные причины, и лечатся они разным.
    toast(i18nText("{0}: в этой карте порталов отсюда нет — выбери другую карту слева", [curZone]));
    return;
  }
  const viewport = visibleMapFocus(n, Math.max(cy.zoom(), 0.9));
  if (!viewport) return;
  const было = { x: cy.pan().x, y: cy.pan().y };
  cy.animate({ ...viewport, duration: 320, easing: 'ease-out' });
  // Страховка на случай, если анимация не проиграется. В скрытом тестовом окне `cy.animate`
  // не двигает камеру ВООБЩЕ (нет анимационного цикла), а `cy.viewport` двигает. Кнопка
  // «наведи камеру» обязана наводить камеру при любой погоде, поэтому через 400 мс
  // проверяем: панорама не сдвинулась НИ НА СКОЛЬКО — значит анимации не было, доводим
  // руками. Сравниваем именно с исходным значением, а не с расстоянием до центра: если
  // игрок увёл карту сам, пока ехала анимация, — это его выбор, и отнимать его не надо.
  clearTimeout(centerTimer);
  centerTimer = setTimeout(() => {
    if (cy.pan().x === было.x && cy.pan().y === было.y) cy.viewport(viewport);
  }, 400);
  clearTimeout(locateTimer);
  n.addClass('locate');
  locateTimer = setTimeout(() => n.removeClass('locate'), 1600);
}
document.getElementById('btn-me').onclick = centerOnMe;

// Поиск в верхней панели работает только с узлами открытой карты. Справочник
// всех зон живёт в окне приложения; игровой хоткей по-прежнему открывает оверлей.
const mapSearchRoot = document.getElementById('map-search');
const mapSearchButton = document.getElementById('find-avalon');
const avalonGuideButton = document.getElementById('open-avalon-guide');
const mapSearchPop = document.getElementById('map-search-pop');
const mapSearchInput = document.getElementById('map-search-input');
const mapSearchResults = document.getElementById('map-search-results');
let mapSearchItems = [];
let mapSearchIndex = 0;
let mapSearchLocateTimer = null;
let mapSearchCenterTimer = null;

function closeMapSearch() {
  if (!mapSearchPop) return;
  mapSearchPop.hidden = true;
  mapSearchButton.setAttribute('aria-expanded', 'false');
}

function updateMapSearchResults() {
  if (!mapSearchPop || mapSearchPop.hidden) return;
  const query = mapSearchInput.value.trim();
  const zones = cy.nodes().map(n => ({
    name: n.id(),
    color: zoneInfoCache[n.id()]?.color || zoneColorCache[n.id()] || demoColors[n.id()] || 'avalon',
    tier: zoneInfoCache[n.id()]?.tier || n.data('tier') || null,
  }));
  mapSearchItems = !query ? [] : /^[468]$/.test(query)
    ? window.ZONE_SEARCH.searchTier(zones, query)
    : window.ZONE_SEARCH.search(zones, query, 10);
  mapSearchIndex = 0;
  if (!mapSearchItems.length) {
    mapSearchResults.innerHTML = '<div class="map-search-empty">' +
      (query ? i18nText("На открытой карте такой зоны нет") : cy.nodes().length
        ? i18nText("Введи название зоны или уровень 4, 6, 8") : i18nText("В этой карте пока нет порталов")) + '</div>';
    return;
  }
  mapSearchResults.innerHTML = mapSearchItems.map((z, i) =>
    '<button class="map-search-result' + (i === 0 ? ' on' : '') + '" type="button" data-i="' + i + '">' +
      '<i class="dot ' + esc(z.color || 'avalon') + '"></i><span>' + markName(z.name, z.marks) + '</span>' +
      (z.tier ? '<small class="map-search-tier">T' + esc(z.tier) + '</small>' : '') +
    '</button>').join('');
}

function chooseMapSearchResult(index) {
  const item = mapSearchItems[index];
  if (!item) return;
  const node = cy.$id(item.name);
  if (node.empty()) { updateMapSearchResults(); return; }
  closeMapSearch();
  selectedEdge = null;
  delArmed = null;
  setSelZone(item.name);
  showSelZone(item.name);
  showCardFor(item.name);
  const viewport = visibleMapFocus(node, Math.max(cy.zoom(), 0.9));
  if (viewport) {
    const previousPan = { x: cy.pan().x, y: cy.pan().y };
    cy.animate({ ...viewport, duration: 320, easing: 'ease-out' });
    clearTimeout(mapSearchCenterTimer);
    mapSearchCenterTimer = setTimeout(() => {
      if (cy.pan().x === previousPan.x && cy.pan().y === previousPan.y) cy.viewport(viewport);
    }, 400);
  }
  clearTimeout(mapSearchLocateTimer);
  cy.elements('.locate').removeClass('locate');
  node.addClass('locate');
  mapSearchLocateTimer = setTimeout(() => node.removeClass('locate'), 2200);
}

if (mapSearchButton) mapSearchButton.onclick = () => {
  if (!mapSearchPop.hidden) { closeMapSearch(); return; }
  mapSearchPop.hidden = false;
  mapSearchButton.setAttribute('aria-expanded', 'true');
  mapSearchInput.value = '';
  updateMapSearchResults();
  mapSearchInput.focus();
};
if (mapSearchInput) {
  mapSearchInput.addEventListener('input', updateMapSearchResults);
  mapSearchInput.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeMapSearch(); mapSearchButton.focus(); }
    else if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && mapSearchItems.length) {
      ev.preventDefault();
      mapSearchIndex = (mapSearchIndex + (ev.key === 'ArrowDown' ? 1 : -1) + mapSearchItems.length) % mapSearchItems.length;
      [...mapSearchResults.children].forEach((el, i) => el.classList.toggle('on', i === mapSearchIndex));
      mapSearchResults.children[mapSearchIndex]?.scrollIntoView({ block: 'nearest' });
    } else if (ev.key === 'Enter') { ev.preventDefault(); chooseMapSearchResult(mapSearchIndex); }
  });
}
if (mapSearchResults) mapSearchResults.addEventListener('click', ev => {
  const row = ev.target.closest('[data-i]');
  if (row) chooseMapSearchResult(Number(row.dataset.i));
});

const avalonGuideDialog = document.getElementById('avalon-guide-dialog');
const avalonGuideInput = document.getElementById('avalon-guide-search');
const avalonGuideResults = document.getElementById('avalon-guide-results');
const avalonGuideDetail = document.getElementById('avalon-guide-detail');
let avalonGuideZones = [];
let avalonGuideSelected = null;

function renderAvalonGuideResults() {
  const query = avalonGuideInput.value.trim();
  const matches = !query ? avalonGuideZones.slice(0, 100)
    : /^[468]$/.test(query) ? window.ZONE_SEARCH.searchTier(avalonGuideZones, query).slice(0, 100)
    : window.ZONE_SEARCH.search(avalonGuideZones, query, 100);
  avalonGuideResults.innerHTML = matches.length ? matches.map(zone => {
    const tier = zone.tier || avalonGuideZones.find(item => item.name === zone.name)?.tier;
    return '<button type="button" data-zone="' + esc(zone.name) + '"' +
      (zone.name === avalonGuideSelected ? ' class="on"' : '') + '><span>' +
      window.ZONE_SEARCH.mark(zone.name, zone.marks, esc) + '</span>' +
      (tier ? '<small>T' + esc(tier) + '</small>' : '') + '</button>';
  }).join('') : '<p class="small muted">' + i18nText("Авалон не найден") + '</p>';
}

function selectAvalonGuideZone(name) {
  const summary = avalonGuideZones.find(zone => zone.name === name);
  if (!summary) return;
  avalonGuideSelected = name;
  renderAvalonGuideResults();
  renderZoneDetails(avalonGuideDetail, rememberZone(zoneInfoCache[name] || {
    name, color: 'avalon', tier: summary.tier, activities: demoActs[name] || null,
  }));
  if (ipc?.getZoneInfo) Promise.resolve(ipc.getZoneInfo(name)).then(info => {
    if (info?.name === name) rememberZone(info);
    if (avalonGuideDialog.open && avalonGuideSelected === name && info?.name === name)
      renderZoneDetails(avalonGuideDetail, zoneInfoCache[name]);
  }).catch(() => {});
}

async function openAvalonGuide() {
  if (avalonGuideDialog.open) return;
  closeMapSearch();
  let names = zoneNames;
  if (ipc?.getZoneNames && !names.length) {
    try { names = await ipc.getZoneNames(); } catch { names = []; }
    if (Array.isArray(names) && names.length) zoneNames = names;
  } else if (!ipc) {
    try {
      const response = await fetch('../data-static/zone-data.json');
      if (response.ok) {
        const data = await response.json();
        names = data.map(z => ({ name: z.name, color: 'avalon', tier: z.tier }));
        data.forEach(z => rememberZone({ name: z.name, color: 'avalon', tier: z.tier, activities: z }));
      }
    } catch { /* The static demo can still use its sample zones. */ }
  }
  if (avalonGuideDialog.open) return;
  avalonGuideZones = (Array.isArray(names) ? names : [])
    .filter(zone => zone?.color === 'avalon')
    .sort((a, b) => a.name.localeCompare(b.name));
  avalonGuideSelected = null;
  avalonGuideInput.value = '';
  avalonGuideDetail.textContent = i18nText("Выбери Авалон из списка");
  renderAvalonGuideResults();
  avalonGuideDialog.showModal();
  avalonGuideInput.focus();
}

if (avalonGuideButton) avalonGuideButton.onclick = () => { void openAvalonGuide(); };
document.getElementById('avalon-guide-close').onclick = () => avalonGuideDialog.close();
avalonGuideDialog.addEventListener('close', () => avalonGuideButton.focus({ preventScroll: true }));
avalonGuideDialog.addEventListener('click', ev => { if (ev.target === avalonGuideDialog) avalonGuideDialog.close(); });
avalonGuideInput.addEventListener('input', () => {
  avalonGuideSelected = null;
  avalonGuideDetail.textContent = i18nText("Выбери Авалон из списка");
  renderAvalonGuideResults();
});
avalonGuideResults.addEventListener('click', ev => {
  const button = ev.target.closest('button[data-zone]');
  if (button) selectAvalonGuideZone(button.dataset.zone);
});
document.addEventListener('pointerdown', ev => {
  if (mapSearchRoot && !mapSearchRoot.contains(ev.target)) closeMapSearch();
});

// ---------- журнал и тосты ----------
function logTransition(from, to) {
  // The first known position and a repeat of the same zone are not transitions.
  if (!from || !to || from === to) return;
  const el = document.getElementById('log');
  const row = document.createElement('div');
  row.className = 'journal-row';
  const stamp = document.createElement('time');
  stamp.textContent = new Date().toLocaleTimeString((globalThis.AvalonI18n?.locale() || 'ru-RU'), { hour: '2-digit', minute: '2-digit' });
  row.append(stamp, ' ');
  // Render the destination as text, never HTML from OCR/network strings.
  const tag = document.createElement('span');
  const color = zoneColorCache[to] || demoColors[to];
  tag.className = 'journal-zone'; tag.textContent = to;
  tag.dataset.color = color || 'unknown';
  tag.title = ZONE_TYPE_RU[color] || i18nText("Тип зоны пока неизвестен");
  row.append(tag);
  el.prepend(row);
  while (el.children.length > 60) el.lastChild.remove();
}
let toastTimer = null;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// ---------- панель: статус и настройки ----------
// Живут на уровне модуля, а не внутри ветки Electron: ровно эти же строки и
// переключатели показывает стенд оформления, где ipc нет.
// Строка статуса складывается из трёх вещей: бинд хоткея, запущена ли игра и что
// именно приложение сейчас делает по настройкам.
let bindLabel = '—', gameOn = null, placing = false;
function setBindingLabel(target, label) {
  const labels = { binding: 'bind-label', manualBinding: 'manual-bind-label', searchBinding: 'search-bind-label',
    overlayToggleBinding: 'overlay-toggle-bind-label' };
  document.getElementById(labels[target] || labels.binding).textContent = label;
  document.querySelectorAll('[data-binding="' + target + '"]').forEach(el => { el.textContent = label; });
  if (target === 'binding') { bindLabel = label; renderStatus(); }
}
function renderStatus() {
  const el = document.getElementById('status');
  const key = i18nText("хоткей {0}", [bindLabel]) + (cfg && !cfg.cursorScan ? i18nText(" — поиск зоны") : '');
  // Строка состояния называет ИСТОЧНИК зоны: у трафика и экрана разные признаки покоя,
  // и «опрос приостановлен» у трафика значило бы неправду — он слушает всегда.
  const src = cfg ? cfg.zoneSource : 'screen';
  const watch = cfg && cfg.zoneError ? i18nText("трафик не слушается: ") + cfg.zoneError
    : src === 'off' ? i18nText("зона не отслеживается")
    : src === 'traffic' ? i18nText("зона из трафика игры")
    // «Слежу за экраном» читалось как «я слежу за тобой». Речь о работе механизма.
    : gameOn === false ? i18nText("игра не запущена · опрос приостановлен") : i18nText("отслеживание экрана работает");
  el.textContent = `${watch} · ${key}`;
  el.classList.toggle('idle',
    !!(cfg && (cfg.zoneError || src === 'off')) || (src === 'screen' && gameOn === false));
}
function setPlacing(on) {
  placing = on;
  const b = document.getElementById('ov-place');
  b.classList.toggle('active', on);
  b.textContent = on ? i18nText("Готово") : i18nText("Задать место");
}
// Кнопки «Тёмная / Светлая». Без ipc (стенд оформления) переключаем прямо здесь —
// иначе тему нельзя было бы посмотреть там, где её как раз и правят.
document.querySelectorAll('[data-theme-pick]').forEach(b => {
  b.onclick = async () => {
    const t = b.dataset.themePick;
    if (ipc && typeof ipc.setOption === 'function') applyConfig(await ipc.setOption('theme', t));
    else { applyTheme(t); applyConfig(Object.assign({}, cfg, { theme: t })); }
  };
});

// ---------- откуда берётся зона ----------
// Источник ровно один: выбранный выключает остальные. Поэтому переключатель, а не
// галочки, — двумя галочками игрок неизбежно поставил бы обе и ждал, что работают обе.
const ZONE_SRC = {
  screen: i18nText("Название зоны считывается с экрана каждые 1,5–6 секунд. Область чтения настраивается ниже."),
  traffic: i18nText("Зона определяется по трафику игры. Снимки зоны не создаются, в том числе при ошибках соединения. ") +
           i18nText("Требуются права администратора. После запуска зона определяется при переходе или задаётся вручную."),
  off: i18nText("Определение зоны отключено в прежней настройке. Выбери «С экрана» или «Из трафика»."),
};
document.querySelectorAll('[data-zone-src]').forEach(b => {
  b.onclick = async () => {
    if (ipc && typeof ipc.setOption === 'function') {
      applyConfig(await ipc.setOption('zoneSource', b.dataset.zoneSrc));
    }
  };
});
function applyZoneSrc(c) {
  const src = ZONE_SRC[c.zoneSource] ? c.zoneSource : 'screen';
  document.querySelectorAll('[data-zone-src]').forEach(b => {
    const on = b.dataset.zoneSrc === src;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const note = document.getElementById('zone-src-note');
  if (note) note.textContent = ZONE_SRC[src];
  // Выбранный источник может не работать (трафику нужны права администратора). Молчать
  // об этом нельзя: в окне всё выглядело бы включённым, а зона не появлялась бы никогда.
  const err = document.getElementById('zone-src-err');
  if (err) {
    err.hidden = !c.zoneError;
    err.textContent = c.zoneError ? i18nText("Не работает: ") + c.zoneError : '';
  }
  // Настройка области нужна только чтению с экрана — при других источниках она ни на что
  // не влияет, а настройка, которая ни на что не влияет, хуже отсутствующей.
  const zk = document.getElementById('zone-opts');
  if (zk) { if (src === 'screen') zk.removeAttribute('data-off'); else zk.setAttribute('data-off', '1'); }
}

// ---------- тема ----------
// Всё оформление висит на переменных CSS, поэтому теме достаточно переставить один
// атрибут. Одно исключение — граф: он рисуется на canvas, переменных CSS не видит вовсе,
// и стиль ему приходится пересобирать руками. Стиль перечитывает те же переменные, так
// что второго списка цветов не заводится.
const THEMES = {
  dark:  i18nText("Тёмная с фактурой игры: дерево и золото"),
  coal:  i18nText("Тёмная нейтральная: графит и терракота"),
  light: i18nText("Светлая: пергамент, коричневые чернила, то же золото"),
};
let themeNow = null;
function applyTheme(name) {
  const t = THEMES[name] ? name : 'dark';   // чужое значение — обратно к теме по умолчанию
  // Подпись и нажатая кнопка ставятся ЗДЕСЬ, а не в applyConfig: applyConfig знает только
  // то, что пришло из главного процесса, и предпросмотр по ?theme= шёл мимо него — окно
  // было в одной теме, а кнопка показывала другую.
  const note = document.getElementById('theme-note');
  if (note) note.textContent = THEMES[t];
  document.querySelectorAll('[data-theme-pick]').forEach(b => {
    const on = b.dataset.themePick === t;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if (t === themeNow) return;
  themeNow = t;
  document.documentElement.dataset.theme = t;
  if (typeof cy !== 'undefined' && typeof window.graphStyle === 'function') {
    cy.style(window.graphStyle());
  }
}
// Панель не хранит своего состояния: она рисует то, что вернул main-процесс.
// Так переключатель не может «показывать включено», когда на деле выключено.
// Какой ползунок сейчас держат мышью: 'ov-scale' | 'ov-hold' | null. Пока он под пальцем,
// applyConfig его не переписывает — см. подробности там же.
let sliderHeld = null;
function applyConfig(c) {
  if (!c) return;
  cfg = c;
  window.AvalonSubscriptionsUI?.render(c.billing);
  const languageSelect = document.getElementById('interface-language');
  if (languageSelect) languageSelect.value = c.language || globalThis.AvalonI18n?.language || 'ru';
  const profileBadge = document.getElementById('profile-badge');
  if (profileBadge) profileBadge.hidden = !c.secondaryAccount;
  for (const id of ['bind-btn', 'manual-bind-btn', 'search-bind-btn', 'overlay-toggle-bind-btn']) {
    const button = document.getElementById(id);
    if (button) button.disabled = !!c.secondaryAccount;
  }
  if (c.secondaryAccount) document.getElementById('binding-hint').textContent = i18nText("Хоткеи работают в основном окне. Здесь можно проверять карту группы и действия второго участника.");
  const portalCity = document.getElementById('route-portal-city');
  if (portalCity) {
    portalCity.value = c.outlandsPortalCity || '';
    document.getElementById('route-portal-current').textContent = portalCity.selectedOptions[0]?.textContent || '';
  }
  if (cloudSignedIn) {
    const note = document.getElementById('acc-who-note');
    if (note) note.textContent = i18nText("Личная облачная карта доступна только твоему аккаунту.");
  }
  setBindingLabel('searchBinding', c.secondaryAccount ? '—' : c.searchBinding?.label || 'F10');
  setBindingLabel('binding', c.secondaryAccount ? '—' : c.binding?.label || 'F9');
  setBindingLabel('manualBinding', c.secondaryAccount ? '—' : c.manualBinding?.label || 'F8');
  setBindingLabel('overlayToggleBinding', c.overlayToggleBinding?.label || '—');
  document.getElementById('overlay-toggle-clear').disabled = !c.overlayToggleBinding;
  applyTheme(c.theme);
  // Переключатели живут в окне настроек, а не в панели — ищем по всему документу
  document.querySelectorAll('input[data-opt]').forEach(inp => {
    inp.checked = !!c[inp.dataset.opt];
  });
  const kids = document.getElementById('overlay-opts');
  if (c.overlayEnabled) kids.removeAttribute('data-off'); else kids.setAttribute('data-off', '1');
  applyZoneSrc(c);
  // Ползунок, который сейчас тянут, эхом НЕ трогаем. Значение возвращается из главного
  // процесса с задержкой в круг IPC: пока оно шло, палец уехал дальше — и ручка прыгала
  // назад, к позапрошлому значению. Плашка при этом дёргалась туда-сюда вслед за ней.
  const scale = Math.round((c.overlayScale || 1) * 100);
  if (sliderHeld !== 'ov-scale') {
    document.getElementById('ov-scale').value = scale;
    document.getElementById('ov-scale-val').textContent = scale + '%';
  }
  const hold = c.overlayHoldSec || 7;
  if (sliderHeld !== 'ov-hold') {
    document.getElementById('ov-hold').value = hold;
    document.getElementById('ov-hold-val').textContent = hold + i18nText(" с");
  }
  document.getElementById('ov-place-note').textContent = c.overlayPos
    ? i18nText("Своё место: {0}, {1} (нижний левый угол)", [Math.round(c.overlayPos.x), Math.round(c.overlayPos.bottom)])
    : i18nText("Стандартное место — над миникартой справа внизу");
  document.getElementById('ov-reset').disabled = !c.overlayPos;
  // Версия живёт только в окне настроек: в панели она занимала строку, которую читают раз
  // в жизни, а рядом с ней стоит блок «вышла новая» — он и есть то, что важно видеть.
  if (c.appVersion) document.getElementById('modal-version').textContent = i18nText("версия ") + c.appVersion;
  // Симуляция — инструмент разработки: подсовывает распознавателю картинку с диска вместо
  // экрана игры. Игрок её не видит ни в собранной сборке, ни при обычном запуске из
  // исходников: нужен явный AVALON_DEV=1.
  document.getElementById('sim').hidden = !c.dev;
  // Слежение выключили — main-процесс забыл текущую зону, и панель обязана
  // показать то же самое: иначе маршрут строился бы от зоны, где нас уже нет.
  if (!c.zoneWatch && curZone) {
    curZone = null;
    updateOrigin();
    document.getElementById('cur-zone').textContent = i18nText("— не отслеживается");
  }
  // точки выгрузки в списке каналов и тумблеры комнат читаются из настроек
  renderChannels();
  renderRoomToggles();
  renderStatus();
}

// Версия внизу панели и предложение обновиться. Приложение раздаётся файлом, поэтому
// «вышла новая сборка» должно быть видно в самом приложении — иначе половина друзей
// останется на старой навсегда. Скачивание открывается в браузере: ничего не качаем
// и не запускаем сами.
// ---------- каналы ----------
// Переключение канала меняет ТОЛЬКО видимое. Куда уходят новые порталы — отдельный вопрос,
// на него отвечает переключатель выгрузки у каждого канала. Так можно смотреть общую карту,
// записывая при этом лишь к себе, и это осознанное разделение, а не недоделка.
//
let authSignedIn = false; // Discord нужен для карт друзей
let cloudSignedIn = false; // гостевая учётная запись тоже синхронизирует личную карту
let accNick = null;       // свой ник: в списке подтвердивших он заменяется на «ты»
let accountId = null;
let layoutAccountId = null;
let chanView = 'local';     // personal map or a joined group
let chanRooms = [];         // [{ id, title, upload }]

// Видно ли ребро в выбранном канале.
//
// Ребро принадлежит НЕСКОЛЬКИМ картам сразу: свой портал уходит и в личную, и в комнату,
// и канал комнаты показывал только чужие порталы. Выглядело как «выгрузка не работает».
// scope при этом остаётся и отвечает на другой вопрос: откуда мы про портал узнали.
function edgeMaps(e) {
  return Array.isArray(e.maps) && e.maps.length ? e.maps : [e.scope || 'local'];
}
function edgeInView(e) {
  return edgeMaps(e).includes(chanView);
}

// Значок канала — буквы названия, как у значка сервера в Discord. Одно слово даёт одну
// букву, несколько — по первой от каждого из двух первых: «Всё вместе» → ВВ, «Личная» → Л.
function initials(name) {
  const parts = String(name || '').trim().split(/[\s\-_]+/).filter(Boolean);
  if (!parts.length) return '—';
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0][0];
  return s.toUpperCase();
}

// Каналы одним списком: по нему строится и полоса значков, и шапка колонки. Подпись
// у каждого своя — «Всё вместе» иначе не объяснить ничем, кроме догадки.
// Включена ли общая карта. Выключатель живёт в lib/sync.js и приезжает в настройках —
// своей копии здесь нет намеренно. Пока конфиг не пришёл, считаем выключенной: показать
// канал и тут же его убрать хуже, чем показать на долю секунды позже.

function channelItems() {
  return [
    { id: 'local', name: i18nText("Личная"), sub: cloudSignedIn ? i18nText("На компьютере и в личном облаке") : i18nText("На этом компьютере"), up: true },
    // Комнаты — в самом низу и в порядке появления: их число растёт, а первые три места
    // должны оставаться на своих местах, иначе промахиваться будешь каждый раз.
    // Своя роль стоит прямо в подписи: «почему мой портал сюда не ушёл» — вопрос, на
    // который интерфейс обязан отвечать до того, как его зададут.
    ...(authSignedIn ? chanRooms : []).map(r => ({
      id: r.id, name: r.title || i18nText("Комната"), room: true, up: !!r.upload && r.role !== 'viewer',
      sub: r.role === 'viewer' ? i18nText("Карта друзей · у тебя только просмотр")
        : r.role === 'admin' ? i18nText("Карта друзей · ты хранитель")
        : r.role === 'moderator' ? i18nText('Карта друзей · ты модератор')
        : r.role === 'verified' ? i18nText("Карта друзей · ты проверенный")
        : i18nText("Карта друзей — видят те, кому ты дал код"),
    })),
  ];
}

function renderChannels() {
  const box = document.getElementById('chan-list');
  if (!box) return;
  const items = channelItems();
  // Выбранного канала больше нет — вышли из комнаты, выключили общую карту или
  // сменили аккаунт. Возвращаемся в личную карту и перестраиваем граф.
  const resetView = !items.some(it => it.id === chanView);
  if (resetView) { chanView = 'local'; markViewChanged(); }
  box.innerHTML = items.map(it =>
    '<button class="rail-btn' + (it.id === chanView ? ' on' : '') + (it.up ? ' up' : '') + '" type="button"' +
        ' data-id="' + esc(it.id) + '" aria-label="' + esc(it.name) + '"' +
        // В подсказку кладём и смысл обводки: значок сам себя объяснить не может, а обводка
        // молча решает судьбу каждого нового портала.
        ' data-tip="' + esc(it.name + (it.up ? i18nText(" · сюда пишутся новые порталы") : '')) + '">' +
      '<span class="rail-ico">' + esc(initials(it.name)) + '</span>' +
    '</button>').join('');
  renderChanHead();
  if (resetView && lastSnap) render(lastSnap);
}

// Шапка колонки — имя выбранного канала, как имя сервера в Discord, плюс строчка о том,
// что это за канал, и отдельная строка про золотую точку, когда она горит.
function renderChanHead() {
  document.getElementById('btn-relayout').hidden=!canRearrangeMap();
  const changesEntry = document.getElementById('changes-entry');
  if (changesEntry) changesEntry.hidden = !canViewChangeJournal();
  if (!canViewChangeJournal() && document.getElementById('changes-dialog')?.open)
    document.getElementById('changes-dialog').close();
  const it = channelItems().find(x => x.id === chanView);
  const title = document.getElementById('chan-title');
  if (!title) return;
  title.textContent = it ? it.name : i18nText("Канал");
  document.getElementById('chan-sub').textContent = it ? it.sub : '';
  document.getElementById('chan-up-note').hidden = !(it && it.up);
  // стрелка, наведение и фокус с клавиатуры. Кликабельный заголовок, который ничего не
  // открывает, — обещание, которого интерфейс не держит.
  const head = document.getElementById('chan-head');
  const noMenu = !!(it && it.noMenu);
  head.classList.toggle('flat', noMenu);
  head.disabled = noMenu;
  if (noMenu) head.removeAttribute('aria-haspopup'); else head.setAttribute('aria-haspopup', 'menu');
}

function canViewChangeJournal() {
  if (chanView === 'local') return true;
  const room = chanRooms.find(r => r.id === chanView);
  return !!room && (room.isOwner || room.role === 'admin');
}
function renderChangeJournal() {
  const list = document.getElementById('changes-list');
  if (!list || !canViewChangeJournal()) return;
  const now = Date.now();
  const edges = (lastSnap?.edges || []).filter(e => edgeInView(e) && edgeAlive(e, now))
    .sort((a, b) => (b.firstSeenByMap?.[chanView] || b.createdAt || b.updatedAt || 0)
      - (a.firstSeenByMap?.[chanView] || a.createdAt || a.updatedAt || 0)).slice(0, 300);
  list.replaceChildren();
  if (!edges.length) {
    const empty = document.createElement('p'); empty.className = 'muted small';
    empty.textContent = i18nText('В этой карте нет активных порталов.'); list.append(empty); return;
  }
  const locale = document.documentElement.lang === 'en' ? 'en-US' : 'ru-RU';
  const knownColors = new Map(zoneNames.map(zone => [zone.name, zone.color]));
  const colorOf = name => zoneInfoCache[name]?.color || zoneColorCache[name]
    || knownColors.get(name) || demoColors[name] || 'unknown';
  for (const edge of edges) {
    const firstSeen = chanView === 'local' ? (edge.createdAt || edge.updatedAt || now)
      : (edge.firstSeenByMap?.[chanView] || edge.updatedAt || now);
    const author = chanView === 'local' ? edge.by : edge.authorByMap?.[chanView];
    const item = document.createElement('div'); item.className = 'changes-item';
    const title = document.createElement('strong');
    const zoneName = name => {
      const label = document.createElement('span');
      label.className = 'changes-zone';
      label.dataset.color = colorOf(name);
      label.textContent = name;
      return label;
    };
    title.append(zoneName(edge.a), ' ⇄ ', zoneName(edge.b));
    const details = document.createElement('div'); details.className = 'changes-meta';
    const expires = edge.expiresAt || edge.updatedAt + 6 * 3600e3;
    const time = document.createElement('span');
    time.textContent = i18nText('Закроется: {0} · через {1}', [
      new Date(expires).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
      fmtLeft(expires - now)]);
    const by = document.createElement('span');
    by.textContent = now - firstSeen < 15 * 60e3
      ? i18nText('Автор появится через {0}', [fmtLeft(15 * 60e3 - (now - firstSeen))])
      : i18nText('Добавил: {0}', [author || i18nText('Неизвестно')]);
    details.append(time, by); item.append(title, details); list.append(item);
  }
}
const changesDialog = document.getElementById('changes-dialog');
document.getElementById('changes-toggle')?.addEventListener('click', () => {
  if (!canViewChangeJournal()) return;
  renderChangeJournal(); changesDialog.showModal();
});
document.getElementById('changes-close')?.addEventListener('click', () => changesDialog.close());
changesDialog?.addEventListener('click', event => { if (event.target === changesDialog) changesDialog.close(); });
setInterval(() => { if (!document.hidden && changesDialog?.open) renderChangeJournal(); }, 30000);

// Смена выбранного канала — переклейка класса, а не перестройка полосы. Это не экономия:
// у выбранного значка золотая скоба слева растёт по переходу, а сам значок меняет
// скругление. Пересоздай разметку — переходить будет нечему, и всё это моргнёт.
function markChannel() {
  document.querySelectorAll('#chan-list .rail-btn').forEach(c => c.classList.toggle('on', c.dataset.id === chanView));
  renderChanHead();
}

// думает о них одинаково — «куда попадёт следующий портал», — и разносить их по разным
// местам значило бы прятать половину ответа.
function renderRoomToggles() {
  const box = document.getElementById('set-rooms');
  if (!box) return;
  if (!authSignedIn) {
    box.innerHTML = i18nText("<div class=\"opt-note\">Для карт друзей войди через Discord.</div>");
    return;
  }
  if (!chanRooms.length) {
    box.innerHTML = i18nText("<div class=\"opt-note\">Карт друзей пока нет. Создать свою или войти по коду — ") +
      i18nText("кнопкой «+» у списка каналов слева.</div>");
    return;
  }
  box.innerHTML = chanRooms.map(r =>
    '<label class="opt"><input type="checkbox" data-room="' + esc(r.id) + '"' + (r.upload && r.role !== 'viewer' ? ' checked' : '') +
      (r.role === 'viewer' ? i18nText(" disabled title=\"Карта обновляется. Для отправки порталов нужны права разведчика.\"") : '') + '>' +
      i18nText("<span>В карту «") + esc(r.title || i18nText("Комната")) + '»</span></label>' +
    (window.AvalonServerAccess.canManage(r) ? '<div class="opt-note room-note">' +
      '<button class="btn ghost" type="button" data-copy="' + esc(r.id) + i18nText("\">Пригласить участников</button></div>") : '')).join('');
}

// Состояние входа. Живёт на верхнем уровне, а не внутри моста Electron, чтобы блок можно
// было прогнать в стенде оформления — как и всё остальное в этом окне.
//
// Показываем честно: не вошёл — объясняем, что без входа работает, а что нет; вошёл —
// имя из Discord и признак доверия. Ошибку не прячем: человек только что ходил в браузер,
// и «просто не сработало» — худшее, что он может увидеть.
// Аватарка приходит с cdn.discordapp.com — единственный внешний адрес во всём окне.
// Проверяем его ЗДЕСЬ, а не только в CSP: заголовок ловит запрос, но в src уже успел бы
// лечь чужой адрес, и это было бы видно в отладчике как попытка стука наружу.
const AVATAR_HOST = /^https:\/\/cdn\.discordapp\.com\//;
function setAvatar(iniId, imgId, nick, url) {
  const ini = document.getElementById(iniId), img = document.getElementById(imgId);
  if (!ini || !img) return;
  ini.textContent = initials(nick || '?');
  if (url && AVATAR_HOST.test(url)) {
    img.onerror = () => { img.hidden = true; };   // картинки нет — остаются буквы под ней
    img.hidden = false;
    if (img.getAttribute('src') !== url) img.src = url;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }
}

function renderAuth(st) {
  if (!st) return;
  const out = document.getElementById('acc-out');
  const box = document.getElementById('acc-in-box');
  const err = document.getElementById('acc-err');
  if (!out || !box || !err) return;
  // рисуется по клику, а состояние входа приходит асинхронно и раньше.
  accTrusted = !!st.trusted;
  const previousLayoutAccount = layoutAccountId;
  cloudSignedIn = !!st.signedIn;
  layoutAccountId = cloudSignedIn && typeof st.userId === 'string' ? st.userId.toLowerCase() : null;
  if (previousLayoutAccount !== layoutAccountId) {
    renderRevision++;
    if (lastSnap) queueMicrotask(() => render(lastSnap));
  }
  authSignedIn = cloudSignedIn && !st.guest;
  accountId = authSignedIn && typeof st.userId === 'string' ? st.userId.toLowerCase() : null;
  // Своё имя — чтобы в списке подтвердивших писать «ты», а не свой же ник: игрок ищет
  // там друзей, а себя опознаёт хуже всех (ник в Discord мог смениться).
  accNick = st.nick || null;

  // нижняя карточка панели
  document.getElementById('acc-in').hidden = authSignedIn;
  document.getElementById('acc-me').hidden = !authSignedIn;
  if (authSignedIn) {
    document.getElementById('acc-nick').textContent = st.nick || i18nText("без имени");
    const role = document.getElementById('acc-role');
    role.textContent = st.trusted ? i18nText("доверенный") : i18nText("вход через Discord");
    role.classList.toggle('trusted', !!st.trusted);
    setAvatar('acc-ini', 'acc-img', st.nick, st.avatar);
    // раздел «Аккаунт» в настройках — та же правда, только подробнее
    document.getElementById('acc-who').textContent = st.nick || i18nText("без имени");
    document.getElementById('acc-who-note').textContent = i18nText("Личная облачная карта доступна только твоему аккаунту.");
    setAvatar('acc-ini-2', 'acc-img-2', st.nick, st.avatar);
  }
  out.hidden = authSignedIn;
  box.hidden = !authSignedIn;
  const guestNote = document.getElementById('acc-guest-note');
  if (guestNote) guestNote.textContent = st.guest
    ? i18nText("Личная карта сохраняется на компьютере и в облаке без Discord. Для карт друзей и восстановления доступа на другом компьютере войди через Discord.")
    : i18nText("Личная карта сохраняется на компьютере. Облачный вход пока недоступен.");
  // окно новой карты: без входа комнаты недоступны, и предупредить надо до нажатия
  const need = document.getElementById('map-need-auth');
  if (need) need.hidden = authSignedIn;
  // подпись под списком каналов объясняет, почему общее недоступно; вошёл — объяснять нечего
  const note = document.getElementById('chan-note');
  if (note) note.hidden = authSignedIn;
  document.querySelectorAll('#map-create, #map-join').forEach(b => { b.disabled = !authSignedIn; });

  err.hidden = !st.error && !(st.signedIn && st.sessionOnly);
  if (st.error) err.textContent = i18nText("Вход не удался: ") + st.error;
  else if (st.signedIn && st.sessionOnly) err.textContent = st.guest
    ? i18nText("Гостевой вход не сохранён. После перезапуска доступ к этой облачной карте может пропасть.")
    : i18nText("Вход не сохранён. После перезапуска приложения потребуется войти снова.");
  renderChannels();
  renderRoomToggles();
}

function renderUpdate(st) {
  const box = document.getElementById('update-box');
  if (!box || !st) return;
  if (st.current) document.getElementById('modal-version').textContent = i18nText("версия ") + st.current;
  const has = !!st.latest;
  box.hidden = !has;
  if (has) {
    document.getElementById('update-ver').textContent = st.latest;
    document.getElementById('update-notes').textContent = st.notes || '';
    document.getElementById('update-btn').disabled = !st.url;
  }
  renderUpdCheck(st);
}

// Блок «Обновления» в настройках. Отдельно от плашки в панели: та появляется сама и
// только когда есть что ставить, а сюда игрок приходит спросить. Поэтому здесь ответ
// нужен ВСЕГДА — в том числе «стоит последняя» и «проверить не вышло». Молчание в ответ
// на нажатие кнопки читается как поломка.
function renderUpdCheck(st) {
  const line = document.getElementById('upd-state');
  const open = document.getElementById('upd-open');
  if (!line || !open) return;
  open.hidden = !(st && st.latest && st.url);
  if (!st) return;
  const когда = st.checkedAt ? i18nText(" · проверено в ") + new Date(st.checkedAt).toLocaleTimeString().slice(0, 5) : '';
  if (st.latest) {
    line.textContent = i18nText("Вышла версия ") + st.latest + (st.notes ? ' — ' + st.notes : '') + когда;
    return;
  }
  // Ошибку показываем, только если проверка ДО неё ни разу не удалась либо она свежее
  // успешной: иначе строка пугала бы отвалившейся сетью, когда ответ уже получен.
  if (st.error && !st.checkedAt) { line.textContent = i18nText("Проверить не вышло: ") + st.error; return; }
  if (st.checkedAt) { line.textContent = i18nText("Установлена последняя версия") + когда; return; }
  line.textContent = i18nText("Нажми «Проверить», чтобы узнать");
}

// Строка состояния общих карт: включено ли, сколько ждёт в очереди, была ли связь.
// Молчаливая синхронизация — худший вариант: игрок должен видеть, ушло или нет.
function renderSync(st) {
  const el = document.getElementById('sync-state');
  if (!el || !st) return;
  el.classList.remove('on', 'bad');
  if (!st.ready) { el.textContent = i18nText("Сервер не настроен — выгрузка недоступна"); return; }
  if (cfg?.cloudError) { el.classList.add('bad'); el.textContent = i18nText("Облачная карта: ") + cfg.cloudError; return; }
  if (!st.enabled) { el.textContent = i18nText("Совместные карты не подключены"); return; }
  const bits = [];
  // targets — коды карт, а не слова: переводим их в названия тем же способом, что и
  // подпись под ребром. Иначе строка состояния показывала бы игроку голые uuid.
  bits.push(i18nText("Получение: ") + (st.readTargets || st.targets || []).map(scopeName).join(', '));
  bits.push(st.targets?.length ? i18nText("Отправка: ") + st.targets.map(scopeName).join(', ') : i18nText("Отправка выключена"));
  if (st.queued) bits.push(i18nText("в очереди ") + st.queued);
  if (st.lastPushAt) bits.push(i18nText("отправлено в ") + new Date(st.lastPushAt).toLocaleTimeString().slice(0, 5));
  if (st.pulled) bits.push(i18nText("обновлений карты: ") + st.pulled);
  if (st.legacyServer) bits.push(i18nText("Сервер требует обновления синхронизации"));
  if (st.lastError) {
    el.classList.add('bad');
    el.textContent = i18nText("Сеть: ") + st.lastError + (st.waitingSec ? i18nText(" — повтор через {0} с", [st.waitingSec]) : '');
    return;
  }
  el.classList.add('on');
  el.textContent = bits.join(' · ');
}

// ---------- длительности движения ----------
// Числа живут в CSS и берутся оттуда: иначе они в двух местах, однажды разъезжаются, и
// окно снимается либо до конца анимации (рывок), либо заметно после (залипание).
// Объявлены ЗДЕСЬ, выше первого использования: сворачивание колонки применяется сразу
// при загрузке, а const до своей строки не существует.
function cssMs(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(v.endsWith('ms') ? n : n * 1000);
}
const EXIT_MS = cssMs('--t-out', 260);    // уход окон и меню
const SLOW_MS = cssMs('--t-slow', 340);   // долгие переходы: колонка, сворачивание блоков

// ---------- независимые плавающие панели ----------
// Сворачивание панелей не меняет размеры холста или координаты зон.
function foldState() {
  try { return JSON.parse(localStorage.getItem('fold') || '{}') || {}; } catch (e) { return {}; }
}
function foldSave(s) { try { localStorage.setItem('fold', JSON.stringify(s)); } catch (e) { /* и ладно */ } }
// Высоту меняет CSS: обёртка .fold-wrap едет между 1fr и 0fr. Здесь только признак —
// [hidden] тут больше не при чём, он и убивал анимацию, снимая блок одним кадром.
function applyFold(id, open) {
  const body = document.getElementById(id);
  const head = document.querySelector('[data-fold="' + id + '"]');
  if (!body || !head) return;
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  body.inert = !open;
}
function toggleCard(open) {
  document.body.classList.toggle('no-card', !open);
  const btn = document.getElementById('card-toggle');
  if (btn) {
    btn.setAttribute('aria-expanded', String(open));
    btn.title = open ? i18nText("Скрыть карточку зоны") : i18nText("Показать карточку зоны");
  }
  document.getElementById('card').inert = !open;
}

{
  const s = foldState();
  for (const id of ['card-body', 'route-body']) applyFold(id, s[id] !== false);
  toggleCard(s.card !== false && !!cardZone);
  document.addEventListener('click', ev => {
    const head = ev.target.closest('[data-fold]');
    if (head) {
      const id = head.dataset.fold;
      const open = head.getAttribute('aria-expanded') !== 'true';
      applyFold(id, open);
      const st = foldState(); st[id] = open; foldSave(st);
      return;
    }
    if (ev.target.closest('#card-close')) {
      toggleCard(false);
      document.getElementById('card-toggle').focus({preventScroll:true});
      const st = foldState(); st.card = false; foldSave(st);
      return;
    }
    if (ev.target.closest('#card-toggle')) {
      const open = document.body.classList.contains('no-card');
      toggleCard(open);
      const st = foldState(); st.card = open; foldSave(st);
    }
  });
}

// ---------- окна поверх ----------
// Настройки и создание карты переехали в окна: панель слева стала колонкой каналов, а
// настройки открывают раз в неделю — держать их развёрнутыми на пол-экрана незачем.
// Закрыть можно тремя способами: крестик, подложка, Escape. Рабочий обычно третий.
let modalReturn = null;          // куда вернуть фокус после закрытия
let lastSection = 'set-hotkeys'; // окно настроек открывается там, где его закрыли

// Уход для всего, что закрывается «мимо кадра»: меню каналов и меню зоны. Класс .closing
// проигрывает анимацию, и только потом элемент снимается. Повторный вызов на уже уходящем
// элементе ничего не делает, а открытие отменяет уход — иначе меню, открытое сразу после
// закрытия, снялось бы по чужому таймеру.
const exitTimers = new WeakMap();
function fadeOutEl(el, done) {
  if (!el || el.hidden || el.classList.contains('closing')) return;
  el.classList.add('closing');
  exitTimers.set(el, setTimeout(() => {
    el.classList.remove('closing');
    el.hidden = true;
    exitTimers.delete(el);
    if (done) done();
  }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : EXIT_MS));
}
function cancelFadeOut(el) {
  if (!el) return;
  clearTimeout(exitTimers.get(el));
  exitTimers.delete(el);
  el.classList.remove('closing');
}

function showSection(id) {
  if (id === 'set-subscriptions') window.AvalonSubscriptionsUI?.clearContext();
  lastSection = id;
  document.querySelectorAll('#modal-settings .msec').forEach(s => { s.hidden = s.id !== id; });
  document.querySelectorAll('#modal-settings .mn').forEach(b => b.classList.toggle('on', b.dataset.sec === id));
  const body = document.querySelector('#modal-settings .modal-body');
  if (body) body.scrollTop = 0;
}
function openModal(id, section) {
  const m = document.getElementById(id);
  if (!m) return;
  // Окно ещё уходит — оно не hidden, и прежняя проверка молча выходила отсюда, а чужой
  // таймер через мгновение снимал только что открытое окно. Уход отменяем и открываем.
  if (m.classList.contains('closing')) cancelFadeOut(m);
  else if (!m.hidden) return;
  modalReturn = document.activeElement;
  if (id === 'modal-settings') {
    showSection(section || lastSection);
    // Строку об обновлениях освежаем при открытии окна. Часовая проверка идёт в фоне и
    // о своём успехе не сообщает, когда обновления НЕТ, — без этого игрок читал бы
    // «нажми Проверить» уже после того, как приложение всё проверило само. Сети тут нет:
    // update-status отдаёт то, что уже известно.
    if (ipc && typeof ipc.updateStatus === 'function') ipc.updateStatus().then(renderUpdate).catch(() => {});
  }
  m.classList.remove('closing');
  m.hidden = false;
  // Фокус — на первое ПОЛЕ, и порядок выбора именно такой. Список селекторов через
  // запятую здесь не годится: querySelector отдаёт первый в порядке ДОКУМЕНТА, а не в
  // порядке предпочтений, и кольцо фокуса садилось на кнопку вкладки выше поля.
  // Если поля нет — фокус на само окно (tabindex=-1), а не на первую кнопку: кольцо на
  // разделе, который и так подсвечен как выбранный, читается как ошибка. Tab уводит
  // отсюда внутрь окна, как и положено.
  const first = m.querySelector('input[type=text]') || m.querySelector('.modal-win');
  if (first) first.focus({ preventScroll: true });
}
function closeModal(m) {
  if (!m || m.hidden || m.classList.contains('closing')) return;
  if (m.id === 'modal-route-image') invalidateRouteImage();
  // Прячем не сразу: сначала уход, потом [hidden]. Длительность та же, что в .modal.closing.
  fadeOutEl(m);
  if (modalReturn && modalReturn.focus) modalReturn.focus({ preventScroll: true });
  modalReturn = null;
}
function shutModals() { document.querySelectorAll('.modal:not([hidden])').forEach(closeModal); }
// Закрытие окон с оглядкой на режим размещения плашки. «Готово» живёт в окне настроек,
// а тянут плашку поверх игры — закрыть окно, не ответив, проще простого. Раньше режим
// при этом оставался включённым без единого видимого способа выйти.
function closeModals() {
  const place = document.getElementById('modal-place');
  if (place && !place.hidden) return;        // вопрос уже задан — ждём ответа
  if (placing) {
    const ch = (cfg && cfg.setupChanges) || {};
    if (ch.moved || ch.resized) return askPlace(ch);
    finishPlace('cancel');                   // ничего не меняли — молча выходим из режима
    return;
  }
  shutModals();
}
// Спрашиваем только когда есть что сохранять, и называем сделанное: «двигали», «меняли
// размер» или и то и другое. Подтверждение на пустом месте — тот же молчаливый выбор,
// только с лишним кликом.
function askPlace(ch) {
  shutModals();
  document.getElementById('place-what').textContent = ch.moved && ch.resized
    ? i18nText("Плашку двигали и меняли ей размер.")
    : ch.moved ? i18nText("Плашку двигали по экрану.") : i18nText("Плашке меняли размер.");
  openModal('modal-place');
}
function finishPlace(action) {
  const place = document.getElementById('modal-place');
  if (place && !place.hidden) closeModal(place);
  shutModals();
  setPlacing(false);
  if (!ipc || typeof ipc.overlaySetup !== 'function') return;
  ipc.overlaySetup(action)
    .then(() => ipc.getConfig()).then(applyConfig)
    .catch(() => {});
}
function mapErr(text) {
  const el = document.getElementById('map-err');
  if (!el) return;
  el.hidden = !text;
  if (text) el.textContent = text;
}

document.addEventListener('click', ev => {
  // меню канала закрывается кликом мимо — но не по самой стрелке, она его переключает
  if (!ev.target.closest('#chan-menu') && !ev.target.closest('#chan-head')) closeChanMenu();
  // меню зоны — так же: клик по самому меню обслуживает его собственный обработчик,
  // а клик в графе закрывает меню через cy.on('tap'), сюда такие клики не доходят
  if (!ev.target.closest('#graph-menu')) closeGraphMenu();
  if (ev.target.closest('[data-close]')) { closeModals(); return; }
  const nav = ev.target.closest('#modal-settings .mn');
  if (nav) showSection(nav.dataset.sec);
  // Только сегменты окна «Новая карта». Раньше здесь стоял голый '.seg-b', и обработчик
  // считал своей ЛЮБУЮ такую кнопку в документе: клик по выбору темы снимал выбор вкладки,
  // а dataset.tab у чужой кнопки не совпадал ни с 'new', ни с 'join' — и обе формы
  // прятались разом, оставляя пустое окно.
  const tab = ev.target.closest('#map-mode .seg-b');
  if (tab) {
    document.querySelectorAll('#map-mode .seg-b').forEach(b => b.classList.toggle('on', b === tab));
    document.getElementById('tab-new').hidden = tab.dataset.tab !== 'new';
    document.getElementById('tab-join').hidden = tab.dataset.tab !== 'join';
    mapErr(null);
  }
});
document.addEventListener('keydown', ev => {
  const routeImageModal = document.getElementById('modal-route-image');
  if (ev.key === 'Tab' && !routeImageModal.hidden && !routeImageModal.classList.contains('closing')) {
    const buttons = [...routeImageModal.querySelectorAll('button:not([disabled]), [tabindex="0"]')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || (!ev.shiftKey && index === buttons.length - 1) || (ev.shiftKey && index === 0)) {
      ev.preventDefault();
      buttons[ev.shiftKey ? buttons.length - 1 : 0]?.focus();
    }
    return;
  }
  if (ev.key !== 'Escape') return;
  // Esc на вопросе о месте плашки значит «вернуть как было» — ровно то же, что Esc
  // по самой плашке поверх игры. Оставить вопрос без ответа Esc не должен: тогда режим
  // снова остался бы включённым, а окно закрытым.
  const place = document.getElementById('modal-place');
  if (place && !place.hidden) return finishPlace('cancel');
  closeChanMenu(); closeGraphMenu(); closeModals();
});
{
  const save = document.getElementById('place-save');
  const undo = document.getElementById('place-undo');
  if (save) save.onclick = () => finishPlace('done');
  if (undo) undo.onclick = () => finishPlace('cancel');
}
document.getElementById('acc-gear').onclick = () => openModal('modal-settings');
document.getElementById('chan-new').onclick = () => openModal('modal-map');

// ---------- полоса каналов ----------
// Выбор канала — чистый интерфейс, серверу до него дела нет, поэтому обработчик живёт
// здесь, а не в ветке Electron: в стенде оформления переключение тоже должно работать.
// Наружу ходит только выход из карты, и он через ipc.
const chanBox = document.getElementById('chan-list');
if (chanBox) chanBox.addEventListener('click', ev => {
  const row = ev.target.closest('.rail-btn');
  if (!row) return;
  if (!channelItems().some(it => it.id === row.dataset.id)) return;
  if (chanView !== row.dataset.id) markViewChanged();   // другой канал — другой граф
  chanView = row.dataset.id;
  closeChanMenu();
  closeGraphMenu();
  closeMapSearch();
  markChannel();
  if (lastSnap) render(lastSnap);   // состав графа зависит от канала
});

// ---------- меню канала ----------
// Стрелка у имени открывает то же, что стрелка у имени сервера в Discord: действия над
// самим каналом. Выход из карты стоит именно здесь, а не крестиком в списке: его нельзя
// отменить, и случайное попадание по строке, которую жмут каждый день, недопустимо.
let leaveArmed = false;   // «Выйти» нажали один раз — второй уже выполняет
function roomOf(id) { return chanRooms.find(r => r.id === id) || null; }
function chanMenuFor(it) {
  const list = [];
  if (it.room) {
    // Код карты И ЕСТЬ приглашение: кто его знает, тот войдёт. Поэтому пункт назван
    // действием, а не свойством, — иначе «скопировать код» звучит безобидно, а на деле
    // это выдача доступа.
    if (window.AvalonServerAccess.canManage(roomOf(it.id)||{})) list.push({ act: 'invite', text: i18nText("Пригласить участников") });
    if (roomOf(it.id)?.isOwner) list.push({ act: 'subscription', text: i18nText('Подписка') });
    const r = roomOf(it.id);
    if (r && (['admin','moderator'].includes(r.role) || r.isOwner)) list.push({ act: 'roles', text: i18nText("Настройки ролей") });
  }
  list.push({ act: 'upload', text: i18nText("Куда сохранять портал…") });
  if (it.room && !roomOf(it.id)?.isOwner) list.push({ act: 'leave', text: leaveArmed ? i18nText("Точно выйти?") : i18nText("Выйти из карты"), cls: 'danger' });
  return list;
}
// Меню всегда относится к КОНКРЕТНОМУ каналу, а не к выбранному: по правой кнопке его
// открывают на значке в полосе, и переключать при этом граф было бы неожиданно.
let menuFor = null, menuAt = null;
function closeChanMenu() {
  const m = document.getElementById('chan-menu');
  if (!m || m.hidden) return;
  // стиль снимаем ПОСЛЕ ухода: он держит меню у курсора, и без него оно на прощание
  // прыгнуло бы под шапку
  fadeOutEl(m, () => m.removeAttribute('style'));
  leaveArmed = false;
  menuFor = null; menuAt = null;
  document.getElementById('chan-head').setAttribute('aria-expanded', 'false');
}
// at — координаты курсора для меню по правой кнопке; без них меню висит под шапкой
function openChanMenu(id, at) {
  const m = document.getElementById('chan-menu');
  const it = channelItems().find(x => x.id === (id || chanView));
  if (!m || !it) return;
  cancelFadeOut(m);   // открыли поверх уходящего — уход отменяем, иначе его таймер снимет живое меню
  menuFor = it.id; menuAt = at || null;
  hideTip();   // подсказка канала стоит ровно там, куда встаёт меню
  m.innerHTML = chanMenuFor(it).map(x =>
    '<button type="button" role="menuitem" data-act="' + x.act + '"' +
      (x.cls ? ' class="' + x.cls + '"' : '') + '>' + esc(x.text) + '</button>').join('');
  if(m.parentNode!==document.body)document.body.appendChild(m);
  const anchor=at||(()=>{const r=document.getElementById('chan-head').getBoundingClientRect();return{x:r.left,y:r.bottom+6};})();
  m.style.cssText='position:fixed;right:auto;bottom:auto;width:220px;max-width:calc(100vw - 16px);z-index:1000';
  m.hidden=false;
  m.style.left=Math.max(8,Math.min(anchor.x,window.innerWidth-m.offsetWidth-8))+'px';
  m.style.top=Math.max(8,Math.min(anchor.y,window.innerHeight-m.offsetHeight-8))+'px';
  document.getElementById('chan-head').setAttribute('aria-expanded', at ? 'false' : 'true');
}
const chanHead = document.getElementById('chan-head');
if (chanHead) chanHead.onclick = () => {
  const it = channelItems().find(x => x.id === chanView);
  const m = document.getElementById('chan-menu');
  if (m.hidden) openChanMenu(chanView); else closeChanMenu();
};
// Правая кнопка по значку канала — то же меню, у курсора. Так это и устроено в Discord.
if (chanBox) chanBox.addEventListener('contextmenu', ev => {
  const row = ev.target.closest('.rail-btn');
  if (!row) return;
  ev.preventDefault();
  closeChanMenu();
  const r = row.getBoundingClientRect();
  openChanMenu(row.dataset.id, { x: r.right + 8, y: r.top });
});
const chanMenu = document.getElementById('chan-menu');
if (chanMenu) chanMenu.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const id = menuFor || chanView;
  if (act === 'upload') { closeChanMenu(); return openModal('modal-settings', 'set-maps'); }
  if (act === 'roles') { closeChanMenu(); return openRoles(id); }
  if (act === 'subscription') { closeChanMenu(); return window.AvalonSubscriptionsUI?.openForMap(id); }
  if (act === 'invite') {
    closeChanMenu();
    return openServerAccess(id,'invite');
  }
  if (act !== 'leave') return;
  if (!leaveArmed) { const at = menuAt; leaveArmed = true; return openChanMenu(id, at); }   // спрашиваем один раз
  closeChanMenu();
  if (!ipc) return;
  const r = await ipc.roomLeave(id);
  if (!r.ok) return toast(i18nText("Не вышло: ") + r.error);
  if (chanView === id) chanView = 'local';
  chanRooms = r.rooms;
  markViewChanged();     // из графа ушли все порталы этой комнаты — раскладываем заново
  applyConfig(cfg);
  if (lastSnap) render(lastSnap);
  toast(i18nText("Вышел из карты"));
});

// ---------- участники и роли ----------
// Единое окно ролей и приглашений для приложения и сайта. Права проверяются также в базе.
let serverAccessDialog = null;
function openServerAccess(mapId,kind) {
  const map=chanRooms.find(r=>r.id===mapId),user=accountId;
  if(!map)return;
  closeModals(); serverAccessDialog?.close();
  serverAccessDialog=window.AvalonServerAccess.open({map,accountId:user,kind,t:i18nText,isCurrent:()=>user===accountId,rpc:async(action,params)=>{const r=await ipc.serverAccess(action,params);if(!r?.ok)throw new Error(r?.error||'server_action_failed');return r.value;},onChanged:async()=>{await ipc.roomsSync?.();}});
}
function openRoles(id){return openServerAccess(id,'roles');}

// ---------- подсказки полосы каналов ----------
// Живут в body и двигаются отсюда: полоса прокручивается, а прокручиваемый ящик обрезает
// всё, что торчит наружу, — подсказка внутри него просто не была бы видна.
const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.hidden = true;
document.body.appendChild(tipEl);
let tipFor = null;   // элемент, для которого подсказка уже показана
function hideTip() { tipEl.hidden = true; tipFor = null; }
// Пока открыто меню канала или окно поверх — подсказок нет. Меню всплывает ровно там же,
// где висит подсказка, и оба одновременно читались как наложение двух панелей друг
// на друга. Гасить один раз при открытии мало: любое движение мыши по значку вернуло бы
// подсказку обратно поверх меню.
function tipsBlocked() {
  const m = document.getElementById('chan-menu');
  return !!((m && !m.hidden) || document.querySelector('.modal:not([hidden])'));
}
document.addEventListener('mouseover', ev => {
  if (tipsBlocked()) { if (tipFor) hideTip(); return; }
  const el = ev.target.closest && ev.target.closest('[data-tip]');
  if (!el) { if (tipFor) hideTip(); return; }
  // Пока мышь ходит по тому же значку — не трогаем ничего. Иначе mouseover срабатывал
  // на каждом переходе между значком и его нутром, подсказка пересоздавалась вместе
  // с анимацией появления и дёргалась вслед за мышью.
  if (el === tipFor) return;
  tipFor = el;
  const r = el.getBoundingClientRect();
  tipEl.textContent = el.dataset.tip;
  tipEl.hidden = false;
  tipEl.style.left = Math.round(r.right + 10) + 'px';
  tipEl.style.top = Math.round(r.top + r.height / 2) + 'px';
});
window.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);

// ---------- подключение к Electron ----------
if (ipc) {
  const setBind = label => setBindingLabel('binding', label);
  ipc.on('ready', ({ binding, manualBinding, searchBinding, overlayToggleBinding }) => {
    setBind(binding);
    setBindingLabel('manualBinding', manualBinding || 'F8');
    setBindingLabel('searchBinding', searchBinding || 'F10');
    setBindingLabel('overlayToggleBinding', overlayToggleBinding || '—');
  });
  ipc.on('binding-changed', ({ label, target }) => {
    setBindingLabel(target, label);
    if (target === 'overlayToggleBinding') document.getElementById('overlay-toggle-clear').disabled = label === '—';
  });
  let capturingBinding = false;
  async function captureHotkey(target) {
    if (cfg.secondaryAccount) return;
    if (capturingBinding) return;
    capturingBinding = true;
    const targets = ['binding', 'manualBinding', 'searchBinding', 'overlayToggleBinding'];
    const buttons = ['bind-btn', 'manual-bind-btn', 'search-bind-btn', 'overlay-toggle-bind-btn'].map(id => document.getElementById(id));
    const active = buttons[targets.indexOf(target)];
    const hint = document.getElementById('binding-hint');
    buttons.forEach(b => { b.disabled = true; }); active.setAttribute('aria-busy', 'true');
    hint.textContent = i18nText("Нажми клавишу или боковую кнопку мыши. Esc — отмена.");
    try {
      setBindingLabel(target, await ipc.captureBinding(target));
      hint.textContent = i18nText("Назначение завершено. Нажми на клавишу справа, чтобы изменить её.");
    } catch { hint.textContent = i18nText("Не удалось назначить клавишу. Попробуй ещё раз."); }
    finally { capturingBinding = false; buttons.forEach(b => { b.disabled = false; }); active.removeAttribute('aria-busy'); }
  }
  document.getElementById('search-bind-btn').onclick = () => captureHotkey('searchBinding');
  document.getElementById('manual-bind-btn').onclick = () => captureHotkey('manualBinding');
  document.getElementById('overlay-toggle-bind-btn').onclick = () => captureHotkey('overlayToggleBinding');
  document.getElementById('overlay-toggle-clear').onclick = async () => {
    setBindingLabel('overlayToggleBinding', await ipc.clearOverlayToggleBinding());
    document.getElementById('overlay-toggle-clear').disabled = true;
  };
  ipc.on('zone-preview', info => showCard(info, i18nText("Просмотр локации")));
  ipc.on('game-state', ({ running }) => { gameOn = running; renderStatus(); });
  document.getElementById('bind-btn').onclick = () => captureHotkey('binding');
  ipc.on('toast', ({ text }) => toast(text));
  // предупреждение о правах: без админа хоткей не долетает, пока фокус на окне игры
  ipc.on('privileges', p => {
    const box = document.getElementById('admin-warn');
    if (box) box.hidden = !p.needsAdmin;
  });
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) adminBtn.onclick = async () => {
    adminBtn.disabled = true;
    adminBtn.textContent = i18nText("Перезапускаю…");
    const r = ipc.restartAsAdmin ? await ipc.restartAsAdmin() : { ok: false, error: i18nText("недоступно") };
    if (!r.ok) {
      adminBtn.disabled = false;
      adminBtn.textContent = i18nText("Перезапустить от администратора");
      toast(i18nText("Не вышло: ") + (r.error || i18nText("неизвестная ошибка")) + i18nText(". Запусти «Avalon Mapper.bat» вручную."));
    }
  };
  // Запасной ручной выбор зоны пока скрыт в интерфейсе; обработчик оставлен для возврата.
  const sayZone = document.getElementById('say-zone');
  if (sayZone && ipc.openSearch) sayZone.onclick = () => ipc.openSearch();

  ipc.on('zone-changed', ({ from, zone }) => {
    if (!zone || !zone.zone) return;
    const info = rememberZone({ name: zone.zone, color: zone.color, tier: zone.tier, quality: zone.quality, activities: zone.activities });
    document.getElementById('cur-zone').textContent = zone.zone;
    setCurZone(zone.zone); // маршрут теперь строится от новой зоны
    logTransition(from, zone.zone);
    showCard(info); // (а) зашли в зону — сразу показываем, что внутри
  });
  ipc.on('edge-added', ({ from, tip, manual }) => {
    if (!tip || !tip.name) return;
    const info = rememberZone({ name: tip.name, color: tip.color, tier: tip.tier, quality: tip.quality, activities: tip.activities });
    // только размер портала: свободные места устаревают за минуты и в интерфейсе не нужны
    const sizeKnown = tip.capMaxKnown !== false && tip.capMax != null;
    const cap = sizeKnown ? i18nText("портал на ") + tip.capMax
      : manual ? i18nText("выбрано вручную") : i18nText("размер портала не прочитан");
    toast(`✔ ${tip.name} · ${cap}${tip.closes ? i18nText(" · закроется через ") + fmtLeft(tip.closes * 1000) : ''}`);
    // (б) главный сценарий: навёл на портал, нажал хоткей — увидел, что за ним.
    // Размер портала — той же полосой в цвет, что и в игровом оверлее.
    const sizeHtml = sizeKnown
      ? '<span class="port-size size-' + Number(tip.capMax) + '"><i></i><b>' + esc(tip.capMax) + '</b></span>'
      : '<span class="port-size size-unknown">' + (manual ? i18nText("выбрано вручную") : i18nText("размер не прочитан")) + '</span>';
    const bits = [from ? i18nText("портал из <b>") + esc(from) + '</b>' : i18nText("зона за порталом"), sizeHtml];
    if (tip.closes != null) bits.push(i18nText("закроется через ") + esc(fmtLeft(tip.closes * 1000)));

    showCard(info, bits.join(' · '));
    // Показать портал на графе. Не вышло (узел ещё не добавлен) — покажем после отрисовки.
    if (!revealEdge(from, tip.name)) pendingReveal = { a: from, b: tip.name, at: Date.now() };
  });
  ipc.on('map-updated', snap => render(snap));
  ipc.getMap().then(async snapshot => {
    await render(snapshot);
    window.__mapperMapReady = true;
    window.dispatchEvent(new Event('mapper-map-ready'));
  });
  // словарь автодополнения: 400 зон Авалона + 558 зон королевства, тянем один раз
  if (typeof ipc.getZoneNames === 'function') {
    Promise.resolve(ipc.getZoneNames()).then(list => {
      if (Array.isArray(list) && list.length) zoneNames = list;
    }).catch(() => {});
  }
  // ---------- область плашки зоны ----------
  // Интерфейс игры у всех свой: миникарту двигают и масштабируют, поэтому жёсткий
  // правый нижний угол подходит не каждому. Даём обвести плашку мышью.
  const regionLabel = region => {
    const el = document.getElementById('zone-region');
    if (!el) return;
    el.innerHTML = region
      ? i18nText("<b>Своя область:</b> {0}×{1} в точке {2}, {3}", [Math.round(region.width), Math.round(region.height), Math.round(region.left), Math.round(region.top)])
      : i18nText("Сейчас стандартная — у миникарты, справа внизу");
  };
  const pickBtn = document.getElementById('btn-pick-region');
  if (pickBtn) pickBtn.onclick = async () => {
    pickBtn.disabled = true;
    try {
      const r = await ipc.pickZoneRegion();
      if (r.cancelled) return;
      if (!r.ok) { toast(i18nText("Не вышло: ") + r.error); return; }
      regionLabel(r.region);
      if (r.zone) {
        toast(i18nText("Область принята — вижу «{0}»", [r.zone]));
      } else {
        toast(i18nText("Область сохранена, но плашку в ней прочитать не смог"));
      }
    } finally { pickBtn.disabled = false; }
  };

  // ---------- настройки ----------
  document.querySelectorAll('input[data-opt]').forEach(inp => {
    inp.onchange = async () => { applyConfig(await ipc.setOption(inp.dataset.opt, inp.checked)); };
  });
  // Размер плашки применяется ПРЯМО ВО ВРЕМЯ перетаскивания ползунка. Раньше — только
  // на отпускании, из осторожности: каждое промежуточное значение двигает окно оверлея.
  // На деле вышло хуже: подбирать размер вслепую невозможно, и приходилось отпускать,
  // смотреть, брать снова. Осторожность оставлена в виде заслонки: пока предыдущее
  // применение не вернулось, следующее не отправляем, и окно не захлёбывается.
  const scaleInput = document.getElementById('ov-scale');
  let scaleBusy = false, scaleWanted = null;
  const applyScale = async () => {
    if (scaleBusy || scaleWanted == null) return;
    scaleBusy = true;
    const v = scaleWanted; scaleWanted = null;
    try { applyConfig(await ipc.setOption('overlayScale', v)); }
    finally { scaleBusy = false; if (scaleWanted != null) applyScale(); }
  };
  scaleInput.oninput = () => {
    sliderHeld = 'ov-scale';   // пока тянут — эхо из главного процесса ручку не трогает
    document.getElementById('ov-scale-val').textContent = scaleInput.value + '%';
    scaleWanted = Number(scaleInput.value) / 100;
    applyScale();
  };
  scaleInput.onchange = () => {
    sliderHeld = null;
    scaleWanted = Number(scaleInput.value) / 100;
    applyScale();
  };

  const holdInput = document.getElementById('ov-hold');
  holdInput.oninput = () => {
    sliderHeld = 'ov-hold';
    document.getElementById('ov-hold-val').textContent = holdInput.value + i18nText(" с");
  };
  holdInput.onchange = async () => {
    sliderHeld = null;
    applyConfig(await ipc.setOption('overlayHoldSec', Number(holdInput.value)));
  };

  const placeBtn = document.getElementById('ov-place');
  placeBtn.onclick = async () => {
    if (placing) { await ipc.overlaySetup('done'); return setPlacing(false); }
    const r = await ipc.overlaySetup('start');
    if (!r.ok) return toast(i18nText("Не вышло: ") + (r.error || i18nText("неизвестная ошибка")));
    setPlacing(true);
    toast(i18nText("Тяни плашку на игре мышью · колесо — размер · Enter — готово"));
  };
  document.getElementById('ov-reset').onclick = async () => {
    await ipc.overlaySetup('reset');
    applyConfig(await ipc.getConfig());
  };
  // ---------- каналы ----------
  ipc.on('rooms-changed', rooms => { chanRooms = rooms || []; renderChannels(); renderRoomToggles(); refreshSelectedEdge(); });
  if (typeof ipc.roomsList === 'function') {
    ipc.roomsList().then(rs => { chanRooms = rs || []; renderChannels(); renderRoomToggles(); }).catch(() => {});
  }
  // Роли и порог живут на сервере: без этого запроса окно не знало бы, показывать ли
  // «Настройки ролей» и почему портал не ушёл в карту. Спрашиваем после входа — до него
  // сервер всё равно ответит отказом.
  const pullRooms = () => { if (ipc.roomsSync) ipc.roomsSync().catch(() => {}); };
  if (authSignedIn) pullRooms();

  // тумблеры выгрузки по комнатам и коды карт — раздел «Куда сохранять портал»
  const roomsBox = document.getElementById('set-rooms');
  if (roomsBox) {
    roomsBox.addEventListener('change', async ev => {
      const t = ev.target.closest('input[data-room]');
      if (!t) return;
      const r = await ipc.roomUpload(t.dataset.room, t.checked);
      if (!r.ok) { t.checked = !t.checked; return toast(i18nText("Не вышло: ") + r.error); }
      chanRooms = r.rooms;
      applyConfig(cfg);   // «не отмечено ничего» и точки в каналах зависят и от комнат
    });
    roomsBox.addEventListener('click', ev => {
      const b = ev.target.closest('[data-copy]');
      if (!b) return;
      openServerAccess(b.dataset.copy,'invite');
    });
  }

  // ---------- новая карта ----------
  const mapCreate = document.getElementById('map-create');
  if (mapCreate) mapCreate.onclick = async () => {
    const el = document.getElementById('map-title');
    const name = el.value.trim();
    if (!name) return mapErr(i18nText("Придумай название — под ним карта встанет в список каналов."));
    mapErr(null);
    mapCreate.disabled = true;
    try {
      const codeInput = document.getElementById('map-activation-code');
      const r = await ipc.roomCreate(name, codeInput.value.trim());
      if (!r.ok) {
        return mapErr(r.error || window.AvalonSubscriptionsUI?.errorText(r.code) || i18nText("карта не создалась"));
      }
      chanRooms = r.rooms;
      applyConfig(cfg);
      el.value = ''; codeInput.value = '';
      chanView = r.id; markViewChanged(); renderChannels();
      if (lastSnap) render(lastSnap);
      closeModals();
      toast(i18nText('Сервер создан. Приглашения доступны по ПКМ на значке сервера.'));
    } finally { mapCreate.disabled = !authSignedIn; }
  };
  const mapJoin = document.getElementById('map-join');
  if (mapJoin) mapJoin.onclick = async () => {
    const code = document.getElementById('map-code');

    if (!code.value.trim()) return mapErr(i18nText("Вставь код карты — его присылает тот, кто её создал."));
    mapErr(null);
    mapJoin.disabled = true;
    try {
      const r = await ipc.roomJoin(code.value.trim());
      if (!r.ok) return mapErr(r.error || i18nText("войти не вышло"));
      chanRooms = r.rooms;
      chanView = r.id;              // сразу показываем то, во что вошли
      markViewChanged();            // и раскладываем под новый состав графа
      applyConfig(cfg);
      if (lastSnap) render(lastSnap);
      code.value = '';
      closeModals();
      toast(i18nText("Вошёл в карту"));
    } finally { mapJoin.disabled = !authSignedIn; }
  };

  // ---------- вход через Discord ----------
  // Кнопок входа две — в нижней карточке панели и в настройках, — а поведение одно.
  //
  // Кнопку НЕ гасим на время ожидания. Браузер мог не открыться, вкладку могли закрыть,
  // человек мог отойти — и при выключенной кнопке единственным выходом было бы ждать
  // три минуты, пока попытка не истечёт сама. Повторное нажатие безопасно: auth.signIn
  // отменяет прошлую попытку, закрывает её порт на 127.0.0.1 и заводит НОВЫЙ секрет
  // PKCE. Код от старой попытки обменять на токен после этого невозможно — verifier
  // от него уже выброшен, — так что «лишний» вход не открывает никакой лазейки.
  const signLabel = new Map();   // исходная разметка кнопки: в ней значок, а не только текст
  let signTry = 0;               // номер попытки: ответ отменённой в интерфейс не пускаем
  const signIn = async btn => {
    const mine = ++signTry;
    if (!signLabel.has(btn)) signLabel.set(btn, btn.innerHTML);
    btn.textContent = i18nText("Жду в браузере · нажми ещё раз, чтобы открыть заново");
    btn.classList.add('waiting');
    let r;
    try { r = await ipc.authSignIn(); }
    finally {
      if (mine === signTry) { btn.innerHTML = signLabel.get(btn); btn.classList.remove('waiting'); }
    }
    if (mine !== signTry) return;   // это ответ отменённой попытки — он уже никому не нужен
    if (!r.ok) {
      // Ошибку показываем там, где рядом с ней есть объяснение, — в разделе «Аккаунт»:
      // человек только что ходил в браузер, и одного тоста ему мало.
      const err = document.getElementById('acc-err');
      err.hidden = false;
      err.textContent = i18nText("Вход не удался: ") + r.error;
      openModal('modal-settings', 'set-account');
      return;
    }
    renderAuth(r);
    toast(i18nText("Вход выполнен: ") + (r.nick || ''));
  };
  if (ipc.authSignIn) ['acc-in', 'acc-in-2'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.onclick = () => signIn(b);
  });
  const accOut = document.getElementById('acc-out-btn');
  if (accOut && ipc.authSignOut) accOut.onclick = async () => renderAuth(await ipc.authSignOut());
  // Код аккаунта нужен ровно для одного: владелец проекта выдаёт по нему право удалять
  const accId = document.getElementById('acc-id');
  if (accId && ipc.authId) accId.onclick = async () => {
    const id = await ipc.authId();
    if (!id) return toast(i18nText("Код появится после входа"));
    if (navigator.clipboard) await navigator.clipboard.writeText(id).catch(() => {});
    toast(i18nText("Код скопирован: ") + id);
  };
  ipc.on('auth-changed', st => { if(st?.userId!==accountId)serverAccessDialog?.close(); renderAuth(st); if (st && st.signedIn) pullRooms(); });
  if (typeof ipc.authStatus === 'function') {
    ipc.authStatus().then(st => { renderAuth(st); if (st && st.signedIn) pullRooms(); }).catch(() => {});
  }

  // ---------- обновления ----------
  ipc.on('update-available', () => { ipc.updateStatus().then(renderUpdate).catch(() => {}); });
  const openUpdate = async () => {
    const r = await ipc.updateOpen();
    toast(r.ok ? i18nText("Открыл страницу выпуска в браузере") : i18nText("Не вышло: ") + (r.error || ''));
  };
  document.getElementById('update-btn').onclick = openUpdate;
  document.getElementById('upd-open').onclick = openUpdate;
  // Проверка идёт по сети и ждёт ответа до восьми секунд. Всё это время кнопка должна
  // выглядеть занятой, иначе игрок нажмёт ещё раз, решив, что не сработало.
  const updBtn = document.getElementById('upd-check');
  updBtn.onclick = async () => {
    if (typeof ipc.updateCheck !== 'function') return;
    updBtn.disabled = true;
    const was = updBtn.textContent;
    updBtn.textContent = i18nText("Проверяю…");
    document.getElementById('upd-state').textContent = i18nText("Спрашиваю у GitHub…");
    try {
      renderUpdate(await ipc.updateCheck());
    } catch (err) {
      document.getElementById('upd-state').textContent = i18nText("Проверить не вышло: ") + (err && err.message ? err.message : err);
    } finally { updBtn.disabled = false; updBtn.textContent = was; }
  };
  if (typeof ipc.updateStatus === 'function') ipc.updateStatus().then(renderUpdate).catch(() => {});

  ipc.on('sync-status', renderSync);
  ipc.syncStatus().then(renderSync).catch(() => {});
  // Строку состояния выгрузки видно только в окне настроек — спрашивать её каждые пять
  // секунд у свёрнутого окна незачем: это запрос через мост и перерисовка ради текста,
  // на который никто не смотрит. Главное — толчки приходят событием 'sync-status' сами,
  // так что опрос здесь лишь подстраховка.
  setInterval(() => {
    if (document.hidden) return;
    ipc.syncStatus().then(renderSync).catch(() => {});
  }, 5000);

  document.getElementById('btn-shots').onclick = async () => {
    const r = await ipc.openShots();
    if (!r.ok) toast(r.error || i18nText("не удалось открыть папку"));
  };
  // оверлей сам сообщает о перетаскивании, колесе и выходе из режима настройки
  ipc.on('config-changed', c => { applyConfig(c); setPlacing(!!c.setupActive); });

  ipc.getConfig().then(c => {
    regionLabel(c.zoneBarRegion);
    document.getElementById('bind-label').textContent = (c.binding && c.binding.label) || 'F9';
    document.getElementById('status').textContent = i18nText("загрузка OCR…");
    applyConfig(c);
  });

  document.getElementById('sim-zone').onclick = async () => {
    for (const f of await ipc.pickSimulateFiles()) await ipc.simulateFile(f, false);
  };
  document.getElementById('sim-tip').onclick = async () => {
    for (const f of await ipc.pickSimulateFiles()) await ipc.simulateFile(f, true);
  };
} else {
  // Стенд оформления: тот же экран без main-процесса. Настройки показываем в
  // осмысленном состоянии — иначе панель выглядела бы «всё выключено».
  bindLabel = 'F9';
  // комнаты и вход — до applyConfig: от них зависят и точки в каналах, и «не отмечено ничего»
  chanRooms = [{ id: '9f1c2a44-7b3e-4d10-9a6f-2c5e8b0d1a77', title: i18nText("Гильдия"), upload: true,
    role: 'admin', isOwner: true, confirmRequired: 3 }];
  // Участники для стенда: без них окно ролей нечем показать (сервера здесь нет).
  window.DEMO_MEMBERS = [
    { id: 'u1', nick: 'Player One', role: 'admin', isOwner: true },
    { id: 'u2', nick: 'Player Two', role: 'admin', isOwner: false },
    { id: 'u3', nick: 'Player Three', role: 'verified', isOwner: false },
    { id: 'u4', nick: 'Player Four', role: 'member', isOwner: false },
    { id: 'u5', nick: 'Player Five', role: 'member', isOwner: false },
    { id: 'u6', nick: 'Player Six', role: 'viewer', isOwner: false },
  ];
  // ?anon — посмотреть, как окно выглядит до входа (нижняя карточка, окно новой карты)
  renderAuth(location.search.includes('anon')
    ? { signedIn: false }
    : { signedIn: true, nick: 'Player One', trusted: false, userId: 'demo', avatar: null });
  applyConfig({
    overlayEnabled: true, overlayMap: true, overlayScale: 1, overlayPos: null,
    zoneSource: 'screen', zoneWatch: true, cursorScan: true, copyWorldZone: true, saveShots: false, portalAudit: false, overlayHoldSec: 7,
    saveLocal: true, autoRecordPortals: true, appVersion: '0.2.0', dev: true,
  });
  renderUpdate({ current: '0.2.0', latest: '0.3.0', url: 'https://example/x.exe', notes: i18nText("быстрее распознаётся портал, чинится плашка зоны") });
  renderSync({
    ready: true, enabled: true, targets: ['9f1c2a44-7b3e-4d10-9a6f-2c5e8b0d1a77'],
    queued: 0, pushed: 12, pulled: 5, lastPushAt: Date.now() - 40000, lastError: null, waitingSec: 0,
  });
  document.getElementById('cur-zone').textContent = 'Qiient-Qi-Odesas';
  zoneNames = Object.entries(demoColors).map(([name, color]) => ({ name, color }));
  for (const [name, color] of Object.entries(demoColors))
    rememberZone({ name, color, tier: color === 'avalon' ? 6 : null, activities: demoActs[name] || null });
  render(demo);
  showCard(zoneInfoCache['Qiient-Qi-Odesas']);
  window.demoRoute = () => {
    const now = Date.now();
    showRoute({
      found: true, hops: 5, portalHops: 2, walkHops: 3, etaSec: 246, risky: true,
      reason: i18nText("таймеры на пределе — портал может закрыться, пока идёшь"),
      bottleneck: { from: 'Qiient-Qi-Odesas', to: 'Coues-Exakrom', expiresAt: now + 8 * 60e3, minutesLeft: 8 },
      steps: [
        { kind: 'portal', from: 'Qiient-Qi-Odesas', to: 'Coues-Exakrom', capNum: 7, capMax: 7, expiresAt: now + 8 * 60e3 },
        { kind: 'exit', from: 'Coues-Exakrom', to: 'Murky Fen', capNum: 5, capMax: 7, expiresAt: now + 124 * 60e3 },
        // пеший участок из нескольких зон — ровно тот случай, ради которого показываем цепочку
        { kind: 'walk', from: 'Murky Fen', to: 'Drownhorse Basin' },
        { kind: 'walk', from: 'Drownhorse Basin', to: 'Windripple Fen' },
        { kind: 'walk', from: 'Windripple Fen', to: 'Sleetwater Basin' },
      ],
    }, i18nText("маршрут до Sleetwater Basin"));
  };
  // ?route — сразу показать заполненный маршрут: иначе оформление ленты шагов
  // вне Electron никак не посмотреть (поиск пути живёт в main-процессе)
  if (location.search.includes('route')) window.demoRoute();
}
initRouteUI();
// Режимы для снимков и отладки (tools/preview-ui.js):
//   ?open=set-maps  — сразу открыть окно настроек на этом разделе;
//   ?only=<id>      — показать ТОЛЬКО этот блок, чтобы снимок обрезался сам по содержимому.
// Раньше блоки вырезались по замеренным координатам, и любое изменение высоты выше по
// панели молча съезжало на снимке.
{
  const q = new URLSearchParams(location.search);
  const open = q.get('open');
  const only = q.get('only');
  if (q.get('theme')) applyTheme(q.get('theme'));   // ?theme=light — снимки и правка стилей
  if (open === 'map') openModal('modal-map');
  else if (open === 'roles') openRoles(chanRooms.length ? chanRooms[0].id : 'demo');
  else if (open) openModal('modal-settings', open);
  const target = only ? document.getElementById(only) : null;
  if (target) {
    // Поднимаемся от блока к body и на каждом уровне гасим соседей. Прежний способ —
    // «спрятать всё в #side, кроме одного» — перестал работать, когда половина блоков
    // уехала в окно настроек: снимок брался бы вместе с рамкой окна и колонкой разделов.
    for (let el = target; el && el.parentElement && el !== document.body; el = el.parentElement) {
      el.hidden = false;
      for (const sib of el.parentElement.children) if (sib !== el) sib.hidden = true;
    }
    document.body.classList.add('shot');   // убирает зерно и градиент — иначе снимок нечем обрезать
  }
}
console.log('ui init ok');

document.getElementById('interface-language').addEventListener('change', async event => {
  const language = event.currentTarget.value;
  sessionStorage.setItem('avalon-language-settings', '1');
  if (ipc?.setOption) applyConfig(await ipc.setOption('language', language));
  else {
    const url = new URL(location.href); url.searchParams.set('lang', language);
    location.replace(url.href);
  }
});
if (sessionStorage.getItem('avalon-language-settings') === '1') {
  sessionStorage.removeItem('avalon-language-settings');
  openModal('modal-settings', 'set-misc');
}
