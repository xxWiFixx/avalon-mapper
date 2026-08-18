// Проверка определения зоны по трафику.
//
// Проверки двух сортов. Первые собирают настоящий кадр Photon вокруг нужных параметров —
// так видно, что смещения заголовков посчитаны верно. Вторые прогоняют ЗАПИСЬ настоящего
// потока (albiondata-client -record): выдуманный буфер не докажет, что мы понимаем живую
// игру, а запись — доказывает.
//
// Запись не в репозитории — она весит мегабайты и содержит трафик игрока. Кладётся
// рядом руками; без неё проверки пропускаются, как и калибровочные кадры.
const fs = require('fs');
const path = require('path');
const cluster = require('../lib/cluster');

const REC = process.env.ROADS_REC || path.join(require('os').homedir(), 'Desktop', 'roads.rec');
let ok = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '—', e.message); fail++; } };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${a} ≠ ${b}`); };

// --- сборка кадра ------------------------------------------------------------
// Обратная сторона разбора из lib/photon.js: строим ответ на операцию с нужными
// параметрами и заворачиваем в команду и пакет Photon.
function param(key, val) {
  if (typeof val === 'string') {
    const s = Buffer.from(val, 'utf8');
    return Buffer.concat([Buffer.from([key, 7, s.length]), s]);   // 7 = строка
  }
  const b = Buffer.alloc(4);
  b[0] = key; b[1] = 4; b.writeUInt16LE(val, 2);                  // 4 = число, два байта
  return b;
}
function response(opCode, params) {
  const ps = Object.entries(params).map(([k, v]) => param(Number(k), v));
  ps.push(param(253, opCode));                                   // 253 — код операции
  return Buffer.concat([Buffer.from([0xf3, 3, 1, 0, 0, 8, ps.length]), ...ps]);
}
function packet(...bodies) {
  const cmds = bodies.map(body => {
    const h = Buffer.alloc(12);
    h[0] = 6;                                                    // надёжная команда
    h.writeInt32BE(12 + body.length, 4);
    return Buffer.concat([h, body]);
  });
  const head = Buffer.alloc(12);
  head[3] = cmds.length;
  return Buffer.concat([head, ...cmds]);
}

console.log('\n=== таблица кластеров ===');
t('в таблице и Авалон, и мир', () => {
  const ids = Object.keys(cluster.IDS);
  eq(ids.filter(x => x.startsWith('TNL-')).length, 400, 'туннелей');
  if (ids.filter(x => /^\d{4}$/.test(x)).length < 400) throw new Error('зон мира мало');
});
t('известные id дают известные имена', () => {
  eq(cluster.IDS['0007'], 'Thetford Market', 'Thetford');
  eq(cluster.IDS['5003'], 'Brecilien Market', 'Brecilien');
});

console.log('\n=== разбор пакета ===');
t('opChangeCluster даёт зону Авалона', () => {
  const r = cluster.pickCluster(packet(response(41, { 0: 'TNL-235' })));
  eq(r && r.zone, 'Tasitos-Obayam', 'зона');
  eq(r && r.avalon, true, 'авалон');
});
t('opChangeCluster даёт зону мира', () => {
  const r = cluster.pickCluster(packet(response(41, { 0: '4208', 8: '4208' })));
  eq(r && r.zone, 'Mawar Gorge', 'зона');
  eq(r && r.avalon, false, 'не авалон');
});
t('несколько команд в пакете — находим нужную', () => {
  const p = packet(response(197, { 0: 'TNL-117' }), response(41, { 0: 'TNL-235' }));
  eq(cluster.pickCluster(p).zone, 'Tasitos-Obayam', 'зона');
});

// Ради этих четырёх проверка и заведена. Каждая — отдельная жалоба игрока:
// «зоны дублируются» и «открыл аукцион — посыпались локации».
console.log('\n=== чужие сообщения не считаются переходом ===');
for (const [op, name] of [[197, 'opGetClusterMapInfo (открытая карта)'],
                          [141, 'opSubscribeToCluster (список соседей)'],
                          [299, 'opClientPerformanceStats (телеметрия)'],
                          [2, 'opJoin (вход на сервер)']]) {
  t(name, () => eq(cluster.pickCluster(packet(response(op, { 0: 'TNL-235' }))), null, 'должен быть null'));
}
t('голая строка без кадра Photon — молчание', () => {
  eq(cluster.pickCluster(Buffer.from('\x00\x01TNL-235\x00')), null, 'должен быть null');
});
t('мусор — молчание', () => {
  eq(cluster.pickCluster(Buffer.from('\x01\x02\x03')), null, 'должен быть null');
});
t('обрезанный пакет не роняет разбор', () => {
  const p = packet(response(41, { 0: 'TNL-235' }));
  for (let n = 1; n < p.length; n++) cluster.pickCluster(p.subarray(0, n));
});
t('незнакомый id в правильной операции не выдумывает зону', () => {
  eq(cluster.pickCluster(packet(response(41, { 0: 'TNL-999' }))), null, 'должен быть null');
});
// id приходит из пакета, то есть снаружи. Через обычный IDS[id] «__proto__» вернул бы
// унаследованное свойство, и зоной стал бы объект вместо имени.
t('служебные имена свойств не проходят за зону', () => {
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    eq(cluster.pickCluster(packet(response(41, { 0: id }))), null, id);
  }
});

console.log('\n=== разбор UDP-пакета ===');
const cap = require('../lib/capture-socket');
// Собираем настоящий кадр IP+UDP вокруг тела: проверяем, что смещения заголовков
// посчитаны верно, а не «вроде бы работает на живом трафике».
function frame(srcPort, dstPort, body, ihl = 20) {
  const b = Buffer.alloc(ihl + 8 + body.length);
  b[0] = 0x40 | (ihl / 4);
  b[9] = 17;
  b.writeUInt16BE(srcPort, ihl);
  b.writeUInt16BE(dstPort, ihl + 2);
  body.copy(b, ihl + 8);
  return b;
}
t('пакет Photon отдаёт тело', () => {
  const f = frame(50000, cap.PHOTON_PORT, Buffer.from('TNL-235'));
  eq(cap.udpPayload(f, f.length).toString(), 'TNL-235', 'тело');
});
t('заголовок с опциями (ihl > 20) не сбивает смещение', () => {
  const f = frame(50000, cap.PHOTON_PORT, Buffer.from('TNL-235'), 24);
  eq(cap.udpPayload(f, f.length).toString(), 'TNL-235', 'тело');
});
t('чужой порт отбрасывается', () => {
  const f = frame(443, 443, Buffer.from('TNL-235'));
  eq(cap.udpPayload(f, f.length), null, 'должен быть null');
});
t('не-UDP отбрасывается', () => {
  const f = frame(50000, cap.PHOTON_PORT, Buffer.from('TNL-235'));
  f[9] = 6;
  eq(cap.udpPayload(f, f.length), null, 'должен быть null');
});

console.log('\n=== слежение за зоной ===');
const watch = require('../lib/zone-watch');
const at = id => packet(response(41, { 0: id }));
t('сообщает только о СМЕНЕ зоны, а не о каждом пакете', () => {
  const seen = [];
  const w = watch.create({ onZone: z => seen.push(z.zone) });
  w.feed(at('TNL-235')); w.feed(at('TNL-235')); w.feed(at('TNL-235')); w.feed(at('TNL-083'));
  eq(seen.join(' -> '), 'Tasitos-Obayam -> Souos-Umogaum', 'переходы');
});
t('чужие сообщения не двигают зону', () => {
  const seen = [];
  const w = watch.create({ onZone: z => seen.push(z.zone) });
  w.feed(at('TNL-235'));
  w.feed(packet(response(197, { 0: 'TNL-117' })));
  w.feed(packet(response(141, { 0: 'TNL-083' })));
  eq(seen.length, 1, 'переходов');
});
t('возврат в ту же зону после отлучки — снова событие', () => {
  const seen = [];
  const w = watch.create({ onZone: z => seen.push(z.zone) });
  w.feed(at('TNL-235')); w.feed(at('TNL-083')); w.feed(at('TNL-235'));
  eq(seen.length, 3, 'переходов');
});

console.log('\n=== настоящая запись потока ===');
// Запись — это поток Go gob со структурой RawPacket{Payload []byte}. Читаем ровно
// эту форму: длина записи, id типа, номер поля, длина среза, байты.
function* recorded(file) {
  const b = fs.readFileSync(file);
  const num = p => { const n = b[p]; if (n < 128) return [n, p + 1];
    let v = 0; const len = 256 - n; for (let i = 0; i < len; i++) v = v * 256 + b[p + 1 + i];
    return [v, p + 1 + len]; };
  let p = 0;
  while (p < b.length) {
    let len; [len, p] = num(p);
    if (!len || p + len > b.length) return;
    const end = p + len;
    let q = p, tid, delta, n;
    [tid, q] = num(q);
    if (!(tid & 1)) {                       // чётный = значение, нечётный = описание типа
      [delta, q] = num(q);
      if (delta === 1) { [n, q] = num(q); if (q + n <= end) yield b.subarray(q, q + n); }
    }
    p = end;
  }
}

if (!fs.existsSync(REC)) {
  console.log('  записи нет (' + REC + ') — пропуск');
} else {
  const route = [];
  let packets = 0;
  for (const pl of recorded(REC)) {
    packets++;
    const hit = cluster.pickCluster(pl);
    if (hit) route.push(hit.zone);
  }
  console.log('  пакетов:', packets, '| переходов:', route.length);
  console.log('  маршрут:', route.join(' → '));
  t('запись прочиталась', () => { if (packets < 1000) throw new Error('пакетов всего ' + packets); });
  // Тринадцать переходов на 48 тысяч пакетов. До разбора операции поиск строки давал
  // здесь 497 срабатываний по 167 зонам — вот цена этой проверки.
  t('переходов единицы, а не сотни', () => {
    if (route.length > 40) throw new Error('переходов ' + route.length + ' — снова ловим лишнее');
    if (!route.length) throw new Error('ни одного перехода');
  });
  t('маршрут связный: Авалон и мир, без скачков пачками', () => {
    let repeats = 0;
    for (let i = 1; i < route.length; i++) if (route[i] === route[i - 1]) repeats++;
    if (repeats) throw new Error('подряд одинаковых: ' + repeats);
  });
}

console.log(fail ? `\nЕСТЬ ПРОВАЛЫ: ${ok}/${ok + fail}` : `\nВСЁ ЗЕЛЕНО: ${ok}/${ok} проверок пройдено`);
process.exit(fail ? 1 : 0);
