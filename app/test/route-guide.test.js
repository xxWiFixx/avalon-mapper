// Проводник по маршруту (lib/route-guide.js).
//
// Проверяем края, а не середину: середина работает сама собой, а вот «дошёл», «ещё не
// вышел», «свернул не туда» и петля в маршруте выглядят на экране одинаково — двумя
// названиями зон, — и ошибка в них незаметна до тех пор, пока игрок не убежит не туда.
'use strict';
const fs = require('fs');
const path = require('path');
const g = require('../lib/route-guide');

let ok = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '—', e.message); fail++; } };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: «${a}» ≠ «${b}»`); };

const S = (...pairs) => pairs.map(([from, to, kind]) => ({ from, to, kind: kind || 'portal' }));
const PATH = S(['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']);

console.log('\n=== где я на маршруте ===');
t('в начальной зоне ведём с первого шага', () => {
  const p = g.progress(PATH, 'A');
  eq(p.state, 'go', 'состояние'); eq(p.idx, 0, 'шаг'); eq(p.left, 4, 'осталось');
  eq(p.steps[0].to, 'B', 'ближайшая цель');
});
t('в середине — со своего шага', () => {
  const p = g.progress(PATH, 'C');
  eq(p.state, 'go', 'состояние'); eq(p.idx, 2, 'шаг'); eq(p.left, 2, 'осталось');
  eq(p.steps[0].to, 'D', 'ближайшая цель');
});
t('в конечной — дошёл, а не «иди дальше»', () => {
  const p = g.progress(PATH, 'E');
  eq(p.state, 'done', 'состояние'); eq(p.left, 0, 'осталось'); eq(p.steps.length, 0, 'шагов');
});
t('зоны на маршруте нет — говорим, что свернул', () => {
  const p = g.progress(PATH, 'Мимо');
  eq(p.state, 'off', 'состояние'); eq(p.left, 4, 'осталось');
});
t('зона ещё не известна — не врём ни «дошёл», ни «свернул»', () => {
  eq(g.progress(PATH, null).state, 'unknown', 'состояние');
});
t('пустой маршрут — идти некуда', () => {
  eq(g.progress([], 'A').state, 'done', 'состояние');
  eq(g.progress(null, 'A').state, 'done', 'состояние');
});

console.log('\n=== кривые данные не должны врать ===');
// Петля: конечная зона встречается и как начало шага. Если проверять «дошёл» ПОСЛЕ
// поиска шага, игрок в конечной точке получит «иди дальше» и уйдёт на второй круг.
t('петля через конечную зону всё равно считается приходом', () => {
  const loop = S(['A', 'B'], ['B', 'C'], ['C', 'B']);
  eq(g.progress(loop, 'B').state, 'done', 'состояние');
});
t('рваная цепь: зона была концом шага — ведём со следующего', () => {
  const torn = [{ from: 'A', to: 'B' }, { from: 'X', to: 'Y' }];
  const p = g.progress(torn, 'B');
  eq(p.state, 'go', 'состояние'); eq(p.idx, 1, 'шаг'); eq(p.steps[0].from, 'X', 'следующий шаг');
});
t('шаги без имён зон выбрасываются, а не рисуются пустыми', () => {
  const junk = [{ from: 'A' }, { to: 'B' }, { from: 'A', to: 'B' }];
  const p = g.progress(junk, 'A');
  eq(p.left, 1, 'осталось'); eq(p.steps.length, 1, 'шагов');
});
t('показываем не больше трёх шагов', () => {
  const long = S(['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F'], ['F', 'G']);
  eq(g.progress(long, 'A').steps.length, g.SHOW, 'шагов на экране');
  eq(g.progress(long, 'A').left, 6, 'а осталось всё равно шесть');
});

console.log('\n=== снимок для оверлея ===');
t('собирается со всем, что рисуется', () => {
  const b = g.board({ steps: PATH, to: 'E' }, 'B');
  eq(b.state, 'go', 'состояние'); eq(b.to, 'E', 'цель'); eq(b.zone, 'B', 'где я');
  eq(b.left, 3, 'осталось'); eq(b.total, 4, 'всего'); eq(b.steps[0].to, 'C', 'ближайшая цель');
});
t('цель берётся из последнего шага, если её не передали', () => {
  eq(g.board({ steps: PATH }, 'A').to, 'E', 'цель');
});
t('без маршрута снимка нет', () => {
  eq(g.board(null, 'A'), null, 'снимок');
  eq(g.board({}, 'A'), null, 'снимок');
});


// ---------- отрисовка плашки ----------
//
// Функцию берём ИЗ ИСХОДНИКА ui/overlay.js, а не копируем: копия разошлась бы с
// оригиналом, и тест охранял бы сам себя. Целиком файл в Node не подгрузить — там
// window и document, поэтому вырезаем одну функцию и даём ей крошечный поддельный узел.
console.log('\n=== плашка проводника ===');
function renderer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'overlay.js'), 'utf8');
  const from = src.indexOf('function renderGuide(b) {');
  if (from < 0) throw new Error('в overlay.js нет renderGuide');
  const end = /\r?\n\}\r?\n/.exec(src.slice(from));
  if (!end) throw new Error('не нашёл конец renderGuide');
  const node = { hidden: true, innerHTML: '' };
  const esc = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const GUIDE_RU = { done: 'пришёл', off: 'сошёл с маршрута', unknown: 'жду, где ты' };
  const fn = new Function('el', 'esc', 'GUIDE_RU',
    src.slice(from, from + end.index + end[0].length) + '\nreturn renderGuide;')(() => node, esc, GUIDE_RU);
  return { fn, node };
}

t('идём — видна цель, счёт и ближайший шаг', () => {
  const { fn, node } = renderer();
  fn(g.board({ steps: PATH, to: 'E' }, 'B'));
  eq(node.hidden, false, 'блок виден');
  if (node.innerHTML.indexOf('>E<') < 0) throw new Error('нет цели: ' + node.innerHTML);
  if (node.innerHTML.indexOf('3 из 4') < 0) throw new Error('нет счёта: ' + node.innerHTML);
  if (node.innerHTML.indexOf('gs now') < 0) throw new Error('ближайший шаг не выделен');
});
t('пришёл — так и написано, шагов нет', () => {
  const { fn, node } = renderer();
  fn(g.board({ steps: PATH, to: 'E' }, 'E'));
  if (node.innerHTML.indexOf('пришёл') < 0) throw new Error('нет слова: ' + node.innerHTML);
  if (node.innerHTML.indexOf('class="gs') >= 0) throw new Error('шаги остались');
});
// Самое опасное состояние: шаги показаны, но они НЕ про то место, где игрок сейчас.
// Без подписи он побежит по ним из чужой зоны.
t('сошёл — шаги подписаны как начало пути', () => {
  const { fn, node } = renderer();
  fn(g.board({ steps: PATH, to: 'E' }, 'Мимо'));
  if (node.innerHTML.indexOf('сошёл') < 0) throw new Error('нет слова: ' + node.innerHTML);
  if (node.innerHTML.indexOf('это начало пути') < 0) throw new Error('нет подписи: ' + node.innerHTML);
  if (node.innerHTML.indexOf('gs now') >= 0) throw new Error('чужой шаг выделен как ближайший');
});
t('без маршрута блок прячется и чистится', () => {
  const { fn, node } = renderer();
  fn(g.board({ steps: PATH }, 'B'));
  fn(null);
  eq(node.hidden, true, 'спрятан');
  eq(node.innerHTML, '', 'очищен');
});
t('имя зоны экранируется, а не выполняется', () => {
  const { fn, node } = renderer();
  fn(g.board({ steps: [{ from: 'A', to: '<img onerror=alert(1)>' }], to: 'A' }, 'A'));
  if (node.innerHTML.indexOf('<img') >= 0) throw new Error('разметка просочилась: ' + node.innerHTML);
  if (node.innerHTML.indexOf('&lt;img') < 0) throw new Error('не экранировано: ' + node.innerHTML);
});
console.log(fail ? `\nЕСТЬ ПРОВАЛЫ: ${ok}/${ok + fail}` : `\nВСЁ ЗЕЛЕНО: ${ok}/${ok} проверок пройдено`);
process.exit(fail ? 1 : 0);
