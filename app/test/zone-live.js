// Живая проверка захвата зоны. Запускается руками, в общий npm test не входит:
// нужны права администратора и запущенная игра.
//
//   правой кнопкой по PowerShell → «Запуск от имени администратора», затем
//   cd C:\Users\tigro\Desktop\Claude_LM\avalon-mapper\app
//   node test/zone-live.js
//
// Что должно быть видно: строка про интерфейсы, дальше ТИШИНА, пока игрок стоит на
// месте, и ровно одна строка на каждый переход. Если строки сыплются пачками, если
// зоны идут кругами или если они появляются от открытия карты, аукциона и рынка —
// значит отсев в lib/cluster.js снова пропускает чужие сообщения.
const capture = require('../lib/capture-socket');
const watch = require('../lib/zone-watch');

let n = 0;
const started = Date.now();
const hhmmss = () => new Date().toTimeString().slice(0, 8);

const w = watch.create({
  onZone: z => console.log(`${hhmmss()}  ${++n}. ${z.zone}  [${z.id}]${z.avalon ? '  Авалон' : ''}`),
  onError: err => console.error(hhmmss(), 'ошибка разбора:', err.message),
});

let state;
try {
  state = w.start(capture);
} catch (err) {
  console.error('\nне удалось начать слушать:', err.message);
  console.error('чаще всего это значит, что PowerShell запущен без прав администратора.\n');
  process.exit(1);
}

console.log('слушаю интерфейсы:', state.listening.join(', ') || '(ни одного)');
if (state.failed.length) console.log('не открылись:', state.failed.join('; '));
console.log('жду переходов. Ctrl+C — закончить.\n');

process.on('SIGINT', () => {
  const min = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\nза ${min} мин переходов: ${n}. Текущая зона: ${w.zone || '(не видел)'}`);
  w.stop();
  process.exit(0);
});
