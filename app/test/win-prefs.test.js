// Сборка настроек окна. Тест появился после того, как приложение перестало
// открываться вовсе: замороженный образец настроек использовался как ЦЕЛЬ
// Object.assign, вызов бросал TypeError, и ни одна проверка этого не поймала —
// потому что окон не создаёт ни одна из них.
const { SAFE_WEB, webPrefs } = require('../lib/win-prefs');

let ok = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

console.log('\n=== сборка настроек окна ===');

t('мост окна на месте — без него в странице нет window.api', () => {
  eq(webPrefs('C:/app/preload.js').preload, 'C:/app/preload.js', 'preload');
});

t('вызов не падает и не портит образец', () => {
  webPrefs('a.js');
  webPrefs('b.js');
  eq(Object.prototype.hasOwnProperty.call(SAFE_WEB, 'preload'), false, 'образец без preload');
  eq(Object.isFrozen(SAFE_WEB), true, 'образец заморожен');
});

t('каждое окно получает свой мост', () => {
  eq(webPrefs('overlay.js').preload !== webPrefs('search.js').preload, true, 'мосты разные');
});

console.log('\n=== безопасные свойства ===');

t('все четыре на месте', () => {
  const p = webPrefs('x.js');
  eq(p.contextIsolation, true, 'contextIsolation');
  eq(p.nodeIntegration, false, 'nodeIntegration');
  eq(p.sandbox, true, 'sandbox');
  eq(p.webSecurity, true, 'webSecurity');
});

t('прочие настройки окна применяются', () => {
  eq(webPrefs('x.js', { backgroundThrottling: false }).backgroundThrottling, false, 'своя настройка');
});

t('ослабить безопасное через extra нельзя', () => {
  const p = webPrefs('x.js', { nodeIntegration: true, sandbox: false, contextIsolation: false, webSecurity: false });
  eq(p.nodeIntegration, false, 'nodeIntegration остался выключен');
  eq(p.sandbox, true, 'песочница осталась');
  eq(p.contextIsolation, true, 'изоляция осталась');
  eq(p.webSecurity, true, 'правила источников остались');
});

t('подменить мост через extra нельзя', () => {
  eq(webPrefs('свой.js', { preload: 'чужой.js' }).preload, 'свой.js', 'preload');
});

console.log(`\n${fail ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ЗЕЛЕНО'}: ${ok}/${ok + fail} проверок пройдено`);
process.exit(fail ? 1 : 0);
