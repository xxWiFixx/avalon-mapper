'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, resizeBounds } = require('../lib/metrics-window-controls');

test('all four corners resize with a fixed opposite corner, minimum dimensions and monitor edges', () => {
  const bounds = { x: 100, y: 100, width: 360, height: 288 }, area = { x: 0, y: 0, width: 1000, height: 800 };
  assert.deepEqual(resizeBounds(bounds, 50, 60, 'se', area), { x: 100, y: 100, width: 410, height: 348 });
  assert.deepEqual(resizeBounds(bounds, -50, -60, 'nw', area), { x: 50, y: 40, width: 410, height: 348 });
  assert.deepEqual(resizeBounds(bounds, 50, -60, 'ne', area), { x: 100, y: 40, width: 410, height: 348 });
  assert.deepEqual(resizeBounds(bounds, -50, 60, 'sw', area), { x: 50, y: 100, width: 410, height: 348 });
  assert.deepEqual(resizeBounds(bounds, 9999, 9999, 'nw', area), { x: 180, y: 248, width: 280, height: 140 });
  assert.deepEqual(resizeBounds(bounds, 9999, 9999, 'se', area), { x: 100, y: 100, width: 900, height: 700 });
  assert.deepEqual(resizeBounds({ ...bounds, x: -1200 }, -100, 0, 'nw', { ...area, x: -1600 }), { x: -1300, y: 100, width: 460, height: 288 });
});

test('resize uses screen coordinates, ends on release and cannot continue after locking or destroying', () => {
  let bounds = { x: 100, y: 100, width: 360, height: 288 }, cursor = { x: 460, y: 388 }, tick, changes = 0, destroyed = false, at = 0;
  const window = { isDestroyed: () => destroyed, getBounds: () => ({ ...bounds }), setBounds: b => { bounds = b; changes++; },
    setMovable(v) { this.movable = v; }, setResizable(v) { this.resizable = v; }, setIgnoreMouseEvents(v) { this.ignoring = v; } };
  const controls = create({ window, screen: { getCursorScreenPoint: () => cursor, getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    schedule: callback => { tick = callback; return 1; }, cancel: () => { tick = null; }, now: () => at });
  assert.equal(controls.startResize('bad'), false);
  assert.equal(controls.startResize('se'), true); cursor = { x: 510, y: 420 }; tick();
  assert.equal(bounds.width, 410); assert.equal(bounds.height, 320);
  controls.stopResize(); const stopped = changes; cursor.x += 100;
  assert.equal(tick, null); assert.equal(changes, stopped);
  controls.startResize('se'); controls.setLocked(true);
  assert.equal(tick, null); assert.equal(window.movable, false); assert.equal(window.resizable, false); assert.equal(window.ignoring, true);
  assert.equal(controls.startResize('nw'), false);
  controls.pointer(true); assert.equal(window.ignoring, false); // Unlock button only.
  controls.pointer(false); assert.equal(window.ignoring, true);
  controls.setLocked(false); assert.equal(window.ignoring, false);
  controls.startResize('se'); at = 31000; tick(); assert.equal(tick, null);
  controls.startResize('se'); destroyed = true; const beforeDestroy = changes; tick();
  assert.equal(changes, beforeDestroy); assert.equal(tick, null);
});
