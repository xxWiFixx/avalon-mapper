// Справочник зон: тир и КАЧЕСТВО.
//
// Качество (Q1…Q6) есть только у чёрных зон — так в игре, так и в дампе. В дампе оно
// записано дважды: суффиксом «_Q5» в имени файла кластера и номером в типе зоны
// («OPENPVP_BLACK_5»). Оба источника сошлись на всех 276 зонах, и на этом выводе
// построен tools/add-royal-tiers.js.
//
// Здесь проверяется не дамп, а ГОТОВЫЙ справочник, который читает приложение: после
// патча игры данные пересобирают, и молча разъехаться они не должны.
const royal = require('../data-static/royal-zones.json');
const { zoneInfo } = require('../lib/recognize');

let ok = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

console.log('\n=== тир и качество зон ===');

t('качество есть только у чёрных зон', () => {
  const чужие = royal.filter(z => z.quality != null && z.color !== 'black');
  if (чужие.length) throw new Error('качество у не-чёрных: ' + чужие.slice(0, 5).map(z => `${z.name} (${z.color})`).join(', '));
});

t('качество в пределах 1…6 и целое', () => {
  for (const z of royal) {
    if (z.quality == null) continue;
    if (!Number.isInteger(z.quality) || z.quality < 1 || z.quality > 6) {
      throw new Error(`${z.name}: качество ${JSON.stringify(z.quality)}`);
    }
  }
});

t('качество совпадает с номером в типе зоны', () => {
  for (const z of royal) {
    const m = /^OPENPVP_BLACK_(\d)$/.exec(z.type || '');
    if (!m) continue;
    eq(z.quality, Number(m[1]), `${z.name} (${z.type})`);
  }
});

t('у каждой открытой чёрной зоны качество есть', () => {
  const без = royal.filter(z => /^OPENPVP_BLACK_\d$/.test(z.type || '') && z.quality == null);
  if (без.length) throw new Error('без качества: ' + без.slice(0, 5).map(z => z.name).join(', '));
});

// Пустое поле «quality: null» у 282 зон — шум в файле, который читают глазами.
t('у зон без качества поля нет вовсе, а не null', () => {
  const пустые = royal.filter(z => Object.prototype.hasOwnProperty.call(z, 'quality') && z.quality == null);
  if (пустые.length) throw new Error(`${пустые.length} зон с пустым полем quality`);
});

t('тир есть у всех зон', () => {
  const без = royal.filter(z => !z.tier);
  if (без.length) throw new Error('без тира: ' + без.slice(0, 5).map(z => z.name).join(', '));
});

// То, что увидит игрок. Числа взяты из дампа и служат сторожем: изменится игра —
// изменится и здесь, но осознанно.
t('распознавание отдаёт качество наружу', () => {
  eq(zoneInfo('Drownfield Sink').quality, 6, 'Drownfield Sink');
  eq(zoneInfo('Northstrand Dunes').quality, 1, 'Northstrand Dunes');
  eq(zoneInfo('Hynites-Ogozlum').quality, null, 'зона Авалона');
  eq(zoneInfo('Tharcal Fissure').quality, null, 'жёлтая зона');
  eq(zoneInfo('Martlock').quality, null, 'город');
});

console.log(fail ? `\nПРОВАЛЕНО: ${fail} из ${ok + fail}` : `\nВСЁ ЗЕЛЕНО: ${ok}/${ok} проверок пройдено`);
process.exit(fail ? 1 : 0);
