// Запись сырого трафика игры с метками времени — разведка для чтения порталов.
//
// ЗАЧЕМ. Мы хотим брать данные портала (куда ведёт, вместимость, таймер) из трафика,
// как уже берём зону. В отладочном логе AODP этих данных не нашлось — но в той сессии
// игрок ни разу не НАВОДИЛСЯ на портал. Гипотеза: данные приезжают в момент наведения.
// Эта запись отвечает на вопрос: появляется ли при наведении новый трафик и какой.
//
//   правой кнопкой по PowerShell → «Запуск от имени администратора», затем
//   cd C:\Users\tigro\Desktop\Claude_LM\avalon-mapper\app
//   node test/traffic-dump.js
//
// Как записывать: стоя У ПОРТАЛА в ДОРОГЕ АВАЛОНА (не в городе и не в укрытии) —
//   1. наведи курсор на портал, дождись тултипа;
//   2. пока тултип на экране — нажми Enter В ЭТОМ ОКНЕ (это метка);
//   3. отведи курсор в сторону, подожди пару секунд;
//   4. повтори раз пять; потом один раз открой карту зоны (M) и тоже отметь Enter;
//   5. Ctrl+C — запись закроется.
//
// Формат файла: [len:u32le][t:f64le мс][payload]; метка Enter — len = 0.
const fs = require('fs');
const path = require('path');
const capture = require('../lib/capture-socket');

// Событие «на ком-то изменился набор эффектов» — то, ради чего запись и делается.
// Считаем их ЖИВЬЁМ и показываем в строке состояния: без этого игрок записывает
// вслепую. Первая попытка так и вышла — 54 секунды, ни одного нужного события,
// и понять это удалось только потом, при разборе.
const EV_EFFECTS = 11;
let effects = 0;
function countEffects(pl) {
  if (!pl || pl.length < 12) return;
  let q = 12;
  for (let i = 0, n = pl[3]; i < n && q + 12 <= pl.length; i++) {
    const ty = pl[q], len = pl.readInt32BE(q + 4);
    if (len < 12 || q + len > pl.length) return;
    if (ty === 6 || ty === 7) {
      const b = pl.subarray(q + 12 + (ty === 7 ? 4 : 0), q + len);
      if (b.length > 3 && b[0] === 0xf3 && (b[1] & 0x7f) === 4 && b[2] === EV_EFFECTS) effects++;
    }
    q += len;
  }
}

const OUT = path.join(require('os').homedir(), 'Desktop', 'hover.rec');
const out = fs.createWriteStream(OUT);
let packets = 0, marks = 0;

function write(buf, isMark) {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(isMark ? 0 : buf.length, 0);
  head.writeDoubleLE(Date.now(), 4);
  out.write(head);
  if (!isMark && buf.length) out.write(Buffer.from(buf));
}

const socks = [];
const ips = capture.localAddresses();
const errs = [];
for (const ip of ips) {
  try { socks.push(capture.open(ip, p => { packets++; countEffects(p); write(p, false); })); }
  catch (err) { errs.push(ip + ': ' + err.message); }
}
if (!socks.length) {
  console.error('ни один интерфейс не открылся — ' + errs.join('; '));
  console.error('скорее всего, PowerShell запущен без прав администратора');
  process.exit(1);
}
console.log('пишу в', OUT);
console.log('слушаю:', socks.map(s => s.ip).join(', '));
console.log('стоя у портала В ДОРОГЕ: наведись, дождись тултипа и нажми Enter. Ctrl+C — закончить.\n');

// readline, а не сырой stdin: прошлый вариант ловил 'data' и в PowerShell не поймал
// ни одной метки — запись пришла пустой по меткам, и окна наведения не к чему было
// привязать. rl.on('line') срабатывает ровно на Enter и переживает Ctrl+C через SIGINT.
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', () => {
  marks++;
  write(null, true);
  console.log(`МЕТКА №${marks} поставлена (пакетов к этому моменту: ${packets})`);
});
rl.on('SIGINT', finish);

const tick = setInterval(() => {
  // «эффектов» — главный указатель. Пока он ноль, запись бесполезна: события про бафы
  // не ловятся. В первой попытке это выяснилось только при разборе, задним числом.
  process.stdout.write(`\rпакетов: ${packets} | эффектов: ${effects} | меток: ${marks}   `);
}, 1000);

let done = false;
function finish() {
  if (done) return;
  done = true;
  clearInterval(tick);
  rl.close();
  for (const s of socks) { try { s.close(); } catch (_) { /* уже закрыт */ } }
  out.end(() => {
    console.log(`\nготово: пакетов ${packets}, эффектов ${effects}, меток ${marks} → ${OUT}`);
    if (!marks) console.log('МЕТОК НЕТ — запись мало о чём скажет; повтори и нажимай Enter в момент действия');
    if (!effects) console.log('ЭФФЕКТОВ НЕТ — ни одного события про бафы не поймано, разбирать нечего.\n' +
      '  Повтори и следи за счётчиком «эффектов»: пока он ноль, запись бесполезна.');
    process.exit(0);
  });
}
process.on('SIGINT', finish);
