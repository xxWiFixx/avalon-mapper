// Где встаёт игровой оверлей. Проверяем именно то, что уже ломалось на живых машинах:
// второй монитор (отрицательные координаты), масштаб Windows 125/150%, свой размер
// плашки и перетаскивание к самому краю экрана.
const place = require('../lib/overlay-place');

let ok = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: получил ${a}, ждал ${b}`);
}
function near(a, b, tol, what) {
  if (Math.abs(a - b) > tol) throw new Error(`${what}: получил ${a}, ждал ${b}±${tol}`);
}

// Экран 1920×1080 без масштабирования; плашка зоны — стандартный правый нижний угол.
const strip1080 = { x: 1520, y: 1032, width: 380, height: 30, screenHeight: 1080 };
const d100 = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

console.log('\n=== место оверлея ===');

t('стандартное место: над миникартой, по левому краю плашки зоны', () => {
  const b = place.bounds({ strip: strip1080, display: d100 });
  eq(b.x, 1520, 'левый край');
  eq(b.width, 290, 'ширина');
  eq(b.height, 470, 'высота');
  // низ блока = верх плашки − 267 (до компаса) − 12 (зазор)
  eq(b.y + b.height, 1032 - 267 - 12, 'нижний край');
  eq(b.zoom, 1, 'зум');
});

t('свой размер: окно крупнее, а низ остаётся на месте', () => {
  const base = place.bounds({ strip: strip1080, display: d100 });
  const big = place.bounds({ strip: strip1080, scale: 1.5, display: d100 });
  eq(big.width, 435, 'ширина ×1.5');
  eq(big.zoom, 1.5, 'зум ×1.5');
  eq(big.y + big.height, base.y + base.height, 'нижний край не поехал');
});

t('размер зажат в 0.6…2.5 — мусор из конфига в setBounds не уходит', () => {
  eq(place.clampScale(99), 2.5, 'слишком крупно');
  eq(place.clampScale(0.01), 0.6, 'слишком мелко');
  eq(place.clampScale('абв'), 1, 'не число');
  eq(place.clampScale(undefined), 1, 'пусто');
  eq(place.bounds({ strip: strip1080, scale: 99, display: d100 }).zoom, 2.5, 'зум тоже зажат');
});

t('своё место: держим нижний левый угол, размер тянется вверх', () => {
  const pos = { x: 100, bottom: 900 };
  const a = place.bounds({ strip: strip1080, pos, display: d100 });
  const b = place.bounds({ strip: strip1080, scale: 2, pos, display: d100 });
  eq(a.x, 100, 'левый край');
  eq(a.y + a.height, 900, 'нижний край');
  eq(b.x, 100, 'левый край крупной');
  eq(b.y + b.height, 900, 'нижний край крупной');
  if (b.height <= a.height) throw new Error('крупная плашка не выросла');
});

console.log('\n=== масштаб Windows ===');

t('125%: окно задаётся в точках, а вёрстка остаётся в пикселях игры', () => {
  // экран 2400×1350 физических при масштабе 125% = 1920×1080 точек
  const strip = { x: 1900, y: 1290, width: 475, height: 38, screenHeight: 1350 };
  const d = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 };
  const b = place.bounds({ strip, display: d });
  eq(b.x, 1520, 'левый край в точках');
  near(b.width, 290, 1, 'ширина в точках');
  near(b.zoom, 1.25 / 1.25, 0.01, 'зум = масштаб игры / масштаб Windows');
  // блок должен закрывать те же физические пиксели: 290 точек × 1.25 = 362 ≈ 290 × (1350/1080)
  near(b.width * 1.25, 290 * (1350 / 1080), 2, 'физическая ширина совпадает с интерфейсом игры');
});

t('4К без масштабирования: плашка вдвое крупнее, чем на 1080p', () => {
  const strip = { x: 3040, y: 2064, width: 760, height: 60, screenHeight: 2160 };
  const d = { bounds: { x: 0, y: 0, width: 3840, height: 2160 }, scaleFactor: 1 };
  const b = place.bounds({ strip, display: d });
  eq(b.width, 580, 'ширина');
  eq(b.zoom, 2, 'зум');
  eq(b.y + b.height, 2064 - (267 + 12) * 2, 'нижний край');
});

console.log('\n=== второй монитор ===');

// монитор слева от основного: координаты отрицательные
const dLeft = { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

t('игра на левом мониторе — плашка тоже, а не на основном', () => {
  const strip = { x: -400, y: 1032, width: 380, height: 30, screenHeight: 1080 };
  const b = place.bounds({ strip, display: dLeft });
  eq(b.x, -400, 'левый край остался отрицательным');
});

t('сохранённое место на отключённом мониторе не принимается', () => {
  // место записано на левом мониторе, а ближайший экран теперь основной
  eq(place.validPos({ x: -1800, bottom: 900 }, d100), false, 'место вне экрана');
  eq(place.validPos({ x: -1800, bottom: 900 }, dLeft), true, 'на своём мониторе годится');
  eq(place.validPos({ x: 1520, bottom: 750 }, d100), true, 'обычное место');
  eq(place.validPos({ x: NaN, bottom: 750 }, d100), false, 'мусор в конфиге');
  eq(place.validPos(null, d100), false, 'места нет вовсе');
});

console.log('\n=== перетаскивание ===');

const wa = { x: 0, y: 0, width: 1920, height: 1080 };
const box = { x: 800, y: 300, width: 290, height: 470 };

t('обычный сдвиг: окно идёт ровно за курсором', () => {
  const b = place.dragTo({ bounds: box, dx: 60, dy: -40, workArea: wa });
  eq(b.x, 860, 'x');
  eq(b.y, 260, 'y');
  eq(b.width, 290, 'ширина не меняется');
});

t('за левый край: 40 px плашки остаются видимыми', () => {
  const b = place.dragTo({ bounds: box, dx: -5000, dy: 0, workArea: wa });
  eq(b.x, 40 - 290, 'левый упор');
  if (b.x + b.width < 40) throw new Error('плашка ушла с экрана целиком');
});

t('за правый и нижний край — тот же упор', () => {
  const b = place.dragTo({ bounds: box, dx: 5000, dy: 5000, workArea: wa });
  eq(b.x, 1880, 'правый упор');
  eq(b.y + b.height, 1080, 'низ по краю экрана');
});

t('вверх: нижний край не поднимается выше 40 px от верха экрана', () => {
  const b = place.dragTo({ bounds: box, dx: 0, dy: -5000, workArea: wa });
  eq(b.y + b.height, 40, 'верхний упор');
});

t('на левом мониторе упоры считаются по его рабочей области', () => {
  const waLeft = { x: -1920, y: 0, width: 1920, height: 1080 };
  const b = place.dragTo({ bounds: { x: -1000, y: 300, width: 290, height: 470 }, dx: -5000, dy: 0, workArea: waLeft });
  eq(b.x, -1920 + 40 - 290, 'левый упор второго монитора');
});

console.log('\n=== окно поиска встаёт туда же, где плашка ===');

const WA = { x: 0, y: 0, width: 1920, height: 1040 };   // рабочая область без панели задач

t('низ к низу, левый край к левому', () => {
  const box = { x: 1520, y: 500, width: 290, height: 470 };
  const g = place.anchorTo(box, { width: 340, height: 430, workArea: WA });
  eq(g.x, 1520, 'левый край');
  eq(g.y + g.height, box.y + box.height, 'низ совпал с низом плашки');
});

t('за правый край экрана не уезжает', () => {
  const box = { x: 1850, y: 500, width: 290, height: 470 };
  const g = place.anchorTo(box, { width: 340, height: 430, workArea: WA });
  eq(g.x, 1580, 'прижались к правому краю рабочей области');
});

t('за верх экрана не уезжает', () => {
  const box = { x: 100, y: 0, width: 290, height: 300 };
  const g = place.anchorTo(box, { width: 340, height: 430, workArea: WA });
  eq(g.y, 0, 'верх окна на границе рабочей области');
});

t('второй монитор слева: отрицательные координаты работают', () => {
  const wa = { x: -1920, y: 0, width: 1920, height: 1040 };
  const box = { x: -400, y: 500, width: 290, height: 470 };
  const g = place.anchorTo(box, { width: 340, height: 430, workArea: wa });
  eq(g.x, -400, 'левый край');
  eq(g.y, 540, 'низ к низу плашки');
});

console.log(`\n${fail ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ЗЕЛЕНО'}: ${ok}/${ok + fail} проверок пройдено`);
process.exit(fail ? 1 : 0);
