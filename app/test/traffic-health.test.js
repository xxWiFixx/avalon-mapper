// Проверка сторожа слушателя трафика (lib/traffic-health.js).
//
// Ради чего заведена. Игрок час простоял в одной зоне, и приложение всё это время
// считало его там же; вернул зону к жизни только ПЕРЕЗАПУСК приложения — значит сокет
// умер насовсем, а не пропустил один переход. Проверки ниже держат два правила, которые
// легко перепутать и тем сломать: молчание ПАКЕТОВ при живой игре — смерть, а молчание
// ПЕРЕХОДОВ (игрок фармит одну зону часами) — норма, и трогать сокет из-за него нельзя.
'use strict';
const { createHealth, SILENCE_MS } = require('../lib/traffic-health');

let ok = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('  ОК     ', name); ok++; }
  catch (e) { console.log('  ПРОВАЛ ', name, '—', e.message); fail++; } };
const eq = (a, b, what) => { if (a !== b) throw new Error(`${what}: ${a} ≠ ${b}`); };

console.log('\n=== живой сокет не трогаем ===');
t('пакеты идут — всё хорошо, сколько бы времени ни прошло', () => {
  const h = createHealth();
  let now = 0, packets = 0;
  for (let i = 0; i < 100; i++) {
    now += 15000; packets += 500;
    eq(h.tick({ packets, gameRunning: true, now }), 'ok', 'тик ' + i);
  }
});
t('игрок час стоит в одной зоне — переходов нет, но пакеты идут: не трогаем', () => {
  const h = createHealth();
  let now = 0, packets = 0;
  // час игры без единой смены зоны — ровно тот случай, из-за которого всё началось
  for (let i = 0; i < 240; i++) {
    now += 15000; packets += 300;
    eq(h.tick({ packets, gameRunning: true, now }), 'ok', 'минута ' + (i / 4));
  }
});

console.log('\n=== молчание при запущенной игре ===');
t('счётчик стоит дольше порога — воскрешаем', () => {
  const h = createHealth();
  let now = 0;
  eq(h.tick({ packets: 100, gameRunning: true, now }), 'ok', 'первый тик');
  now += SILENCE_MS - 1000;
  eq(h.tick({ packets: 100, gameRunning: true, now }), 'ok', 'ещё рано');
  now += 2000;
  eq(h.tick({ packets: 100, gameRunning: true, now }), 'revive', 'пора');
});
t('короткая тишина (загрузка зоны, свёрнутая игра) — терпим', () => {
  const h = createHealth();
  let now = 0;
  h.tick({ packets: 10, gameRunning: true, now });
  for (let i = 0; i < 5; i++) {   // 75 секунд тишины — меньше порога
    now += 15000;
    eq(h.tick({ packets: 10, gameRunning: true, now }), 'ok', 'тик ' + i);
  }
});
t('после воскрешения счёт тишины идёт заново, а не срабатывает каждый тик', () => {
  const h = createHealth();
  let now = 0;
  h.tick({ packets: 5, gameRunning: true, now });
  now += SILENCE_MS + 1000;
  eq(h.tick({ packets: 5, gameRunning: true, now }), 'revive', 'первый приговор');
  now += 15000;
  eq(h.tick({ packets: 5, gameRunning: true, now }), 'ok', 'сразу второй — нельзя');
  now += SILENCE_MS + 1000;
  eq(h.tick({ packets: 5, gameRunning: true, now }), 'revive', 'снова замолчал — снова чиним');
});

console.log('\n=== игра не запущена ===');
t('без игры тишина законна — не воскрешаем', () => {
  const h = createHealth();
  let now = 0;
  for (let i = 0; i < 100; i++) {
    now += 15000;
    eq(h.tick({ packets: 7, gameRunning: false, now }), 'ok', 'тик ' + i);
  }
});
// Игрок закрыл игру на ночь и утром запустил снова. Если бы часы тишины шли и без игры,
// первый же тик объявил бы живой сокет мёртвым и дёрнул его на ровном месте.
t('после долгого перерыва без игры первый тик с игрой не считается смертью', () => {
  const h = createHealth();
  let now = 0;
  h.tick({ packets: 7, gameRunning: false, now });
  now += 8 * 3600 * 1000;                                   // восемь часов
  eq(h.tick({ packets: 7, gameRunning: false, now }), 'ok', 'ещё без игры');
  now += 15000;
  eq(h.tick({ packets: 7, gameRunning: true, now }), 'ok', 'игра только что запущена');
});
t('reset() начинает счёт тишины заново', () => {
  const h = createHealth();
  let now = 0;
  h.tick({ packets: 1, gameRunning: true, now });
  now += SILENCE_MS - 1000;
  h.reset(now);
  now += 2000;                                              // от reset прошло 2 с
  eq(h.tick({ packets: 1, gameRunning: true, now }), 'ok', 'после reset рано');
});

console.log(fail ? `\nЕСТЬ ПРОВАЛЫ: ${ok}/${ok + fail}` : `\nВСЁ ЗЕЛЕНО: ${ok}/${ok} проверок пройдено`);
process.exit(fail ? 1 : 0);
