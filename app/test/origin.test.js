// К какой зоне привязывается найденный портал. Главный случай здесь — тот, что поймал
// игрок вживую: прошёл A → B, в B проверил портал в C, а на карте появилось ребро A ⇄ C.
const { decide, createParking, FRESH_MS, PARK_TTL_MS } = require('../lib/origin');

let ok = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '\n           ', e.message); fail++; }
}
function eq(a, b, what) { if (a !== b) throw new Error(`${what}: получил ${JSON.stringify(a)}, ждал ${JSON.stringify(b)}`); }

const NOW = 1800000000000;

console.log('\n=== откуда портал ===');

t('плашка прочиталась сейчас — берём её, а не память', () => {
  const d = decide({ zoneNow: 'B', currentZone: 'A', seenAt: NOW - 1000, now: NOW });
  eq(d.origin, 'B', 'зона');
  eq(d.park, false, 'не откладываем');
});

t('плашка не прочиталась, но зону подтверждали только что — верим ей', () => {
  const d = decide({ zoneNow: null, currentZone: 'A', seenAt: NOW - 3000, now: NOW });
  eq(d.origin, 'A', 'зона');
  eq(d.park, false, 'не откладываем');
});

t('ТОТ САМЫЙ СЛУЧАЙ: зону давно не подтверждали — портал откладываем', () => {
  // игрок ушёл из A через портал, плашку с тех пор не прочитали ни разу
  const d = decide({ zoneNow: null, currentZone: 'A', seenAt: NOW - 60000, now: NOW });
  eq(d.origin, null, 'к A не привязываем');
  eq(d.park, true, 'откладываем до распознавания зоны');
});

// Плашку сняли вместе с тултипом и не прочитали. Тултип на экране есть — значит игра
// отрисована и плашка на месте, читаться она обязана. Не прочиталась — мы не знаем, где
// стоим, а помним старую зону ещё пару секунд после входа в новую (опрос меняет её со
// второго чтения). Это последнее место, где ребро уезжало в карту из НЕ ТОЙ зоны молча.
t('плашку сняли вместе с тултипом и не прочитали — откладываем, даже если зона свежая', () => {
  const d = decide({ zoneNow: null, zoneTried: true, currentZone: 'A', seenAt: NOW - 1000, now: NOW });
  eq(d.origin, null, 'к A не привязываем');
  eq(d.park, true, 'откладываем до чтения плашки');
});

t('плашку не снимали (окно поиска) — свежей зоне верим как раньше', () => {
  const d = decide({ zoneNow: null, zoneTried: false, currentZone: 'A', seenAt: NOW - 1000, now: NOW });
  eq(d.origin, 'A', 'зона');
  eq(d.park, false, 'не откладываем');
});

t('прочитанная плашка сильнее флага: zoneTried не мешает zoneNow', () => {
  const d = decide({ zoneNow: 'B', zoneTried: true, currentZone: 'A', seenAt: NOW - 1000, now: NOW });
  eq(d.origin, 'B', 'берём прочитанную зону');
  eq(d.park, false, 'ждать нечего');
});

t('слежение выключено — zoneTried ничего не меняет', () => {
  const d = decide({ zoneNow: null, zoneTried: true, currentZone: 'A', watching: false, now: NOW });
  eq(d.origin, 'A', 'верим заданной вручную зоне');
  eq(d.park, false, 'плашку читать некому — ждать нечего');
});

t('граница доверия ровно по FRESH_MS', () => {
  eq(decide({ currentZone: 'A', seenAt: NOW - FRESH_MS + 500, now: NOW }).park, false, 'чуть свежее — верим');
  eq(decide({ currentZone: 'A', seenAt: NOW - FRESH_MS - 500, now: NOW }).park, true, 'чуть старее — откладываем');
});

t('зона не известна вовсе — откладываем', () => {
  eq(decide({ zoneNow: null, currentZone: null, now: NOW }).park, true, 'первый запуск');
});

// Находка ультраревью: проверка !currentZone стояла раньше !watching, и портал уезжал
// «ждать плашку зоны», которую при выключенном слежении никто никогда не прочитает —
// отложенное разбирается только из опроса. На пятом нажатии PARK_MAX вытеснял первый.
t('слежение выключено и зона не задана — НЕ откладываем: ждать нечего', () => {
  const d = decide({ zoneNow: null, currentZone: null, watching: false, now: NOW });
  eq(d.park, false, 'откладывать некуда — плашку читать некому');
  eq(d.origin, null, 'начала нет');
  eq(d.ask, true, 'просим игрока назвать зону');
});

console.log('\n=== слежение выключено ===');

t('слежение выключено — верим заданной вручную зоне, сколько бы ни прошло', () => {
  const d = decide({ zoneNow: null, currentZone: 'A', seenAt: NOW - 3600000, watching: false, now: NOW });
  eq(d.origin, 'A', 'зона');
  eq(d.park, false, 'ждать нечего — плашку никто не читает');
});

// Зона из трафика. Там приходит СОБЫТИЕ на каждый переход, поэтому молчание источника
// само по себе подтверждает зону. Свежесть здесь мерить нечем и не нужно: игрок может
// час фармить одну зону, и всё это время мы точно знаем, где он.
console.log('\n=== зона из трафика (expires: false) ===');

t('зона не устаревает — верим и через час', () => {
  const d = decide({ zoneNow: null, currentZone: 'A', seenAt: NOW - 3600000, expires: false, now: NOW });
  eq(d.origin, 'A', 'зона');
  eq(d.park, false, 'откладывать нечего');
});

t('этот же случай с экраном — откладываем', () => {
  const d = decide({ zoneNow: null, currentZone: 'A', seenAt: NOW - 3600000, now: NOW });
  eq(d.park, true, 'у экрана давняя зона недостоверна');
});

t('плашку сняли и не прочитали — трафику это безразлично', () => {
  const d = decide({ zoneNow: null, zoneTried: true, currentZone: 'A', expires: false, now: NOW });
  eq(d.origin, 'A', 'зона из трафика, а не с плашки');
  eq(d.park, false, 'не откладываем');
});

t('прочитанная плашка всё равно сильнее', () => {
  eq(decide({ zoneNow: 'B', currentZone: 'A', expires: false, now: NOW }).origin, 'B', 'зона');
});

// Трафик сообщает о СМЕНЕ зоны, а не о том, где игрок стоит. Пока перехода не было,
// зоны нет вовсе — и выдумывать её нельзя, даже что «наверное, там же, где и раньше».
t('до первого перехода зоны нет — откладываем, а не выдумываем', () => {
  const d = decide({ zoneNow: null, currentZone: null, expires: false, now: NOW });
  eq(d.park, true, 'ждём первого перехода');
  eq(d.origin, null, 'начала нет');
});

t('источник выключён — правило важнее трафика', () => {
  const d = decide({ currentZone: null, watching: false, expires: false, now: NOW });
  eq(d.ask, true, 'просим игрока назвать зону');
  eq(d.park, false, 'ждать нечего');
});

// Источник зоны → что делать. Правило дважды выводилось «по месту» в main.js и дважды
// выходило боком; последний раз — слепота при запуске в режиме трафика.
console.log('\n=== план по источнику зоны ===');
const { zonePlan } = require('../lib/origin');

t('экран: читаем плашку, зона устаревает', () => {
  const p = zonePlan({ source: 'screen' });
  eq(p.readsScreen, true, 'читаем экран');
  eq(p.expires, true, 'устаревает');
  eq(p.watching, true, 'следим');
});

// ТОТ САМЫЙ СЛУЧАЙ: игрок перезапустил приложение стоя в зоне, через 22 секунды нажал
// хоткей — и получил «жду, откуда портал». Трафик молчит до ПЕРЕХОДА, а экран не читался.
t('трафик поднялся, но зону ещё не называл — экран подстраховывает', () => {
  const p = zonePlan({ source: 'traffic', trafficLive: true, zoneFromTraffic: false });
  eq(p.readsScreen, true, 'читаем экран, пока трафик молчит');
  eq(p.expires, true, 'зона с экрана устаревает как обычно');
});

t('трафик назвал зону — экран умолкает, зона не устаревает', () => {
  const p = zonePlan({ source: 'traffic', trafficLive: true, zoneFromTraffic: true });
  eq(p.readsScreen, false, 'экран больше не снимаем');
  eq(p.expires, false, 'зона из трафика бессрочна');
});

// Нет прав администратора — сокет не открылся. Оставить игрока слепым нельзя.
t('трафик выбран, но не поднялся — работаем как экран', () => {
  const p = zonePlan({ source: 'traffic', trafficLive: false, zoneFromTraffic: false });
  eq(p.readsScreen, true, 'читаем экран');
  eq(p.expires, true, 'и зона устаревает');
});

// Страховка от рассинхрона: «трафик вёл зону» без живого сокета доверия не даёт.
t('сокет отвалился — прежней зоне из трафика больше не верим бессрочно', () => {
  const p = zonePlan({ source: 'traffic', trafficLive: false, zoneFromTraffic: true });
  eq(p.expires, true, 'устаревает');
  eq(p.readsScreen, true, 'и снова читаем экран');
});

t('вручную: экран не читаем, но зона и не устаревает', () => {
  const p = zonePlan({ source: 'off' });
  eq(p.readsScreen, false, 'не читаем');
  eq(p.watching, false, 'не следим');
});

t('план и decide сходятся: с планом трафика портал не откладывается', () => {
  const p = zonePlan({ source: 'traffic', trafficLive: true, zoneFromTraffic: true });
  const d = decide({ currentZone: 'A', seenAt: NOW - 3600000, now: NOW, expires: p.expires, watching: p.watching });
  eq(d.origin, 'A', 'зона');
  eq(d.park, false, 'не откладываем');
});

console.log('\n=== прочее ===');

t('причина всегда объяснена словами', () => {
  for (const args of [{ zoneNow: 'B' }, { currentZone: 'A', seenAt: NOW - 1000, now: NOW }, {}]) {
    if (!decide(args).why) throw new Error('нет объяснения для ' + JSON.stringify(args));
  }
});

console.log('\n=== отложенные порталы ===');

t('дождался зоны — отдаётся на запись', () => {
  const p = createParking();
  p.park({ name: 'C' }, NOW);
  const { ready, lost } = p.take(NOW + 2000);
  eq(ready.length, 1, 'готов к записи');
  eq(ready[0].name, 'C', 'тот самый портал');
  eq(lost.length, 0, 'потерь нет');
  eq(p.size(), 0, 'стоянка пуста');
});

t('не дождался — считается потерянным, а не пишется наугад', () => {
  const p = createParking();
  p.park({ name: 'C' }, NOW);
  const { ready, lost } = p.take(NOW + PARK_TTL_MS + 1000);
  eq(ready.length, 0, 'на запись ничего');
  eq(lost.length, 1, 'о потере скажут вслух');
});

t('несколько порталов подряд в одной зоне — записываются все', () => {
  const p = createParking();
  p.park({ name: 'C' }, NOW);
  p.park({ name: 'D' }, NOW + 1000);
  p.park({ name: 'E' }, NOW + 2000);
  eq(p.take(NOW + 3000).ready.length, 3, 'все три');
});

t('протухшие выбрасываются и без прихода зоны', () => {
  const p = createParking();
  p.park({ name: 'C' }, NOW);
  p.park({ name: 'D' }, NOW + PARK_TTL_MS);
  const lost = p.expire(NOW + PARK_TTL_MS + 100);
  eq(lost.length, 1, 'протух только первый');
  eq(p.size(), 1, 'второй ещё ждёт');
});

t('стоянка не растёт бесконечно', () => {
  const p = createParking({ max: 2 });
  p.park({ name: 'A' }, NOW); p.park({ name: 'B' }, NOW); p.park({ name: 'C' }, NOW);
  const { ready } = p.take(NOW + 1000);
  eq(ready.length, 2, 'держим только последние');
  eq(ready[0].name, 'B', 'самый старый вытеснен');
});

// Вытеснение раньше происходило молча, хотя игроку уже пообещали «запишу, как только
// пойму». Это худший вид потери: игрок не переснимет портал, считая его записанным.
t('вытесненный портал возвращается наружу, а не пропадает молча', () => {
  const p = createParking({ max: 2 });
  eq(p.park({ name: 'A' }, NOW).dropped.length, 0, 'место есть — никого не теряем');
  eq(p.park({ name: 'B' }, NOW).size, 2, 'сколько ждёт');
  const r = p.park({ name: 'C' }, NOW);
  eq(r.dropped.length, 1, 'о вытеснении сообщено');
  eq(r.dropped[0].name, 'A', 'вытеснен самый старый — его и называем');
});

console.log(`\n${fail ? 'ЕСТЬ ПРОВАЛЫ' : 'ВСЁ ЗЕЛЕНО'}: ${ok}/${ok + fail} проверок пройдено`);
process.exit(fail ? 1 : 0);
