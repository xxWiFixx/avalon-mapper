'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const options = require('../lib/metrics-options');
const { create, CODE } = require('../lib/combat-metrics');

test('fresh installs do not capture traffic; saved individual and legacy choices survive restart', () => {
  assert.deepEqual(options.normalize(), { fameEnabled: false, damageEnabled: false });
  assert.deepEqual(options.normalize({ metricsEnabled: true }), { fameEnabled: true, damageEnabled: true });
  assert.deepEqual(options.normalize({ metricsEnabled: false }), { fameEnabled: false, damageEnabled: false });
  const saved = { metricsEnabled: true, fameEnabled: false, damageEnabled: true };
  assert.deepEqual(options.normalize(saved), { fameEnabled: false, damageEnabled: true });
  assert.deepEqual(options.normalize(JSON.parse(JSON.stringify(options.normalize(saved)))), { fameEnabled: false, damageEnabled: true });
  assert.deepEqual(options.normalize({ fameEnabled: 'true', damageEnabled: 1, metricsEnabled: true }), { fameEnabled: false, damageEnabled: false });
});

test('only the three explicit traffic consumers can require capture', () => {
  for (const zoneSource of ['screen', 'off', 'traffic']) {
    for (const fameEnabled of [false, true]) for (const damageEnabled of [false, true]) {
      assert.equal(options.needsTraffic({ zoneSource, fameEnabled, damageEnabled }), zoneSource === 'traffic' || fameEnabled || damageEnabled);
    }
  }
});

function session(flags = {}) {
  let t = 0;
  const m = create({ now: () => t, ...flags });
  m.consume({ kind: 'response', code: 2, returnCode: 0, params: { 0: 1, 1: Array(16).fill(1), 2: 'Me' } });
  return { m, at: n => { t = n; },
    fame: total => m.consume({ kind: 'event', code: CODE.UpdateFame, params: { 0: 1, 1: total, 2: 1000000 } }),
    hit: () => m.consume({ kind: 'event', code: CODE.HealthUpdate, params: { 0: 99, 2: -100, 6: 1 } }),
  };
}

test('fame and damage count independently, including when both are disabled', () => {
  for (const fameEnabled of [false, true]) for (const damageEnabled of [false, true]) {
    const s = session({ fameEnabled, damageEnabled });
    s.fame(100); s.hit(); s.at(1000); s.hit();
    assert.equal(s.m.snapshot().fame, fameEnabled ? 100 : 0);
    assert.equal(s.m.snapshot().overall.totalDamage, damageEnabled ? 200 : 0);
    assert.equal(s.m.snapshot().elapsedMs, fameEnabled ? 1000 : 0);
  }
});

test('disabled fame preserves the total and excludes disabled time and overlapping pauses from its hourly rate', () => {
  const s = session(); s.fame(100); s.at(10000);
  s.m.setEnabled({ fameEnabled: false, damageEnabled: true });
  s.at(20000); s.fame(200); s.hit();
  s.at(30000); s.m.setPaused(true); s.at(40000); s.m.setPaused(false);
  assert.equal(s.m.snapshot().elapsedMs, 10000);
  assert.equal(s.m.snapshot().fame, 100);
  assert.equal(s.m.snapshot().overall.totalDamage, 100);
  s.at(70000); s.m.setEnabled({ fameEnabled: true, damageEnabled: true });
  s.fame(200); // A reward observed while disabled cannot be replayed into the total.
  assert.equal(s.m.snapshot().fame, 100);
  s.at(80000); s.fame(300);
  assert.equal(s.m.snapshot().fame, 200);
  assert.equal(s.m.snapshot().elapsedMs, 20000);
  assert.equal(s.m.snapshot().famePerHour, 36000);
});

test('damage resumes in a new fight without erasing overall damage or interrupting fame', () => {
  const s = session(); s.hit(); s.fame(100); s.at(2000); s.hit();
  s.m.setEnabled({ fameEnabled: true, damageEnabled: false }); s.at(3000); s.hit(); s.fame(200);
  assert.equal(s.m.snapshot().overall.totalDamage, 200);
  assert.equal(s.m.snapshot().inCombat, false);
  s.m.setEnabled({ fameEnabled: true, damageEnabled: true }); s.at(4000); s.hit();
  assert.equal(s.m.snapshot().totalDamage, 100);
  assert.equal(s.m.snapshot().overall.totalDamage, 300);
  assert.equal(s.m.snapshot().overall.durationMs, 3000);
  assert.equal(s.m.snapshot().fame, 200);
});

test('switching a feature does not override pause; reset while disabled starts its clock at the next reward', () => {
  const s = session(); s.fame(100); s.at(1000); s.m.setPaused(true);
  s.m.setEnabled({ fameEnabled: false, damageEnabled: true }); s.at(2000);
  s.m.setEnabled({ fameEnabled: true, damageEnabled: true }); s.fame(200);
  assert.equal(s.m.snapshot().paused, true); assert.equal(s.m.snapshot().fame, 100);
  s.m.setEnabled({ fameEnabled: false, damageEnabled: false }); s.m.reset();
  s.at(90000); s.m.setPaused(false); s.m.setEnabled({ fameEnabled: true, damageEnabled: false }); s.fame(300);
  s.at(100000); assert.equal(s.m.snapshot().elapsedMs, 10000);
});

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function code(name) {
  const at = source.indexOf(`function ${name}(`);
  assert.ok(at >= 0, name);
  const end = /\r?\n\}/.exec(source.slice(at));
  return source.slice(source.slice(at - 6, at) === 'async ' ? at - 6 : at, at + end.index + end[0].length);
}
function runtime(flags = {}, extra = {}) {
  const counts = { open: 0, close: 0, feed: 0, poll: 0, saved: 0, closedOverlays: [] };
  let callbacks;
  const config = { zoneSource: 'screen', fameEnabled: false, damageEnabled: false, ...flags };
  const ctx = vm.createContext({ config, metricsOptions: options, quitting: false,
    zoneRevision: 0, zoneFromTraffic: false, traffic: null, trafficTimer: null, trafficGeneration: 0, trafficError: null,
    pollTimer: null, revives: 0, TRAFFIC_CHECK_MS: 15000,
    console: { log() {}, warn() {}, error() {} }, send() {}, pushConfig() {}, pushMetrics() {},
    saveConfig() { counts.saved++; }, clearInterval() {}, clearTimeout() {}, setInterval: () => 1,
    restartPoll() { counts.poll++; }, health: { reset() {}, tick: () => 'revive' },
    privileges: { isElevated: async () => true }, captureSocket: {},
    combat: { setEnabled() {}, disconnect() {}, feed() { counts.feed++; }, snapshot: () => ({}) },
    metricsWindows: Object.fromEntries(['fame', 'damage'].map(kind => [kind, {
      isDestroyed: () => false, close() { counts.closedOverlays.push(kind); }, webContents: {},
    }])),
    zoneTraffic: { create: value => { callbacks = value; return {
      start() { counts.open++; return { listening: [], failed: [] }; }, stop() { counts.close++; }, packets: () => 0,
    }; } },
    ...extra,
  });
  vm.runInContext(['stopTraffic', 'watchTraffic', 'startTraffic', 'applyZoneSource', 'applyMetricsOptions'].map(code).join('\n'), ctx);
  return { ctx, counts, config, callbacks: () => callbacks };
}

test('screen and manual modes never request capture or elevation with both metrics disabled', async () => {
  for (const zoneSource of ['screen', 'off']) {
    const r = runtime({ zoneSource }, { privileges: { isElevated: () => assert.fail('Unexpected elevation check') } });
    r.ctx.applyZoneSource(); assert.equal(await r.ctx.startTraffic(), false);
    assert.equal(r.counts.open, 0); assert.equal(r.counts.poll, zoneSource === 'screen' ? 1 : 0);
  }
});

test('disabling the last metric closes capture and its overlays and ignores late packets', async () => {
  const r = runtime({ fameEnabled: true, damageEnabled: true }); await r.ctx.startTraffic();
  r.callbacks().onPacket(); assert.equal(r.counts.feed, 1);
  r.config.fameEnabled = false; r.ctx.applyMetricsOptions();
  assert.equal(r.counts.close, 0); assert.deepEqual(r.counts.closedOverlays, ['fame']);
  r.config.damageEnabled = false; r.ctx.applyMetricsOptions();
  assert.equal(r.counts.close, 1); assert.equal(r.ctx.traffic, null);
  r.callbacks().onPacket(); assert.equal(r.counts.feed, 1);
  assert.ok(r.counts.closedOverlays.includes('damage')); assert.equal(r.counts.saved, 2);
});

test('disabling metrics preserves traffic zone capture but stops feeding the counters', async () => {
  const r = runtime({ zoneSource: 'traffic', fameEnabled: true }); await r.ctx.startTraffic();
  r.config.fameEnabled = false; r.ctx.applyMetricsOptions(); r.callbacks().onPacket();
  assert.equal(r.counts.close, 0); assert.ok(r.ctx.traffic); assert.equal(r.counts.feed, 0);
});

test('an in-flight start cannot reopen capture after both metrics have been disabled', async () => {
  let finish;
  const r = runtime({ fameEnabled: true }, { privileges: { isElevated: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = r.ctx.startTraffic();
  r.config.fameEnabled = false; r.ctx.applyMetricsOptions(); finish(true);
  assert.equal(await pending, false); assert.equal(r.counts.open, 0); assert.equal(r.ctx.traffic, null);
});

test('the traffic watchdog cannot revive a listener disabled while checking the game', async () => {
  let tick, finish;
  const r = runtime({ damageEnabled: true }, {
    setInterval: fn => { tick = fn; return 1; },
    gameRunning: () => new Promise(resolve => { finish = resolve; }),
  });
  await r.ctx.startTraffic(); const pending = tick();
  r.config.damageEnabled = false; r.ctx.applyMetricsOptions(); finish(true); await pending;
  assert.equal(r.counts.open, 1); assert.equal(r.counts.close, 1); assert.equal(r.ctx.traffic, null);
});

test('the explicit stop-traffic action also switches traffic zone detection to screen', async () => {
  const handlers = {}, main = {};
  const r = runtime({ zoneSource: 'traffic', fameEnabled: true, damageEnabled: true }, {
    win: { webContents: main }, metricsSnapshot: () => ({}),
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on() {} },
  });
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('get-metrics'"), source.indexOf('// dev включает блок')), r.ctx);
  await r.ctx.startTraffic();
  assert.equal(handlers['metrics-action']({ sender: {} }, 'stop-traffic').ok, false);
  assert.equal(handlers['metrics-action']({ sender: r.ctx.metricsWindows.damage.webContents }, 'stop-traffic').ok, false);
  assert.equal(r.config.zoneSource, 'traffic');
  assert.equal(handlers['metrics-action']({ sender: main }, 'stop-traffic').ok, true);
  assert.equal(r.config.zoneSource, 'screen'); assert.equal(r.config.zoneWatch, true);
  assert.equal(r.config.fameEnabled, false); assert.equal(r.config.damageEnabled, false);
  assert.equal(r.ctx.traffic, null); assert.equal(r.counts.close, 1); assert.equal(r.counts.poll, 1);
});
