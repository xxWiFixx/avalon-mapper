'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create, warningMinutes } = require('../lib/food-buff');
const catalog = require('../assets/food-effects.json').effects;
const entries = Object.entries(catalog).filter(([, e]) => e.duration >= 120000);
const [short, long] = [entries.find(([, e]) => e.duration === 120000) || entries[0],
  entries.find(([, e]) => e.duration === 1800000) || entries[1]];
const ticks = ms => (BigInt(ms + 62135596800000) * 10000n).toString();

test('food reminder tracks only own confirmed effects and uses the original buff start', () => {
  let clock = 1_800_000_000_000;
  const food = create({ now: () => clock });
  food.join(42, clock);
  const id = Number(long[0]), duration = long[1].duration;
  const started = clock - duration + 90_000;
  food.observe({ 0: 99, 1: [id], 4: [ticks(started)] });
  assert.equal(food.snapshot(1).known, false);
  food.observe({ 0: 42, 1: [id], 4: [ticks(started)] });
  assert.equal(food.snapshot(1).remainingMs, 90_000);
  clock += 11_000;
  assert.equal(food.snapshot(1).warning, false);
  clock += 20_000;
  assert.equal(food.snapshot(1).warning, true);
  clock += 100_000;
  assert.equal(food.snapshot(1).alert, 'missing', 'expired food must not remain active while waiting for the next effect update');
  food.observe({ 0: 42, 1: [] });
  assert.equal(food.snapshot(1).warning, false, 'an empty loading frame is not proof');
  food.observe({ 0: 42, 1: [id], 4: [ticks(started)] });
  assert.equal(food.snapshot(1).warning, true);
  food.join(43, clock);
  assert.equal(food.snapshot(1).warning, false, 'a new zone waits for its own effect list');
  food.observe({ 0: 43, 1: [999], 4: [ticks(clock)] });
  assert.equal(food.snapshot(1).warning, false, 'zone loading must settle before no-food alert');
  clock += 10_000;
  assert.equal(food.snapshot(1).alert, 'missing');
});

test('long meal wins over a short secondary food effect; settings are bounded', () => {
  const clock = 1_800_000_000_000;
  const food = create({ now: () => clock });
  food.join(7, clock - 11_000);
  food.observe({ 0: 7, 1: [Number(short[0]), Number(long[0])],
    4: [ticks(clock - 1000), ticks(clock - long[1].duration + 50_000)] });
  assert.equal(food.snapshot(1).food.id, Number(long[0]));
  assert.equal(food.snapshot(1).warning, true);
  assert.equal(warningMinutes(300), 30);
  assert.equal(warningMinutes(-1), 1);
  assert.equal(warningMinutes('garbage'), 1);
  food.disconnect();
  assert.equal(food.snapshot(1).known, false);
});
