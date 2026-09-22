const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ocr = require('../lib/ocr-worker');
const capture = require('../lib/capture-recovery');
const pump = require('../lib/packet-pump');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('a stuck OCR request is terminated; the next request gets a fresh worker, not the late answer', async () => {
  const stalled = deferred();
  let created = 0, stopped = 0;
  const engine = ocr.create({ requestMs: 25, factory: async () => {
    const first = ++created === 1;
    return { setParameters: async () => {}, recognize: () => first ? stalled.promise : Promise.resolve('fresh'), terminate: () => { stopped++; } };
  } });
  await assert.rejects(engine.run('old', {}), { code: 'OCR_TIMEOUT' });
  await turn();
  assert.equal(stopped, 1);
  assert.equal(await engine.run('new', {}), 'fresh');
  stalled.resolve('stale');
  assert.equal(await engine.run('newer', {}), 'fresh');
  assert.equal(created, 2);
  await engine.shutdown();
});

test('parameter failures also release the worker; a bounded frame stops repeated OCR attempts', async () => {
  let created = 0, calls = 0;
  const engine = ocr.create({ factory: async () => {
    const first = ++created === 1;
    return { setParameters: async () => { if (first) throw new Error('worker failed'); }, recognize: async () => ++calls, terminate() {} };
  } });
  await assert.rejects(engine.run('image', {}), /worker failed/);
  assert.equal(await engine.run('image', {}), 1);
  await assert.rejects(engine.withDeadline(() => engine.run('image', {}), -1), { code: 'OCR_TIMEOUT' });
  assert.equal(calls, 1);
  await engine.shutdown();
});

test('slow OCR initialization is bounded and shared; shutdown disposes a late worker', async () => {
  const start = deferred(); let created = 0, stopped = 0;
  const engine = ocr.create({ initMs: 15, factory: () => { created++; return start.promise; } });
  await assert.rejects(engine.init(), { code: 'OCR_TIMEOUT' });
  await assert.rejects(engine.init(), { code: 'OCR_TIMEOUT' });
  assert.equal(created, 1);
  await engine.shutdown();
  start.resolve({ terminate() { stopped++; } });
  await turn();
  assert.equal(stopped, 1);
});

test('a temporary GDI failure releases resources and retries without restarting the app', () => {
  let now = 1000, released = 0;
  const health = capture.create({ now: () => now, release: () => released++ });
  assert.equal(health.available(), true);
  health.failed();
  now += 29999; assert.equal(health.available(), false);
  now++; assert.equal(health.available(), true);
  health.failed();
  assert.equal(released, 2);
});

test('a timed-out desktop capture does not allow accumulating native requests or return an old frame', async () => {
  const run = capture.singleFlight({ timeoutMs: 15 }), slow = deferred();
  let requests = 0;
  await assert.rejects(run(() => { requests++; return slow.promise; }), /не ответил вовремя/);
  await assert.rejects(run(() => { requests++; return 'wrong'; }), /ещё занят/);
  assert.equal(requests, 1);
  slow.resolve('old frame'); await turn();
  assert.equal(await run(async () => 'new frame'), 'new frame');
});

test('traffic bursts yield to input, resume promptly, preserve packet order and stop cleanly', () => {
  const scheduled = new Map(), seen = []; let id = 0, clock = 0, packet = 0;
  const p = pump.create({ now: () => clock, budgetMs: 4,
    readOne() { if (packet === 11) return false; seen.push(++packet); clock++; return true; },
    schedule: (fn, ms) => { scheduled.set(++id, { fn, ms }); return id; }, cancel: id => scheduled.delete(id),
  });
  function tick(delay) {
    assert.equal(scheduled.size, 1);
    const [id, next] = scheduled.entries().next().value; scheduled.delete(id);
    assert.equal(next.ms, delay); next.fn();
  }
  tick(60); assert.deepEqual(seen, [1, 2, 3, 4]);
  tick(1); assert.equal(seen.length, 8);
  tick(1); assert.deepEqual(seen, Array.from({ length: 11 }, (_, i) => i + 1));
  tick(60); p.close(); assert.equal(scheduled.size, 0);
});

test('even cheap traffic is capped per slice; stopping inside a callback never schedules again', () => {
  const scheduled = []; let calls = 0, p;
  p = pump.create({ now: () => 0, maxPackets: 256, readOne() { if (++calls === 260) p.close(); return true; },
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; }, cancel() {},
  });
  scheduled.shift().fn(); assert.equal(calls, 256);
  assert.equal(scheduled[0].ms, 1);
  scheduled.shift().fn(); assert.equal(calls, 260); assert.equal(scheduled.length, 0);
});

test('the portal screenshot precedes the busy overlay, including asynchronous fallback capture', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('async function runHotkey()');
  const end = source.indexOf('\n// Хоткей без снимка курсора', start);
  const full = deferred(), order = [];
  const frame = { width: 2560, height: 1180 };
  const ctx = vm.createContext({
    config: { cursorScan: true }, send() {}, showBusy: () => order.push('busy'),
    captureContext: () => ({}), TIP_BOX_WIDE: {}, captureTooltipArea: () => null,
    captureFull: () => full.promise, cursorOnScreen: () => ({ point: { x: 2400, y: 1000 }, geom: { originX: 0, originY: 0 } }),
    readsScreen: () => false, saveShots() {}, frameStats: () => ({ blank: false, ms: 0 }),
    enqueue: async () => order.push('ocr'), console,
  });
  vm.runInContext(source.slice(start, end), ctx);
  const done = ctx.runHotkey(); await turn();
  assert.deepEqual(order, []);
  order.push('capture'); full.resolve({ frame, ms: 0 }); await done;
  assert.deepEqual(order, ['capture', 'busy', 'ocr']);
});

test('full-screen zone fallback is never passed to OCR as a pre-cropped name strip', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('async function processFrame(');
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  const ctx = vm.createContext({ F: { toFrame: async f => f }, performance,
    finishFrame: (result, frame, options) => ({ frame, options }),
  });
  vm.runInContext(source.slice(start, start + end.index + end[0].length), ctx);
  for (const strip of [false, true]) {
    const zoneFrame = strip ? { width: 415, height: 33 } : { width: 2560, height: 1180 };
    const out = await ctx.processFrame({}, { withTooltip: false, zoneFrame, strip, screenHeight: 1180 });
    assert.equal(out.options.strip, strip);
    assert.equal(out.frame, zoneFrame);
  }
});

test('2560x1180 cursor capture stays in physical pixels at 100%, 125% and 150% desktop scaling', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const extract = name => {
    const start = source.indexOf(`function ${name}(`);
    const end = /\r?\n\}\r?\n/.exec(source.slice(start));
    return source.slice(start, start + end.index + end[0].length);
  };
  for (const scaleFactor of [1, 1.25, 1.5]) {
    const display = { scaleFactor, bounds: { x: 0, y: 0 }, size: { width: 2560 / scaleFactor, height: 1180 / scaleFactor } };
    let captureRect;
    const ctx = vm.createContext({ performance, TIP_BOX_WIDE: { left: 720, right: 720, up: 400, down: 300 },
      screen: { getCursorScreenPoint: () => ({ x: 2420 / scaleFactor, y: 1000 / scaleFactor }), getDisplayNearestPoint: () => display },
      gdiRecovery: { available: () => true }, gdi: { available: () => true, grab: (...rect) => { captureRect = rect; return {}; } },
    });
    vm.runInContext(['displayGeometry', 'cursorOnScreen', 'captureTooltipArea'].map(extract).join('\n'), ctx);
    const frame = ctx.captureTooltipArea();
    assert.equal(frame.screenHeight, 1180);
    const [x, y, w, h] = captureRect;
    assert.equal(x + w, 2560); assert.equal(y + h, 1180);
    assert.equal(x + frame.cursor.x, 2420); assert.equal(y + frame.cursor.y, 1000);
    assert.ok(x <= 2134 && y <= 929 && x + w >= 2475 && y + h >= 1005);
  }
});
