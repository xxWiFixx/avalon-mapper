const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProfiles } = require('../lib/recognition-profiles');

const frame = { width: 1440, height: 700 };
const bar = { span: 258, bh: 11, scale: 1, fill: 95 };
const hint = { region: 'digits', prep: 1 };

test('scale hints are isolated by effective screen height and captured frame dimensions', () => {
  const profiles = createProfiles();
  assert.equal(profiles.getScale(frame, 1080), undefined);
  assert.equal(profiles.rememberScale(frame, 1080, 1), true);
  assert.equal(profiles.getScale(frame, 1080), 1);
  assert.equal(profiles.getScale(frame, 1180), undefined);
  assert.equal(profiles.getScale({ ...frame, width: 1400 }, 1080), undefined);
  assert.equal(profiles.getScale({ ...frame, height: 720 }, 1080), undefined);
  profiles.rememberScale(frame, 0, 0.9);
  assert.equal(profiles.getScale(frame), 0.9);
  assert.equal(profiles.getScale(frame, frame.height), 0.9);
  assert.equal(profiles.getScale(frame, 1080), 1);
});

test('capacity hints follow measured UI size and dark, mixed, or full bar polarity', () => {
  const profiles = createProfiles();
  assert.equal(profiles.rememberCapacity(frame, 1080, bar, hint), true);
  assert.deepEqual(profiles.getCapacity(frame, 1080, bar), hint);
  assert.deepEqual(profiles.getCapacity(frame, 1080, { ...bar, fill: 125 }), hint);
  for (const changed of [{ span: 285 }, { bh: 12 }, { scale: 1.1 }, { fill: 0 }, { fill: 195 }]) {
    assert.equal(profiles.getCapacity(frame, 1080, { ...bar, ...changed }), undefined);
  }
  assert.equal(profiles.getCapacity(frame, 1180, bar), undefined);
  assert.equal(profiles.getCapacity({ ...frame, width: 1441 }, 1080, bar), undefined);
  assert.deepEqual(profiles.getCapacity(frame, 1080, { ...bar, span: 258.1, bh: 10.9, scale: 1.001 }), hint);
});

test('scale and capacity hints share a bounded LRU budget; access refreshes recency', () => {
  const profiles = createProfiles({ maxEntries: 2 });
  profiles.rememberScale(frame, 1080, 1);
  profiles.rememberScale(frame, 1180, 1.1);
  assert.equal(profiles.getScale(frame, 1080), 1); // Protect the actively used geometry.
  profiles.rememberCapacity(frame, 1080, bar, hint);
  assert.equal(profiles.getScale(frame, 1180), undefined);
  assert.equal(profiles.getScale(frame, 1080), 1);
  assert.deepEqual(profiles.getCapacity(frame, 1080, bar), hint);
  profiles.rememberCapacity(frame, 1080, bar, { region: 'center', prep: 2 });
  assert.equal(profiles.getScale(frame, 1080), 1); // Updating a key consumes no extra entry.
  assert.deepEqual(profiles.getCapacity(frame, 1080, bar), { region: 'center', prep: 2 });
});

test('the default cache evicts old geometry and clear invalidates every hint', () => {
  const profiles = createProfiles();
  for (let i = 0; i < 13; i++) profiles.rememberScale(frame, 1080 + i, 1);
  assert.equal(profiles.getScale(frame, 1080), undefined);
  assert.equal(profiles.getScale(frame, 1081), 1);
  profiles.rememberCapacity(frame, 1080, bar, hint);
  profiles.clear();
  assert.equal(profiles.getScale(frame, 1081), undefined);
  assert.equal(profiles.getCapacity(frame, 1080, bar), undefined);
});

test('profiles keep processing choices only, and reads or input mutation cannot modify cached hints', () => {
  const profiles = createProfiles();
  const source = { ...hint, name: 'Touos-Ataglos', capNum: 11, closes: 11340 };
  profiles.rememberCapacity({ ...frame, data: Buffer.alloc(10), portal: source }, 1080, { ...bar, name: source.name }, source);
  source.region = 'mutated';
  const first = profiles.getCapacity(frame, 1080, bar);
  assert.deepEqual(first, hint);
  first.prep = 99;
  assert.deepEqual(profiles.getCapacity(frame, 1080, { ...bar, name: 'Another portal' }), hint);
});

test('invalid geometry, scales and processing hints do not enter the cache', () => {
  const profiles = createProfiles();
  for (const scale of [0, 0.44, 4.01, NaN, Infinity, '1']) {
    assert.equal(profiles.rememberScale(frame, 1080, scale), false);
    assert.equal(profiles.rememberCapacity(frame, 1080, { ...bar, scale }, hint), false);
  }
  for (const invalidFrame of [null, {}, { width: 0, height: 700 }, { width: 1440, height: Infinity }]) {
    assert.equal(profiles.rememberScale(invalidFrame, 1080, 1), false);
    assert.equal(profiles.getScale(invalidFrame, 1080), undefined);
  }
  for (const screenHeight of [-1, NaN, Infinity, '1080']) {
    assert.equal(profiles.rememberScale(frame, screenHeight, 1), false);
  }
  for (const invalidBar of [null, {}, { ...bar, span: 0 }, { ...bar, bh: NaN }, { ...bar, fill: -1 }]) {
    assert.equal(profiles.rememberCapacity(frame, 1080, invalidBar, hint), false);
  }
  for (const invalidHint of [null, [], new Date(), {}, { region: '', prep: 1 },
    { region: 'a'.repeat(65), prep: 1 }, { region: 'digits\n', prep: 1 },
    { region: 'digits', prep: -1 }, { region: 'digits', prep: 1.5 }, { region: 'digits', prep: 256 }]) {
    assert.equal(profiles.rememberCapacity(frame, 1080, bar, invalidHint), false);
  }
  assert.equal(profiles.getScale(frame, 1080), undefined);
  assert.equal(profiles.getCapacity(frame, 1080, bar), undefined);
  assert.equal(profiles.rememberScale(frame, 1080, 0.45), true);
  assert.equal(profiles.rememberScale(frame, 1080, 4), true);
});
