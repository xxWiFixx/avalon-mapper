const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const portalTime = require('../lib/portal-time');
const origin = require('../lib/origin');
const store = require('../lib/store');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function productionFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end);
  return source.slice(start, start + end.index + end[0].length);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const portal = { name: 'B', color: 'avalon', closes: 60, capMax: 7, capMaxKnown: true, capNum: 4 };

function session(t, { now = 1000, saveLocal = true, currentZone = 'A' } = {}) {
  const messages = [], uploads = [], overlays = [];
  t.mock.method(Date, 'now', () => now);
  store.flush();
  store.setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-portal-time-')));
  Object.assign(store.state, { edges: {}, players: {}, journal: [] });
  t.after(() => store.flush());
  const ctx = vm.createContext({
    portalTime, origin, store, Date, performance, console: { log() {}, warn() {}, error() {} },
    config: { saveLocal, nick: 'test', zoneWatch: true, zoneSource: 'traffic', copyWorldZone: false },
    net: { status: () => ({ targets: ['group', 'public'] }), push: edge => uploads.push(edge) },
    sync: { PUBLIC_MAP_ID: 'public' },
    currentZone, zoneSeenAt: 0, zoneRevision: 0, quitting: false,
    zonePlan: () => ({ expires: false }), parking: origin.createParking(),
    reportLost() {}, watchParking() {}, kickPoll() {},
    send: (channel, payload) => messages.push({ channel, payload }),
    showOverlay: payload => overlays.push(payload),
    F: { toFrame: async frame => frame },
    recognize: { recognizeTooltip: async () => ({ ...portal }), recognizeZone: async () => null },
    saveFailShot() {}, captureContext: () => null, bindingLabel: () => 'Mouse5',
    queue: [], ocrBusy: true, running: null, MAX_HOTKEY_TASKS: 8,
    isPress: kind => kind === 'hotkey' || kind === 'zone', hotkeyPending: () => false,
    setImmediate() {},
  });
  vm.runInContext(['enqueue', 'pump', 'processFrame', 'finishFrame', 'applyTip', 'saveEdge', 'flushParked']
    .map(productionFunction).join('\n'), ctx);
  return { ctx, messages, uploads, overlays, at: value => { now = value; } };
}

test('capture time fixes expiry across repeated refreshes, including timestamp and expiry zero', () => {
  const first = portalTime.fromCapture({ ...portal }, 0, 12000);
  assert.equal(first.capturedAt, 0);
  assert.equal(first.expiresAt, 60000);
  assert.equal(first.closes, 48);
  const second = portalTime.refresh(first, 25000);
  assert.equal(second.expiresAt, 60000);
  assert.equal(second.closes, 35);
  assert.equal(portalTime.refresh(second, 61000).closes, 0);
  assert.equal(portalTime.expired(second, 60000), true);
  const zero = portalTime.refresh({ ...portal, expiresAt: 0 }, 0);
  assert.equal(zero.expiresAt, 0);
  assert.equal(zero.closes, 0);
  assert.equal(portalTime.expired(zero, 0), true);
  assert.equal(portalTime.expiry({ closes: 0, capturedAt: 0 }, 0), 0);
});

test('timestamps and durations are validated without coercing strings or treating zero as missing', () => {
  for (const invalid of [null, undefined, -1, NaN, Infinity, '1000', 8640000000000001]) {
    assert.equal(portalTime.validTimestamp(invalid), false);
    assert.equal(portalTime.expiry({ closes: 60, capturedAt: invalid }, 1000), 61000);
  }
  for (const invalid of [null, undefined, -1, NaN, Infinity, '60', 48 * 3600 + 1]) {
    assert.equal(portalTime.expiry({ closes: invalid, capturedAt: 0 }, 1000), null);
    assert.equal(portalTime.refresh({ closes: invalid }, 1000).closes, null);
  }
  assert.equal(portalTime.expiry({ closes: 1, capturedAt: 8640000000000000 }, 0), null);
  assert.equal(portalTime.expiry({ closes: 60 }, NaN), null);
  assert.equal(portalTime.refresh({ expiresAt: 1000 }, NaN).closes, null);
  assert.equal(portalTime.expired({ expiresAt: 0 }, NaN), false);
});

test('manual and untimestamped legacy durations begin once at submission, then retain fixed expiry', t => {
  const s = session(t, { now: 10000 });
  s.ctx.applyTip({ ...portal }, { manual: true });
  assert.equal(store.state.edges['A|B'].expiresAt, 70000);
  assert.equal(s.uploads[0].expiresAt, 70000);
  assert.equal(s.overlays[0].tip.closes, 60);
  s.at(20000);
  const legacy = store.addEdge('A', { name: 'C', closes: 120 }, 'test');
  assert.equal(legacy.expiresAt, 140000);
  const unknown = store.addEdge('A', { name: 'D', closes: null }, 'test');
  assert.equal(unknown.expiresAt, null);
});

test('queue, tooltip OCR and zone OCR delays all reduce the final displayed time without extending local or shared expiry', async t => {
  const s = session(t, { now: 1000 });
  s.ctx.config.zoneSource = 'screen';
  s.ctx.recognize = {
    recognizeTooltip: async () => { s.at(22000); return { ...portal }; },
    recognizeZone: async () => { s.at(27000); return null; },
  };
  const pending = s.ctx.enqueue({ kind: 'hotkey', frame: {}, withTooltip: true, capturedAt: 1000 });
  s.at(16000); // the worker was processing another captured portal
  s.ctx.ocrBusy = false;
  await s.ctx.pump();
  const result = await pending;
  assert.equal(result.tip.capturedAt, 1000);
  assert.equal(result.tip.expiresAt, 61000);
  assert.equal(result.tip.closes, 34);
  assert.equal(s.overlays.at(-1).tip.closes, 34);
  assert.equal(store.state.edges['A|B'].expiresAt, 61000);
  assert.equal(store.state.edges['A|B'].capAt, 1000);
  assert.equal(s.uploads[0].expiresAt, 61000);
});

test('waiting for the origin retains absolute expiry and does not subtract elapsed time twice', t => {
  const s = session(t, { now: 10000, currentZone: null });
  s.ctx.applyTip({ ...portal, capturedAt: 0 });
  assert.equal(s.ctx.parking.size(), 1);
  assert.equal(s.overlays[0].tip.closes, 50);
  assert.equal(s.uploads.length, 0);
  s.at(25000);
  s.ctx.flushParked('A');
  assert.equal(s.ctx.parking.size(), 0);
  assert.equal(store.state.edges['A|B'].expiresAt, 60000);
  assert.equal(s.uploads[0].expiresAt, 60000);
  const event = s.messages.find(m => m.channel === 'edge-added');
  assert.equal(event.payload.tip.closes, 35);
  assert.equal(event.payload.tip.capturedAt, 0);
});

test('an expired OCR result still displays its destination but cannot be parked, stored, uploaded or revive an expired edge', async t => {
  const s = session(t, { now: 20000, currentZone: null });
  s.ctx.recognize.recognizeTooltip = async () => ({ ...portal, closes: 5 });
  const result = await s.ctx.processFrame({}, { kind: 'hotkey', withTooltip: true, withZone: false, capturedAt: 1000 });
  assert.equal(result.tip.expiresAt, 6000);
  assert.equal(result.tip.closes, 0);
  assert.equal(s.overlays[0].tip.name, 'B');
  assert.equal(s.overlays[0].expired, true);
  assert.equal(s.ctx.parking.size(), 0);
  assert.equal(s.uploads.length, 0);
  assert.deepEqual(store.state.edges, {});
  store.state.edges['A|B'] = { a: 'A', b: 'B', updatedAt: 0, expiresAt: 6000 };
  assert.equal(store.addEdge('A', result.tip, 'test'), null);
  assert.equal(store.state.edges['A|B'].updatedAt, 0);
  store.prune(20000);
  assert.deepEqual(store.state.edges, {});
});

test('a portal that closes while parked is skipped when its origin arrives', t => {
  const s = session(t, { now: 1000, currentZone: null });
  s.ctx.applyTip({ ...portal, capturedAt: 0, closes: 5 });
  assert.equal(s.ctx.parking.size(), 1);
  s.at(6000);
  s.ctx.flushParked('A');
  assert.equal(s.ctx.parking.size(), 0);
  assert.equal(s.uploads.length, 0);
  assert.deepEqual(store.state.edges, {});
  assert.equal(s.messages.some(m => m.channel === 'edge-added'), false);
  assert.match(s.messages.at(-1).payload.text, /уже закрылся/);
});

test('shared-only saving uses the same fixed expiry and rejects expiredAt zero', t => {
  const s = session(t, { now: 10000, saveLocal: false });
  s.ctx.saveEdge('A', { ...portal, capturedAt: 0 }, 'ocr');
  assert.equal(s.uploads[0].expiresAt, 60000);
  assert.deepEqual(store.state.edges, {});
  s.ctx.saveEdge('A', { ...portal, expiresAt: 0 }, 'ocr');
  assert.equal(s.uploads.length, 1);
  store.state.edges['A|B'] = { a: 'A', b: 'B', updatedAt: 1, expiresAt: 0 };
  store.prune(0);
  assert.deepEqual(store.state.edges, {});
});

test('an unreadable timer cannot turn an already expired stored edge into an untimed upload', t => {
  const s = session(t, { now: 10000 });
  store.state.edges['A|B'] = { a: 'A', b: 'B', updatedAt: 0, expiresAt: 0 };
  assert.equal(s.ctx.saveEdge('A', { name: 'B', closes: null }, 'ocr'), null);
  assert.equal(s.uploads.length, 0);
  assert.equal(store.state.edges['A|B'].updatedAt, 0);
});

test('rejecting an untimed rescan of an expired edge never reports a successful direct or pending record', t => {
  const s = session(t, { now: 10000 });
  store.state.edges['A|B'] = { a: 'A', b: 'B', updatedAt: 0, expiresAt: 0 };
  s.ctx.applyTip({ name: 'B', closes: null });
  assert.equal(s.messages.some(m => m.channel === 'edge-added'), false);
  assert.equal(s.overlays.at(-1).notSaved, true);
  assert.match(s.messages.at(-1).payload.text, /не записан/);
  s.ctx.currentZone = null;
  s.ctx.applyTip({ name: 'B', closes: null });
  assert.equal(s.ctx.parking.size(), 1);
  s.ctx.flushParked('A');
  assert.equal(s.messages.some(m => m.channel === 'edge-added'), false);
  assert.match(s.messages.at(-1).payload.text, /не записан/);
  assert.equal(s.uploads.length, 0);
});

test('successful shared-only submissions still report completion for direct and pending portals', t => {
  const s = session(t, { now: 10000, saveLocal: false });
  s.ctx.applyTip({ ...portal, capturedAt: 0 });
  assert.equal(s.messages.filter(m => m.channel === 'edge-added').length, 1);
  assert.equal(s.overlays.at(-1).notSaved, undefined);
  s.ctx.currentZone = null;
  s.ctx.applyTip({ ...portal, name: 'C', capturedAt: 0 });
  s.ctx.flushParked('A');
  assert.equal(s.messages.filter(m => m.channel === 'edge-added').length, 2);
  assert.equal(s.uploads.length, 2);
  assert.equal(s.uploads[0].expiresAt, 60000);
  assert.equal(s.uploads[1].expiresAt, 60000);
  assert.deepEqual(store.state.edges, {});
});

test('desktop fallback timestamp is receipt of the captured image, before bitmap conversion', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const native = deferred();
  const ctx = vm.createContext({ Date, performance, captureInFlight: 0, process: { env: {} },
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1 }) },
    captureOnce: fn => fn(), desktopCapturer: { getSources: () => native.promise },
    F: { fromBitmap: (data, width, height) => ({ data, width, height }) },
  });
  vm.runInContext(productionFunction('captureScreen'), ctx);
  const work = ctx.captureScreen();
  now = 7000;
  native.resolve([{ display_id: '1', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 1920, height: 1080 }),
    toBitmap() { now = 9000; return Buffer.alloc(4); },
  } }]);
  const result = await work;
  assert.equal(result.capturedAt, 7000);
  assert.equal(now, 9000);
  assert.equal(ctx.captureInFlight, 0);
});

test('the hotkey carries tooltip capture time, rather than the later zone screenshot time', async () => {
  const tasks = [];
  const ctx = vm.createContext({
    config: { cursorScan: true }, beginPortalPreview: () => 1, send() {}, showBusy() {},
    captureContext: () => null, TIP_BOX_WIDE: {},
    captureTooltipArea: () => ({ frame: {}, capturedAt: 1000, ms: 1, screenHeight: 1080 }),
    readsScreen: () => true, captureZoneStrip: async () => ({ frame: {}, capturedAt: 8000, strip: true, ms: 7000 }),
    saveShots() {}, frameStats: () => ({ blank: false, ms: 0 }), enqueue: async task => tasks.push(task),
  });
  vm.runInContext(productionFunction('runHotkey'), ctx);
  await ctx.runHotkey();
  assert.equal(tasks[0].capturedAt, 1000);
});
