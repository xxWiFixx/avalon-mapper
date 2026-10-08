'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { create, register } = require('../lib/overlay-capture');
test('OCR-only exclusion leaves the overlay visible to screen recording and ignores destroyed windows', () => {
  const window = { visible: true, protected: false, isDestroyed: () => false,
    setContentProtection(value) { this.protected = value; }, hide() { throw new Error('must remain visible'); } };
  register(window);
  assert.equal(window.protected, false); assert.equal(window.visible, true);
  register(null); register({ isDestroyed: () => true, setContentProtection() { throw new Error('destroyed'); } });
});

test('lingering display affinity is cleared without hiding or changing click-through', () => {
  const calls = [];
  const window = { visible: true, isDestroyed: () => false,
    setContentProtection: value => calls.push(['electron', value]), isContentProtected: () => true,
    hide() { throw new Error('must remain visible'); }, setIgnoreMouseEvents() { throw new Error('input mode must remain unchanged'); } };
  register(window, target => { assert.equal(target, window); calls.push(['native']); return true; });
  assert.deepEqual(calls, [['electron', false], ['native']]);
  assert.equal(window.visible, true);
  window.isContentProtected = () => false;
  register(window, () => { throw new Error('already cleared'); });
});

function tool(bounds, options = {}) {
  return { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    getBounds: () => bounds, hide: () => assert.fail('Capture hid an overlay'),
    show: () => assert.fail('Capture changed stream visibility'), ...options };
}
test('only overlapping visible windows use game capture, in physical coordinates on any monitor', async () => {
  const window = tool({ x: -100, y: 20, width: 40, height: 30 });
  const calls = [];
  const guard = create({ windows: () => [window], toPhysical: b => ({ x: b.x * 2, y: b.y * 2, width: b.width * 2, height: b.height * 2 }),
    captureWindow: rect => { calls.push(rect); return 'game'; } });
  const rect = { x: -190, y: 45, width: 20, height: 20 };
  assert.equal(await guard.run(rect, () => assert.fail('Overlay would enter the screenshot')), 'game');
  assert.deepEqual(calls, [rect]);
  assert.equal(await guard.run({ x: 0, y: 0, width: 10, height: 10 }, () => 'fast'), 'fast');
  window.isVisible = () => false;
  assert.equal(await guard.run(rect, () => 'fast'), 'fast');
  window.isVisible = () => true; window.isMinimized = () => true;
  assert.equal(await guard.run(rect, () => 'fast'), 'fast');
});

test('a tool appearing during a desktop capture forces a clean game frame; errors never hide it', async () => {
  let visible = false, release, busy = 0;
  const window = tool({ x: 0, y: 0, width: 20, height: 20 }, { isVisible: () => visible });
  const rect = { x: 0, y: 0, width: 20, height: 20 };
  const guard = create({ windows: () => [window], busy: delta => { busy += delta; }, captureWindow: () => 'game' });
  const result = guard.run(rect, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve)); visible = true; release('contaminated');
  assert.equal(await result, 'game'); assert.equal(busy, 0);
  const failing = create({ windows: () => [window], busy: delta => { busy += delta; },
    captureWindow: () => { throw new Error('game capture unavailable'); } });
  await assert.rejects(failing.run(rect, () => assert.fail('Unsafe fallback')), /unavailable/);
  assert.equal(busy, 0); assert.equal(window.isVisible(), true);
  window.isVisible = () => false;
  assert.equal(await failing.run(rect, () => 'fast'), 'fast', 'Failure does not poison the next capture');
});

test('concurrent captures serialize and release the queue after a failure', async () => {
  let busy = 0, release;
  const guard = create({ busy: delta => { busy += delta; } });
  const first = guard.run(null, () => new Promise(resolve => { release = resolve; }));
  let secondStarted = false;
  const second = guard.run(null, () => { secondStarted = true; assert.equal(busy, 1); throw new Error('failed'); });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(secondStarted, false); assert.equal(busy, 1);
  release(); await first;
  await assert.rejects(second, /failed/); assert.equal(busy, 0);
  assert.equal(await guard.run(null, () => 42), 42); assert.equal(busy, 0);
});
