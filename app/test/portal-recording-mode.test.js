'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const portalTime = require('../lib/portal-time');
const origin = require('../lib/origin');
const code = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function productionFunction(name) {
  let start = code.indexOf('function ' + name + '(');
  assert.notEqual(start, -1);
  if (code.slice(start - 6, start) === 'async ') start -= 6;
  const end = /\r?\n\}\r?\n/.exec(code.slice(start));
  return code.slice(start, start + end.index + end[0].length);
}
function session(autoRecordPortals = false) {
  const overlays = [], messages = [], saved = [], uploads = [], quota = [], originUpdates = [], copied = [];
  const ctx = vm.createContext({ Date, performance, Promise, console: { log() {}, warn() {}, error() {} },
    i18nText: require('../lib/i18n').t, portalTime, origin,
    config: { autoRecordPortals, portalRecordingRevision: 0, saveLocal: true, nick: 'test',
      copyWorldZone: true, zoneWatch: true, zoneSource: 'traffic' },
    store: { addEdge: (from, tip) => { const edge = { a: from, b: tip.name, ...tip }; saved.push(edge); return edge; },
      snapshot: () => ({ edges: saved }) },
    net: { status: () => ({ targets: ['personal', 'friends'] }), push: edge => uploads.push(edge) },
    subscriptions: { capture: async (from, tip) => { quota.push({ from, tip }); return { ok: true, receipt: 'authorized' }; } },
    parking: origin.createParking(), currentZone: 'Origin', zoneSeenAt: Date.now(), zoneRevision: 0, quitting: false,
    zonePlan: () => ({ expires: false }), parkedSequence: 0, traffic: {}, trafficError: null,
    clipboard: { writeText: value => copied.push(value) },
    showOverlay: data => overlays.push(data), send: (channel, data) => messages.push({ channel, data }),
    updateParkedOverlay: (tip, data) => originUpdates.push({ tip, data }),
    reportLost() {}, watchParking() {}, kickPoll() {}, billingMessage: code => code,
  });
  vm.runInContext(['saveEdge', 'savePortal', 'applyTip', 'flushParked', 'finishFrame'].map(productionFunction).join('\n'), ctx);
  return { ctx, overlays, messages, saved, uploads, quota, originUpdates, copied };
}
const portal = () => ({ name: 'Destination', color: 'yellow', capMax: 7, capMaxKnown: true,
  expiresAt: Date.now() + 3600000 });

test('preview-only hotkey shows the portal and copies its name without writing to any map or spending quota', async () => {
  const s = session();
  await s.ctx.applyTip(portal());
  assert.equal(s.overlays.at(-1).recordingSkipped, true);
  assert.deepEqual(s.copied, ['Destination']);
  assert.equal(s.saved.length, 0); assert.equal(s.uploads.length, 0); assert.equal(s.quota.length, 0);
  assert.equal(s.messages.some(x => x.channel === 'edge-added'), false);
  s.ctx.currentZone = null; s.ctx.config.zoneSource = 'screen';
  await s.ctx.applyTip(portal());
  assert.equal(s.ctx.parking.size(), 0);
  assert.equal(s.overlays.at(-1).waiting, undefined);
});

test('switching recording back on saves normally; explicit manual entry stays available while it is off', async () => {
  const s = session();
  await s.ctx.applyTip(portal(), { manual: true });
  assert.equal(s.saved.length, 1); assert.equal(s.uploads.length, 1); assert.equal(s.quota.length, 0);
  s.ctx.config.autoRecordPortals = true;
  await s.ctx.applyTip({ ...portal(), name: 'Another destination' });
  assert.equal(s.saved.length, 2); assert.equal(s.uploads.length, 2); assert.equal(s.quota.length, 0);
  assert.equal(s.saved[1].captureReceipt, undefined);
});

test('preview intent is kept through OCR delays and changing the zone, even after enabling recording', async () => {
  const s = session(true);
  await s.ctx.finishFrame({ tip: portal() }, null, { kind: 'hotkey', withTooltip: true,
    observation: { revision: -1, source: 'screen', autoRecordPortals: false, recordingRevision: 0 } });
  assert.equal(s.overlays.at(-1).recordingSkipped, true);
  assert.equal(s.quota.length, 0); assert.equal(s.uploads.length, 0);
  assert.equal(s.messages.some(x => x.channel === 'toast'), false);
  s.ctx.config.portalRecordingRevision = 1;
  await s.ctx.finishFrame({ tip: portal() }, null, { kind: 'hotkey', withTooltip: true,
    observation: { revision: 0, source: 'traffic', autoRecordPortals: true, recordingRevision: 0 } });
  assert.equal(s.quota.length, 0); assert.equal(s.saved.length, 0);
});

test('disabling recording cancels parked automatic portals, including after reenabling; manual parked entries are preserved', async () => {
  const s = session(true);
  s.ctx.currentZone = null; s.ctx.config.zoneSource = 'screen';
  await s.ctx.applyTip(portal());
  assert.equal(s.ctx.parking.size(), 1);
  s.ctx.config.autoRecordPortals = false;
  await s.ctx.flushParked('Origin');
  assert.equal(s.originUpdates.at(-1).data.recordingSkipped, true);
  assert.equal(s.quota.length, 0); assert.equal(s.saved.length, 0);
  s.ctx.config.autoRecordPortals = true;
  await s.ctx.applyTip(portal());
  s.ctx.config.portalRecordingRevision++;
  await s.ctx.flushParked('Origin');
  assert.equal(s.quota.length, 0); assert.equal(s.saved.length, 0);
  await s.ctx.applyTip(portal(), { manual: true });
  s.ctx.config.autoRecordPortals = false;
  await s.ctx.flushParked('Origin');
  assert.equal(s.saved.length, 1); assert.equal(s.quota.length, 0);
});

test('the final automatic write gate also honors preview mode and outdated recording intent', async () => {
  const s = session(); const results = [];
  await s.ctx.savePortal('Origin', portal(), 'ocr', (...args) => results.push(args));
  assert.equal(results[0][2], true);
  s.ctx.config.autoRecordPortals = true; s.ctx.config.portalRecordingRevision = 1;
  await s.ctx.savePortal('Origin', { ...portal(), __recordingRevision: 0 }, 'ocr', (...args) => results.push(args));
  assert.equal(results[1][2], true);
  assert.equal(s.quota.length, 0); assert.equal(s.uploads.length, 0);
});

test('the setting is validated, persisted and returned to the UI; turning it off invalidates earlier captures', () => {
  const handlers = new Map(), snapshots = [];
  const config = { autoRecordPortals: true, portalRecordingRevision: 0 };
  const ctx = vm.createContext({ config, console: { log() {}, warn() {} }, i18nText: text => text,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    configForWindow: () => ({ ...config }), saveConfig: () => snapshots.push({ ...config }), flushConfig() {} });
  vm.runInContext(code.slice(code.indexOf('const OPTIONS = {'), code.indexOf('// ---------- комнаты ----------')), ctx);
  const set = handlers.get('set-option');
  set({}, 'autoRecordPortals', false);
  assert.equal(snapshots.at(-1).autoRecordPortals, false);
  assert.equal(config.portalRecordingRevision, 1);
  set({}, 'autoRecordPortals', false); assert.equal(config.portalRecordingRevision, 1);
  const applied = set({}, 'autoRecordPortals', true); assert.equal(config.autoRecordPortals, true);
  assert.equal(applied.autoRecordPortals, true);
  set({}, 'saveLocal', false); assert.equal(config.autoRecordPortals, true);
});
