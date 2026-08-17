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
// Как записывать: стоя У ПОРТАЛА в дороге Авалона —
//   1. наведи курсор на портал, дождись тултипа;
//   2. пока тултип на экране — нажми Enter В ЭТОМ ОКНЕ (это метка времени);
//   3. отведи курсор в сторону, подожди пару секунд;
//   4. повтори раз пять; потом один раз открой карту зоны (M) и тоже отметь Enter;
//   5. Ctrl+C — запись закроется.
//
// Формат файла: [len:u32le][t:f64le мс][payload]; метка Enter — len = 0.
const fs = require('fs');
const path = require('path');
const capture = require('../lib/capture-socket');

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
  try { socks.push(capture.open(ip, p => { packets++; write(p, false); })); }
  catch (err) { errs.push(ip + ': ' + err.message); }
}
if (!socks.length) {
  console.error('ни один интерфейс не открылся — ' + errs.join('; '));
  console.error('скорее всего, PowerShell запущен без прав администратора');
  process.exit(1);
}
console.log('пишу в', OUT);
console.log('слушаю:', socks.map(s => s.ip).join(', '));
console.log('наведись на портал, дождись тултипа и нажми Enter (метка). Ctrl+C — закончить.\n');

process.stdin.setEncoding('utf8');
process.stdin.on('data', ch => {
  if (ch.includes('\u0003')) return finish();          // Ctrl+C в raw-режиме
  marks++;
  write(null, true);
  console.log(`МЕТКА №${marks} поставлена (пакетов к этому моменту: ${packets})`);
});

const tick = setInterval(() => process.stdout.write(`\rпакетов: ${packets}   `), 1000);

function finish() {
  clearInterval(tick);
  for (const s of socks) { try { s.close(); } catch (_) { /* уже закрыт */ } }
  out.end(() => {
    console.log(`\nготово: пакетов ${packets}, меток ${marks} → ${OUT}`);
    process.exit(0);
  });
}
process.on('SIGINT', finish);
