'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, resizeBounds, normalizeBounds, restoreBounds } = require('../lib/metrics-window-controls');

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

test('saved bounds retain negative monitor coordinates and recover from changed displays or invalid settings', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  const saved = { x: -1400, y: 600, width: 500, height: 350 };
  assert.deepEqual(restoreBounds('damage', saved, area), saved);
  assert.deepEqual(restoreBounds('fame', saved, area), { x: -1400, y: 600, width: 250, height: 48 });
  assert.deepEqual(restoreBounds('damage', { x: 2500, y: 2000, width: 2400, height: 1300 }, area), area);
  assert.deepEqual(restoreBounds('damage', { x: -1700, y: 100, width: 1, height: 1 }, area),
    { x: -1700, y: 100, width: 280, height: 140 });
  for (const invalid of [null, {}, { ...saved, x: '20' }, { ...saved, y: Infinity }, { ...saved, x: 2 ** 32 }, { ...saved, width: -1 }]) {
    assert.equal(normalizeBounds(invalid), null);
    assert.deepEqual(restoreBounds('damage', invalid, area), { x: -1900, y: 140, width: 360, height: 288 });
  }
});

// Run the real window-opening and config-writing functions against window events.
// Recreating the session from disk checks that no in-memory bounds are required.
function appSession(file, area = { x: 0, y: 0, width: 1920, height: 1040 }) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const jsonFile = require('../lib/json-file');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const functionSource = name => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1);
    const end = /\r?\n\}\r?\n/.exec(source.slice(start));
    assert.ok(end);
    return source.slice(start, start + end.index + end[0].length);
  };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.bounds = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, options[key]]));
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
    }
    isDestroyed() { return !!this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { Object.assign(this.bounds, bounds); this.emit('move'); this.emit('resize'); }
    setResizable() {} setMovable() {} setIgnoreMouseEvents() {} setAlwaysOnTop() {} loadFile() {}
    close() { this.emit('close'); this.destroy(); }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const pending = new Map();
  let timerId = 0;
  const ctx = vm.createContext({
    config: { fameEnabled: true, damageEnabled: true, ...jsonFile.readObject(file) },
    metricsWindows: { fame: null, damage: null }, damageWindowControls: null, damageLocked: false,
    metricsWindowControls: require('../lib/metrics-window-controls'), BrowserWindow: Window,
    screen: { getCursorScreenPoint: () => ({ x: 100, y: 100 }), getDisplayNearestPoint: () => ({ workArea: area }) },
    path, __dirname: path.join(__dirname, '..'), webPrefs: () => ({}), pushMetrics() {},
    jsonFile, CONFIG_PATH: file, saveTimer: null,
    setTimeout: fn => { pending.set(++timerId, fn); return timerId; }, clearTimeout: id => pending.delete(id),
  });
  vm.runInContext(['saveConfig', 'saveConfigSoon', 'flushConfig', 'openMetrics'].map(functionSource).join('\n'), ctx);
  return { ctx, pending, open: kind => { ctx.openMetrics(kind); return ctx.metricsWindows[kind]; } };
}

test('both overlay positions and DPS size survive closing and a fresh application session', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-metrics-bounds-'));
  t.after(() => { fs.unlinkSync(path.join(dir, 'config.json')); fs.rmdirSync(dir); });
  const file = path.join(dir, 'config.json'), session = appSession(file);
  const fame = session.open('fame'), damage = session.open('damage');
  const fameBounds = { x: 421, y: 885, width: 250, height: 48 };
  const damageBounds = { x: 1110, y: 610, width: 520, height: 410 };
  fame.setBounds(fameBounds); damage.setBounds(damageBounds);
  assert.equal(session.pending.size, 1, 'dragging coalesces writes');
  assert.equal(fs.existsSync(file), false);
  fame.close(); damage.close(); // Closing immediately must flush the pending write.
  assert.equal(session.pending.size, 0);
  const next = appSession(file);
  assert.deepEqual(next.open('fame').getBounds(), fameBounds);
  assert.deepEqual(next.open('damage').getBounds(), damageBounds);
});

test('application exit flushes bounds even when overlay windows are destroyed without a close event', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-metrics-exit-'));
  t.after(() => { fs.unlinkSync(path.join(dir, 'config.json')); fs.rmdirSync(dir); });
  const file = path.join(dir, 'config.json'), session = appSession(file);
  for (const kind of ['fame', 'damage']) {
    const window = session.open(kind);
    window.setBounds({ x: 320, y: 530 });
    window.destroy();
  }
  session.ctx.flushConfig(); // will-quit flushes config after the main window destroys overlays.
  const next = appSession(file);
  assert.equal(next.open('fame').getBounds().y, 530);
  assert.equal(next.open('damage').getBounds().y, 530);
});
