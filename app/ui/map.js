// Живой граф порталов на Cytoscape + карточка зоны. Работает в двух режимах:
// внутри Electron (window.api) и как статическая страница с демо-данными (для правки стилей).
const COLORS = window.ZONE_COLORS; // объявлены в graph-style.js — общий источник для приложения и стенда
const ZONE_TYPE_RU = {
  avalon: 'Авалон', blue: 'Синяя', yellow: 'Жёлтая', red: 'Красная',
  black: 'Чёрная', city: 'Город', 'city-black': 'Город (чёрные земли)',
};
// Порядок и подписи активностей общие с игровым оверлеем — ui/activities.js.
// Раньше таблица дублировалась здесь по старым плоским ключам, и при смене формы
// данных карточка молча пустела.
const ACTS = window.ZONE_ACTS;

// геометрия раскладки: расстояния подобраны так, чтобы подписи зон не слипались
const LINK_LEN = 165;  // желаемая длина ребра
const MIN_DIST = 125;  // минимальное расстояние между центрами узлов

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
const demoAct = (chests, dungeons, res, brecilien) => ({
  chests: Object.assign({ green: 0, blueSmall: 0, blueBig: 0, goldSmall: 0, goldBig: 0 }, chests),
  dungeons: Object.assign({ solo: 0, group: 0, elite: 0, factions: [] }, dungeons),
  res: ['ore', 'wood', 'fiber', 'hide', 'rock'].reduce((a, k) => (a[k] = Object.assign({ small: 0, big: 0, n: 0 }, res[k]), a), {}),
  brecilien: brecilien || 0,
});
const demoActs = {
  'Coues-Exakrom': demoAct({ green: 3, goldSmall: 1 }, { solo: 1, factions: ['KPR'] }, { rock: { small: 2, n: 2 }, ore: { big: 1, n: 1 } }),
  'Qiient-Qi-Odesas': demoAct({ green: 8, blueBig: 2 }, { group: 1, factions: ['MOR'] }, { hide: { big: 1, n: 1 }, wood: { small: 1, n: 1 } }),
  'Xiros-Aiairom': demoAct({ green: 1, blueBig: 1, goldBig: 1 }, { solo: 1, group: 1, factions: ['UND', 'HER'] }, { fiber: { small: 1, n: 1 } }, 1),
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
  if (h > 0) return `${h}ч ${String(m).padStart(2, '0')}м`;
  if (m > 0) return `${m}м`;
  return `${s}с`;
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
  const cap = e.capMax != null ? `на ${e.capMax}` : '';
  return {
    label: [cap, fmtLeft(left)].filter(Boolean).join(' · '),
    soon: left != null && left < 30 * 60e3,
    // откуда мы это знаем: свой глаз, карта друзей или общая (lib/store.js → scope)
    scope: e.scope || 'local', by: e.by || null,
    confirms: e.confirms ?? null, needed: e.needed ?? null,
  };
}

function nodeDataFor(name, here) {
  const color = zoneColorCache[name] || demoColors[name] || 'avalon';
  return { id: name, label: name, color: COLORS[color] || '#64748b', isAvalon: color === 'avalon', here: !!here };
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
  const P = [];
  const idx = new Map();
  all.forEach(n => { idx.set(n.id(), P.length); P.push({ n, x: n.position('x'), y: n.position('y'), free: freeIds.has(n.id()) }); });
  const freeIdx = [];
  P.forEach((p, i) => { if (p.free) freeIdx.push(i); });
  if (!freeIdx.length) return;

  const links = [];
  if (useSprings) cy.edges().forEach(e => {
    const i = idx.get(e.data('source')), j = idx.get(e.data('target'));
    if (i != null && j != null && (P[i].free || P[j].free)) links.push([i, j]);
  });

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

// Своя «фаза» узла — угол, с которого начинается перебор направлений.
//
// ЗАЧЕМ. Раньше кандидаты отсчитывались от нуля, а при равных зазорах побеждал первый
// по счёту. Из-за этого первый портал уходил строго на восток, второй строго на запад,
// третий и четвёртый — вертикально вниз и вверх, и только пятый попадал на диагональ.
// Ровно так граф и выглядел: рёбра по горизонтали и вертикали, диагонали изредка.
// Фаза сдвигает сетку у каждого узла по-своему, и оси перестают выигрывать все ничьи.
//
// Считаем из имени зоны (FNV-1a), а не случайно: раскладка пересчитывается при каждом
// обновлении карты, и случайная фаза заставляла бы граф прыгать на каждом портале.
function phaseOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

// угол вокруг host, максимально далёкий от уже занятых направлений
function freeAngle(host, pending, center, id) {
  const hx = host.position('x'), hy = host.position('y');
  const phase = phaseOf(id || host.id());
  const taken = [];
  host.neighborhood('node').forEach(n => {
    if (pending.has(n.id())) return;
    const a = Math.atan2(n.position('y') - hy, n.position('x') - hx);
    if (Number.isFinite(a)) taken.push(a);
  });
  if (!taken.length) {
    // «прочь от середины графа» — осмысленное направление, но у первого же узла
    // host совпадает с центром, atan2(0,0) даёт ноль, и портал уезжал строго вправо
    const dx = hx - center.x, dy = hy - center.y;
    return Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : phase;
  }
  let best = phase, bestGap = -1;
  for (let k = 0; k < 24; k++) {
    const cand = phase + (k / 24) * Math.PI * 2;
    let gap = Math.PI;
    for (const t of taken) {
      let d = Math.abs(cand - t) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d < gap) gap = d;
    }
    if (gap > bestGap) { bestGap = gap; best = cand; }
  }
  return best;
}

// стартовые позиции для новых узлов: рядом с уже размещённым соседом, в свободном секторе
function seedNewNodes(ids) {
  const pending = new Set(ids);
  const placed = cy.nodes().filter(n => !pending.has(n.id()));
  const center = { x: 0, y: 0 };
  let radius = 220;
  if (placed.length) {
    placed.forEach(n => { center.x += n.position('x'); center.y += n.position('y'); });
    center.x /= placed.length; center.y /= placed.length;
    const bb = placed.boundingBox();
    radius = Math.max(bb.w, bb.h) / 2 + LINK_LEN;
  }
  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const id of [...pending]) {
      const node = cy.$id(id);
      if (node.empty()) { pending.delete(id); continue; }
      const anchors = node.neighborhood('node').filter(n => !pending.has(n.id()));
      if (!anchors.length) continue;
      const host = anchors[0];
      const ang = freeAngle(host, pending, center, id);
      node.position({ x: host.position('x') + Math.cos(ang) * LINK_LEN, y: host.position('y') + Math.sin(ang) * LINK_LEN });
      pending.delete(id);
      progress = true;
    }
  }
  // одиночки без размещённых соседей — на кольцо вокруг всего графа
  const rest = [...pending];
  rest.forEach((id, i) => {
    const ang = (i / Math.max(1, rest.length)) * Math.PI * 2;
    cy.$id(id).position({ x: center.x + Math.cos(ang) * radius, y: center.y + Math.sin(ang) * radius });
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

function fitGraph() {
  if (!cy.nodes().length) return;
  cy.fit(undefined, 60);
  if (cy.zoom() > 1.5) { cy.zoom(1.5); cy.center(); }
}

let laidOut = false; // граф уже раскладывали хотя бы раз
function fullLayout() {
  if (!cy.nodes().length) return;
  laidOut = true;
  const l = cy.layout({
    name: 'cose', animate: false, fit: false, padding: 60, randomize: true,
    idealEdgeLength: LINK_LEN, edgeElasticity: 60, nodeRepulsion: 20000,
    nodeOverlap: 40, componentSpacing: 220, gravity: 0.3, numIter: 1200,
  });
  // После cose доводим руками, в два прохода.
  // Пружины выравнивают длины рёбер: cose оставляет разброс, при котором соседние
  // порталы то липнут, то растянуты через весь экран, и граф читается как путаница.
  // Замер на 120 узлах: разброс длин 56 → 24, самое длинное ребро 343 → 251.
  // Затем чистое расталкивание — оно и даёт гарантированный зазор между узлами.
  l.one('layoutstop', () => {
    const all = new Set(cy.nodes().map(n => n.id()));
    relaxPositions(all, 120, true);
    relaxPositions(all, 160, false);
    fitGraph();
  });
  l.run();
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
function render(snap) {
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
  const newNodeIds = new Set();
  let needFullLayout = false;

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
      else { addNodes.push({ group: 'nodes', data }); newNodeIds.add(id); }
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

    // 4. раскладка нужна только когда появились новые узлы
    if (newNodeIds.size) {
      if (!laidOut) needFullLayout = true; // первый непустой снимок — раскладываем всё
      else {
        seedNewNodes(newNodeIds);            // новые узлы — рядом с соседом, в свободном секторе
        relaxPositions(newNodeIds, 250, true); // и короткая релаксация: старые узлы зафиксированы
      }
    }
  });

  if (needFullLayout) fullLayout();
  if (!cy.nodes().length) laidOut = false;

  // Событие о портале и перерисовка графа приходят порознь, и узла в момент события
  // может ещё не быть. Тогда показ откладывается до ближайшей отрисовки — этой.
  if (pendingReveal) {
    if (Date.now() - pendingReveal.at > REVEAL_STALE_MS) pendingReveal = null;
    else if (revealEdge(pendingReveal.a, pendingReveal.b)) pendingReveal = null;
  }

  applyRouteHighlight(); // состав графа изменился — заново красим найденный маршрут
  ensureZoneInfo(model.nodes.keys());
}

// лёгкий тик: пересчитываем ТОЛЬКО подписи рёбер, позиции и состав графа не трогаем
function refreshLabels() {
  if (!lastSnap) return;
  const now = Date.now();
  cy.batch(() => {
    for (const e of lastSnap.edges || []) {
      if (!e.a || !e.b) continue;
      const el = cy.$id(edgeKeyOf(e.a, e.b));
      if (el.nonempty()) el.data(edgeLabelData(e, now));
    }
  });
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

setInterval(() => { if (!dropExpired()) refreshLabels(); }, 5000);

// перекраска узлов после доезда информации о зонах (позиции не трогаются)
function refreshNodeColors() {
  cy.batch(() => cy.nodes().forEach(n => {
    const color = zoneColorCache[n.id()] || demoColors[n.id()] || 'avalon';
    n.data({ color: COLORS[color] || '#64748b', isAvalon: color === 'avalon' });
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
function showCard(info, extraHtml) {
  const body = document.getElementById('card-body');
  if (!body || !info || !info.name) return;
  const z = rememberZone(info);
  cardZone = z.name;
  const color = z.color || 'avalon';
  const acts = z.activities;
  const html = [];

  html.push(
    '<div class="card-head">' +
      '<div class="card-name">' + esc(z.name) + '</div>' +
      // Порядок «сначала тир, потом тип» — как в самой плашке игры: «VI ☠ Oiros-Alaiam».
      // Уровень зоны определяет, по зубам ли она, и читается первым.
      '<div class="card-tags">' +
        (z.tier ? '<span class="chip chip-tier">T' + esc(z.tier) + '</span>' : '') +
        '<span class="chip chip-' + esc(color) + '">' + esc(ZONE_TYPE_RU[color] || 'Зона') + '</span>' +
      '</div>' +
    '</div>');
  if (extraHtml) html.push('<div class="card-portal">' + extraHtml + '</div>');
  if (color === 'avalon') html.push('<div class="card-map" id="card-map"><img alt=""></div>');

  if (acts && acts.chests) {
    const items = ACTS.listActivities(acts);
    html.push(items.length
      ? '<div class="acts">' + items.map(it =>
          '<span class="act' + (it.big ? ' big' : '') + '" title="' + esc(it.icon.startsWith('dg_') ? ACTS.dungeonTitle(acts, it.ru) : it.ru) + '">' +
            '<img data-fb="' + esc(it.ru.slice(0, 3)) + '" src="' + iconUrl(it.icon) + '" alt="">' +
            '<b>' + esc(it.count) + '</b>' +
          '</span>').join('') + '</div>'
      : '<div class="muted small acts-empty">активностей в этой зоне не отмечено</div>');
  } else if (color === 'avalon') {
    html.push('<div class="muted small acts-empty">данные об активностях недоступны</div>');
  }
  body.innerHTML = html.join('');

  // ассеты качает отдельный процесс — если файла ещё нет, аккуратно деградируем
  const wrap = document.getElementById('card-map');
  if (wrap) {
    const img = wrap.querySelector('img');
    // Скелет гасим явно по загрузке. «Картинка сама его закроет» не работает: карта зоны —
    // ромб с ПРОЗРАЧНЫМИ углами, и мерцание было видно в них всегда, читаясь как вечная загрузка.
    img.onload = () => wrap.classList.add('ready');
    img.onerror = () => { wrap.innerHTML = '<div class="map-missing">карта зоны ещё не скачана</div>'; };
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
      if (cardZone && zoneInfoCache[cardZone]) showCard(zoneInfoCache[cardZone]);
      // цвета зон доехали — перекрашиваем ромбы в ленте маршрута
      if (lastRoute) showRoute(lastRoute.res, lastRoute.title, lastRoute.emptyText);
    }
  });
}

// карточка по произвольному узлу графа: сначала кэш, потом уточнение через IPC (если он есть)
function showCardFor(name) {
  const cached = zoneInfoCache[name];
  showCard(cached || { name, color: zoneColorCache[name] || demoColors[name] || null, tier: null, activities: demoActs[name] || null });
  if (!ipc || typeof ipc.getZoneInfo !== 'function') return;
  Promise.resolve(ipc.getZoneInfo(name)).then(info => {
    if (info && info.name) { rememberZone(info); if (cardZone === name) showCard(zoneInfoCache[name]); }
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
  return el ? resolveDest(el.value) : null;
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
  btn.textContent = curZone
    ? (same ? 'Это твоя зона: ' + curZone : 'Подставить мою зону: ' + curZone)
    : 'Твоя зона ещё не распознана';
}
function setCurZone(name) {
  if (!name || name === curZone) return;
  curZone = name;
  if (!fromTouched) fillFrom(name);   // поле не трогали — держим в нём текущую зону
  updateOrigin();
}
function setSelZone(name) { selZone = name; }

function plural(n, one, few, many) {
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
function makeAC(inputId, boxId, onEnter) {
  const input = () => document.getElementById(inputId);
  const box = () => document.getElementById(boxId);
  let items = [], idx = -1;
  const ac = {
    render(list) {
      const b = box();
      items = list; idx = list.length ? 0 : -1;
      if (!list.length) { b.hidden = true; b.innerHTML = ''; return; }
      b.innerHTML = list.map((z, i) =>
        '<div class="ac-item' + (i === idx ? ' on' : '') + '" data-i="' + i + '">' +
          '<i class="dot ' + esc(z.color || 'avalon') + '"></i>' +
          '<span>' + markName(z.name, z.marks) + '</span>' +
        '</div>').join('');
      b.hidden = false;
    },
    close() { const b = box(); b.hidden = true; b.innerHTML = ''; items = []; idx = -1; },
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
let acTo = null, acFrom = null;
function acClose() { if (acTo) acTo.close(); if (acFrom) acFrom.close(); }
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
const KIND_RU = { portal: 'портал', exit: 'портал', walk: 'пешком' };
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
  if (s.capMax != null) bits.push('<span class="num">на ' + esc(s.capMax) + '</span>');
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
    '<span class="rz" data-zone="' + esc(groups[0].from) + '">' + esc(groups[0].from) + '</span></li>'];
  groups.forEach((g, i) => {
    li.push('<li class="rs ' + esc(g.kind) + (i === groups.length - 1 ? ' last' : '') + '" ' + rowStyle(i + 1, g.to) + '>' +
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
  const bits = [stat(hops, plural(hops, 'шаг', 'шага', 'шагов'))];
  // роутер и раньше считал время в пути, но панель его не показывала
  // время в пути — наш расчёт по средним скоростям, а не факт: помечаем тильдой
  if (res.etaSec) bits.push('<span class="rs-stat"><b>~' + esc(fmtLeft(res.etaSec * 1000)) + '</b>в пути</span>');
  if (portals > 0) bits.push(stat(portals, plural(portals, 'портал', 'портала', 'порталов')));
  if (walk > 0) bits.push(stat(walk, 'пешком'));
  const bn = res.bottleneck;
  if (bn) {
    const left = bn.minutesLeft != null ? fmtLeft(bn.minutesLeft * 60e3)
      : (bn.expiresAt ? fmtLeft(bn.expiresAt - Date.now()) : null);
    bits.push('<span class="route-bn" title="' + esc((bn.from || '?') + ' → ' + (bn.to || '?')) + '">' +
      'узкое место: портал в ' + esc(bn.to || bn.from || '?') +
      (left ? ' закроется через ' + esc(left) : ' скоро закроется') + '</span>');
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
function showRoute(res, title, emptyText) {
  const head = title ? '<div class="route-title">' + esc(title) + '</div>' : '';
  if (!res || !res.found) {
    setRouteHighlight(null);
    routeMsg(head + '<div class="route-fail">' + esc(res && res.reason ? res.reason : 'путь не найден') + '</div>', '');
    return;
  }
  // роутер нашёл путь длиной ноль — идти никуда не надо
  if (!res.steps || !res.steps.length) {
    setRouteHighlight(null);
    routeMsg(head + '<div class="route-here">' + esc(emptyText || 'ты уже на месте') + '</div>', '');
    return;
  }
  // Цвет ромба берётся из справочника зон, а зоны мира в нём могут быть ещё не спрошены —
  // спрашиваем и перерисовываем ленту, когда ответ придёт (см. ensureZoneInfo).
  lastRoute = { res, title, emptyText };
  const names = new Set();
  for (const st of res.steps) { if (st.from) names.add(st.from); if (st.to) names.add(st.to); }
  ensureZoneInfo(names);
  const html = [head, chainHtml(res.steps), summaryHtml(res)];
  if (res.risky) {
    html.push('<div class="route-risky">рискованно: ' +
      esc(res.reason || 'таймеры на пределе — портал может закрыться, пока идёшь') + '</div>');
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
  const btn = document.getElementById('route-clear');
  if (btn) btn.hidden = !routeHl;
}
function clearRoute() {
  lastRoute = null;
  setRouteHighlight(null);
  document.getElementById('route-to').value = '';
  if (curZone) fillFrom(curZone, true); else document.getElementById('route-from-input').value = '';
  acClose();
  routeMsg('введи зону назначения и нажми «Найти путь»');
}

// ---------- действия панели маршрута ----------
let routeBusy = false;
async function runRoute(mode) {
  if (routeBusy) return;
  const from = routeOrigin();
  if (!from) return routeMsg('Укажи, откуда идти.', 'route-fail');
  document.getElementById('route-from-input').value = from;
  if (!ipc || typeof ipc.findRoute !== 'function') return routeMsg('Поиск пути доступен только внутри приложения.', 'route-fail');

  let to = null;
  if (mode === 'to') {
    to = resolveDest(document.getElementById('route-to').value);
    if (!to) return routeMsg('Укажи, куда идти.', 'route-fail');
    document.getElementById('route-to').value = to;
  }
  acClose();
  routeBusy = true;
  const buttons = [document.getElementById('route-go'), document.getElementById('route-exit')];
  buttons.forEach(b => { b.disabled = true; });
  routeMsg('ищу путь…');
  try {
    const res = mode === 'to' ? await ipc.findRoute(from, to) : await ipc.findNearestExit(from);
    if (mode === 'to') showRoute(res);
    else showRoute(res, 'Ближайший выход в мир', 'идти никуда не нужно — выход прямо здесь');
  } catch (err) {
    setRouteHighlight(null);
    routeMsg('Ошибка поиска: ' + esc(err && err.message ? err.message : err), 'route-fail');
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
  document.getElementById('route-here').onclick = () => { if (curZone) fillFrom(curZone, true); };

  document.getElementById('route-go').onclick = () => runRoute('to');
  document.getElementById('route-exit').onclick = () => runRoute('exit');
  document.getElementById('route-clear').onclick = () => clearRoute();
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
const SCOPE_RU = { local: 'своя карта', group: 'карта друзей', public: 'общая карта' };
function scopeName(s) {
  if (!s || s === 'local') return SCOPE_RU.local;
  if (s === PUBLIC_ID || s === 'public') return SCOPE_RU.public;
  const r = chanRooms.find(x => x.id === s);
  return r ? (r.title || 'комната') : 'комната, из которой вышли';
}
cy.on('tap', 'edge', evt => {
  const d = evt.target.data();
  const el = document.getElementById('sel-info');
  // откуда ребро — важнее, чем кажется: чужому порталу веры меньше, чем своему.
  // Название канала, а не его код: код игроку ни о чём не говорит.
  const from = d.scope && d.scope !== 'local'
    ? '<br><i>' + esc(scopeName(d.scope)) + (d.by ? ' · ' + esc(d.by) : '') + '</i>' : '';
  // Сколько игроков подтвердило портал. Показываем, только пока не хватает: принятое
  // всеми ребро ничем не отличается от обычного, и лишняя подпись на нём — шум.
  // А вот своё непринятое видеть обязательно: иначе игрок решит, что выгрузка не работает.
  // Подтверждения считаются весом, а не штуками: прочитанный с экрана портал — единица,
  // вписанный руками — половина. Поэтому число бывает дробным, и дробь надо объяснить
  // ровно там, где она появилась, — иначе «1,5 из 3» читается как ошибка.
  const half = d.confirms != null && d.confirms % 1 !== 0;
  const ждёт = d.confirms != null && d.needed > 0 && d.confirms < d.needed
    ? '<br><i class="unconf">подтверждений ' + String(d.confirms).replace('.', ',') + ' из ' + d.needed +
      ' — остальные его пока не видят' +
      (half ? '<br>портал, вписанный руками, весит половину' : '') + '</i>' : '';
  // Кнопку удаления показываем ровно там, где право есть: у себя всегда, на общей
  // и в комнатах — владельцу карты и доверенным. Иначе она обещала бы несбыточное.
  const своё = !d.scope || d.scope === 'local';
  // Право удалять из КОМНАТЫ есть у её хранителя и владельца — так решает сервер
  // (delete_edge смотрит my_role). Раньше кнопка зависела только от общего признака
  // доверия, и владелец собственной комнаты читал под своим же порталом «удалять может
  // владелец», не понимая, что владелец — это он.
  const room = chanRooms.find(r => r.id === d.scope);
  const хозяинКомнаты = !!(room && (room.isOwner || room.role === 'admin'));
  const можно = своё || хозяинКомнаты || accTrusted;
  el.innerHTML = '<b>' + esc(d.a) + '</b> ⇄ <b>' + esc(d.b) + '</b><br>' + esc(d.label || 'таймер неизвестен') +
    from + ждёт +
    (можно ? '<br><button id="del-edge">Удалить портал</button>'
           : '<br><span class="muted small">удалять из этой карты может её хранитель</span>');
  const del = document.getElementById('del-edge');
  if (del) del.onclick = async () => {
    if (!ipc) return;
    const r = await ipc.removeEdge(d.a, d.b, d.scope || 'local');
    if (r && r.ok === false) { el.innerHTML = '<span class="muted small">не удалось: ' + esc(r.error) + '</span>'; return; }
    render(r && r.snapshot ? r.snapshot : r);
    el.textContent = 'удалено';
  };
});
cy.on('tap', 'node', evt => {
  const id = evt.target.id();
  document.getElementById('sel-info').innerHTML = '<b>' + esc(id) + '</b>';
  setSelZone(id); // запасная точка старта маршрута, пока зона не распознана
  showCardFor(id);
});
cy.on('dbltap', 'node', evt => {
  cy.animate({ center: { eles: evt.target }, duration: 250, easing: 'ease-out' });
});

// Клик по пустому месту снимает выбор. Раньше выбранная зона держалась до клика по
// другой, и «просто ничего не выбрано» было недостижимым состоянием: панель и карточка
// показывали зону, к которой игрок давно потерял интерес, а маршрут молча строился от неё.
// evt.target === cy означает попадание в холст, а не в узел или ребро.
function clearSelection() {
  selZone = null;
  cardZone = null;
  cy.elements(':selected').unselect();
  document.getElementById('sel-info').textContent = 'клик по зоне или порталу';
  const body = document.getElementById('card-body');
  if (body) body.innerHTML = '<div class="muted small">зона не выбрана</div>';
  updateOrigin();   // точка старта маршрута снова считается по текущей зоне
}
cy.on('tap', evt => { if (evt.target === cy) clearSelection(); });
document.getElementById('btn-relayout').onclick = () => fullLayout();
document.getElementById('btn-fit').onclick = () => { if (cy.nodes().length) cy.animate({ fit: { padding: 60 }, duration: 250 }); };

// ---------- журнал и тосты ----------
function log(text) {
  const el = document.getElementById('log');
  const row = document.createElement('div');
  row.textContent = new Date().toLocaleTimeString().slice(0, 5) + ' ' + text;
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
function renderStatus() {
  const el = document.getElementById('status');
  const key = `хоткей ${bindLabel}` + (cfg && !cfg.cursorScan ? ' — поиск зоны' : '');
  const watch = cfg && !cfg.zoneWatch ? 'зона не отслеживается'
    // «Слежу за экраном» читалось как «я слежу за тобой». Речь о работе механизма.
    : gameOn === false ? 'игра не запущена · опрос приостановлен' : 'отслеживание экрана работает';
  el.textContent = `${watch} · ${key}`;
  el.classList.toggle('idle', gameOn === false || !!(cfg && !cfg.zoneWatch));
}
function setPlacing(on) {
  placing = on;
  const b = document.getElementById('ov-place');
  b.classList.toggle('active', on);
  b.textContent = on ? 'Готово' : 'Задать место';
}
// Панель не хранит своего состояния: она рисует то, что вернул main-процесс.
// Так переключатель не может «показывать включено», когда на деле выключено.
function applyConfig(c) {
  if (!c) return;
  cfg = c;
  // Переключатели живут в окне настроек, а не в панели — ищем по всему документу
  document.querySelectorAll('input[data-opt]').forEach(inp => {
    inp.checked = !!c[inp.dataset.opt];
  });
  const kids = document.getElementById('overlay-opts');
  if (c.overlayEnabled) kids.removeAttribute('data-off'); else kids.setAttribute('data-off', '1');
  const zk = document.getElementById('zone-opts');
  if (c.zoneWatch) zk.removeAttribute('data-off'); else zk.setAttribute('data-off', '1');
  const scale = Math.round((c.overlayScale || 1) * 100);
  document.getElementById('ov-scale').value = scale;
  document.getElementById('ov-scale-val').textContent = scale + '%';
  const hold = c.overlayHoldSec || 7;
  document.getElementById('ov-hold').value = hold;
  document.getElementById('ov-hold-val').textContent = hold + ' с';
  document.getElementById('ov-place-note').textContent = c.overlayPos
    ? `своё место: ${Math.round(c.overlayPos.x)}, ${Math.round(c.overlayPos.bottom)} (нижний левый угол)`
    : 'стандартное место — над миникартой справа внизу';
  document.getElementById('ov-reset').disabled = !c.overlayPos;
  // Версия живёт только в окне настроек: в панели она занимала строку, которую читают раз
  // в жизни, а рядом с ней стоит блок «вышла новая» — он и есть то, что важно видеть.
  if (c.appVersion) document.getElementById('modal-version').textContent = 'версия ' + c.appVersion;
  // Симуляция — инструмент разработки: подсовывает распознавателю картинку с диска вместо
  // экрана игры. Игрок её не видит ни в собранной сборке, ни при обычном запуске из
  // исходников: нужен явный AVALON_DEV=1.
  document.getElementById('sim').hidden = !c.dev;
  // Ни одной цели выгрузки — портал не сохранится вообще нигде; молчать об этом нельзя.
  // Комнаты считаем наравне со своей и общей: целью может быть только комната.
  document.getElementById('share-none').hidden =
    !!(c.saveLocal || c.uploadPublic || chanRooms.some(r => r.upload));
  // Слежение выключили — main-процесс забыл текущую зону, и панель обязана
  // показать то же самое: иначе маршрут строился бы от зоны, где нас уже нет.
  if (!c.zoneWatch && curZone) {
    curZone = null;
    updateOrigin();
    document.getElementById('cur-zone').textContent = '— не отслеживается';
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
// PUBLIC_ID здесь тот же, что в lib/sync.js и в схеме базы: общая карта одна и с
// постоянным кодом, поэтому его можно писать константой, а не запрашивать.
const PUBLIC_ID = '00000000-0000-0000-0000-0000000000a0';
let accTrusted = false;   // доверенный: может удалять из общей карты и комнат
let authSignedIn = false; // вошёл через Discord: без этого комнаты и общая недоступны
let chanView = 'all';       // 'all' | 'local' | PUBLIC_ID | <код комнаты>
let chanRooms = [];         // [{ id, title, upload }]

// Видно ли ребро в выбранном канале.
//
// Ребро принадлежит НЕСКОЛЬКИМ картам сразу: свой портал уходит и в личную, и в комнату,
// и в общую. Раньше здесь сверялся один scope, а он у своего ребра всегда 'local' —
// и канал комнаты показывал только чужие порталы. Выглядело как «выгрузка не работает».
// scope при этом остаётся и отвечает на другой вопрос: откуда мы про портал узнали.
function edgeMaps(e) {
  return Array.isArray(e.maps) && e.maps.length ? e.maps : [e.scope || 'local'];
}
function edgeInView(e) {
  if (chanView === 'all') return true;
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
function channelItems() {
  return [
    // «Все карты», а не «Всё вместе»: игрок спросил, что это значит, — значит имя не
    // объясняло себя. Это не отдельная карта, а вид, где показаны все сразу.
    { id: 'all', name: 'Все карты', sub: 'порталы из всех карт сразу на одном графе' },
    { id: PUBLIC_ID, name: 'Общая', sub: 'одна карта на всех, кто её включил', up: !!(cfg && cfg.uploadPublic) },
    { id: 'local', name: 'Личная', sub: 'файл на этом компьютере, наружу не уходит', up: !cfg || !!cfg.saveLocal },
    // Комнаты — в самом низу и в порядке появления: их число растёт, а первые три места
    // должны оставаться на своих местах, иначе промахиваться будешь каждый раз.
    // Своя роль стоит прямо в подписи: «почему мой портал сюда не ушёл» — вопрос, на
    // который интерфейс обязан отвечать до того, как его зададут.
    ...chanRooms.map(r => ({
      id: r.id, name: r.title || 'Комната', room: true, up: !!r.upload,
      sub: r.role === 'viewer' ? 'карта друзей · у тебя только просмотр'
        : r.role === 'admin' ? 'карта друзей · ты хранитель'
        : r.role === 'verified' ? 'карта друзей · ты проверенный'
        : 'карта друзей — видят те, кому ты дал код',
    })),
  ];
}

function renderChannels() {
  const box = document.getElementById('chan-list');
  if (!box) return;
  box.innerHTML = channelItems().map(it =>
    '<button class="rail-btn' + (it.id === chanView ? ' on' : '') + '" type="button"' +
        ' data-id="' + esc(it.id) + '" aria-label="' + esc(it.name) + '"' +
        // В подсказку кладём и смысл точки: значок сам себя объяснить не может, а точка
        // молча решает судьбу каждого нового портала.
        ' data-tip="' + esc(it.name + (it.up ? ' · сюда пишутся новые порталы' : '')) + '">' +
      '<span class="rail-ico">' + esc(initials(it.name)) + '</span>' +
      (it.up ? '<span class="rail-up"></span>' : '') +
    '</button>').join('');
  renderChanHead();
}

// Шапка колонки — имя выбранного канала, как имя сервера в Discord, плюс строчка о том,
// что это за канал, и отдельная строка про золотую точку, когда она горит.
function renderChanHead() {
  const it = channelItems().find(x => x.id === chanView);
  const title = document.getElementById('chan-title');
  if (!title) return;
  title.textContent = it ? it.name : 'Канал';
  document.getElementById('chan-sub').textContent = it ? it.sub : '';
  document.getElementById('chan-up-note').hidden = !(it && it.up);
}

// Смена выбранного канала — переклейка класса, а не перестройка полосы. Это не экономия:
// у выбранного значка золотая скоба слева растёт по переходу, а сам значок меняет
// скругление. Пересоздай разметку — переходить будет нечему, и всё это моргнёт.
function markChannel() {
  document.querySelectorAll('#chan-list .rail-btn').forEach(c => c.classList.toggle('on', c.dataset.id === chanView));
  renderChanHead();
}

// Тумблеры выгрузки по комнатам. Стоят в настройках рядом со «своей» и «общей»: игрок
// думает о них одинаково — «куда попадёт следующий портал», — и разносить их по разным
// местам значило бы прятать половину ответа.
function renderRoomToggles() {
  const box = document.getElementById('set-rooms');
  if (!box) return;
  if (!chanRooms.length) {
    box.innerHTML = '<div class="opt-note">Карт друзей пока нет. Создать свою или войти по коду — ' +
      'кнопкой «+» у списка каналов слева.</div>';
    return;
  }
  box.innerHTML = chanRooms.map(r =>
    '<label class="opt"><input type="checkbox" data-room="' + esc(r.id) + '"' + (r.upload ? ' checked' : '') + '>' +
      '<span>В карту «' + esc(r.title || 'Комната') + '»</span></label>' +
    '<div class="opt-note room-note"><code>' + esc(r.id) + '</code>' +
      '<button class="btn ghost" type="button" data-copy="' + esc(r.id) + '">Копировать код</button></div>').join('');
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
  // Право удалять из общей карты и комнат. Держим отдельной переменной: карточка ребра
  // рисуется по клику, а состояние входа приходит асинхронно и раньше.
  accTrusted = !!st.trusted;
  authSignedIn = !!st.signedIn;

  // нижняя карточка панели
  document.getElementById('acc-in').hidden = !!st.signedIn;
  document.getElementById('acc-me').hidden = !st.signedIn;
  if (st.signedIn) {
    document.getElementById('acc-nick').textContent = st.nick || 'без имени';
    const role = document.getElementById('acc-role');
    role.textContent = st.trusted ? 'доверенный' : 'вход через Discord';
    role.classList.toggle('trusted', !!st.trusted);
    setAvatar('acc-ini', 'acc-img', st.nick, st.avatar);
    // раздел «Аккаунт» в настройках — та же правда, только подробнее
    document.getElementById('acc-who').textContent = st.nick || 'без имени';
    document.getElementById('acc-who-note').textContent = st.trusted
      ? 'доверенный: можешь удалять чужие порталы из общей карты'
      : 'обычный игрок: твой портал появится в общей карте после трёх подтверждений';
    setAvatar('acc-ini-2', 'acc-img-2', st.nick, st.avatar);
  }
  out.hidden = !!st.signedIn;
  box.hidden = !st.signedIn;
  // окно новой карты: без входа комнаты недоступны, и предупредить надо до нажатия
  const need = document.getElementById('map-need-auth');
  if (need) need.hidden = !!st.signedIn;
  // подпись под списком каналов объясняет, почему общее недоступно; вошёл — объяснять нечего
  const note = document.getElementById('chan-note');
  if (note) note.hidden = !!st.signedIn;
  document.querySelectorAll('#map-create, #map-join').forEach(b => { b.disabled = !st.signedIn; });

  err.hidden = !st.error;
  if (st.error) err.textContent = 'Вход не удался: ' + st.error;
}

function renderUpdate(st) {
  const box = document.getElementById('update-box');
  if (!box || !st) return;
  if (st.current) document.getElementById('modal-version').textContent = 'версия ' + st.current;
  const has = !!st.latest;
  box.hidden = !has;
  if (!has) return;
  document.getElementById('update-ver').textContent = st.latest;
  document.getElementById('update-notes').textContent = st.notes || '';
  document.getElementById('update-btn').disabled = !st.url;
}

// Строка состояния общих карт: включено ли, сколько ждёт в очереди, была ли связь.
// Молчаливая синхронизация — худший вариант: игрок должен видеть, ушло или нет.
function renderSync(st) {
  const el = document.getElementById('sync-state');
  if (!el || !st) return;
  el.classList.remove('on', 'bad');
  if (!st.ready) { el.textContent = 'сервер не настроен — выгрузка недоступна'; return; }
  if (!st.enabled) { el.textContent = 'наружу ничего не уходит — отмечена только своя карта'; return; }
  const bits = [];
  // targets — коды карт, а не слова: переводим их в названия тем же способом, что и
  // подпись под ребром. Иначе строка состояния показывала бы игроку голые uuid.
  bits.push('уходит в: ' + (st.targets || []).map(scopeName).join(', '));
  if (st.queued) bits.push('в очереди ' + st.queued);
  if (st.lastPushAt) bits.push('отправлено в ' + new Date(st.lastPushAt).toLocaleTimeString().slice(0, 5));
  if (st.pulled) bits.push('принято чужих: ' + st.pulled);
  if (st.lastError) {
    el.classList.add('bad');
    el.textContent = 'сеть: ' + st.lastError + (st.waitingSec ? ` — повтор через ${st.waitingSec} с` : '');
    return;
  }
  el.classList.add('on');
  el.textContent = bits.join(' · ');
}

// ---------- окна поверх ----------
// Настройки и создание карты переехали в окна: панель слева стала колонкой каналов, а
// настройки открывают раз в неделю — держать их развёрнутыми на пол-экрана незачем.
// Закрыть можно тремя способами: крестик, подложка, Escape. Рабочий обычно третий.
let modalReturn = null;          // куда вернуть фокус после закрытия
let lastSection = 'set-account'; // окно настроек открывается там, где его закрыли

function showSection(id) {
  lastSection = id;
  document.querySelectorAll('#modal-settings .msec').forEach(s => { s.hidden = s.id !== id; });
  document.querySelectorAll('#modal-settings .mn').forEach(b => b.classList.toggle('on', b.dataset.sec === id));
  const body = document.querySelector('#modal-settings .modal-body');
  if (body) body.scrollTop = 0;
}
function openModal(id, section) {
  const m = document.getElementById(id);
  if (!m || !m.hidden) return;
  modalReturn = document.activeElement;
  if (id === 'modal-settings') showSection(section || lastSection);
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
  // Прячем не сразу: сначала уход, потом [hidden]. Длительность та же, что в .modal.closing.
  m.classList.add('closing');
  setTimeout(() => { m.hidden = true; m.classList.remove('closing'); }, 160);
  if (modalReturn && modalReturn.focus) modalReturn.focus({ preventScroll: true });
  modalReturn = null;
}
function closeModals() { document.querySelectorAll('.modal:not([hidden])').forEach(closeModal); }
function mapErr(text) {
  const el = document.getElementById('map-err');
  if (!el) return;
  el.hidden = !text;
  if (text) el.textContent = text;
}

document.addEventListener('click', ev => {
  // меню канала закрывается кликом мимо — но не по самой стрелке, она его переключает
  if (!ev.target.closest('#chan-menu') && !ev.target.closest('#chan-head')) closeChanMenu();
  if (ev.target.closest('[data-close]')) { closeModals(); return; }
  const nav = ev.target.closest('#modal-settings .mn');
  if (nav) showSection(nav.dataset.sec);
  const tab = ev.target.closest('.seg-b');
  if (tab) {
    document.querySelectorAll('.seg-b').forEach(b => b.classList.toggle('on', b === tab));
    document.getElementById('tab-new').hidden = tab.dataset.tab !== 'new';
    document.getElementById('tab-join').hidden = tab.dataset.tab !== 'join';
    mapErr(null);
  }
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { closeChanMenu(); closeModals(); } });
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
  chanView = row.dataset.id;
  closeChanMenu();
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
    list.push({ act: 'invite', text: 'Пригласить участников' });
    const r = roomOf(it.id);
    if (r && (r.role === 'admin' || r.isOwner)) list.push({ act: 'roles', text: 'Настройки ролей' });
  }
  list.push({ act: 'upload', text: 'Куда сохранять портал…' });
  if (it.room) list.push({ act: 'leave', text: leaveArmed ? 'Точно выйти?' : 'Выйти из карты', cls: 'danger' });
  return list;
}
// Меню всегда относится к КОНКРЕТНОМУ каналу, а не к выбранному: по правой кнопке его
// открывают на значке в полосе, и переключать при этом граф было бы неожиданно.
let menuFor = null, menuAt = null;
function closeChanMenu() {
  const m = document.getElementById('chan-menu');
  if (!m || m.hidden) return;
  m.hidden = true;
  m.removeAttribute('style');
  leaveArmed = false;
  menuFor = null; menuAt = null;
  document.getElementById('chan-head').setAttribute('aria-expanded', 'false');
}
// at — координаты курсора для меню по правой кнопке; без них меню висит под шапкой
function openChanMenu(id, at) {
  const m = document.getElementById('chan-menu');
  const it = channelItems().find(x => x.id === (id || chanView));
  if (!m || !it) return;
  menuFor = it.id; menuAt = at || null;
  hideTip();   // подсказка канала стоит ровно там, куда встаёт меню
  m.innerHTML = chanMenuFor(it).map(x =>
    '<button type="button" role="menuitem" data-act="' + x.act + '"' +
      (x.cls ? ' class="' + x.cls + '"' : '') + '>' + esc(x.text) + '</button>').join('');
  if (at) {
    // у курсора: фиксируем по окну, чтобы меню не резалось прокруткой полосы
    m.style.position = 'fixed';
    m.style.left = Math.round(at.x) + 'px';
    m.style.top = Math.round(at.y) + 'px';
    m.style.right = 'auto';
    m.style.width = '210px';
  }
  m.hidden = false;
  document.getElementById('chan-head').setAttribute('aria-expanded', at ? 'false' : 'true');
}
const chanHead = document.getElementById('chan-head');
if (chanHead) chanHead.onclick = () => {
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
  if (act === 'invite') {
    closeChanMenu();
    return navigator.clipboard.writeText(id)
      .then(() => toast('Код скопирован — это и есть приглашение, отправь его игроку'))
      .catch(() => toast('Буфер недоступен'));
  }
  if (act !== 'leave') return;
  if (!leaveArmed) { const at = menuAt; leaveArmed = true; return openChanMenu(id, at); }   // спрашиваем один раз
  closeChanMenu();
  if (!ipc) return;
  const r = await ipc.roomLeave(id);
  if (!r.ok) return toast('Не вышло: ' + r.error);
  if (chanView === id) chanView = 'all';
  chanRooms = r.rooms;
  applyConfig(cfg);
  if (lastSnap) render(lastSnap);
  toast('Вышел из карты');
});

// ---------- участники и роли ----------
// Графы идут слева направо по возрастанию прав: наблюдатель ничего не меняет, хранитель
// меняет всё. Ник переносится между графами мышью — это и есть выдача роли.
//
// «Проверенный» существует не сам по себе, а вместе с порогом подтверждений: пока порога
// нет, разведчик и проверенный неотличимы, и графа была бы обманом. Поэтому тумблер
// включает и то и другое разом, а число подтверждений задаётся тут же.
const ROLES = [
  { id: 'viewer',   name: 'Наблюдатель', sub: 'только смотрит карту' },
  { id: 'member',   name: 'Разведчик',   sub: 'смотрит и добавляет порталы' },
  { id: 'verified', name: 'Проверенный', sub: 'добавляет без подтверждений', needsPolicy: true },
  { id: 'admin',    name: 'Хранитель',   sub: 'роли, удаление, порог' },
];
const ROLE_NAME = Object.fromEntries(ROLES.map(r => [r.id, r.name]));
let rolesMap = null;      // код карты, чьи участники открыты
let rolesList = [];       // [{ id, nick, role, isOwner }]
let rolesNeed = 0;        // порог подтверждений карты; 0 — порога нет
let rolesOwner = false;   // я владелец: только владелец назначает и снимает хранителей
let rolesPicked = null;   // ник «взят» щелчком и ждёт, куда его положить

function rolesErr(text) {
  const el = document.getElementById('roles-err');
  if (!el) return;
  el.hidden = !text;
  if (text) el.textContent = text;
}

function renderRoles() {
  const box = document.getElementById('roles-cols');
  if (!box) return;
  const on = rolesNeed > 0;
  document.getElementById('roles-verified').checked = on;
  document.getElementById('roles-need-row').hidden = !on;
  document.getElementById('roles-need').value = on ? rolesNeed : 3;
  document.getElementById('roles-policy-note').textContent = on
    ? 'включено: портал разведчика появляется у остальных после ' + rolesNeed +
      ' подтверждений от разных людей. Проверенные и хранители не ждут.'
    : 'выключено: разведчики пишут в карту напрямую, их порталы видны всем сразу';

  const cols = ROLES.filter(r => on || !r.needsPolicy);
  box.style.setProperty('--cols', cols.length);
  box.innerHTML = cols.map(r => {
    // Порог сняли — графа «проверенный» пропадает, но люди из неё не должны пропасть
    // вместе с ней: без порога проверенный и разведчик делают ровно одно и то же,
    // поэтому показываем их вместе. Роль на сервере при этом не трогаем — вернут порог,
    // и все окажутся там же, где были.
    const people = rolesList.filter(m => m.role === r.id || (!on && r.id === 'member' && m.role === 'verified'));
    return '<div class="rcol" data-role="' + r.id + '">' +
      '<div class="rcol-h"><b>' + esc(r.name) + '</b><i>' + esc(r.sub) + '</i></div>' +
      '<div class="rcol-b">' + (people.length ? people.map(m =>
        '<div class="rchip' + (m.isOwner ? ' owner' : '') + '" data-user="' + esc(m.id) + '"' +
            (m.isOwner ? '' : ' draggable="true"') + '>' +
          '<span class="rchip-n">' + esc(m.nick) + '</span>' +
          (m.isOwner ? '<i class="rchip-o">владелец</i>'
                     : '<button class="rchip-x" type="button" data-kick="' + esc(m.id) + '" title="Выгнать из карты">×</button>') +
        '</div>').join('') : '<div class="rcol-empty">пусто</div>') + '</div>' +
    '</div>';
  }).join('');
}

async function moveRole(userId, role) {
  const m = rolesList.find(x => x.id === userId);
  if (!m || m.role === role || m.isOwner) return;
  if ((role === 'admin' || m.role === 'admin') && !rolesOwner) {
    return rolesErr('Назначать и снимать хранителей может только владелец карты.');
  }
  rolesErr(null);
  const prev = m.role;
  m.role = role;          // показываем сразу, а не после ответа: перетаскивание должно быть мгновенным
  renderRoles();
  if (!ipc || !ipc.mapSetRole) return;
  const r = await ipc.mapSetRole(rolesMap, userId, role);
  if (!r.ok) { m.role = prev; renderRoles(); return rolesErr('Не вышло: ' + r.error); }
  rolesList = r.members;
  renderRoles();
}

async function openRoles(mapId) {
  rolesMap = mapId;
  rolesPicked = null;
  rolesErr(null);
  const room = chanRooms.find(r => r.id === mapId);
  document.getElementById('roles-map').textContent = (room && room.title) || 'карта';
  rolesOwner = !!(room && room.isOwner);
  rolesNeed = (room && Number(room.confirmRequired)) || 0;
  rolesList = [];
  renderRoles();
  openModal('modal-roles');
  // Стенд оформления: сервера нет, но окно должно быть видно с живым содержимым
  if (!ipc || !ipc.mapMembers) { rolesList = window.DEMO_MEMBERS || []; return renderRoles(); }
  const r = await ipc.mapMembers(mapId);
  if (!r.ok) return rolesErr('Список участников не пришёл: ' + r.error);
  rolesList = r.members;
  renderRoles();
}

{
  const cols = document.getElementById('roles-cols');
  if (cols) {
    // Перетаскивание — основной способ. Щелчок по нику и потом по графе — запасной:
    // мышь может сорваться, а на разных машинах перетаскивание ведёт себя по-разному.
    cols.addEventListener('dragstart', ev => {
      const chip = ev.target.closest('.rchip');
      if (!chip || chip.classList.contains('owner')) return ev.preventDefault();
      ev.dataTransfer.setData('text/plain', chip.dataset.user);
      ev.dataTransfer.effectAllowed = 'move';
      chip.classList.add('dragging');
    });
    cols.addEventListener('dragend', () => {
      cols.querySelectorAll('.dragging').forEach(c => c.classList.remove('dragging'));
      cols.querySelectorAll('.over').forEach(c => c.classList.remove('over'));
    });
    cols.addEventListener('dragover', ev => {
      const col = ev.target.closest('.rcol');
      if (!col) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      cols.querySelectorAll('.over').forEach(c => { if (c !== col) c.classList.remove('over'); });
      col.classList.add('over');
    });
    cols.addEventListener('drop', ev => {
      const col = ev.target.closest('.rcol');
      if (!col) return;
      ev.preventDefault();
      col.classList.remove('over');
      const user = ev.dataTransfer.getData('text/plain');
      if (user) moveRole(user, col.dataset.role);
    });
    cols.addEventListener('click', async ev => {
      const kick = ev.target.closest('[data-kick]');
      if (kick) {
        ev.stopPropagation();
        const id = kick.dataset.kick;
        // Выгнать нельзя отменить — спрашиваем вторым нажатием, как и с выходом из карты
        if (kick.dataset.armed !== '1') {
          cols.querySelectorAll('[data-armed]').forEach(x => { x.dataset.armed = '0'; x.textContent = '×'; });
          kick.dataset.armed = '1';
          kick.textContent = '?';
          return;
        }
        if (!ipc || !ipc.mapKick) return;
        const r = await ipc.mapKick(rolesMap, id);
        if (!r.ok) return rolesErr('Не вышло: ' + r.error);
        rolesList = r.members;
        rolesErr(null);
        renderRoles();
        return;
      }
      const chip = ev.target.closest('.rchip');
      if (chip && !chip.classList.contains('owner')) {
        cols.querySelectorAll('.picked').forEach(c => c.classList.remove('picked'));
        rolesPicked = rolesPicked === chip.dataset.user ? null : chip.dataset.user;
        if (rolesPicked) chip.classList.add('picked');
        return;
      }
      const col = ev.target.closest('.rcol');
      if (col && rolesPicked) { const u = rolesPicked; rolesPicked = null; moveRole(u, col.dataset.role); }
    });
  }
  const vsw = document.getElementById('roles-verified');
  if (vsw) vsw.onchange = async () => {
    const want = vsw.checked ? (Number(document.getElementById('roles-need').value) || 3) : 0;
    await savePolicy(want);
  };
  const needBtn = document.getElementById('roles-need-save');
  if (needBtn) needBtn.onclick = () => savePolicy(Number(document.getElementById('roles-need').value) || 3);
}

async function savePolicy(n) {
  const want = Math.max(0, Math.min(10, Math.round(n)));
  rolesErr(null);
  if (!ipc || !ipc.mapPolicy) { rolesNeed = want; return renderRoles(); }
  const r = await ipc.mapPolicy(rolesMap, want);
  if (!r.ok) { renderRoles(); return rolesErr('Не вышло: ' + r.error); }
  rolesNeed = r.confirmRequired;
  const room = chanRooms.find(x => x.id === rolesMap);
  if (room) room.confirmRequired = rolesNeed;
  renderRoles();
  toast(rolesNeed
    ? 'Порталы разведчиков теперь ждут ' + rolesNeed + ' подтверждений'
    : 'Порог снят — разведчики пишут напрямую');
}

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
  const setBind = label => {
    bindLabel = label;
    document.getElementById('bind-label').textContent = label;
    renderStatus();
  };
  ipc.on('ready', ({ binding }) => setBind(binding));
  ipc.on('binding-changed', ({ label }) => { setBind(label); toast(`Бинд: ${label}`); });
  ipc.on('game-state', ({ running }) => { gameOn = running; renderStatus(); });
  document.getElementById('bind-btn').onclick = async () => {
    document.getElementById('bind-label').textContent = 'Нажми клавишу или кнопку мыши (Esc — отмена)';
    setBind(await ipc.captureBinding());
  };
  ipc.on('toast', ({ text }) => toast(text));
  // предупреждение о правах: без админа хоткей не долетает, пока фокус на окне игры
  ipc.on('privileges', p => {
    const box = document.getElementById('admin-warn');
    if (box) box.hidden = !p.needsAdmin;
  });
  const adminBtn = document.getElementById('btn-admin');
  if (adminBtn) adminBtn.onclick = async () => {
    adminBtn.disabled = true;
    adminBtn.textContent = 'Перезапускаю…';
    const r = ipc.restartAsAdmin ? await ipc.restartAsAdmin() : { ok: false, error: 'недоступно' };
    if (!r.ok) {
      adminBtn.disabled = false;
      adminBtn.textContent = 'Перезапустить от администратора';
      toast('Не вышло: ' + (r.error || 'неизвестная ошибка') + '. Запусти «Avalon Mapper.bat» вручную.');
    }
  };
  // «Указать мою зону» — постоянный вход в окно поиска. Он нужен именно как кнопка:
  // при выключенном слежении окно открывалось только хоткеем и только когда снимок
  // у курсора выключен, то есть в части настроек назвать свою зону было нечем вовсе.
  const sayZone = document.getElementById('say-zone');
  if (sayZone && ipc.openSearch) sayZone.onclick = () => ipc.openSearch();

  ipc.on('zone-changed', ({ zone }) => {
    if (!zone || !zone.zone) return;
    const info = rememberZone({ name: zone.zone, color: zone.color, tier: zone.tier, activities: zone.activities });
    document.getElementById('cur-zone').textContent = zone.zone;
    setCurZone(zone.zone); // маршрут теперь строится от новой зоны
    log(`зона: ${zone.zone}`);
    showCard(info); // (а) зашли в зону — сразу показываем, что внутри
  });
  ipc.on('edge-added', ({ from, tip, manual }) => {
    if (!tip || !tip.name) return;
    const info = rememberZone({ name: tip.name, color: tip.color, tier: tip.tier, activities: tip.activities });
    // только размер портала: свободные места устаревают за минуты и в интерфейсе не нужны
    const sizeKnown = tip.capMaxKnown !== false && tip.capMax != null;
    const cap = sizeKnown ? 'портал на ' + tip.capMax
      : manual ? 'выбрано вручную' : 'размер портала не прочитан';
    // Ребро появляется, только когда известно, ОТКУДА портал. Слежение за зоной
    // выключено — на карте ничего не прибавится, и врать об этом в журнале нельзя.
    log(from ? `портал: ${from} → ${tip.name} (${cap})`
      : `зона за порталом: ${tip.name} (${cap}) — начало неизвестно, ребро не создано`);
    toast(`✔ ${tip.name} · ${cap}${tip.closes ? ' · закроется через ' + fmtLeft(tip.closes * 1000) : ''}`);
    // (б) главный сценарий: навёл на портал, нажал хоткей — увидел, что за ним.
    // Размер портала — той же полосой в цвет, что и в игровом оверлее.
    const sizeHtml = sizeKnown
      ? '<span class="port-size size-' + Number(tip.capMax) + '"><i></i><b>' + esc(tip.capMax) + '</b></span>'
      : '<span class="port-size size-unknown">' + (manual ? 'выбрано вручную' : 'размер не прочитан') + '</span>';
    const bits = [from ? 'портал из <b>' + esc(from) + '</b>' : 'зона за порталом', sizeHtml];
    if (tip.closes != null) bits.push('закроется через ' + esc(fmtLeft(tip.closes * 1000)));

    showCard(info, bits.join(' · '));
    // Показать портал на графе. Не вышло (узел ещё не добавлен) — покажем после отрисовки.
    if (!revealEdge(from, tip.name)) pendingReveal = { a: from, b: tip.name, at: Date.now() };
  });
  ipc.on('map-updated', snap => render(snap));
  ipc.getMap().then(render);
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
      ? `<b>своя область:</b> ${Math.round(region.width)}×${Math.round(region.height)} в точке ${Math.round(region.left)}, ${Math.round(region.top)}`
      : 'сейчас стандартная — у миникарты, справа внизу';
  };
  const pickBtn = document.getElementById('btn-pick-region');
  if (pickBtn) pickBtn.onclick = async () => {
    pickBtn.disabled = true;
    try {
      const r = await ipc.pickZoneRegion();
      if (r.cancelled) return;
      if (!r.ok) { toast('Не вышло: ' + r.error); return; }
      regionLabel(r.region);
      if (r.zone) {
        toast(`Область принята — вижу «${r.zone}»`);
        log(`область плашки задана, читаю: ${r.zone}`);
      } else {
        toast('Область сохранена, но плашку в ней прочитать не смог');
        log('область плашки задана, но текст не распознан — попробуй обвести иначе');
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
    document.getElementById('ov-scale-val').textContent = scaleInput.value + '%';
    scaleWanted = Number(scaleInput.value) / 100;
    applyScale();
  };
  scaleInput.onchange = () => { scaleWanted = Number(scaleInput.value) / 100; applyScale(); };

  const holdInput = document.getElementById('ov-hold');
  holdInput.oninput = () => { document.getElementById('ov-hold-val').textContent = holdInput.value + ' с'; };
  holdInput.onchange = async () => { applyConfig(await ipc.setOption('overlayHoldSec', Number(holdInput.value))); };

  const placeBtn = document.getElementById('ov-place');
  placeBtn.onclick = async () => {
    if (placing) { await ipc.overlaySetup('done'); return setPlacing(false); }
    const r = await ipc.overlaySetup('start');
    if (!r.ok) return toast('Не вышло: ' + (r.error || 'неизвестная ошибка'));
    setPlacing(true);
    toast('Тяни плашку на игре мышью · колесо — размер · Enter — готово');
  };
  document.getElementById('ov-reset').onclick = async () => {
    await ipc.overlaySetup('reset');
    applyConfig(await ipc.getConfig());
  };
  // ---------- каналы ----------
  ipc.on('rooms-changed', rooms => { chanRooms = rooms || []; renderChannels(); renderRoomToggles(); });
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
      if (!r.ok) { t.checked = !t.checked; return toast('Не вышло: ' + r.error); }
      chanRooms = r.rooms;
      applyConfig(cfg);   // «не отмечено ничего» и точки в каналах зависят и от комнат
    });
    roomsBox.addEventListener('click', ev => {
      const b = ev.target.closest('[data-copy]');
      if (!b) return;
      navigator.clipboard.writeText(b.dataset.copy)
        .then(() => toast('Код карты скопирован')).catch(() => toast('Буфер недоступен'));
    });
  }

  // ---------- новая карта ----------
  const mapCreate = document.getElementById('map-create');
  if (mapCreate) mapCreate.onclick = async () => {
    const el = document.getElementById('map-title');
    const name = el.value.trim();
    if (!name) return mapErr('Придумай название — под ним карта встанет в список каналов.');
    mapErr(null);
    mapCreate.disabled = true;
    try {
      const r = await ipc.roomCreate(name);
      if (!r.ok) return mapErr(r.error || 'карта не создалась');
      chanRooms = r.rooms;
      applyConfig(cfg);
      el.value = '';
      closeModals();
      if (navigator.clipboard) navigator.clipboard.writeText(r.id).catch(() => {});
      log('создана карта «' + name + '»: ' + r.id);
      toast('Карта «' + name + '» создана, код скопирован — отправь его друзьям');
    } finally { mapCreate.disabled = !authSignedIn; }
  };
  const mapJoin = document.getElementById('map-join');
  if (mapJoin) mapJoin.onclick = async () => {
    const code = document.getElementById('map-code');
    const title = document.getElementById('map-code-title');
    if (!code.value.trim()) return mapErr('Вставь код карты — его присылает тот, кто её создал.');
    mapErr(null);
    mapJoin.disabled = true;
    try {
      const r = await ipc.roomJoin(code.value.trim(), title.value.trim());
      if (!r.ok) return mapErr(r.error || 'войти не вышло');
      chanRooms = r.rooms;
      chanView = r.id;              // сразу показываем то, во что вошли
      applyConfig(cfg);
      if (lastSnap) render(lastSnap);
      code.value = ''; title.value = '';
      closeModals();
      toast('Вошёл в карту');
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
    btn.textContent = 'Жду в браузере · нажми ещё раз, чтобы открыть заново';
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
      err.textContent = 'Вход не удался: ' + r.error;
      openModal('modal-settings', 'set-account');
      return;
    }
    renderAuth(r);
    toast('Вход выполнен: ' + (r.nick || ''));
  };
  if (ipc.authSignIn) ['acc-in', 'acc-in-2'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.onclick = () => signIn(b);
  });
  const accOut = document.getElementById('acc-out-btn');
  if (accOut && ipc.authSignOut) accOut.onclick = async () => renderAuth(await ipc.authSignOut());
  // Код аккаунта нужен ровно для одного: владелец проекта выдаёт по нему право удалять
  // из общей карты. Показывать его постоянно незачем — это длинный uuid, — поэтому кнопка.
  // Ник для связи: только в буфер обмена. Приложение не открывает ничего в Discord само
  // и никуда ничего не отправляет — «написать нам» остаётся действием человека.
  const contact = document.getElementById('contact-copy');
  if (contact) contact.onclick = () => {
    const nick = document.getElementById('contact-nick').textContent.trim();
    navigator.clipboard.writeText(nick)
      .then(() => toast('Скопировано: ' + nick)).catch(() => toast('Буфер недоступен'));
  };
  const accId = document.getElementById('acc-id');
  if (accId && ipc.authId) accId.onclick = async () => {
    const id = await ipc.authId();
    if (!id) return toast('Код появится после входа');
    if (navigator.clipboard) await navigator.clipboard.writeText(id).catch(() => {});
    toast('Код скопирован: ' + id);
  };
  ipc.on('auth-changed', st => { renderAuth(st); if (st && st.signedIn) pullRooms(); });
  if (typeof ipc.authStatus === 'function') {
    ipc.authStatus().then(st => { renderAuth(st); if (st && st.signedIn) pullRooms(); }).catch(() => {});
  }

  // ---------- обновления ----------
  ipc.on('update-available', () => { ipc.updateStatus().then(renderUpdate).catch(() => {}); });
  document.getElementById('update-btn').onclick = async () => {
    const r = await ipc.updateOpen();
    toast(r.ok ? 'Открыл страницу выпуска в браузере' : 'Не вышло: ' + (r.error || ''));
  };
  if (typeof ipc.updateStatus === 'function') ipc.updateStatus().then(renderUpdate).catch(() => {});

  ipc.on('sync-status', renderSync);
  ipc.syncStatus().then(renderSync).catch(() => {});
  setInterval(() => { ipc.syncStatus().then(renderSync).catch(() => {}); }, 5000);

  document.getElementById('btn-shots').onclick = async () => {
    const r = await ipc.openShots();
    if (!r.ok) toast(r.error || 'не удалось открыть папку');
  };
  // оверлей сам сообщает о перетаскивании, колесе и выходе из режима настройки
  ipc.on('config-changed', c => { applyConfig(c); setPlacing(!!c.setupActive); });

  ipc.getConfig().then(c => {
    regionLabel(c.zoneBarRegion);
    document.getElementById('bind-label').textContent = (c.binding && c.binding.label) || 'F9';
    document.getElementById('status').textContent = 'загрузка OCR…';
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
  chanRooms = [{ id: '9f1c2a44-7b3e-4d10-9a6f-2c5e8b0d1a77', title: 'Гильдия', upload: true,
    role: 'admin', isOwner: true, confirmRequired: 3 }];
  // Участники для стенда: без них окно ролей нечем показать (сервера здесь нет).
  window.DEMO_MEMBERS = [
    { id: 'u1', nick: 'wifi07', role: 'admin', isOwner: true },
    { id: 'u2', nick: 'Hallelujah', role: 'admin', isOwner: false },
    { id: 'u3', nick: 'Langnita', role: 'verified', isOwner: false },
    { id: 'u4', nick: 'yolo.sapiens', role: 'member', isOwner: false },
    { id: 'u5', nick: 'Boerst_dono', role: 'member', isOwner: false },
    { id: 'u6', nick: 'Tw1Nk1', role: 'viewer', isOwner: false },
  ];
  // ?anon — посмотреть, как окно выглядит до входа (нижняя карточка, окно новой карты)
  renderAuth(location.search.includes('anon')
    ? { signedIn: false }
    : { signedIn: true, nick: 'wifi07', trusted: false, userId: 'demo', avatar: null });
  applyConfig({
    overlayEnabled: true, overlayMap: true, overlayScale: 1, overlayPos: null,
    zoneWatch: true, cursorScan: true, copyWorldZone: true, saveShots: false, overlayHoldSec: 7,
    saveLocal: true, uploadPublic: false, appVersion: '0.2.0', dev: true,
  });
  renderUpdate({ current: '0.2.0', latest: '0.3.0', url: 'https://example/x.exe', notes: 'быстрее распознаётся портал, чинится плашка зоны' });
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
      reason: 'таймеры на пределе — портал может закрыться, пока идёшь',
      bottleneck: { from: 'Qiient-Qi-Odesas', to: 'Coues-Exakrom', expiresAt: now + 8 * 60e3, minutesLeft: 8 },
      steps: [
        { kind: 'portal', from: 'Qiient-Qi-Odesas', to: 'Coues-Exakrom', capNum: 7, capMax: 7, expiresAt: now + 8 * 60e3 },
        { kind: 'exit', from: 'Coues-Exakrom', to: 'Murky Fen', capNum: 5, capMax: 7, expiresAt: now + 124 * 60e3 },
        // пеший участок из нескольких зон — ровно тот случай, ради которого показываем цепочку
        { kind: 'walk', from: 'Murky Fen', to: 'Drownhorse Basin' },
        { kind: 'walk', from: 'Drownhorse Basin', to: 'Windripple Fen' },
        { kind: 'walk', from: 'Windripple Fen', to: 'Sleetwater Basin' },
      ],
    }, 'маршрут до Sleetwater Basin');
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
