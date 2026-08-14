// Проверка определения зоны по трафику. Работает на ЗАПИСИ настоящего потока
// (albiondata-client -record), а не на выдуманных байтах: смысл проверки в том,
// что мы понимаем реальный поток игры, а придуманный буфер этого не доказывает.
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

console.log('\n=== таблица кластеров ===');
t('в таблице и Авалон, и мир', () => {
  const ids = Object.keys(cluster.IDS);
  const tnl = ids.filter(x => x.startsWith('TNL-')).length;
  const num = ids.filter(x => /^\d{4}$/.test(x)).length;
  eq(tnl, 400, 'туннелей');
  if (num < 400) throw new Error('зон мира всего ' + num);
});
t('известные id дают известные имена', () => {
  eq(cluster.IDS['0007'], 'Thetford Market', 'Thetford');
  eq(cluster.IDS['5003'], 'Brecilien Market', 'Brecilien');
});

console.log('\n=== разбор пакета ===');
t('один id — зона определяется', () => {
  const r = cluster.pickCluster(Buffer.from('\x00\x01TNL-235\x00'));
  eq(r && r.zone, 'Tasitos-Obayam', 'зона');
  eq(r && r.avalon, true, 'авалон');
});
t('зона мира числом', () => {
  const r = cluster.pickCluster(Buffer.from('\x00 4208 \x00'));
  eq(r && r.zone, 'Mawar Gorge', 'зона');
  eq(r && r.avalon, false, 'не авалон');
});
// Ради этого проверка и заведена: список соседей приходит от opSubscribeToCluster
// и выглядит точно так же, как настоящая смена зоны.
t('список соседей не принимается за смену зоны', () => {
  eq(cluster.pickCluster(Buffer.from('TNL-235 TNL-117 TNL-083')), null, 'должен быть null');
});
t('мусор без id — молчание', () => {
  eq(cluster.pickCluster(Buffer.from('\x01\x02\x03')), null, 'должен быть null');
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
t('сообщает только о СМЕНЕ зоны, а не о каждом пакете', () => {
  const seen = [];
  const w = watch.create({ onZone: z => seen.push(z.zone) });
  w.feed(Buffer.from('TNL-235'));
  w.feed(Buffer.from('TNL-235'));
  w.feed(Buffer.from('TNL-235'));
  w.feed(Buffer.from('TNL-083'));
  eq(seen.join(' -> '), 'Tasitos-Obayam -> Souos-Umogaum', 'переходы');
});
t('список соседей не двигает зону', () => {
  const seen = [];
  const w = watch.create({ onZone: z => seen.push(z.zone) });
  w.feed(Buffer.from('TNL-235'));
  w.feed(Buffer.from('TNL-117 TNL-083 TNL-244'));
  eq(seen.length, 1, 'переходов');
});
t('зона мира — такой же переход', () => {
  const seen = [];
  const w = watch.create({ onZone: z => seen.push(z.zone) });
  w.feed(Buffer.from(' 4208 '));
  eq(seen[0], 'Mawar Gorge', 'зона');
});

console.log('\n=== настоящая запись потока ===');
if (!fs.existsSync(REC)) {
  console.log('  записи нет (' + REC + ') — пропуск');
} else {
  const buf = fs.readFileSync(REC);
  const found = cluster.findCandidates(buf);
  const uniq = [...new Set(found)];
  const zones = uniq.map(id => cluster.IDS[id]);
  console.log('  найдено id:', uniq.length, '→', zones.join(', '));
  t('в записи опознаны зоны Авалона', () => {
    const av = uniq.filter(x => x.startsWith('TNL-'));
    if (!av.length) throw new Error('ни одного TNL');
  });
  t('каждый найденный id есть в таблице', () => {
    for (const id of uniq) if (!cluster.IDS[id]) throw new Error('нет в таблице: ' + id);
  });
}

console.log(fail ? `\nЕСТЬ ПРОВАЛЫ: ${ok}/${ok + fail}` : `\nВСЁ ЗЕЛЕНО: ${ok}/${ok} проверок пройдено`);
process.exit(fail ? 1 : 0);
