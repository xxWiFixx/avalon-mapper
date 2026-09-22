const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normDigits, parseDur, allDurations, parseBottom, sameNumber, MAX_HOURS } = require('../lib/portal-duration');

test('short timers with explicit units are complete, including zero and English seconds', () => {
  for (const [text, sec, unit] of [['59 с', 59, 's'], ['5м', 300, 'm'], ['1 ч', 3600, 'h'],
    ['1м', 60, 'm'], ['0с', 0, 's'], ['5s', 5, 's'], ['5 S', 5, 's'], ['5S', 5, 's'], ['59m', 3540, 'm']]) {
    const actual = parseDur(text);
    assert.equal(actual?.sec, sec, text);
    assert.equal(actual.complete, true, text);
    assert.equal(actual.unit, unit, text);
    assert.equal(actual.quality, 1, 'legacy quality remains the explicit unit count');
  }
  assert.equal(normDigits('5S'), '5S');
  assert.equal(parseDur('1O м').sec, 600);
  assert.equal(parseDur('S9 м').sec, 3540);
  assert.equal(parseDur('1S м').sec, 900);
});

test('minute and day boundaries remain exact and invalid pairs cannot become partial timers', () => {
  for (const [text, sec, unit] of [['0м59с', 59, 'ms'], ['59м59с', 3599, 'ms'], ['1ч0м', 3600, 'hm'],
    ['23ч59м', 86340, 'hm'], ['24ч00м', 86400, 'hm'], ['24ч', 86400, 'h']]) {
    const actual = parseDur(text);
    assert.equal(actual.sec, sec, text);
    assert.equal(actual.complete, true);
    assert.equal(actual.unit, unit);
  }
  assert.equal(MAX_HOURS, 24);
  for (const text of ['24ч24м', '25ч00м', '30ч', '1ч60м', '60м0с', '5м60с', '60с', '60м', '-1с', '1.5м',
    '-1м59с', '1.5м59с', '5ч-1м', '1ч5.5м']) {
    assert.equal(parseDur(text), null, text);
    assert.equal(allDurations(text).length, 0, text);
  }
});

test('missing units and dangling digits are rejected instead of shortening the timer', () => {
  for (const text of ['5 59 с', '5 м 59', 'Закроется через5 59с', 'через 5 59 s', '5 м 59 хвост', '59', '1 ч 5', '1 5 м',
    'ч5 м', 'Закроется через10 Ч ОТ M']) {
    assert.equal(parseDur(text), null, text);
    assert.deepEqual(allDurations(text), [], text);
  }
});

test('established noisy label and fused-hour recovery survive with explicit confidence metadata', () => {
  for (const text of ['Закроется через 5ч36м', 'ссч5Ч36м', '3ч 5Ч36м', 'через 5y36м']) {
    assert.equal(parseDur(text)?.sec, 20160, text);
    assert.equal(parseDur(text).complete, true);
  }
  for (const [text, sec] of [['2424 м', 8640], ['524м', 19440], ['10401м', 36060], ['19453м', 71580]]) {
    const actual = parseDur(text);
    assert.equal(actual?.sec, sec);
    assert.equal(actual.complete, false);
    assert.equal(actual.quality, 1);
    assert.equal(allDurations(text)[0].sec, sec);
  }
});

test('duplicated red timer unit glyphs stay one unit and preserve all visible numbers', () => {
  for (const text of ['1Мм16сС', '1Мм 16 С', '1Мм 16С']) {
    assert.equal(parseDur(text)?.sec, 76, text);
    assert.equal(parseDur(text)?.complete, true, text);
  }
  assert.equal(parseDur('5ч48 Мм')?.sec, 20880);
  assert.equal(parseDur('4 чЧ11 м')?.sec, 15060);
  assert.equal(parseDur('сс ч5Ч36м')?.sec, 20160);
  assert.equal(parseDur('сс ч19ч53м')?.sec, 71580);
  assert.equal(parseBottom('Х можно использовать3м49с X зокроется нерез4ч11Мм уч').closes, 15060);
  assert.equal(parseDur('24424м'), null);
  assert.equal(parseDur('25400м'), null);
});

test('closing labels distinguish the real expiry from the portal cooldown', () => {
  const both = parseBottom('Можно использовать 3 м 05 с Закроется через 59 с');
  assert.equal(both.canuse, 185);
  assert.equal(both.closes, 59);
  assert.equal(both.complete, true);
  assert.equal(both.marker, true);
  assert.equal(both.unit, 's');
  const cooldown = parseBottom('Можно использовать 3м05с');
  assert.equal(cooldown.canuse, 185);
  assert.equal(cooldown.closes, null);
  const broken = parseBottom('Можно использовать 3м05с Закроется через 5 59с');
  assert.equal(broken.canuse, 185);
  assert.equal(broken.closes, null);
  assert.equal(broken.complete, false);
  assert.equal(parseBottom('Можно использовать 5с Закроется через 24ч24м').closes, null);
  assert.equal(parseBottom('Closes in 5s').closes, 5);
  assert.equal(parseBottom('Закроется через 0с').closes, 0);
  assert.equal(parseBottom('3ч 5Ч36м').closes, 20160);
});

test('lost leading one repairs actual digits only, while the established doubled hour repair survives', () => {
  const H = (h, m) => h * 3600 + m * 60;
  for (const [lo, hi] of [[7, 17], [5 * 60, 15 * 60], [H(7, 44), H(17, 44)], [H(1, 5), H(1, 15)]]) {
    assert.equal(sameNumber(lo, hi), 'hi');
  }
  for (const [lo, hi] of [[49, 59], [15 * 60, 25 * 60], [H(10, 2), H(19, 53)], [H(1, 30), H(15, 30)], [5, 5], [15, 5]]) {
    assert.equal(sameNumber(lo, hi), null, `${lo}/${hi}`);
  }
  for (const [lo, hi] of [[H(1, 59), H(14, 59)], [H(2, 20), H(24, 20)], [H(2, 20), H(29, 20)]]) {
    assert.equal(sameNumber(lo, hi), 'lo');
  }
});
