// Тесты маршрутизатора: обычный node, без фреймворков.
//   node test/router.test.js   → печатает ОК/ПРОВАЛ, код возврата 1 при любом провале.
// Данные синтетические: зоны классифицируются через opts.zoneColor, смежность мира
// подсовывается через opts.worldAdjacency — тесты не зависят ни от map.json,
// ни от того, скачал ли соседний агент world-adjacency.json.
const fs = require('fs');
const path = require('path');
const router = require('../lib/router');

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0); // фиксируем время — тесты детерминированные
const at = (sec) => NOW + sec * 1000;        // абсолютное время через sec секунд
const min = (m) => at(m * 60);

// ---------- мини-харнесс ----------
let failed = 0, total = 0;
function ok(name, cond, detail) {
  total++;
  if (cond) { console.log(`  ОК      ${name}`); return true; }
  failed++;
  console.log(`  ПРОВАЛ  ${name}`);
  if (detail !== undefined) console.log(`          ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  return false;
}
function eq(name, actual, expected) {
  return ok(name, actual === expected, `получено ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(expected)}`);
}
function near(name, actual, expected, tol) {
  return ok(name, Math.abs(actual - expected) <= tol, `получено ${actual}, ожидалось ${expected} ±${tol}`);
}
function head(t) { console.log(`\n=== ${t} ===`); }
const asPath = (r) => r.found ? r.steps.map(s => `${s.from} -${s.kind}-> ${s.to}`).join(' | ') : `нет пути: ${r.reason}`;

// ---------- построители синтетики ----------
function E(a, b, extra) {
  return Object.assign({ a, b, capNum: null, capMax: null, expiresAt: null, canUseAt: null, updatedAt: NOW, source: 'ocr' }, extra);
}
// avalon/world — списки имён; всё остальное считается НЕИЗВЕСТНОЙ зоной (zoneColor → null)
function opts(avalon, world, extra) {
  const av = new Set(avalon), wo = new Set(world);
  return Object.assign({
    now: NOW,
    zoneColor: (n) => (av.has(n) ? 'avalon' : (wo.has(n) ? 'blue' : null)),
    worldAdjacency: { zones: {} }, // по умолчанию пеших переходов нет
  }, extra);
}
const snap = (edges) => ({ edges, players: {}, journalLen: 0 });

// =====================================================================
head('1. Ключевой сценарий: 10 прыжков против «2 прыжка + выход + 2 пешком»');
{
  const LONG = ['Long-1', 'Long-2', 'Long-3', 'Long-4', 'Long-5', 'Long-6', 'Long-7', 'Long-8', 'Long-9'];
  const chain = ['A', ...LONG, 'Z'];                       // 10 порталов подряд
  const edges = [];
  for (let i = 0; i + 1 < chain.length; i++) edges.push(E(chain[i], chain[i + 1]));
  edges.push(E('A', 'S1'), E('S1', 'S2'));                 // 2 прыжка в сторону выхода
  edges.push(E('S2', 'World-1'));                          // выход в мир (портал наружу)

  const o = opts(
    ['A', 'Z', 'S1', 'S2', ...LONG],
    ['World-1', 'World-2'],
    { worldAdjacency: { zones: {
      'World-1': { color: 'blue', neighbors: ['World-2'] },   // пеший переход
      'World-2': { color: 'blue', neighbors: ['World-1', 'Z'] }, // статический вход обратно в Авалон
    } } },
  );
  const r = router.findRoute(snap(edges), 'A', 'Z', o);
  console.log('   маршрут:', asPath(r));
  console.log(`   шагов=${r.hops} порталов=${r.portalHops} пеших=${r.walkHops} выходов=${r.exitHops} ETA=${r.etaMin} мин`);

  ok('маршрут найден', r.found);
  eq('шагов всего', r.hops, 5);
  eq('порталов', r.portalHops, 2);
  eq('пеших', r.walkHops, 1);
  eq('границ Авалон/мир', r.exitHops, 2);
  ok('длинная цепочка из 10 прыжков НЕ выбрана', r.steps.every(s => !/^Long-/.test(s.to) && !/^Long-/.test(s.from)), asPath(r));
  // границу выводим из констант роутера, а не пишем числом: иначе при калибровке весов
  // тест продолжает проходить, но проверяет уже не то (так и случилось: в комментарии
  // стояли докалибровочные 60+3 при фактических 78+78)
  const D = router.DEFAULTS;
  ok('короткий путь заметно быстрее 10 прыжков', r.etaSec < 10 * (D.avalonCrossSec + D.loadSec), r.etaSec);
  eq('таймеров нет — узкого места нет', r.bottleneck, null);
  eq('риска нет', r.risky, false);

  // Те же данные с «наивными» весами (пробежку не считаем, а бег по миру очень дорогой):
  // выигрывает цепочка из 10 прыжков. Тест фиксирует, что веса реально настраиваются через opts.
  const naive = router.findRoute(snap(edges), 'A', 'Z',
    Object.assign({}, o, { avalonCrossSec: 0, worldCrossSec: 200 }));
  eq('с нулевой авалонской пробежкой и дорогим бегом выигрывает цепочка из 10 прыжков', naive.hops, 10);
}

// =====================================================================
head('2. Портал закрывается через 30 секунд');
{
  const o = opts(['A', 'B', 'C', 'D', 'Z'], []);
  const edges = [
    E('A', 'B', { expiresAt: at(30), capNum: 3, capMax: 20, source: 'ocr' }), // закроется раньше, чем добежим
    E('B', 'Z'),
    E('A', 'C'), E('C', 'D'), E('D', 'Z'),                                    // обход, таймеров нет
  ];
  const r = router.findRoute(snap(edges), 'A', 'Z', o);
  console.log('   маршрут:', asPath(r));
  ok('маршрут найден в обход', r.found);
  ok('умирающий портал A→B не использован', r.steps.every(s => !(s.from === 'A' && s.to === 'B')), asPath(r));
  eq('обход занял 3 шага', r.hops, 3);

  // без обхода пути быть не должно
  const r2 = router.findRoute(snap([edges[0], edges[1]]), 'A', 'Z', o);
  eq('без обхода путь не найден', r2.found, false);
  eq('код причины', r2.reasonCode, 'no-route');
  console.log('   причина:', r2.reason);

  // портал, закрывающийся через 10 минут, пройти успеваем
  const r3 = router.findRoute(snap([E('A', 'B', { expiresAt: min(10) }), edges[1]]), 'A', 'Z', o);
  ok('портал на 10 минут проходим', r3.found && r3.hops === 2, asPath(r3));

  // Ровно на границе запаса: нужно expiresAt >= приход(0) + пробежка по Авалону + запас.
  // Границу считаем ОТ КОНСТАНТ, иначе тест ломается при каждой калибровке весов.
  const D = router.DEFAULTS;
  const edge = D.avalonCrossSec * D.mountFactor + D.safetyMarginSec; // 78 + 120 = 198
  const r4 = router.findRoute(snap([E('A', 'B', { expiresAt: at(edge + 1) }), edges[1]]), 'A', 'Z', o);
  const r5 = router.findRoute(snap([E('A', 'B', { expiresAt: at(edge - 1) }), edges[1]]), 'A', 'Z', o);
  ok(`${edge + 1} c — ещё проходим, ${edge - 1} c — уже нет`,
    r4.found === true && r5.found === false, `${r4.found}/${r5.found}`);
  const r6 = router.findRoute(snap([E('A', 'B', { expiresAt: at(179) }), edges[1]]), 'A', 'Z',
    Object.assign({}, o, { safetyMarginSec: 0 }));
  ok('с safetyMarginSec=0 тот же портал проходим', r6.found === true, asPath(r6));
}

// =====================================================================
head('3. Пути нет вообще');
{
  const o = opts(['A', 'B', 'Y', 'Z'], []);
  const r = router.findRoute(snap([E('A', 'B'), E('Y', 'Z')]), 'A', 'Z', o);
  eq('found=false', r.found, false);
  eq('код причины', r.reasonCode, 'no-route');
  ok('причина заполнена', typeof r.reason === 'string' && r.reason.length > 10, r.reason);
  eq('шагов нет', r.hops, 0);
  ok('steps — пустой массив', Array.isArray(r.steps) && r.steps.length === 0);
  console.log('   причина:', r.reason);

  const r2 = router.findRoute(snap([E('A', 'B')]), 'A', 'Неведомая Зона', o);
  eq('неизвестная цель → found=false', r2.found, false);
  eq('код причины', r2.reasonCode, 'unknown-to');
  const r3 = router.findRoute(snap([E('A', 'B')]), 'Неведомая Зона', 'Z', o);
  eq('неизвестный старт → код причины', r3.reasonCode, 'unknown-from');
  console.log('   причина:', r2.reason);

  // зона известна по справочнику, но переходов в неё никто не видел
  const r4 = router.findRoute(snap([E('A', 'B')]), 'A', 'Z', o);
  eq('цель без единого известного перехода', r4.reasonCode, 'isolated-to');
  const r5 = router.findRoute(snap([E('Y', 'Z')]), 'A', 'Z', o);
  eq('старт без единого известного перехода', r5.reasonCode, 'isolated-from');
  console.log('   причина:', r4.reason);

  // zoneKind работает и без opts — по справочнику зон
  eq('zoneKind(реальная авалонская зона)', router.zoneKind('Cases-Ugumlos'), 'avalon');
  eq('zoneKind(город)', router.zoneKind('Martlock'), 'world');
  eq('zoneKind(мусор)', router.zoneKind('Такой Зоны Нет'), 'world');
}

// =====================================================================
head('4. Цель равна текущей зоне');
{
  const o = opts(['A', 'B'], []);
  const r = router.findRoute(snap([E('A', 'B')]), 'A', 'A', o);
  eq('found', r.found, true);
  eq('hops', r.hops, 0);
  eq('порталов', r.portalHops, 0);
  eq('пеших', r.walkHops, 0);
  ok('steps пуст', Array.isArray(r.steps) && r.steps.length === 0);
  eq('bottleneck', r.bottleneck, null);
  eq('risky', r.risky, false);
  eq('ETA', r.etaSec, 0);
}

// =====================================================================
head('5. Узкое место (bottleneck) — ребро с самым ранним закрытием');
{
  const o = opts(['A', 'B', 'C', 'D'], []);
  const edges = [
    E('A', 'B', { expiresAt: min(40), capNum: 1, capMax: 20, source: 'ocr' }),
    E('B', 'C', { expiresAt: min(12), capNum: 9, capMax: 20, source: 'ocr' }), // самое раннее
    E('C', 'D', { expiresAt: min(25), source: 'ocr' }),
  ];
  const r = router.findRoute(snap(edges), 'A', 'D', o);
  console.log('   маршрут:', asPath(r), '| bottleneck:', JSON.stringify(r.bottleneck));
  ok('маршрут найден', r.found);
  ok('bottleneck заполнен', !!r.bottleneck);
  eq('bottleneck.from', r.bottleneck && r.bottleneck.from, 'B');
  eq('bottleneck.to', r.bottleneck && r.bottleneck.to, 'C');
  eq('bottleneck.expiresAt', r.bottleneck && r.bottleneck.expiresAt, min(12));
  near('bottleneck.minutesLeft', r.bottleneck && r.bottleneck.minutesLeft, 12, 0.2);
  eq('вместимость проброшена в шаг', r.steps[1].capNum, 9);
  eq('risky (портал закроется через 12 мин)', r.risky, true);

  // те же рёбра, но закрываются через часы — риска нет
  const calm = edges.map((e, i) => Object.assign({}, e, { expiresAt: min(120 + i) }));
  const r2 = router.findRoute(snap(calm), 'A', 'D', o);
  eq('дальние таймеры → risky=false', r2.risky, false);
  eq('bottleneck.expiresAt = самый ранний из дальних', r2.bottleneck.expiresAt, min(120));
}

// =====================================================================
head('6. Ближайший выход в мир');
{
  const o = opts(['A', 'B'], ['World-1', 'World-9']);
  const far = [E('A', 'B'), E('B', 'World-1')];
  const r1 = router.findNearestExit(snap(far.concat([E('A', 'World-9')])), 'A', o);
  console.log('   маршрут:', asPath(r1), '→', r1.to);
  ok('выход найден', r1.found);
  eq('ближайший выход — прямой', r1.to, 'World-9');
  eq('шагов', r1.hops, 1);
  eq('тип последнего шага', r1.steps[r1.steps.length - 1].kind, 'exit');

  const r2 = router.findNearestExit(snap(far), 'A', o);
  eq('без прямого выхода — через B', r2.to, 'World-1');
  eq('шагов', r2.hops, 2);

  const r3 = router.findNearestExit(snap(far), 'World-1', o);
  ok('из зоны мира выходить некуда — 0 шагов', r3.found && r3.hops === 0 && r3.to === 'World-1');

  const r4 = router.findNearestExit(snap([E('A', 'B')]), 'A', o);
  eq('выхода нет вовсе → found=false', r4.found, false);
  eq('код причины', r4.reasonCode, 'no-exit');

  // routeToWorldZone: цель обязана быть зоной мира
  const world = router.routeToWorldZone(snap(far), 'A', 'World-1', o);
  ok('routeToWorldZone ведёт в мир', world.found && world.to === 'World-1' && world.hops === 2, asPath(world));
  const wrong = router.routeToWorldZone(snap(far), 'A', 'B', o);
  eq('авалонская цель отвергнута', wrong.reasonCode, 'not-world-target');
  console.log('   причина:', wrong.reason);
}

// =====================================================================
head('7. Нет world-adjacency.json — работаем только по порталам');
{
  const o = opts(['A', 'B', 'Z'], ['World-1', 'World-2'], { worldAdjacency: { zones: {} } });
  const edges = [E('A', 'B'), E('B', 'World-1'), E('World-2', 'Z')];
  const g = router.buildGraph(snap(edges), o);
  eq('флаг hasWorldAdjacency', g.hasWorldAdjacency, false);
  ok('причина указана', typeof g.worldAdjacencyError === 'string', g.worldAdjacencyError);
  const r = router.findRoute(g, 'A', 'B', o);
  ok('маршрут по порталам работает', r.found && r.hops === 1, asPath(r));
  const r2 = router.findRoute(g, 'A', 'Z', o);
  eq('без пеших переходов путь через мир не найден', r2.found, false);
  ok('в ответе есть флаг hasWorldAdjacency', r2.hasWorldAdjacency === false);

  // сборка графа по умолчанию (файла может не быть на диске) не должна падать
  let crashed = null;
  try {
    const g2 = router.buildGraph(snap([E('A', 'B')]), { now: NOW, zoneColor: o.zoneColor });
    ok('buildGraph без worldAdjacency не падает', !!g2 && g2.nodes.size >= 2);
    console.log(`   world-adjacency: ${g2.hasWorldAdjacency ? 'загружен' : 'нет (' + g2.worldAdjacencyError + ')'}`);
  } catch (e) { crashed = e; }
  ok('исключения нет', crashed === null, crashed && crashed.message);

  // allowWalk=false режет пешие переходы даже при наличии смежности
  const withAdj = opts(['A', 'B', 'Z'], ['World-1', 'World-2'], {
    allowWalk: false,
    worldAdjacency: { zones: { 'World-1': { neighbors: ['World-2'] }, 'World-2': { neighbors: ['World-1', 'Z'] } } },
  });
  const r3 = router.findRoute(snap(edges), 'A', 'Z', withAdj);
  eq('allowWalk=false → пути через мир нет', r3.found, false);
  const r4 = router.findRoute(snap(edges), 'A', 'Z', Object.assign({}, withAdj, { allowWalk: true }));
  ok('allowWalk=true → путь появляется', r4.found && r4.walkHops === 1, asPath(r4));
}

// =====================================================================
head('8. Парето-метки: быстрый, но «дорогой» путь спасает маршрут');
{
  // A→M напрямую: 80 c, но портал рискованный (закроется через 400 c) → штраф ~114 c, цена ~194.
  // A→P→M: 160 c без штрафа — дешевле по цене, но приходим позже.
  // Портал M→Z закрывается через 300 c: успеть можно ТОЛЬКО придя в M за 80 c.
  const o = opts(['A', 'P', 'M', 'Z'], []);
  const edges = [
    E('A', 'M', { expiresAt: at(400), source: 'ocr' }),
    E('A', 'P'), E('P', 'M'),
    E('M', 'Z', { expiresAt: at(300), source: 'ocr' }),
  ];
  const r = router.findRoute(snap(edges), 'A', 'Z', o);
  console.log('   маршрут:', asPath(r), `| ETA=${r.etaSec} c, цена=${r.costSec}`);
  ok('маршрут найден', r.found, asPath(r));
  eq('шагов', r.hops, 2);
  eq('идём напрямую через M', r.steps[0].to, 'M');
  eq('risky', r.risky, true);
  eq('bottleneck — портал M→Z', r.bottleneck && r.bottleneck.expiresAt, at(300));
}

// =====================================================================
head('9. Штраф за риск: при прочих равных выбираем надёжный путь');
{
  const o = opts(['A', 'R', 'S', 'Z'], []);
  const edges = [
    E('A', 'R', { expiresAt: min(8), source: 'ocr' }), E('R', 'Z', { expiresAt: min(8), source: 'ocr' }),
    E('A', 'S'), E('S', 'Z'),
  ];
  const r = router.findRoute(snap(edges), 'A', 'Z', o);
  console.log('   маршрут:', asPath(r));
  ok('выбран путь без таймеров', r.steps.every(s => s.expiresAt === null), asPath(r));
  eq('risky=false', r.risky, false);

  // если надёжного пути нет — рискованный всё равно предлагается
  const r2 = router.findRoute(snap([edges[0], edges[1]]), 'A', 'Z', o);
  ok('рискованный путь не запрещён', r2.found && r2.risky === true, asPath(r2));
}

// =====================================================================
head('10. Перезарядка портала не учитывается');
{
  const o = opts(['A', 'B', 'Z'], []);
  const D2 = router.DEFAULTS;
  const cross = D2.avalonCrossSec * D2.mountFactor;
  const plain = cross + D2.loadSec + cross + D2.loadSec;   // два шага без всякого ожидания

  // Игрок решил (2026-07-26): время до открытия портала — лишняя информация, приложение
  // её больше не читает. Даже если поле осталось в старых данных, маршрут его игнорирует.
  const wait = [E('A', 'B', { canUseAt: at(200), expiresAt: min(30), source: 'ocr' }), E('B', 'Z')];
  const r = router.findRoute(snap(wait), 'A', 'Z', o);
  ok('маршрут найден', r.found, asPath(r));
  eq('ETA как без перезарядки', r.etaSec, plain);
  eq('ожидания в шаге нет', r.steps[0].waitSec, 0);

  // и даже заведомо долгая перезарядка не отменяет маршрут
  const long = [E('A', 'B', { canUseAt: min(20), expiresAt: min(60), source: 'ocr' }), E('B', 'Z')];
  const r2 = router.findRoute(snap(long), 'A', 'Z', o);
  ok('долгая перезарядка не мешает', r2.found, asPath(r2));
  eq('ETA тот же', r2.etaSec, plain);
}

// =====================================================================
head('11. Контракт ответа');
{
  const o = opts(['A', 'B'], []);
  const r = router.findRoute(snap([E('A', 'B', { expiresAt: min(30), capNum: 5, capMax: 20, source: 'ocr' })]), 'A', 'B', o);
  const keys = ['found', 'steps', 'hops', 'portalHops', 'walkHops', 'bottleneck', 'risky'];
  ok('есть все обязательные поля', keys.every(k => k in r), keys.filter(k => !(k in r)).join(','));
  const s = r.steps[0];
  const skeys = ['from', 'to', 'kind', 'expiresAt', 'capNum', 'capMax'];
  ok('есть все поля шага', skeys.every(k => k in s), skeys.filter(k => !(k in s)).join(','));
  eq('kind', s.kind, 'portal');
  eq('capMax', s.capMax, 20);
  eq('expiresAt', s.expiresAt, min(30));
  const r2 = router.findRoute(snap([E('A', 'B')]), 'A', 'B', o);
  eq('expiresAt=null у ребра без таймера', r2.steps[0].expiresAt, null);
  eq('capNum=null у ребра без таймера', r2.steps[0].capNum, null);
  // detached now: тот же снапшот через час — портал уже мёртв
  const r3 = router.findRoute(snap([E('A', 'B', { expiresAt: min(30) })]), 'A', 'B', Object.assign({}, o, { now: min(45) }));
  eq('opts.now управляет временем', r3.found, false);
}

// =====================================================================
head('12. Дым на реальных данных');
{
  const adjPath = router.WORLD_ADJACENCY_PATH;
  if (!fs.existsSync(adjPath)) {
    console.log('   world-adjacency.json ещё не создан — smoke-тест пропущен (это не провал)');
  } else {
    const t0 = Date.now();
    const g = router.buildGraph({ edges: [] }, { now: NOW });
    console.log(`   граф: зон=${g.nodes.size}, порталов=${g.stats.portal}, выходов=${g.stats.exit}, пеших=${g.stats.walk}, ${Date.now() - t0} мс`);
    ok('смежность мира загружена', g.hasWorldAdjacency, g.worldAdjacencyError);
    ok('зон в графе больше 300', g.nodes.size > 300, g.nodes.size);
    // проверенная пара из world.json: Cairn Camain ⇄ Fort Sterling
    const r = router.findRoute(g, 'Fort Sterling', 'Cairn Camain', { now: NOW });
    ok('Fort Sterling → Cairn Camain найден', r.found, asPath(r));
    ok('это пеший переход в один шаг', r.found && r.hops === 1 && r.steps[0].kind === 'walk', asPath(r));
    const r2 = router.findRoute(g, 'Fort Sterling', 'Martlock', { now: NOW });
    console.log(`   Fort Sterling → Martlock: ${r2.found ? r2.hops + ' шагов, ' + r2.etaMin + ' мин' : r2.reason}`);
    ok('город → город проходим пешком', r2.found, r2.reason);
    // авалонскую зону без живых порталов достать нельзя (или только через статические входы)
    const t1 = Date.now();
    for (let i = 0; i < 20; i++) router.findRoute(g, 'Fort Sterling', 'Martlock', { now: NOW });
    console.log(`   20 поисков по реальному графу: ${Date.now() - t1} мс`);
  }
}

// =====================================================================
head('13. Опции на ГОТОВОМ графе, blockFullPortals и maxLabelsPerNode');
{
  // Веса запекаются в рёбра при сборке графа. Если граф построен один раз, а поиск
  // зовут с другими весами, они обязаны примениться (раньше молча игнорировались).
  const edges = [E('A', 'B'), E('B', 'C')];
  const o = opts(['A', 'B', 'C'], []);
  const g = router.buildGraph(snap(edges), o);

  const base = router.findRoute(g, 'A', 'C', { now: NOW });
  const slow = router.findRoute(g, 'A', 'C', { now: NOW, mountFactor: 2 });
  const fast = router.findRoute(g, 'A', 'C', { now: NOW, mountFactor: 0.5 });
  // mountFactor масштабирует ПРОБЕЖКУ, а загрузочный экран остаётся как есть
  const D = router.DEFAULTS;
  const eta = (mf) => 2 * (D.avalonCrossSec * mf + D.loadSec);
  ok('маршрут на готовом графе найден', base.found, asPath(base));
  near('без опций — веса по умолчанию', base.etaSec, eta(1), 2);
  near('mountFactor 2 применился к готовому графу', slow.etaSec, eta(2), 2);
  near('mountFactor 0.5 применился к готовому графу', fast.etaSec, eta(0.5), 2);
  ok('сам граф не испорчен (веса не переписаны)', router.findRoute(g, 'A', 'C', { now: NOW }).etaSec === base.etaSec);

  // blockFullPortals: набитый портал (capNum === capMax) не должен использоваться
  const full = [E('A', 'B', { capNum: 7, capMax: 7, source: 'ocr' }), E('B', 'C', { capNum: 7, capMax: 7, source: 'ocr' })];
  const rFull = router.findRoute(snap(full), 'A', 'C', opts(['A', 'B', 'C'], [], { blockFullPortals: true }));
  const rOpen = router.findRoute(snap(full), 'A', 'C', opts(['A', 'B', 'C'], [], { blockFullPortals: false }));
  ok('с blockFullPortals забитый портал не используется', !rFull.found, asPath(rFull));
  ok('без blockFullPortals тот же путь находится', rOpen.found, asPath(rOpen));

  // maxLabelsPerNode: значение по умолчанию не должно отсекать оптимум на «веере» путей.
  // Строим 8 параллельных веток разной длины между A и Z — оптимум это кратчайшая.
  const fan = [];
  for (let i = 0; i < 8; i++) {
    const mid = [];
    for (let j = 0; j <= i; j++) mid.push(`F${i}-${j}`);
    const chain = ['A', ...mid, 'Z'];
    for (let k = 0; k + 1 < chain.length; k++) fan.push(E(chain[k], chain[k + 1]));
  }
  const names = new Set(['A', 'Z']);
  for (const e of fan) { names.add(e.a); names.add(e.b); }
  const rFan = router.findRoute(snap(fan), 'A', 'Z', opts([...names], []));
  eq('на веере из 8 веток выбрана кратчайшая (2 шага)', rFan.found ? rFan.hops : null, 2);
  const rFan1 = router.findRoute(snap(fan), 'A', 'Z', opts([...names], [], { maxLabelsPerNode: 1 }));
  ok('maxLabelsPerNode учитывается и не роняет поиск', rFan1.found, asPath(rFan1));
}

// =====================================================================
console.log(`\n${failed ? 'ПРОВАЛЕНО' : 'ВСЁ ЗЕЛЕНО'}: ${total - failed}/${total} проверок пройдено`);
process.exit(failed ? 1 : 0);
