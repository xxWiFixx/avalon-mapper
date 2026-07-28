// Маршрутизатор Дорог Авалона: поиск пути по объединённому графу
//   'portal' — портал Авалона (оба конца — авалонские зоны),
//   'exit'   — граница Авалон/мир (выход наружу или вход обратно),
//   'walk'   — пеший переход между смежными зонами мира.
// Карта рисует только Авалон, но роутер обязан находить «2 прыжка + выход + 2 зоны пешком»
// вместо десяти прыжков по Дорогам, поэтому цена шага — ВРЕМЯ, а не количество прыжков.
// Алгоритм — Дейкстра с парето-метками (стоимость, время): стоимость включает штраф за риск,
// а время нужно отдельно, чтобы честно проверять таймеры порталов.
const fs = require('fs');
const path = require('path');

const STATIC = path.join(__dirname, '..', 'data-static');
const WORLD_ADJACENCY_PATH = path.join(STATIC, 'world-adjacency.json');

// Все веса — в секундах, все настраиваются через opts.
//
// МОДЕЛЬ ВРЕМЕНИ. Любой шаг = «пробежать зону, в которой стою» + «загрузочный экран».
// Ключевой момент: бежим мы всегда по зоне, которую ПОКИДАЕМ, поэтому цена шага
// зависит от типа зоны-источника, а не назначения. Выход из Авалона в мир стоит
// столько же, сколько прыжок по Авалону (обе пробежки — по авалонской зоне),
// а вход обратно из мира — это уже пробежка по зоне мира.
//
// Пробежки усреднены: портал/выход может оказаться и рядом, и в дальнем углу;
// в мире переход к соседней грани короче, чем к противоположной. Берём среднее.
// Скорость маунта на ВЫБОР маршрута почти не влияет (масштабирует все пробежки
// одинаково) — она важна для точности ETA, поэтому вынесена отдельным множителем.
const DEFAULTS = {
  // Загрузочный экран при любом переходе между зонами (замер игрока: 2–3 с).
  loadSec: 3,
  // Среднее время пересечения зоны до точки перехода, на дефолтном маунте.
  // Замеры игрока (короткий/длинный вариант, берём середину):
  //   Авалон 20…135 → 78 (портал может оказаться рядом, а может в дальнем углу)
  //   Мир    35…120 → 78 (переход к соседней грани короче, чем к противоположной)
  // Средние совпали, поэтому прыжок и пеший переход стоят почти одинаково,
  // и роутер по сути минимизирует ЧИСЛО шагов. Разброс у Авалона заметно шире.
  avalonCrossSec: 78, // авалонская зона: от входа до портала
  worldCrossSec: 78,  // зона мира: от границы до границы
  // Множитель скорости передвижения: <1 — быстрый маунт, >1 — медленный/пешком.
  // Влияет только на пробежки, загрузочные экраны от него не зависят.
  mountFactor: 1,
  // Запас: портал должен быть жив ещё столько секунд к моменту, когда мы к нему подойдём.
  safetyMarginSec: 120,
  // Портал, закрывающийся в пределах этого окна после прогноза прохода, считается рискованным.
  riskHorizonSec: 600,
  // Максимальный штраф за риск (для портала, закрывающегося ровно на границе запаса).
  riskPenaltySec: 180,
  // TODO (отложено по решению 2026-07-24): опция «безопасный маршрут».
  // Сейчас роутер ищет ТОЛЬКО кратчайший путь по времени, опасность зон не учитывается.
  // Замысел на будущее: накопительный штраф за каждый шаг по цвету зоны — смысл не в запрете
  // (Авалон сам по себе чёрная зона, избежать нельзя), а в ЭКСПОЗИЦИИ: 5 шагов подряд по
  // чёрным опаснее, чем 10 шагов, где чёрных только 3. По оценке игрока авалонская зона
  // примерно равна по опасности чёрной зоне Аутлендов, синие/жёлтые заметно безопаснее.
  // Включаться должно отдельной опцией в интерфейсе, а не по умолчанию.
  // Ограничение на число недоминируемых меток в узле — страховка от разрастания поиска.
  maxLabelsPerNode: 6,
  // Разрешить пешие переходы по миру (false — считать только по порталам Авалона).
  allowWalk: true,
  // Считать переполненный портал (capNum >= capMax) непроходимым.
  blockFullPortals: false,
};

// ---------- справочник зон ----------
// recognize.js тянет sharp и tesseract, поэтому грузим его ТОЛЬКО если он уже в кеше
// (в приложении он загружен всегда). Иначе читаем те же два файла напрямую — данные идентичны.
let zoneInfoCache = null;
function getZoneInfo() {
  if (zoneInfoCache) return zoneInfoCache;
  try {
    const p = require.resolve('./recognize');
    const cached = require.cache[p];
    if (cached && cached.exports && cached.exports.ZONE_INFO) {
      zoneInfoCache = cached.exports.ZONE_INFO;
      return zoneInfoCache;
    }
  } catch (e) { /* recognize недоступен — не беда */ }
  const m = new Map();
  try {
    for (const z of JSON.parse(fs.readFileSync(path.join(STATIC, 'zone-data.json'), 'utf8')))
      m.set(z.name, { color: 'avalon', tier: z.tier });
  } catch (e) { /* нет файла — все зоны станут «мировыми» */ }
  try {
    for (const z of JSON.parse(fs.readFileSync(path.join(STATIC, 'royal-zones.json'), 'utf8')))
      if (!m.has(z.name)) m.set(z.name, { color: z.color });
  } catch (e) { /* аналогично */ }
  zoneInfoCache = m;
  return zoneInfoCache;
}

// Функция «имя зоны → цвет». Тесты подменяют её через opts.zoneColor / opts.avalonZones.
function makeColorFn(o) {
  if (typeof o.zoneColor === 'function') return o.zoneColor;
  if (o.avalonZones) {
    const set = o.avalonZones instanceof Set ? o.avalonZones : new Set(o.avalonZones);
    return (name) => (set.has(name) ? 'avalon' : (getZoneInfo().get(name) || {}).color || null);
  }
  const info = getZoneInfo();
  return (name) => (info.get(name) || {}).color || null;
}

function zoneKind(name, colorFn) {
  const fn = colorFn || makeColorFn(DEFAULTS);
  return fn(name) === 'avalon' ? 'avalon' : 'world';
}

// ---------- смежность мира ----------
let adjCache = null; // { zones, ok, error, path }
function normalizeAdjacency(raw) {
  // Основной контракт: { zones: { "<Имя>": { color, neighbors: [...] } } }.
  // На всякий случай понимаем и плоскую карту, и значение-массив соседей.
  const src = raw && raw.zones ? raw.zones : raw;
  const out = new Map();
  if (!src || typeof src !== 'object') return out;
  for (const [name, v] of Object.entries(src)) {
    const neighbors = Array.isArray(v) ? v : (v && Array.isArray(v.neighbors) ? v.neighbors : []);
    out.set(name, { color: (v && v.color) || null, neighbors: neighbors.filter(n => typeof n === 'string' && n) });
  }
  return out;
}

// Читает world-adjacency.json. Файла может не быть (его готовит другой агент) — это не ошибка.
function loadWorldAdjacency(opts = {}) {
  const file = opts.worldAdjacencyPath || WORLD_ADJACENCY_PATH;
  if (adjCache && adjCache.path === file && adjCache.ok && !opts.force) return adjCache;
  let res;
  try {
    res = { zones: normalizeAdjacency(JSON.parse(fs.readFileSync(file, 'utf8'))), ok: true, error: null, path: file };
    if (!res.zones.size) { res.ok = false; res.error = 'world-adjacency.json пуст'; }
  } catch (e) {
    res = { zones: new Map(), ok: false, error: e.code === 'ENOENT' ? 'world-adjacency.json ещё не создан' : String(e.message || e), path: file };
  }
  // кешируем только удачную загрузку: файл готовит другой агент, он может появиться позже
  if (res.ok) adjCache = res;
  return res;
}

// ---------- построение графа ----------
function normOpts(opts = {}) {
  const o = Object.assign({}, DEFAULTS, opts);
  o.nowMs = opts.now != null ? opts.now : Date.now();
  return o;
}

// Тип шага определяется ТОЛЬКО концами ребра, независимо от источника данных.
function edgeKind(kindA, kindB) {
  if (kindA === 'avalon' && kindB === 'avalon') return 'portal';
  if (kindA === 'avalon' || kindB === 'avalon') return 'exit';
  return 'walk';
}

// Цена шага считается по зоне, которую ПОКИДАЕМ: бежим-то мы по ней.
// costSec — весь шаг (пробежка + загрузка), preSec — только пробежка до точки перехода:
// именно в момент `приход + preSec` мы входим в портал, и по нему проверяется таймер.
function stepCost(fromKind, o) {
  const cross = (fromKind === 'avalon' ? o.avalonCrossSec : o.worldCrossSec) * o.mountFactor;
  return { costSec: cross + o.loadSec, preSec: cross };
}

function ensureNode(g, name, colorFn) {
  let n = g.nodes.get(name);
  if (!n) {
    const color = colorFn(name);
    n = { name, color, kind: color === 'avalon' ? 'avalon' : 'world' };
    g.nodes.set(name, n);
    g.adj.set(name, []);
  }
  return n;
}

function link(g, a, b, data, o, colorFn) {
  if (!a || !b || a === b) return null;
  const na = ensureNode(g, a, colorFn);
  const nb = ensureNode(g, b, colorFn);
  const kind = edgeKind(na.kind, nb.kind);
  if (kind === 'walk' && !o.allowWalk) return null;
  const key = [a, b].sort().join('\u0000') + '\u0000' + kind; // \0 — имена зон содержат пробелы
  if (g._seen.has(key)) return null;
  g._seen.add(key);
  const base = {
    kind,
    expiresAt: data.expiresAt != null ? data.expiresAt : null,
    capNum: data.capNum != null ? data.capNum : null,
    capMax: data.capMax != null ? data.capMax : null,
    source: data.source || null,
  };
  // цена у направлений РАЗНАЯ: считается по зоне-источнику (её и пересекаем).
  // Пример: выход Авалон→мир стоит как авалонская пробежка, а вход мир→Авалон — как пробежка по миру.
  const ab = stepCost(na.kind, o);
  const ba = stepCost(nb.kind, o);
  g.adj.get(a).push(Object.assign({ from: a, to: b }, base, ab));
  g.adj.get(b).push(Object.assign({ from: b, to: a }, base, ba));
  g.stats[kind] += 1;
  return base;
}

// snapshot — из store.snapshot(); opts.worldAdjacency позволяет подсунуть смежность вручную (тесты).
function buildGraph(snapshot, opts = {}) {
  const o = normOpts(opts);
  const colorFn = makeColorFn(o);
  const g = {
    nodes: new Map(), adj: new Map(), _seen: new Set(),
    stats: { portal: 0, exit: 0, walk: 0 },
    hasWorldAdjacency: false, worldAdjacencyError: null,
    opts: o, colorFn,
    source: snapshot,        // нужен, чтобы пересобрать граф, если позже сменят веса
  };

  // 1) живые рёбра из store: порталы Авалона и подтверждённые проходы.
  const edges = (snapshot && snapshot.edges) || [];
  for (const e of edges) {
    if (!e || !e.a || !e.b) continue;
    if (e.expiresAt != null && e.expiresAt <= o.nowMs) continue; // уже закрыт
    link(g, e.a, e.b, e, o, colorFn);
  }

  // 2) статическая смежность мира: пешие переходы и постоянные входы/выходы Авалона.
  // Ребро walk отсеет сам link(), если allowWalk=false; статические выходы при этом остаются.
  let zones;
  if (o.worldAdjacency) {
    zones = normalizeAdjacency(o.worldAdjacency);
    g.hasWorldAdjacency = zones.size > 0;
    if (!g.hasWorldAdjacency) g.worldAdjacencyError = 'переданная смежность пуста';
  } else {
    const loaded = loadWorldAdjacency(o);
    zones = loaded.zones;
    g.hasWorldAdjacency = loaded.ok;
    g.worldAdjacencyError = loaded.error;
  }
  for (const [name, rec] of zones) {
    ensureNode(g, name, colorFn);
    for (const nb of rec.neighbors) link(g, name, nb, { source: 'adjacency' }, o, colorFn);
  }
  if (!o.allowWalk) g.worldAdjacencyError = 'пешие переходы отключены (allowWalk=false)';

  delete g._seen;
  return g;
}

function isGraph(x) { return !!x && x.adj instanceof Map && x.nodes instanceof Map; }

// ---------- двоичная куча по стоимости ----------
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].costSec <= a[i].costSec) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].costSec < a[m].costSec) m = l;
        if (r < a.length && a[r].costSec < a[m].costSec) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t; i = m;
      }
    }
    return top;
  }
}

const EPS = 1e-6;

// Метка «доминируется», если в узле уже есть метка не хуже и по стоимости, и по времени.
function dominated(settled, L, o) {
  const list = settled.get(L.node);
  if (!list) return false;
  if (list.length >= o.maxLabelsPerNode) return true;
  for (const s of list) if (s.costSec <= L.costSec + EPS && s.timeSec <= L.timeSec + EPS) return true;
  return false;
}
function settle(settled, L) {
  let list = settled.get(L.node);
  if (!list) settled.set(L.node, (list = []));
  // выкидываем метки, которые новая перекрывает
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i].costSec >= L.costSec - EPS && list[i].timeSec >= L.timeSec - EPS) list.splice(i, 1);
  list.push(L);
}

// Продление метки через ребро с учётом таймеров. null — ребро использовать нельзя.
function relax(L, e, o) {
  if (o.blockFullPortals && e.capNum != null && e.capMax != null && e.capNum >= e.capMax) return null;
  const arriveMs = o.nowMs + L.timeSec * 1000;
  let useMs = arriveMs + e.preSec * 1000;   // момент, когда мы реально входим в портал
  // Перезарядку портала не учитываем: игрок решил, что это лишняя информация,
  // и приложение её больше не читает. waitSec остаётся в модели шага ради формата.
  const waitSec = 0;
  let penaltySec = 0;
  if (e.expiresAt != null) {
    const slackSec = (e.expiresAt - useMs) / 1000 - o.safetyMarginSec;
    if (slackSec < 0) return null;           // закроется раньше, чем мы дойдём (с запасом)
    if (slackSec < o.riskHorizonSec) penaltySec = o.riskPenaltySec * (1 - slackSec / o.riskHorizonSec);
  }
  return {
    node: e.to,
    timeSec: L.timeSec + e.costSec + waitSec,
    costSec: L.costSec + e.costSec + waitSec + penaltySec,
    edge: e, parent: L, waitSec, penaltySec, useAtMs: useMs,
  };
}

// Дейкстра по парето-меткам. isGoal(name, label) → true у цели.
function search(g, from, isGoal, o) {
  const start = { node: from, timeSec: 0, costSec: 0, edge: null, parent: null, waitSec: 0, penaltySec: 0 };
  if (isGoal(from, start)) return start;
  const heap = new Heap();
  const settled = new Map();
  heap.push(start);
  while (heap.size) {
    const L = heap.pop();
    if (dominated(settled, L, o)) continue;
    settle(settled, L);
    if (L.parent && isGoal(L.node, L)) return L;
    for (const e of g.adj.get(L.node) || []) {
      const nx = relax(L, e, o);
      if (nx) heap.push(nx);
    }
  }
  return null;
}

// ---------- сборка ответа ----------
function minutesLeft(expiresAt, nowMs) { return Math.round((expiresAt - nowMs) / 6000) / 10; }

function buildResult(L, o, extra) {
  const chain = [];
  for (let cur = L; cur && cur.parent; cur = cur.parent) chain.push(cur);
  chain.reverse();
  const steps = chain.map(c => ({
    from: c.edge.from,
    to: c.edge.to,
    kind: c.edge.kind,
    expiresAt: c.edge.expiresAt != null ? c.edge.expiresAt : null,
    capNum: c.edge.capNum != null ? c.edge.capNum : null,
    capMax: c.edge.capMax != null ? c.edge.capMax : null,
    // дополнительные поля — для UI, контракт их не требует
    costSec: Math.round(c.edge.costSec + c.waitSec),
    waitSec: Math.round(c.waitSec),
    etaSec: Math.round(c.timeSec),
    source: c.edge.source,
    risky: c.penaltySec > 0,
  }));
  let bottleneck = null;
  for (const s of steps) {
    if (s.expiresAt == null) continue;
    if (!bottleneck || s.expiresAt < bottleneck.expiresAt)
      bottleneck = { from: s.from, to: s.to, expiresAt: s.expiresAt, minutesLeft: minutesLeft(s.expiresAt, o.nowMs) };
  }
  return Object.assign({
    found: true,
    steps,
    hops: steps.length,
    portalHops: steps.filter(s => s.kind === 'portal').length,
    walkHops: steps.filter(s => s.kind === 'walk').length,
    exitHops: steps.filter(s => s.kind === 'exit').length,
    bottleneck,
    risky: steps.some(s => s.risky),
    etaSec: Math.round(L.timeSec),
    etaMin: Math.round(L.timeSec / 6) / 10,
    costSec: Math.round(L.costSec),
    arriveAt: o.nowMs + Math.round(L.timeSec) * 1000,
  }, extra);
}

function fail(reason, reasonCode, extra) {
  return Object.assign({
    found: false, steps: [], hops: 0, portalHops: 0, walkHops: 0, exitHops: 0,
    bottleneck: null, risky: false, etaSec: 0, etaMin: 0, costSec: 0, arriveAt: null,
    reason, reasonCode,
  }, extra);
}

// Веса берём из настроек графа, а время — всегда из вызова: граф строится один раз,
// а маршруты по нему считаются позже, и «сейчас» к тому моменту уже другое.
function mergeOpts(graphOpts, opts) {
  const base = Object.assign({}, graphOpts);
  delete base.now; delete base.nowMs;
  return normOpts(Object.assign(base, opts));
}

// Веса шага (stepCost) запекаются в рёбра ещё при сборке графа, поэтому передать их
// вместе с готовым графом нельзя — раньше они молча игнорировались (замер: тот же путь
// давал 199 с при сборке с mountFactor 0.6 и 324 с на готовом графе с тем же параметром).
// Теперь при изменении любого «весового» ключа граф пересобирается из сохранённого снимка.
const WEIGHT_KEYS = ['avalonCrossSec', 'worldCrossSec', 'loadSec', 'mountFactor', 'allowWalk', 'blockFullPortals', 'zoneColor', 'avalonZones'];
function weightsDiffer(graphOpts, opts) {
  if (!opts) return false;
  return WEIGHT_KEYS.some(k => k in opts && opts[k] !== graphOpts[k]);
}

// snapshotOrGraph: результат store.snapshot() либо уже построенный граф (buildGraph).
function resolveGraph(snapshotOrGraph, opts) {
  const useGraph = isGraph(snapshotOrGraph) ? snapshotOrGraph : (isGraph(opts && opts.graph) ? opts.graph : null);
  if (useGraph) {
    const o = mergeOpts(useGraph.opts, opts);
    if (weightsDiffer(useGraph.opts, opts)) {
      if (useGraph.source) return { g: buildGraph(useGraph.source, o), o };
      console.warn('[роутер] веса изменены, а снимок графа недоступен — считаю по старым весам');
    }
    return { g: useGraph, o };
  }
  const o = normOpts(opts);
  return { g: buildGraph(snapshotOrGraph, o), o };
}

function known(g, name, o) {
  if (!name || typeof name !== 'string') return false;
  if (g.nodes.has(name)) return true;
  return g.colorFn(name) != null;
}

// Основной поиск: из fromZone в toZone по объединённому графу.
function findRoute(snapshotOrGraph, fromZone, toZone, opts = {}) {
  const { g, o } = resolveGraph(snapshotOrGraph, opts);
  const meta = { from: fromZone, to: toZone, hasWorldAdjacency: g.hasWorldAdjacency };
  if (!known(g, fromZone, o)) return fail(`Неизвестная зона: «${fromZone}»`, 'unknown-from', meta);
  if (!known(g, toZone, o)) return fail(`Неизвестная зона: «${toZone}»`, 'unknown-to', meta);
  if (fromZone === toZone) return buildResult({ node: fromZone, timeSec: 0, costSec: 0, edge: null, parent: null }, o, meta);
  if (!g.adj.has(fromZone)) return fail(`Из зоны «${fromZone}» нет известных переходов`, 'isolated-from', meta);
  if (!g.adj.has(toZone)) return fail(`В зону «${toZone}» нет известных переходов`, 'isolated-to', meta);
  const L = search(g, fromZone, (n) => n === toZone, o);
  if (!L) {
    const hint = g.hasWorldAdjacency ? '' : ' (смежность мира не загружена — пешие переходы недоступны)';
    return fail(`Путь «${fromZone}» → «${toZone}» не найден: нет живых порталов или все закрываются слишком рано${hint}`, 'no-route', meta);
  }
  return buildResult(L, o, meta);
}

// Ближайший выход в мир из авалонской зоны (цель — любая зона мира).
function findNearestExit(snapshotOrGraph, fromZone, opts = {}) {
  const { g, o } = resolveGraph(snapshotOrGraph, opts);
  const meta = { from: fromZone, to: null, hasWorldAdjacency: g.hasWorldAdjacency };
  if (!known(g, fromZone, o)) return fail(`Неизвестная зона: «${fromZone}»`, 'unknown-from', meta);
  const kindOf = (n) => { const rec = g.nodes.get(n); return rec ? rec.kind : (g.colorFn(n) === 'avalon' ? 'avalon' : 'world'); };
  if (kindOf(fromZone) === 'world') {
    const r = buildResult({ node: fromZone, timeSec: 0, costSec: 0, edge: null, parent: null }, o, meta);
    r.to = fromZone;
    return r;
  }
  if (!g.adj.has(fromZone)) return fail(`Из зоны «${fromZone}» нет известных переходов`, 'isolated-from', meta);
  const L = search(g, fromZone, (n) => kindOf(n) === 'world', o);
  if (!L) return fail(`Из зоны «${fromZone}» не найдено выхода в мир`, 'no-exit', meta);
  const r = buildResult(L, o, meta);
  r.to = L.node;
  return r;
}

// Маршрут в конкретную зону мира (алиас findRoute с проверкой типа цели).
function routeToWorldZone(snapshotOrGraph, fromZone, worldZoneName, opts = {}) {
  const { g, o } = resolveGraph(snapshotOrGraph, opts);
  const meta = { from: fromZone, to: worldZoneName, hasWorldAdjacency: g.hasWorldAdjacency };
  if (!known(g, worldZoneName, o)) return fail(`Неизвестная зона: «${worldZoneName}»`, 'unknown-to', meta);
  const rec = g.nodes.get(worldZoneName);
  const kind = rec ? rec.kind : (g.colorFn(worldZoneName) === 'avalon' ? 'avalon' : 'world');
  if (kind !== 'world') return fail(`Зона «${worldZoneName}» — авалонская, а не зона мира`, 'not-world-target', meta);
  return findRoute(g, fromZone, worldZoneName, Object.assign({}, opts, { now: o.nowMs }));
}

module.exports = {
  DEFAULTS, WORLD_ADJACENCY_PATH,
  buildGraph, findRoute, findNearestExit, routeToWorldZone,
  loadWorldAdjacency, zoneKind, getZoneInfo,
};
