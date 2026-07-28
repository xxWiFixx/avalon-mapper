// Чему приложение верит, получая рёбра из общей карты.
//
// Ключ проекта лежит внутри сборки — так и задумано, иначе клиент не работал бы.
// Значит, писать в общую карту может кто угодно, а не только наш клиент. Здесь
// проверяется, что чужие данные не принимаются на слово: имя зоны, которого нет
// в справочнике игры, в карту не попадает.
const recognize = require('../lib/recognize');
const store = require('../lib/store');

let ok = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

// то же правило, что в main.js: обе зоны обязаны быть в справочнике
const keep = list => list.filter(e => e && recognize.ZONE_INFO.has(e.a) && recognize.ZONE_INFO.has(e.b));
const edge = (a, b) => ({ a, b, capMax: 7, capMaxKnown: true, expiresAt: Date.now() + 3600e3, source: 'ocr', by: 'друг', updatedAt: Date.now() });

console.log('\n=== чужие рёбра ===');

t('настоящие зоны проходят', () => {
  eq(keep([edge('Coues-Exakrom', 'Qiient-Qi-Odesas')]).length, 1, 'ребро принято');
});

t('выдуманная зона не проходит', () => {
  eq(keep([edge('Coues-Exakrom', 'Такой Зоны Нет')]).length, 0, 'отброшено');
  eq(keep([edge('Выдумка', 'Ещё Выдумка')]).length, 0, 'обе выдуманы');
});

t('длинное имя не проходит', () => {
  eq(keep([edge('Coues-Exakrom', 'X'.repeat(500))]).length, 0, 'мегабайтное имя отброшено');
});

t('попытка вставить разметку не проходит', () => {
  eq(keep([edge('Coues-Exakrom', '<img src=x onerror=alert(1)>')]).length, 0, 'разметка отброшена');
});

t('пустое и мусор не ломают фильтр', () => {
  eq(keep([null, {}, edge('', 'Coues-Exakrom'), edge('Coues-Exakrom', null)]).length, 0, 'ничего не прошло');
});

console.log('\n=== что попадает в карту после фильтра ===');

t('карта принимает только проверенное', () => {
  store.state.edges = {}; store.state.players = {}; store.state.journal = [];
  const list = [edge('Coues-Exakrom', 'Qiient-Qi-Odesas'), edge('Coues-Exakrom', 'Выдумка')];
  store.mergeRemote(keep(list), 'public');
  const names = store.snapshot().edges.flatMap(e => [e.a, e.b]);
  eq(store.snapshot().edges.length, 1, 'рёбер в карте');
  eq(names.includes('Выдумка'), false, 'выдуманной зоны в карте нет');
});

t('зоны королевства тоже настоящие — их не режем', () => {
  // порталы Авалона ведут в мир, и такие рёбра обязаны проходить
  eq(recognize.ZONE_INFO.has('Cairn Camain'), true, 'зона королевства есть в справочнике');
  eq(keep([edge('Coues-Exakrom', 'Cairn Camain')]).length, 1, 'выход в мир принят');
});

console.log(`\n${fail ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ЗЕЛЕНО'}: ${ok}/${ok + fail} проверок пройдено`);
process.exit(fail ? 1 : 0);
