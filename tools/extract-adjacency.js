// Извлекает пешую смежность зон королевства из сырого дампа world.json.
// Туннели Авалона (TUNNEL_*) сюда НЕ попадают — они живут в динамическом графе store.js.
//
// Запуск:  node tools/extract-adjacency.js [ISO-дата]
//   node tools/extract-adjacency.js 2026-07-24T12:00:00.000Z
// Без аргумента подставляется текущее время. Если граф не изменился,
// generatedAt из существующего файла сохраняется — скрипт идемпотентен.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'world-raw.json');
const OUT = path.join(ROOT, 'app', 'data-static', 'world-adjacency.json');
const ROYAL = path.join(ROOT, 'royal-zones.json');
const POSITIONS = path.join(ROOT, 'world-positions.json');

// ── правила отбора ────────────────────────────────────────────────────────────

// Типы зон королевства, которые считаем проходимыми пешком.
const ALLOWED_TYPE = /^(OPENPVP_|SAFEAREA$|PASSAGE_|STARTINGCITY$|STARTAREA$|PLAYERCITY)/;

// Мусор: отладка, экспедиции, арены, данжи, хайдауты, острова, туториал, шоурум.
const JUNK_TYPE = /DEBUG|EXPEDITION|ARENA|DUNGEON|HIDEOUT|ISLAND|TUTORIAL|SHOWROOM/;

// Отладочные кластеры маскируются под обычные типы (Champions' Realm — STARTAREA,
// 1900-DynamicTest — OPENPVP_YELLOW), но выдают себя id/именем файла: _DBG_, DynamicTest.
const JUNK_ID = /(^|[-_])DBG([-_]|$)|DEBUG|DynamicTest/i;

// Тип кластера → цвет зоны (совпадает с раскладкой royal-zones.json).
function colorOf(type) {
  if (/^PLAYERCITY_BLACK/.test(type)) return 'city-black';
  if (/^PLAYERCITY_HELLDEN/.test(type)) return 'city-black';
  if (/^PLAYERCITY/.test(type)) return 'city';
  if (/YELLOW/.test(type)) return 'yellow';
  if (/RED/.test(type)) return 'red';
  if (/BLACK/.test(type)) return 'black';
  // SAFEAREA, PASSAGE_SAFEAREA, STARTAREA, STARTINGCITY
  return 'blue';
}

// ── утилиты ───────────────────────────────────────────────────────────────────

// exits.exit бывает и объектом, и массивом, и вовсе отсутствует.
function exitsOf(cluster) {
  const ex = cluster.exits && cluster.exits.exit;
  if (!ex) return [];
  return Array.isArray(ex) ? ex : [ex];
}

// "guid@4213" → "4213"; часть ПОСЛЕ @ — это id кластера-цели.
function targetClusterId(exit) {
  const t = String(exit['@targetid'] || '');
  const i = t.indexOf('@');
  return i < 0 ? null : t.slice(i + 1);
}

// Детерминированный ГПСЧ — чтобы «случайные» пары городов не менялись между запусками.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── построение графа ──────────────────────────────────────────────────────────

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const clusters = raw.world.clusters.cluster;

const isKeepable = (c) =>
  !!c &&
  c['@enabled'] !== 'false' &&
  ALLOWED_TYPE.test(c['@type'] || '') &&
  !JUNK_TYPE.test(c['@type'] || '') &&
  !JUNK_ID.test(c['@id'] || '') &&
  !JUNK_ID.test(c['@file'] || '');

const kept = clusters.filter(isKeepable);
const keptIds = new Set(kept.map((c) => c['@id']));
const byId = new Map(kept.map((c) => [c['@id'], c]));

// Смежность на уровне id кластеров. Двунаправленная: в дампе бывает односторонняя запись.
const idAdj = new Map();
const linkIds = (a, b) => {
  if (a === b) return; // самопетли выкидываем
  if (!idAdj.has(a)) idAdj.set(a, new Set());
  if (!idAdj.has(b)) idAdj.set(b, new Set());
  idAdj.get(a).add(b);
  idAdj.get(b).add(a);
};

let rawDirected = 0;
for (const c of kept) {
  for (const e of exitsOf(c)) {
    const tid = targetClusterId(e);
    if (!tid || !keptIds.has(tid)) continue; // выход в туннель/данж/остров — не наше
    rawDirected++;
    linkIds(c['@id'], tid);
  }
}

// ── разбор одинаковых имён ────────────────────────────────────────────────────
// Граф ключуется ИМЕНАМИ зон (так работает всё остальное приложение), но часть
// кластеров делит одно имя на несколько инстансов в разных концах карты
// (Smuggler's Den x35, Antiquarian's Den x6, Conquerors' Hall x5 на каждый уровень).
// Слить их по имени нельзя: получится телепорт-хаб, и роутер найдёт
// несуществующий пеший путь Thetford → Lymhurst в два шага.
// Правило: инстансы объединяем, только если они доказуемо в одном месте —
// то есть имеют общего ОДНОЗНАЧНОГО соседа (Caerleon Market, Brecilien).
// Иначе имя выбрасываем целиком: это тупиковые интерьеры, для маршрутов бесполезные.

const idsByName = new Map();
for (const c of kept) {
  const n = c['@displayname'];
  if (!idsByName.has(n)) idsByName.set(n, []);
  idsByName.get(n).push(c['@id']);
}

const ambiguous = new Set([...idsByName].filter(([, ids]) => ids.length > 1).map(([n]) => n));
const mergedNames = [];
const droppedNames = [];

for (const name of ambiguous) {
  const ids = idsByName.get(name);
  // соседи каждого инстанса, только однозначные имена и без самоссылки
  const sets = ids.map((id) => {
    const s = new Set();
    for (const nb of idAdj.get(id) || []) {
      const nn = byId.get(nb)['@displayname'];
      if (nn === name || ambiguous.has(nn)) continue;
      s.add(nn);
    }
    return s;
  });
  const common = [...sets[0]].filter((n) => sets.every((s) => s.has(n)));
  if (common.length > 0) mergedNames.push({ name, count: ids.length, common });
  else droppedNames.push({ name, count: ids.length });
}

const droppedSet = new Set(droppedNames.map((d) => d.name));
const liveIds = new Set(kept.filter((c) => !droppedSet.has(c['@displayname'])).map((c) => c['@id']));

// Смежность по именам.
const zones = new Map(); // имя → { color, neighbors:Set }
for (const id of liveIds) {
  const c = byId.get(id);
  const n = c['@displayname'];
  if (!zones.has(n)) zones.set(n, { color: colorOf(c['@type']), neighbors: new Set() });
}
for (const [id, nbs] of idAdj) {
  if (!liveIds.has(id)) continue;
  const a = byId.get(id)['@displayname'];
  for (const nb of nbs) {
    if (!liveIds.has(nb)) continue;
    const b = byId.get(nb)['@displayname'];
    if (a === b) continue; // самопетля после слияния имён
    zones.get(a).neighbors.add(b);
    zones.get(b).neighbors.add(a);
  }
}

// ── сериализация (детерминированный порядок) ──────────────────────────────────

const zoneNames = [...zones.keys()].sort();
const outZones = {};
for (const n of zoneNames) {
  const z = zones.get(n);
  outZones[n] = { color: z.color, neighbors: [...z.neighbors].sort() };
}

let generatedAt = process.argv[2] || new Date().toISOString();
let unchanged = false;
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (JSON.stringify(prev.zones) === JSON.stringify(outZones)) {
      generatedAt = prev.generatedAt || generatedAt; // граф тот же — дату не трогаем
      unchanged = true;
    }
  } catch (_) {
    /* битый прошлый файл — просто перезапишем */
  }
}

fs.writeFileSync(OUT, JSON.stringify({ generatedAt, zones: outZones }, null, 2) + '\n', 'utf8');

// ── статистика ────────────────────────────────────────────────────────────────

let degSum = 0;
let isolated = 0;
for (const n of zoneNames) {
  const d = outZones[n].neighbors.length;
  degSum += d;
  if (d === 0) isolated++;
}
const edges = degSum / 2;

// компоненты связности
const seen = new Set();
const components = [];
for (const start of zoneNames) {
  if (seen.has(start)) continue;
  const comp = [];
  const q = [start];
  seen.add(start);
  while (q.length) {
    const cur = q.pop();
    comp.push(cur);
    for (const nb of outZones[cur].neighbors) {
      if (!seen.has(nb)) {
        seen.add(nb);
        q.push(nb);
      }
    }
  }
  components.push(comp);
}
components.sort((a, b) => b.length - a.length);

// поиск кратчайшего пути в ширину
function bfs(from, to) {
  if (!outZones[from] || !outZones[to]) return null;
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const cur = q[i];
    for (const nb of outZones[cur].neighbors) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      if (nb === to) {
        const p = [];
        for (let x = to; x !== null; x = prev.get(x)) p.push(x);
        return p.reverse();
      }
      q.push(nb);
    }
  }
  return null;
}

const log = (s) => process.stdout.write(s + '\n');

log('=== СТАТИСТИКА ГРАФА ===');
log(`кластеров в дампе:        ${clusters.length}`);
log(`прошло фильтр типа/enabled: ${kept.length}`);
log(`направленных выходов:     ${rawDirected}`);
log(`имена-дубликаты слиты:    ${mergedNames.map((m) => `${m.name} x${m.count}`).join(', ') || '—'}`);
log(`имена-дубликаты выкинуты: ${droppedNames.map((d) => `${d.name} x${d.count}`).join(', ') || '—'}`);
log(`зон в файле:              ${zoneNames.length}`);
log(`рёбер (неориентированных):${edges}`);
log(`средняя степень:          ${(degSum / zoneNames.length).toFixed(2)}`);
log(`изолированных зон:        ${isolated}`);
log(`компонент связности:      ${components.length}`);
log(
  `крупнейшая компонента:    ${components[0].length} зон` +
    (components.length > 1
      ? `; остальные: ${components.slice(1).map((c) => c.length).join(', ')}`
      : '')
);
for (const c of components.slice(1, 6)) {
  log(`   компонента [${c.length}]: ${c.slice(0, 8).join(', ')}${c.length > 8 ? ' …' : ''}`);
}

// ── самопроверки ──────────────────────────────────────────────────────────────

log('');
log('=== САМОПРОВЕРКИ ===');
let failures = 0;
const check = (ok, title, detail) => {
  if (!ok) failures++;
  log(`[${ok ? ' OK ' : 'FAIL'}] ${title}${detail ? ' — ' + detail : ''}`);
};

// 1a. Сырой разбор выходов Cairn Camain против эталона (до фильтров).
const REF = ['Cairn Fidair', 'Fort Sterling', 'Creag Dhor', 'Tharcal Fissure', 'Stoneroot Caverns'];
const allById = new Map(clusters.map((c) => [c['@id'], c]));
const camain = clusters.find((c) => c['@displayname'] === 'Cairn Camain');
const rawNb = [
  ...new Set(
    exitsOf(camain)
      .map((e) => allById.get(targetClusterId(e)))
      .filter(Boolean)
      .map((c) => c['@displayname'])
  ),
].sort();
check(
  JSON.stringify(rawNb) === JSON.stringify([...REF].sort()),
  "сырые выходы 'Cairn Camain' == эталон",
  rawNb.join(', ')
);

// 1b. Отфильтрованные соседи: данж Stoneroot Caverns отсеян правилом 3.
const camainNb = outZones['Cairn Camain'] ? outZones['Cairn Camain'].neighbors : [];
const expectFiltered = REF.filter((n) => n !== 'Stoneroot Caverns').sort();
check(
  JSON.stringify([...camainNb].sort()) === JSON.stringify(expectFiltered),
  "соседи 'Cairn Camain' в файле == эталон минус DUNGEON",
  camainNb.join(', ')
);

// 2. Пеший путь Cairn Camain → Fort Sterling.
const p1 = bfs('Cairn Camain', 'Fort Sterling');
check(
  !!p1 && p1.length - 1 <= 2,
  "пеший путь 'Cairn Camain' → 'Fort Sterling' короткий",
  p1 ? `${p1.length - 1} шаг(ов): ${p1.join(' → ')}` : 'ПУТИ НЕТ'
);

// 3. Три «случайные» пары городов (сид фиксирован → воспроизводимо).
const CITIES = ['Thetford', 'Lymhurst', 'Bridgewatch', 'Martlock', 'Fort Sterling', 'Caerleon'];
const rnd = mulberry32(20260724);
const pairs = [];
while (pairs.length < 3) {
  const a = CITIES[Math.floor(rnd() * CITIES.length)];
  const b = CITIES[Math.floor(rnd() * CITIES.length)];
  if (a === b || pairs.some((p) => p[0] === a && p[1] === b)) continue;
  pairs.push([a, b]);
}
for (const [a, b] of pairs) {
  const p = bfs(a, b);
  check(!!p, `путь ${a} → ${b}`, p ? `${p.length - 1} шагов: ${p.join(' → ')}` : 'ПУТИ НЕТ');
}

// 4. Все города между собой (шире, чем требует ТЗ — ловим отвалившиеся куски карты).
const cityZones = zoneNames.filter((n) => outZones[n].color === 'city' || outZones[n].color === 'city-black');
const unreachable = [];
for (let i = 0; i < CITIES.length; i++) {
  for (const c of cityZones) {
    if (c === CITIES[i]) continue;
    if (!bfs(CITIES[i], c)) unreachable.push(`${CITIES[i]}→${c}`);
  }
}
log(
  `[info] городских зон: ${cityZones.length}; недостижимых пар от 6 столиц: ${unreachable.length}` +
    (unreachable.length ? ` (${[...new Set(unreachable.map((u) => u.split('→')[1]))].join(', ')})` : '')
);

// 5. Сверка цветов с royal-zones.json (независимый источник).
if (fs.existsSync(ROYAL)) {
  const royal = JSON.parse(fs.readFileSync(ROYAL, 'utf8'));
  let cmp = 0;
  const mismatch = [];
  for (const z of royal) {
    if (!outZones[z.name]) continue;
    cmp++;
    if (outZones[z.name].color !== z.color) mismatch.push(`${z.name}: ${outZones[z.name].color} vs ${z.color}`);
  }
  check(mismatch.length === 0, `цвета сходятся с royal-zones.json (${cmp} общих зон)`, mismatch.slice(0, 5).join('; '));
}

// 6. Покрытие координатами world-positions.json (для отрисовки/джойна на карте).
if (fs.existsSync(POSITIONS)) {
  const pos = JSON.parse(fs.readFileSync(POSITIONS, 'utf8'));
  const known = new Set(pos.map((p) => p.name));
  const withPos = zoneNames.filter((n) => known.has(n)).length;
  const posNoZone = pos.filter((p) => !outZones[p.name]).map((p) => p.name);
  log(`[info] зон с координатами: ${withPos}/${zoneNames.length}; в world-positions без зоны: ${posNoZone.length}${posNoZone.length ? ' (' + posNoZone.slice(0, 5).join(', ') + ')' : ''}`);
}

// 7. Целостность самого файла: симметрия, отсутствие самопетель и висячих ссылок.
let asym = 0;
let selfLoop = 0;
let dangling = 0;
for (const n of zoneNames) {
  for (const nb of outZones[n].neighbors) {
    if (nb === n) selfLoop++;
    if (!outZones[nb]) { dangling++; continue; }
    if (!outZones[nb].neighbors.includes(n)) asym++;
  }
}
check(asym === 0 && selfLoop === 0 && dangling === 0, 'файл консистентен', `асимметрия=${asym}, самопетли=${selfLoop}, висячие=${dangling}`);

log('');
log(`Файл: ${OUT}${unchanged ? ' (граф не изменился, generatedAt сохранён)' : ''}`);
log(failures === 0 ? 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `ПРОВАЛЕНО ПРОВЕРОК: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
