const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNameMatcher, isCompleteTimer, timerConflict, selectTimerReread } = require('../lib/recognition-confidence');

test('a clear exact name is retained without requiring additional OCR evidence', () => {
  const matcher = createNameMatcher(['Touos-Ataglos', 'Touos-Utaglos', 'Quaent-Vynsum']);
  const ranked = matcher.rank('  TOUOS-ATAGLOS\n');
  assert.equal(ranked.match.name, 'Touos-Ataglos');
  assert.equal(ranked.exact, true);
  assert.equal(ranked.ambiguous, false);
  assert.equal(matcher.resolve(['Touos-Ataglos', 'Quaent-Vynsum']).name, 'Touos-Ataglos');
});

test('dictionary order cannot select a winner for equally plausible names', () => {
  const names = ['Touos-Ataglos', 'Touos-Utaglos'];
  for (const dictionary of [names, [...names].reverse()]) {
    const matcher = createNameMatcher(dictionary);
    const ranked = matcher.rank('Touos-Otaglos');
    assert.equal(ranked.ambiguous, true);
    assert.equal(ranked.match, null);
    assert.equal(ranked.best.name, 'Touos-Ataglos');
    assert.equal(ranked.runnerUp.name, 'Touos-Utaglos');
    assert.equal(ranked.gap, 0);
    assert.equal(matcher.resolve(['Touos-Otaglos', 'Touos-Etaglos']), null);
  }
});

test('an explicit rereading resolves a tied name, while conflicting exact rereadings do not', () => {
  const matcher = createNameMatcher(['Touos-Ataglos', 'Touos-Utaglos']);
  assert.equal(matcher.resolve(['Touos-Otaglos', 'Touos-Utaglos']).name, 'Touos-Utaglos');
  assert.equal(matcher.resolve(['Touos-Otaglos', 'Touos-Utaglos', 'Touos-Ataglos']), null);
});

test('two agreeing noisy rereadings can resolve an ambiguous first name', () => {
  const matcher = createNameMatcher(['Touos-Ataglos', 'Touos-Utaglos']);
  const match = matcher.resolve(['Touos-Otaglos', 'Tuos-Ataglos', 'Touos-Ataglo']);
  assert.equal(match.name, 'Touos-Ataglos');
  assert.ok(match.score > 0);
  assert.equal(matcher.resolve(['Touos-Otaglos', 'Tuos-Ataglos', 'Touos-Utaglo']), null);
});

test('a weak name needs confirmation even without a close runner-up', () => {
  const matcher = createNameMatcher(['Touos-Ataglos', 'Quaent-Vynsum']);
  const ranked = matcher.rank('Txxos-Ataglx');
  assert.ok(ranked.match.score > 0.2);
  assert.equal(ranked.ambiguous, true);
  assert.equal(matcher.resolve(['Txxos-Ataglx']), null);
  assert.equal(matcher.resolve(['Txxos-Ataglx', 'Touos-Ataglos']).name, 'Touos-Ataglos');
});

test('unreadable and short names cannot produce confident matches', () => {
  const matcher = createNameMatcher(['Touos-Ataglos', 'Quaent-Vynsum']);
  for (const raw of ['', 'x', '12345678', 'zzzzzzzzzzzzzzzzzz']) {
    assert.equal(matcher.rank(raw).match, null);
    assert.equal(matcher.resolve([raw, raw]), null);
  }
  assert.equal(matcher.resolve([]), null);
  assert.equal(createNameMatcher([]).rank('Touos-Ataglos').match, null);
});

const hours = (h, m) => h * 3600 + m * 60;
const vote = (closes, options = {}) => ({ closes, quality: 2, marker: false, ...options });

test('conflicts are detected before dropped digits and duplicated hour glyphs are merged', () => {
  assert.equal(timerConflict([vote(hours(7, 44)), vote(hours(17, 44))]), true);
  assert.equal(timerConflict([vote(hours(1, 59)), vote(hours(14, 59))]), true);
  assert.equal(timerConflict([vote(hours(17, 44)), vote(hours(17, 44))]), false);
  assert.equal(timerConflict([vote(hours(17, 44)), vote(3 * 60, { quality: 1 })]), false);
  assert.equal(timerConflict([vote(null), vote(NaN), vote(-1), vote(24 * 3600 + 1)]), false);
});

test('targeted evidence can confirm either side instead of always preferring a larger timer', () => {
  const low = hours(7, 44), high = hours(17, 44);
  const originals = [vote(low), vote(high)];
  assert.equal(selectTimerReread(originals, [vote(low), vote(low)], high), low);
  assert.equal(selectTimerReread(originals, [vote(high), vote(high)], low), high);
  const one = hours(1, 59), fourteen = hours(14, 59);
  assert.equal(selectTimerReread([vote(one), vote(fourteen)], [vote(fourteen), vote(fourteen)], one), fourteen);
});

test('inconclusive targeted OCR preserves existing timer repair behavior', () => {
  const low = hours(1, 59), high = hours(14, 59), originals = [vote(low), vote(high)];
  for (const rereads of [[], [vote(high)], [vote(high), vote(low)],
    [vote(high, { quality: 1 }), vote(high, { quality: 1 })]]) {
    assert.equal(selectTimerReread(originals, rereads, low), low);
  }
  assert.equal(selectTimerReread([vote(low), vote(low)], [vote(high), vote(high)], low), low);
});

test('new targeted durations require an explicit closing label', () => {
  const originals = [vote(hours(1, 59)), vote(hours(14, 59))];
  const fallback = hours(1, 59), corrected = hours(11, 59);
  assert.equal(selectTimerReread(originals, [vote(corrected), vote(corrected)], fallback), fallback);
  assert.equal(selectTimerReread(originals, [vote(corrected, { marker: true }), vote(corrected)], fallback), corrected);
});

test('complete single-unit timers participate in conflicts and targeted confirmation', () => {
  const single = (closes, evidenceKey) => vote(closes, { quality: 1, complete: true, unit: 's', evidenceKey });
  assert.equal(isCompleteTimer(single(59)), true);
  assert.equal(isCompleteTimer(vote(59, { quality: 1, complete: false })), false);
  assert.equal(isCompleteTimer(vote(59)), true, 'older two-unit votes remain compatible');
  const originals = [single(5), single(15)];
  assert.equal(timerConflict(originals), true);
  assert.equal(selectTimerReread(originals, [single(5, 'digits:normal'), single(5, 'digits:threshold')], 15), 5);
  assert.equal(timerConflict([single(59), vote(3599)]), true, 'unit count cannot suppress a conflicting complete timer');
});

test('repeated identical or internally contradictory processing cannot manufacture independent timer evidence', () => {
  const originals = [vote(5), vote(15)];
  const same = vote(5, { evidenceKey: 'same-crop-and-preprocessing' });
  assert.equal(selectTimerReread(originals, [same, { ...same }], 15), 15);
  assert.equal(selectTimerReread(originals, [same, { ...same, closes: 15 }, vote(5, { evidenceKey: 'other' })], 15), 15);
  assert.equal(selectTimerReread(originals, [vote(5, { complete: false }), vote(5, { complete: false })], 15), 15);
});
