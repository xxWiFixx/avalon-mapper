// Правило «потерянная середина»: короткий близнец повышается до длинного ТОЛЬКО тогда,
// когда какое-то прочтение реально увидело средний слог.
// Запуск: node test/twins.test.js
const { NAME_TWINS, resolveTwin, DICT } = require('../lib/recognize');

let ok = 0, fail = 0;
function is(actual, expected, what) {
  if (actual === expected) { ok++; console.log(`  ОК      ${what}`); }
  else { fail++; console.error(`  ПРОВАЛ  ${what}\n          ждали: ${expected}\n          вышло: ${actual}`); }
}

console.log(`словарь ${DICT.length} имён, пар-близнецов ${NAME_TWINS.size}`);
if (!NAME_TWINS.has('Settun-Odetum')) { console.error('индекс близнецов пуст — дальше проверять нечего'); process.exit(1); }
is(NAME_TWINS.get('Settun-Odetum').length, 3, 'у Settun-Odetum три длинных близнеца (-Al-, -Et-, -In-)');

// --- средний слог не прочитан: остаёмся на коротком имени ---
is(resolveTwin('Sectun-Tersas', ['Sectun-Tersas']), 'Sectun-Tersas',
  'чистое короткое имя не превращается в длинное');
is(resolveTwin('Settun-Odetum', ['Settun-Odetum', 'Settun Odetum']), 'Settun-Odetum',
  'три кандидата и ноль улик — короткое имя остаётся');
is(resolveTwin('Qiient-Qinsum', ['Qiient-Qinsum']), 'Qiient-Qinsum',
  'калибровочная зона Qiient-Qinsum не уезжает в Qiient-Et-Qinsum');

// --- средний слог виден: повышаем ---
is(resolveTwin('Sectun-Tersas', ['Sectun-Tersas', 'Sectun-Et-Tersas']), 'Sectun-Et-Tersas',
  'слог увиден во втором прочтении — берём длинное имя');
is(resolveTwin('Settun-Odetum', ['Settun-Odetum', 'Settun-In-Odetum']), 'Settun-In-Odetum',
  'из трёх близнецов выбираем того, чей слог прочитан');
is(resolveTwin('Qiient-Odesas', ['Qiient-Qi-Odesas']), 'Qiient-Qi-Odesas',
  'зона калибровки Qiient-Qi-Odesas восстанавливается из длинного прочтения');

// --- слог прочитан с опечаткой: одна замена прощается ---
is(resolveTwin('Sectun-Tersas', ['Sectun-Ei-Tersas']), 'Sectun-Et-Tersas',
  'Ei → Et (t/i — типичная путаница шрифта)');
is(resolveTwin('Quaent-Qintis', ['Quaent-AI-Qintis']), 'Quaent-Al-Qintis',
  'AI → Al (l/I — та же путаница)');
is(resolveTwin('Sectun-Tersas', ['Sectun-Xyz-Tersas']), 'Sectun-Tersas',
  'непохожий слог не считается уликой');

// --- мусор вокруг имени не мешает и не выдумывает улик ---
is(resolveTwin('Qiient-Odesas', ['2 Qiient-Qi-Odesas 18:37']), 'Qiient-Qi-Odesas',
  'счётчик игроков и часы в строке плашки не мешают');
is(resolveTwin('Qiient-Odesas', ['Qi 2 Qiient-Odesas']), 'Qiient-Odesas',
  'слог сам по себе, не между частями имени, уликой не считается');
is(resolveTwin('Sectun-Tersas', ['Sectun-Tersas-Et']), 'Sectun-Tersas',
  'слог после имени — не середина');

// --- имена без близнецов правило не трогает ---
is(resolveTwin('Fort Sterling', ['Fort Al Sterling']), 'Fort Sterling',
  'у имени без близнецов ничего не меняется');
is(resolveTwin('Coues-Exakrom', ['Coues-Et-Exakrom']), 'Coues-Exakrom',
  'несуществующее длинное имя не выдумывается');

console.log(fail ? `\nПРОВАЛЕНО: ${fail} из ${ok + fail}` : `\nВСЁ ЗЕЛЕНО: ${ok}/${ok} проверок пройдено`);
process.exit(fail ? 1 : 0);
