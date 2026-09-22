// Regression: screen verification must not erase a zone already learned from traffic.
// Run the production state updates and portal handling, with no capture or disk writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const origin = require('../lib/origin');
const portalTime = require('../lib/portal-time');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function productionFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end);
  return source.slice(start, start + end.index + end[0].length);
}

function session() {
  let now = 100000;
  const edges = [], overlays = [], positions = [];
  const ctx = vm.createContext({
    origin, portalTime, console: { log() {}, warn() {} }, Date: { now: () => now },
    config: { zoneSource: 'traffic', zoneWatch: true, copyWorldZone: false, nick: 'test' },
    traffic: {}, trafficError: null, zoneFromTraffic: false,
    currentZone: null, pendingZone: null, zoneSeenAt: 0, zoneRevision: 0, pollStable: 0,
    parking: origin.createParking(),
    store: { setPlayerZone: (_, zone) => positions.push(zone) },
    send() {}, pushGuide() {}, flushParked() {}, watchParking() {}, reportLost() {}, kickPoll() {},
    saveEdge: (from, tip) => { const edge = { from, to: tip.name }; edges.push(edge); return edge; },
    showOverlay: payload => overlays.push(payload),
  });
  vm.runInContext(`
    const zonePlan = () => origin.zonePlan({
      source: config.zoneSource, trafficLive: !!traffic && !trafficError, zoneFromTraffic,
    });
    ${productionFunction('applyZone')}
    ${productionFunction('applyTip')}
  `, ctx);
  return {
    ctx, edges, overlays, positions,
    advance: ms => { now += ms; },
    zone: (zone, source, commit = true, manual = false) => ctx.applyZone({ zone, source }, commit, manual),
    portal: () => ctx.applyTip({ name: 'Qiient-Si-Tertum' }, { zoneNow: null, zoneTried: true }),
  };
}

test('traffic → same zone on screen → unreadable strip: portal records immediately, even an hour later', () => {
  const s = session();
  s.zone('A', 'traffic');
  s.zone('A', undefined, false);
  s.advance(3600000);
  s.portal();
  assert.equal(s.ctx.zoneFromTraffic, true);
  assert.deepEqual(s.edges, [{ from: 'A', to: 'Qiient-Si-Tertum' }]);
  assert.equal(s.ctx.parking.size(), 0);
  assert.equal(s.overlays[0].waiting, undefined);
});

test('one unconfirmed OCR candidate cannot erase traffic provenance of the current zone', () => {
  const s = session();
  s.zone('A', 'traffic');
  s.zone('B', undefined, false);
  assert.equal(s.ctx.currentZone, 'A');
  assert.equal(s.ctx.pendingZone, 'B');
  assert.equal(s.ctx.zoneFromTraffic, true);
  s.portal();
  assert.equal(s.edges[0].from, 'A');
});

test('confirmed screen correction still replaces a traffic zone after a missed transition', () => {
  const s = session();
  s.zone('A', 'traffic');
  s.zone('B', undefined, false);
  s.zone('B', undefined, false);
  assert.equal(s.ctx.currentZone, 'B');
  assert.equal(s.ctx.zoneFromTraffic, false);
  assert.deepEqual(s.positions, ['A', 'B']);
  s.portal();
  assert.equal(s.edges.length, 0);
  assert.equal(s.ctx.parking.size(), 1);
});

test('traffic confirmation upgrades the same screen zone; later screen checks keep it', () => {
  const s = session();
  s.zone('A');
  assert.equal(s.ctx.zoneFromTraffic, false);
  s.zone('A', 'traffic');
  s.zone('A');
  assert.equal(s.ctx.zoneFromTraffic, true);
  s.zone('B', 'traffic');
  s.zone('B');
  s.portal();
  assert.equal(s.edges[0].from, 'B');
});

test('screen-only startup does not acquire traffic trust just because the socket is open', () => {
  const s = session();
  s.zone('A');
  s.zone('A');
  s.portal();
  assert.equal(s.ctx.zoneFromTraffic, false);
  assert.equal(s.edges.length, 0);
});

test('stopped traffic or switching to screen keeps the unreadable-strip safeguard', () => {
  for (const stop of [s => { s.ctx.traffic = null; }, s => { s.ctx.config.zoneSource = 'screen'; }]) {
    const s = session();
    s.zone('A', 'traffic');
    stop(s);
    s.portal();
    assert.equal(s.edges.length, 0);
    assert.equal(s.ctx.parking.size(), 1);
  }
});

test('explicit manual position is not passed off as a traffic confirmation', () => {
  const s = session();
  s.zone('A', 'traffic');
  s.zone('A', undefined, true, true);
  assert.equal(s.ctx.zoneFromTraffic, false);
});
