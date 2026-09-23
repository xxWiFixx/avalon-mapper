const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const portalTime = require('../lib/portal-time');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
function productionFunction(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = /\r?\n\}\r?\n/.exec(source.slice(start));
  assert.ok(end);
  return source.slice(start, start + end.index + end[0].length);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function session() {
  const messages = [], writes = [], copied = [], timers = new Map();
  let timerId = 0;
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, performance, Date, Object, portalTime,
    portalPreviewSequence: 0, portalPreview: null,
    overlayReady: true, overlayTimer: null, overlayFadeTimer: null, overlaySetup: false,
    setupBackup: null, lastBlock: '', quitting: false, search: null, guide: null,
    overlaysHidden: () => false, suspendedOverlay: false,
    BUSY_MAX_MS: 12000, OVERLAY_FADE_MS: 260,
    config: { overlayEnabled: true, overlayMap: true, overlayHoldSec: 7, copyWorldZone: true, zoneSource: 'traffic', zoneWatch: true },
    overlay: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
      showInactive() {}, setAlwaysOnTop() {}, isAlwaysOnTop: () => true, hide() {},
      setIgnoreMouseEvents() {}, setFocusable() {}, show() {}, focus() {},
    },
    placeOverlay() {}, blocked() {}, pushConfig() {}, sendSetupFrame() {},
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id), setImmediate: () => {},
    F: { toFrame: async frame => frame },
    zoneRevision: 0, currentZone: 'Origin', zoneSeenAt: 100, zonePlan: () => ({ expires: false }),
    origin: { decide: () => ({ origin: 'Origin' }) },
    clipboard: { writeText: name => copied.push(name) },
    saveEdge: (from, tip) => { const edge = { from, to: tip.name }; writes.push(edge); return edge; },
    send: (channel, payload) => messages.push({ channel, payload }),
    store: { snapshot: () => ({ edges: writes }) },
    saveFailShot() {}, bindingLabel: () => 'Mouse5',
    queue: [], ocrBusy: false, running: null, isPress: kind => kind === 'hotkey',
  });
  vm.runInContext([
    'beginPortalPreview', 'cancelPortalPreview', 'portalPreviewCurrent', 'showPortalPreview',
    'overlayBlocked', 'showOverlay', 'showBusy', 'hideOverlay', 'startOverlaySetup',
    'openSearch', 'processFrame', 'finishFrame', 'applyTip', 'pump',
  ].map(productionFunction).join('\n'), ctx);
  return { ctx, messages, writes, copied, timers,
    shows: () => messages.filter(m => m.channel === 'overlay-show').map(m => m.payload),
  };
}
const zone = { name: 'Longmarch Meadow', color: 'blue', tier: 5 };
const complete = { ...zone, capNum: 4, capMax: 7, closes: 3600 };

test('the name shows before detail OCR completes, with no graph, clipboard or main-map writes', async () => {
  const s = session(), pending = deferred();
  s.ctx.recognize = { recognizeTooltip: async (_, opts) => { opts.onName(zone); return pending.promise; } };
  const previewId = s.ctx.beginPortalPreview();
  const work = s.ctx.processFrame({}, { withTooltip: true, withZone: false, kind: 'hotkey', previewId });
  await turn();
  assert.equal(s.shows().length, 1);
  assert.equal(s.shows()[0].tip.name, zone.name);
  assert.equal(s.shows()[0].partial, true);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.copied, []);
  assert.deepEqual(s.messages.map(m => m.channel), ['overlay-show']);
  pending.resolve(complete);
  await work;
  assert.deepEqual(s.writes, [{ from: 'Origin', to: zone.name }]);
  assert.deepEqual(s.copied, [zone.name]);
  assert.equal(s.shows()[1].partial, undefined);
  assert.equal(s.shows()[1].tip.capMax, 7);
  assert.equal(s.ctx.portalPreviewCurrent(previewId), false);
});

test('a newer capture owns the overlay, but the older completed portal still follows normal recording', async () => {
  const s = session(), pending = deferred();
  let report;
  s.ctx.recognize = { recognizeTooltip: async (_, opts) => { report = opts.onName; return pending.promise; } };
  const oldId = s.ctx.beginPortalPreview();
  const work = s.ctx.processFrame({}, { withTooltip: true, withZone: false, kind: 'hotkey', previewId: oldId });
  await turn();
  const newId = s.ctx.beginPortalPreview();
  s.ctx.showBusy(newId);
  report(zone);
  pending.resolve(complete);
  await work;
  assert.equal(s.shows().length, 1);
  assert.equal(s.shows()[0].busy, true);
  assert.equal(s.writes.length, 1);
  s.ctx.showPortalPreview(newId, { name: 'Touos-Ataglos', color: 'avalon' });
  assert.equal(s.shows()[1].tip.name, 'Touos-Ataglos');
});

test('the previous result timer cannot cancel a new asynchronous capture', () => {
  const s = session();
  s.ctx.showOverlay({ tip: complete });
  assert.equal(s.timers.size, 1);
  const id = s.ctx.beginPortalPreview();
  assert.equal(s.timers.size, 0);
  assert.equal(s.ctx.portalPreviewCurrent(id), true);
  s.ctx.showBusy(id);
  assert.equal([...s.timers.values()][0].ms, 12000);
});

test('hiding, searching and configuring the overlay permanently invalidate an in-flight preview', () => {
  for (const mode of ['hide', 'search', 'setup']) {
    const s = session(), id = s.ctx.beginPortalPreview();
    s.ctx.showPortalPreview(id, zone);
    if (mode === 'hide') s.ctx.hideOverlay(true);
    else if (mode === 'search') {
      s.ctx.search = { isDestroyed: () => false, focus() {} };
      s.ctx.searchMode = 'lookup';
      s.ctx.openSearch('lookup');
      s.ctx.search = null; // even closing the newer surface does not revive old OCR
    } else {
      s.ctx.startOverlaySetup();
      s.ctx.overlaySetup = false;
    }
    s.ctx.showPortalPreview(id, zone);
    s.ctx.showBusy(id);
    s.ctx.showOverlay({ tip: complete }, id);
    assert.equal(s.shows().length, 1, mode);
    assert.equal(s.ctx.portalPreviewCurrent(id), false, mode);
  }
});

test('completion and manual lookup reject later name callbacks; loading also has a bounded lifetime', () => {
  const s = session(), id = s.ctx.beginPortalPreview();
  s.ctx.showPortalPreview(id, zone);
  assert.equal([...s.timers.values()][0].ms, 12000);
  s.ctx.showOverlay({ tip: complete }, id);
  s.ctx.showPortalPreview(id, zone);
  assert.equal(s.shows().length, 2);
  const nextId = s.ctx.beginPortalPreview();
  s.ctx.showOverlay({ tip: { name: 'Touos-Ataglos' }, lookup: true });
  s.ctx.showPortalPreview(nextId, zone);
  assert.equal(s.shows().length, 3);
  const finalId = s.ctx.beginPortalPreview();
  s.ctx.showPortalPreview(finalId, zone);
  [...s.timers.values()].at(-1).fn();
  s.ctx.showPortalPreview(finalId, zone);
  assert.equal(s.shows().length, 4);
});

test('an OCR failure after name preview replaces loading with an error and never records partial data', async () => {
  const s = session(), pending = deferred(), result = deferred();
  s.ctx.recognize = { recognizeTooltip: async (_, opts) => { opts.onName(zone); return pending.promise; } };
  const id = s.ctx.beginPortalPreview();
  s.ctx.queue.push({ kind: 'hotkey', frame: {}, withTooltip: true, withZone: false, previewId: id, at: Date.now(), resolve: result.resolve });
  const work = s.ctx.pump();
  await turn();
  assert.equal(s.shows()[0].partial, true);
  pending.reject(new Error('OCR stopped'));
  await work;
  assert.match((await result.promise).error, /OCR stopped/);
  assert.match(s.shows()[1].error, /OCR stopped/);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.copied, []);
  s.ctx.showPortalPreview(id, zone);
  assert.equal(s.shows().length, 2);
});

function renderer() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { hidden: false, textContent: '', innerHTML: '', style: {}, scrollHeight: 30,
        classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: (...names) => names.forEach(n => classes.delete(n)),
          toggle: (n, on) => on ? classes.add(n) : classes.delete(n) },
        getAttribute(name) { return this[name] || null; },
        removeAttribute(name) { delete this[name]; },
      });
    }
    return elements.get(id);
  }
  const events = {};
  const ctx = vm.createContext({
    window: { ZONE_ACTS: { roadTypeRu: type => type + ' — дорога', listActivities: () => [] }, api: { on: (name, fn) => { events[name] = fn; } } },
    document: { getElementById: element, querySelector: element, body: element('body') },
    console, setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/overlay.js'), 'utf8'), ctx);
  return { element, events, show: ctx.window.__overlayShow };
}

test('preview reserves detail cells without fabricated values, and preserves the map and known activities', () => {
  const { show, element } = renderer();
  const tip = { name: 'Touos-Ataglos', color: 'avalon', tier: 6, capMax: 20, closes: 300 };
  tip.activities = { type: 'L1 Outer', chests: {} };
  show({ tip, partial: true, waiting: true, noOrigin: true, staleOrigin: true, copied: 'ignored' });
  assert.match(element('ovMap').src, /Touos-Ataglos\.webp$/);
  assert.equal(element('ovName').textContent, tip.name);
  assert.match(element('ovCapacity').innerHTML, /Читаю параметры…/);
  assert.equal(element('ovStatusText').innerHTML, '');
  assert.equal(element('ovStatus').style.height, '0px');
  assert.doesNotMatch(element('ovCapacity').innerHTML, /size-20|cap-num/);
  assert.match(element('ovRoad').innerHTML, /L1 Outer/);
  assert.equal(element('ovTime').textContent, '');
  const src = element('ovMap').src;
  Object.defineProperty(element('ovMap'), 'src', { get: () => src, set: () => assert.fail('Reloaded unchanged map') });
  for (const id of ['ovPanel', 'ovRoad', 'ovActivities']) {
    const html = element(id).innerHTML;
    Object.defineProperty(element(id), 'innerHTML', { configurable: true, get: () => html, set: () => assert.fail('Replaced unchanged ' + id) });
  }
  show({ tip });
  assert.equal(element('ovStatusText').innerHTML, '');
  assert.equal(element('ovStatus').style.height, '0px');
  assert.match(element('ovCapacity').innerHTML, /size-20/);
  assert.equal(element('ovTime').textContent, '5м');
});

test('origin completion updates only its waiting portal and cannot resurrect a closed or replaced overlay', () => {
  const { show, element, events } = renderer();
  const tip = { name: 'Touos-Ataglos', color: 'avalon' };
  const waiting = { tip, waiting: true, pendingId: 1 };
  show(waiting);
  events['overlay-origin']({ pendingId: 2, from: 'Other' });
  assert.match(element('ovStatusText').innerHTML, /Уточняю текущую зону/);
  assert.equal(element('ovStatus').style.height, '30px');
  events['overlay-origin']({ pendingId: 1, from: 'Origin', tip: { ...tip, closes: 60 } });
  assert.equal(element('ovStatusText').innerHTML, '');
  assert.equal(element('ovStatus').style.height, '0px');
  assert.equal(element('ovTime').textContent, '1м');
  show(waiting);
  events['overlay-hide']({ instant: true });
  events['overlay-origin']({ pendingId: 1, from: 'Origin' });
  assert.equal(element('box').hidden, true);
  show({ tip: { ...tip, name: 'New portal' }, waiting: true, pendingId: 3 });
  events['overlay-origin']({ pendingId: 1, from: 'Origin' });
  assert.equal(element('ovName').textContent, 'New portal');
  assert.match(element('ovStatusText').innerHTML, /Уточняю текущую зону/);
  events['overlay-origin']({ pendingId: 3, originLost: true });
  assert.match(element('ovStatusText').innerHTML, /Повтори хоткей/);
});

test('parked portal completion sends an update with its own ID, including save failures', () => {
  for (const failed of [false, true]) {
    const s = session();
    s.ctx.parking = require('../lib/origin').createParking();
    s.ctx.config.saveLocal = true;
    if (failed) s.ctx.saveEdge = () => null;
    vm.runInContext(['flushParked', 'updateParkedOverlay', 'reportLost'].map(productionFunction).join('\n'), s.ctx);
    s.ctx.parking.park({ ...complete, __pendingId: 17 });
    s.ctx.flushParked('Origin');
    const update = s.messages.find(m => m.channel === 'overlay-origin').payload;
    assert.equal(update.pendingId, 17);
    assert.equal(update[failed ? 'notSaved' : 'from'], failed ? true : 'Origin');
  }
});
