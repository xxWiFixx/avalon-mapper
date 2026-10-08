'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadFlow } = require('./helpers/manual-portal-flow');

function session(overrides = {}) {
  const hook = new EventEmitter(), ipc = new EventEmitter();
  hook.start = () => {};
  const handlers = {}, pending = [], windows = [], saved = [], uploads = [], messages = [], overlays = [];
  ipc.handle = (name, callback) => { handlers[name] = callback; };
  const keys = { Escape: 1, F4: 4, F5: 5, F6: 6, F7: 7, F8: 8, F9: 9, F10: 10, F11: 11 };
  let clock = 1000, writes = 0, captures = 0;
  class Window extends EventEmitter {
    constructor() {
      super(); windows.push(this); this.webContents = new EventEmitter();
      this.webContents.send = (...args) => { this.init = args; };
    }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    setAlwaysOnTop() {}
    setContentProtection() {}
    loadFile() {}
    show() { this.shown = true; }
    focus() {}
  }
  const config = { binding: { type: 'key', code: 9, label: 'F9' },
    manualBinding: { type: 'key', code: 8, label: 'F8' },
    searchBinding: { type: 'key', code: 10, label: 'F10' }, overlayToggleBinding: null,
    zoneSource: 'traffic', zoneWatch: true, autoRecordPortals: false, saveLocal: true, nick: 'test',
    ...overrides };
  const info = { color: 'avalon', tier: 6, quality: 2, activities: [] };
  const ctx = vm.createContext({ config, profile: { secondary: false }, Date: { now: () => clock }, console,
    i18nText: require('../lib/i18n').t, setImmediate: callback => pending.push(callback),
    require: () => ({ uIOhook: hook, UiohookKey: keys }),
    ipcMain: ipc, BrowserWindow: Window, path, __dirname: path.resolve(__dirname, '..'),
    overlayCapture: require('../lib/overlay-capture'),
    overlayBounds: () => ({ x: 0, y: 0, height: 500 }),
    screen: { getDisplayNearestPoint: () => ({ workArea: {} }) },
    place: { anchorTo: () => ({}) }, webPrefs: () => ({}), lockNavigation() {},
    saveConfig() { writes++; }, send: (channel, data) => messages.push({ channel, data }),
    recognize: { ZONE_INFO: new Map([['Coues-Exakrom', info], ['Origin', info]]), zoneInfo: () => info },
    currentZone: 'Origin', zoneSeenAt: clock, zoneRevision: 0,
    readsScreen: () => false, dragTimer: null, overlaySetup: false,
    overlaysHidden: () => false, hideOverlay() {}, cancelPortalPreview() {},
    captureZoneStrip: () => assert.fail('Manual input captured the tooltip or origin in traffic mode'),
    subscriptions: { capture: () => { captures++; assert.fail('Manual entry used automatic quota'); } },
    store: { addEdge: (from, tip, by, source, maps) => {
      const edge = { a: from, b: tip.name, ...tip, by, source, maps }; saved.push(edge); return edge;
    }, snapshot: () => ({ edges: saved }) },
    net: { status: () => ({ targets: ['personal', 'friends'] }), push: edge => uploads.push(edge) },
    portalTime: require('../lib/portal-time'), origin: require('../lib/origin'),
    zonePlan: () => ({ expires: false }), showOverlay: data => overlays.push(data),
    applyZone: zone => { ctx.currentZone = zone.zone; },
  });
  loadFlow(ctx); vm.runInContext('setupHook()', ctx);
  return { ctx, config, hook, ipc, handlers, pending, saved, uploads, messages, overlays, windows, keys,
    advance: () => { clock += 1000; }, writes: () => writes, captures: () => captures,
    flush: () => { while (pending.length) pending.shift()(); },
    search: () => vm.runInContext('search', ctx) };
}

test('manual key opens and closes the portal form once per press, independently of recognition', () => {
  const s = session();
  s.hook.emit('keydown', { keycode: 8 });
  s.hook.emit('keydown', { keycode: 8 });
  assert.equal(s.pending.length, 1);
  assert.equal(s.windows.length, 0, 'Input hook must return before creating a window');
  s.flush();
  const opened = s.search();
  opened.webContents.emit('did-finish-load');
  assert.equal(opened.init[1].mode, 'portal');
  assert.equal(opened.init[1].binding, 'F8');
  assert.equal(opened.init[1].here, 'Origin');
  assert.equal(opened.shown, true);
  s.hook.emit('keyup', { keycode: 8 }); s.advance();
  s.hook.emit('keydown', { keycode: 8 }); s.flush();
  assert.equal(s.search(), null);
  s.advance(); s.hook.emit('keydown', { keycode: 8 });
  assert.equal(s.pending.length, 0, 'Held closing key must not reopen the form');
  assert.equal(s.saved.length, 0); assert.equal(s.captures(), 0);
});

test('manual key replaces the guide with an editable portal form and Esc never saves', () => {
  const s = session();
  s.ctx.openSearch('lookup'); const guide = s.search();
  s.hook.emit('keydown', { keycode: 8 }); s.flush();
  assert.equal(guide.destroyed, true);
  assert.equal(vm.runInContext('searchMode', s.ctx), 'portal');
  s.ipc.emit('search-close', { sender: {} });
  assert.ok(s.search(), 'Foreign windows cannot close the form');
  s.ipc.emit('search-close', { sender: s.search().webContents });
  assert.equal(s.search(), null);
  assert.equal(s.saved.length, 0); assert.equal(s.captures(), 0);
});

test('manual form submits a timed portal locally and to enabled cloud maps with no quota claim', () => {
  const s = session();
  s.hook.emit('keydown', { keycode: 8 }); s.flush();
  const payload = { name: 'Coues-Exakrom', mode: 'portal', closes: 4500, capMax: 20 };
  s.ipc.emit('search-pick', { sender: {} }, payload);
  assert.equal(s.saved.length, 0);
  const before = Date.now();
  s.ipc.emit('search-pick', { sender: s.search().webContents }, payload);
  assert.equal(s.search(), null);
  assert.equal(s.saved.length, 1); assert.equal(s.uploads.length, 1); assert.equal(s.captures(), 0);
  const edge = s.saved[0];
  assert.equal(edge.a, 'Origin'); assert.equal(edge.b, 'Coues-Exakrom');
  assert.equal(edge.source, 'manual'); assert.equal(edge.capMax, 20);
  assert.deepEqual(Array.from(edge.maps), ['local', 'personal', 'friends']);
  assert.ok(edge.expiresAt >= before + 4500000 && edge.expiresAt <= Date.now() + 4500000);
  assert.equal(s.overlays[0].manual, true);
  assert.equal(s.messages.filter(message => message.channel === 'edge-added').length, 1);
});

test('Ctrl+Enter sets the origin without using quota or recording a portal', () => {
  const s = session(); s.ctx.openSearch('portal');
  s.ipc.emit('search-pick', { sender: s.search().webContents }, { name: 'Coues-Exakrom', mode: 'here' });
  assert.equal(s.ctx.currentZone, 'Coues-Exakrom');
  assert.equal(s.saved.length, 0); assert.equal(s.captures(), 0); assert.equal(s.search(), null);
});

test('manual binding rejects conflicts, can move to a side mouse button, and persists', async () => {
  const s = session();
  const conflicted = s.handlers['capture-binding']({}, 'manualBinding');
  s.hook.emit('keydown', { keycode: 9 });
  assert.equal(await conflicted, 'F8'); assert.equal(s.writes(), 0);
  assert.equal(s.config.manualBinding.code, 8);
  const changed = s.handlers['capture-binding']({}, 'manualBinding');
  s.hook.emit('mousedown', { button: 4 });
  assert.equal(await changed, 'Mouse4'); assert.equal(s.writes(), 1);
  s.hook.emit('mousedown', { button: 4 }); s.flush(); assert.ok(s.search());
  s.advance(); s.hook.emit('mousedown', { button: 4 }); s.flush(); assert.equal(s.search(), null);
  const cancel = s.handlers['capture-binding']({}, 'manualBinding');
  s.hook.emit('keydown', { keycode: 1 }); assert.equal(await cancel, 'Mouse4');
  assert.equal(s.writes(), 1);
  const other = s.handlers['capture-binding']({}, 'searchBinding');
  s.hook.emit('mousedown', { button: 4 }); assert.equal(await other, 'F10');
  assert.equal(s.writes(), 1, 'Other actions cannot take the manual binding');
});

test('upgrade assigns F8 when available and preserves all existing keyboard and mouse bindings', () => {
  const s = session({ manualBinding: null });
  s.ctx.initializeHotkeyBindings(); assert.equal(s.config.manualBinding.label, 'F8');
  assert.equal(s.writes(), 1); s.ctx.initializeHotkeyBindings(); assert.equal(s.writes(), 1);
  const occupied = session({ manualBinding: null, overlayToggleBinding: { type: 'key', code: 8, label: 'F8' } });
  occupied.ctx.initializeHotkeyBindings(); assert.equal(occupied.config.manualBinding.label, 'F7');
  assert.equal(occupied.config.overlayToggleBinding.label, 'F8');
  const mouse = session({ manualBinding: { type: 'mouse', button: 5, label: 'Mouse5' } });
  mouse.ctx.initializeHotkeyBindings(); assert.equal(mouse.config.manualBinding.label, 'Mouse5');
  assert.equal(mouse.writes(), 0);
});

test('debounce protects side mouse presses and hidden overlays do not launch background capture', () => {
  const s = session({ manualBinding: { type: 'mouse', button: 4, label: 'Mouse4' } });
  s.hook.emit('mousedown', { button: 4 }); s.hook.emit('mousedown', { button: 4 });
  assert.equal(s.pending.length, 1); s.flush();
  s.ctx.closeSearch(); s.advance(); s.ctx.overlaysHidden = () => true;
  s.hook.emit('mousedown', { button: 4 }); s.flush();
  assert.equal(s.search(), null); assert.equal(s.windows.length, 1);
});
