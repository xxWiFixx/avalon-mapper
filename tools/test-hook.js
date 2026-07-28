// Диагностика глобального хука: ловятся ли нажатия, когда фокус на игре.
// Запуск:  node tools/test-hook.js
// Затем: понажимать mouse4/mouse5 и клавиши — сначала на рабочем столе, потом в окне Albion.
// Если события идут на рабочем столе, но пропадают в игре — виноваты права (см. вывод в конце).
const path = require('path');
const { uIOhook } = require(path.join(__dirname, '..', 'app', 'node_modules', 'uiohook-napi'));

const t0 = Date.now();
let count = 0;
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 'с';

console.log('Хук запущен. Нажимай клавиши и кнопки мыши.');
console.log('Порядок проверки: 1) на рабочем столе  2) переключись в Albion и нажимай там.');
console.log('Ctrl+C — выход.\n');

uIOhook.on('mousedown', e => {
  count++;
  console.log(`${ts()}  МЫШЬ кнопка=${e.button}  (x=${e.x}, y=${e.y})`);
});
uIOhook.on('keydown', e => {
  count++;
  console.log(`${ts()}  КЛАВИША keycode=${e.keycode}`);
});

uIOhook.start();

// каждые 5 секунд — какое окно в фокусе и сколько событий поймано
setInterval(() => {
  console.log(`${ts()}  [событий поймано: ${count}]`);
}, 5000);

process.on('SIGINT', () => {
  console.log(`\nВсего событий: ${count}`);
  console.log('Если в игре событий не было, а на рабочем столе были — запусти приложение от имени администратора.');
  try { uIOhook.stop(); } catch (e) {}
  process.exit(0);
});
