const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const begin = source.indexOf('async function captureScreen(');
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
  const context = vm.createContext({ i18nText: require('../lib/i18n').t,
    overlay, suspendedOverlay: true, guide: null, overlaySetup: false,
    hidden: false, overlaysHidden() { return context.hidden; },
    captureInFlight: 0, performance, Date, process: { env: {} }, console,
    setTimeout: fn => queueMicrotask(fn),
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1, height: 1 }, scaleFactor: 1 }) },
    captureOnce: fn => fn(),
    desktopCapturer: { getSources() { started.resolve(); return native.promise; } },
    F: { fromBitmap: (_, width, height) => ({ width, height }) },
    displayGeometry: () => ({ originX: 0, originY: 0, width: 1, height: 1 }),
  });
  context.captureOverlayGuard = require('../lib/overlay-capture').create({
    busy: delta => { context.captureInFlight += delta; },
  });
  vm.runInContext(captureCode, context);
  return { context, overlay, native, started, capture: () => vm.runInContext('captureScreen()', context) };
}

test('portal, metrics and search windows use OCR-only exclusion and do not block external recording', () => {
  assert.match(source, /overlayCapture\.register\(w\)/);
  assert.match(source, /overlayCapture\.register\(window\)/);
  assert.match(source, /overlayCapture\.register\(opened\)/);
  assert.match(source, /captureWindow: rect => gameCapture\.capture\(rect\)/);
});

test('desktop fallback leaves the overlay visible for the whole capture', async () => {
  const s = session();
  const result = s.capture();
  await s.started.promise;
  assert.equal(s.overlay.visible, true);
  s.native.resolve([{ display_id: 1, thumbnail: {
    isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.alloc(4),
  } }]);
  assert.equal((await result).frame.width, 1);
  assert.equal(s.overlay.visible, true);
  assert.deepEqual([s.overlay.hides, s.overlay.shows, s.context.captureInFlight], [0, 0, 0]);
});

test('desktop fallback does not reveal an overlay hidden while capture was pending', async () => {
  const s = session();
  const result = s.capture();
  await s.started.promise;
  s.context.hidden = true;
  s.overlay.hide(); // Manual hiding remains possible during a native capture.
  s.native.reject(new Error('capture failed'));
  await assert.rejects(result, /capture failed/);
  assert.equal(s.overlay.visible, false);
  assert.equal(s.overlay.shows, 0);
  assert.equal(s.context.captureInFlight, 0);
});

test('desktop fallback correctly wraps an isolated game frame and preserves its capture timestamp', async () => {
  const s = session();
  s.context.captureOverlayGuard = { run: async () => ({ width: 1, height: 1, data: Buffer.alloc(4), capturedAt: 12345 }) };
  const result = await s.capture();
  assert.equal(result.frame.width, 1); assert.equal(result.capturedAt, 12345);
  assert.equal(s.overlay.visible, true); assert.equal(s.overlay.hides, 0);
});
