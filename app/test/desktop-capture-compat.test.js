const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const begin = source.indexOf('async function captureScreen()');
const end = source.indexOf('// Диагностика чёрного/однотонного кадра', begin);
assert.ok(begin >= 0 && end > begin);
const captureCode = source.slice(begin, end);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function session() {
  const native = deferred();
  const started = deferred();
  const overlay = {
    visible: true, hides: 0, shows: 0,
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    hide() { this.visible = false; this.hides++; },
    showInactive() { this.visible = true; this.shows++; },
  };
  const context = vm.createContext({
    overlay, suspendedOverlay: true, guide: null, overlaySetup: false,
    hidden: false, overlaysHidden() { return context.hidden; },
    captureInFlight: 0, performance, Date, process: { env: {} }, console,
    setTimeout: fn => queueMicrotask(fn),
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, scaleFactor: 1 }) },
    captureOnce: fn => fn(),
    desktopCapturer: { getSources() { started.resolve(); return native.promise; } },
    F: { fromBitmap: (_, width, height) => ({ width, height }) },
  });
  vm.runInContext(captureCode, context);
  return { context, overlay, native, started, capture: () => vm.runInContext('captureScreen()', context) };
}

test('portal overlay never marks desktop capture as protected', () => {
  assert.doesNotMatch(source, /\.setContentProtection\s*\(\s*true\s*\)/);
});

test('desktop fallback captures without the overlay and restores it afterward', async () => {
  const s = session();
  const result = s.capture();
  await s.started.promise;
  assert.equal(s.overlay.visible, false);
  s.native.resolve([{ display_id: 1, thumbnail: {
    isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.alloc(4),
  } }]);
  assert.equal((await result).frame.width, 1);
  assert.equal(s.overlay.visible, true);
  assert.deepEqual([s.overlay.hides, s.overlay.shows, s.context.captureInFlight], [1, 1, 0]);
});

test('desktop fallback does not reveal an overlay hidden while capture was pending', async () => {
  const s = session();
  const result = s.capture();
  await s.started.promise;
  s.context.hidden = true;
  s.native.reject(new Error('capture failed'));
  await assert.rejects(result, /capture failed/);
  assert.equal(s.overlay.visible, false);
  assert.equal(s.overlay.shows, 0);
  assert.equal(s.context.captureInFlight, 0);
});
