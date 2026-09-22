const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { zonePlan } = require('../lib/origin');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function code(name) {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  const end = /\r?\n\}/.exec(source.slice(at));
  return source.slice(source.slice(at - 6, at) === 'async ' ? at - 6 : at, at + end.index + end[0].length);
}
function env(extra = {}) {
  const config = { zoneSource: 'traffic', pollMs: 1500, cursorScan: true };
  const ctx = vm.createContext({
    config, console, Date, Promise, performance,
    metricsOptions: require('../lib/metrics-options'),
    readsScreen: () => zonePlan({ source: config.zoneSource }).readsScreen,
    zoneStripRect: () => assert.fail('Unexpected zone screenshot'),
    ...extra,
  });
  return { ctx, config, load: (...names) => vm.runInContext(names.map(code).join('\n'), ctx) };
}

test('zone capture is disabled before any graphics access in traffic and manual modes', async () => {
  const e = env(); e.load('captureZoneStrip');
  for (const mode of ['traffic', 'off']) {
    e.config.zoneSource = mode;
    assert.equal(await e.ctx.captureZoneStrip(), null);
  }
});

test('traffic source starts the socket without starting a polling timer', () => {
  let sockets = 0, polls = 0, stops = 0;
  const e = env({
    pollTimer: 7, clearTimeout() {}, stopTraffic: () => stops++, trafficError: 'old',
    zoneFromTraffic: true, quitting: false,
    startTraffic: () => sockets++, restartPoll: () => polls++,
  });
  e.load('applyZoneSource'); e.ctx.applyZoneSource();
  assert.equal(sockets, 1); assert.equal(polls, 0); assert.equal(stops, 1);
  e.config.zoneSource = 'screen'; e.ctx.applyZoneSource();
  assert.equal(polls, 1, 'Explicit screen mode still polls');
});

test('portal hotkey captures the tooltip only in traffic mode', async () => {
  const tasks = [], screenshots = [];
  const e = env({
    beginPortalPreview: () => 1, send() {}, captureContext: () => ({ source: 'traffic', origin: 'A' }),
    TIP_BOX_WIDE: {}, captureTooltipArea: () => ({ frame: {}, ms: 1, screenHeight: 1080 }),
    captureZoneStrip: () => assert.fail('Portal hotkey captured the zone'),
    showBusy() {}, saveShots: frames => screenshots.push(frames),
    frameStats: () => ({ blank: false, ms: 0 }), enqueue: task => tasks.push(task),
  });
  e.load('runHotkey'); await e.ctx.runHotkey();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].withTooltip, true); assert.equal(tasks[0].withZone, false);
  assert.equal(screenshots[0].zone, null);
});

test('manual portal search opens without capturing a zone in traffic mode', async () => {
  let opened = 0;
  const e = env({ openSearch: () => opened++, captureZoneStrip: () => assert.fail('Search captured the zone') });
  e.load('runHotkeySearch'); await e.ctx.runHotkeySearch();
  assert.equal(opened, 1);
});

test('a poll waiting for the game stops without a screenshot after switching to traffic', async () => {
  let resume, timers = 0;
  const game = new Promise(resolve => { resume = resolve; });
  const e = env({
    polling: false, reportLost() {}, parking: { expire: () => [] }, hotkeyPending: () => false,
    captureInFlight: 0, process: { env: {} }, gameRunning: () => game,
    captureContext: () => ({}), quitting: false, setTimeout: () => timers++,
  });
  e.config.zoneSource = 'screen';
  e.load('captureZoneStrip', 'runPoll');
  const pending = e.ctx.runPoll();
  e.config.zoneSource = 'traffic'; resume(true); await pending;
  assert.equal(timers, 0);
  assert.equal(e.ctx.polling, false);
});

test('queued zone frames do not invoke OCR after switching to traffic', async () => {
  const e = env({
    zoneRevision: 2, quitting: false, send() {}, store: { snapshot: () => ({}) },
    recognize: { recognizeZone: () => assert.fail('Zone OCR ran in traffic mode') },
  });
  e.load('finishFrame');
  const result = { zone: null, tip: null };
  await e.ctx.finishFrame(result, {}, { kind: 'poll', withTooltip: false, tz: 0 });
  assert.equal(result.zone, null);
});

test('the zone-region picker rejects traffic mode before hiding windows or capturing the desktop', async () => {
  const handlers = new Map();
  const e = env({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) } });
  const at = source.indexOf("ipcMain.handle('pick-zone-region'");
  const end = source.indexOf('// ---------- окно поиска зоны', at);
  vm.runInContext(source.slice(at, end), e.ctx);
  const result = await handlers.get('pick-zone-region')();
  assert.equal(result.ok, false);
  assert.match(result.error, /С экрана/);
});
