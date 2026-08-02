// Раскладка графа обязана получаться ОДИНАКОВОЙ у разных игроков — иначе карты
// невозможно сравнить, а именно этого игрок и просил: «у меня они выглядят по одному,
// у друга по-другому».
//
// Проверяем три источника расхождения, каждый из которых ломал повторяемость сам по себе:
//   1) случайность старта (Math.random в cose);
//   2) порядок элементов (граф наполняется в разном порядке у разных игроков);
//   3) размер окна (cose мерил разброс по cy.width/height, когда boundingBox не задан).
require('../ui/graph-layout.js');
const GL = globalThis.GRAPH_LAYOUT;
const cytoscape = require('cytoscape');

const LINK_LEN = 165;   // тот же, что в ui/map.js

let ok = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

// Граф, похожий на настоящую карту: цепочки зон с ответвлениями.
// Имена нарочно не по алфавиту — чтобы сортировка в seedFrom реально что-то делала.
function makeElements() {
  const zones = [];
  for (let i = 0; i < 24; i++) zones.push(`Zone-${String((i * 7) % 24).padStart(2, '0')}-${'qwertyuiop'[i % 10]}`);
  const nodes = zones.map(id => ({ group: 'nodes', data: { id } }));
  const edges = [];
  const pair = (i, j) => edges.push({ group: 'edges', data: { id: `${zones[i]}~${zones[j]}`, source: zones[i], target: zones[j] } });
  for (let i = 0; i + 1 < zones.length; i++) pair(i, i + 1);
  pair(0, 12); pair(3, 17); pair(5, 20); pair(8, 15); pair(2, 22);
  return { nodes, edges };
}

// Одна раскладка целиком, как её делает ui/map.js.
// shuffle — добавить элементы в другом порядке (так и бывает у разных игроков).
// container — «размер окна»: в headless его нет, но boundingBox обязан перебить и его.
function layoutOnce({ shuffle = false, seeded = true, scatter = 0, twice = false } = {}) {
  const { nodes, edges } = makeElements();
  let elements = [...nodes, ...edges];
  if (shuffle) {
    // переставляем задом наперёд и вперемешку — лишь бы порядок был другой
    elements = [...edges].reverse().concat([...nodes].reverse());
  }
  const cy = cytoscape({ headless: true, styleEnabled: false, elements });
  // scatter — «граф уже разложен по-своему»: у каждого игрока узлы стоят там, куда их
  // занесла его собственная история сканов. Именно это состояние протекало в результат.
  if (scatter) {
    const rnd = GL.mulberry32(scatter);
    cy.nodes().forEach(n => n.position({ x: rnd() * 3000 - 1500, y: rnd() * 3000 - 1500 }));
  }
  const run = () => {
    const opts = GL.options(cy.nodes().length, LINK_LEN);
    GL.resetPositions(cy, opts.boundingBox.w);
    const l = cy.layout(Object.assign(opts, { eles: GL.sortedEles(cy) }));
    if (seeded) {
      GL.runSeeded(l, GL.seedFrom(cy.nodes().map(n => n.id()), cy.edges().map(e => [e.data('source'), e.data('target')])));
    } else {
      l.run();
    }
  };
  run();
  if (twice) run();   // «Пересобрать» второй раз подряд не должно менять картинку
  // округляем до сотой: сравниваем раскладку, а не последний бит double
  const out = cy.nodes().map(n => `${n.id()}:${n.position('x').toFixed(2)},${n.position('y').toFixed(2)}`).sort().join(' ');
  cy.destroy();
  return out;
}

console.log('\n=== раскладка одинакова у всех ===');

t('два прогона подряд дают одно и то же', () => {
  eq(layoutOnce(), layoutOnce(), 'позиции');
});

t('порядок добавления рёбер и узлов ничего не меняет', () => {
  eq(layoutOnce({ shuffle: true }), layoutOnce({ shuffle: false }), 'позиции при другом порядке');
});

// Найдено замером на живой странице: та же коллекция, то же зерно, тот же порядок — и
// РАЗНЫЙ результат, если перед раскладкой узлы стояли по-разному. А стоят они у каждого
// игрока по-своему: граф рос в том порядке, в каком кто что отсканировал.
t('прежние позиции узлов не протекают в результат', () => {
  eq(layoutOnce({ scatter: 777 }), layoutOnce({ scatter: 0 }), 'позиции после разного старта');
  eq(layoutOnce({ scatter: 777 }), layoutOnce({ scatter: 12345 }), 'позиции после двух разных стартов');
});

t('вторая раскладка подряд даёт ту же картинку', () => {
  eq(layoutOnce({ twice: true }), layoutOnce({ twice: false }), 'позиции после повторной раскладки');
});

t('без зерна прогоны РАСХОДЯТСЯ — значит проверка выше не пустая', () => {
  const a = layoutOnce({ seeded: false }), b = layoutOnce({ seeded: false });
  if (a === b) throw new Error('два несеяных прогона совпали — тест ничего не доказывает');
});

t('зерно зависит от состава, а не от порядка', () => {
  const s1 = GL.seedFrom(['b', 'a', 'c'], [['b', 'a'], ['c', 'b']]);
  const s2 = GL.seedFrom(['c', 'b', 'a'], [['b', 'c'], ['a', 'b']]);   // те же зоны и пары, иначе записаны
  eq(s1, s2, 'зерно');
});

t('другой состав — другое зерно', () => {
  const s1 = GL.seedFrom(['a', 'b'], [['a', 'b']]);
  const s2 = GL.seedFrom(['a', 'b', 'c'], [['a', 'b']]);
  if (s1 === s2) throw new Error('добавили зону, а зерно то же — рисунок не обновится');
});

t('поле раскладки не зависит от окна и растёт от числа зон', () => {
  const small = GL.options(10, LINK_LEN).boundingBox, big = GL.options(400, LINK_LEN).boundingBox;
  if (!small || !big) throw new Error('boundingBox не задан — cose возьмёт размер окна');
  if (!(big.w > small.w)) throw new Error('на 400 зонах поле не больше, чем на 10');
  eq(GL.options(50, LINK_LEN).boundingBox.w, GL.options(50, LINK_LEN).boundingBox.h, 'поле квадратное');
});

t('Math.random возвращается на место после раскладки', () => {
  const before = Math.random;
  const cy = cytoscape({ headless: true, styleEnabled: false, elements: makeElements().nodes });
  GL.runSeeded(cy.layout(GL.options(1, LINK_LEN)), 123);
  cy.destroy();
  if (Math.random !== before) throw new Error('подменённый Math.random остался в приложении');
});

t('и возвращается даже если раскладка упала', () => {
  const before = Math.random;
  try { GL.runSeeded({ run() { throw new Error('падение внутри cose'); } }, 1); } catch (e) { /* ждём его */ }
  if (Math.random !== before) throw new Error('после исключения Math.random остался подменённым');
});

console.log(fail ? `\nПРОВАЛЕНО: ${fail} из ${ok + fail}` : `\nВСЁ ЗЕЛЕНО: ${ok}/${ok} проверок пройдено`);
process.exit(fail ? 1 : 0);
