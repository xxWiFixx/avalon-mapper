// Exercise the actual main-process handlers with inert windows and input events.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
require('../ui/zone-search');
const zones = require('../data-static/zone-data.json').map(z => ({ ...z, color: 'avalon' }));
for (const query of ['Peb Avo', 'pebavo', 'PEB-AVO']) {
  assert.equal(ZONE_SEARCH.search(zones, query)[0].name, 'Pebos-Avosrom');
}
const ipc = new EventEmitter();
const hook = new EventEmitter();
hook.start = () => {};
const events = [], previews = [], pending = [];
class Window extends EventEmitter {
  constructor() { super(); this.webContents = new EventEmitter(); this.webContents.send = () => {}; }
  isDestroyed() { return !!this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  setAlwaysOnTop() {}
  loadFile() {}
  focus() {}
}
const config = {
  binding: { type: 'key', code: 9, label: 'F9' },
  searchBinding: { type: 'key', code: 10, label: 'F10' },
};
let clock = 1000, saved = 0;
const ctx = vm.createContext({
  config, console, Date: { now: () => clock }, setImmediate: fn => pending.push(fn),
  require: () => ({ uIOhook: hook, UiohookKey: { F9: 9, F10: 10, Escape: 1 } }),
  saveConfig: () => saved++, send: (ch, data) => events.push([ch, data]),
  ipcMain: ipc, BrowserWindow: Window, path, __dirname, dragTimer: null,
  overlayBounds: () => ({ x: 0, y: 0, height: 500 }),
  screen: { getDisplayNearestPoint: () => ({ workArea: {} }) },
  place: { anchorTo: () => ({}) }, webPrefs: () => ({}), lockNavigation: () => {},
  recognize: {
    ZONE_INFO: new Map([...zones.map(z => [z.name, z]), ['Lymhurst', { color: 'city' }]]),
    zoneInfo: name => ({ name, color: 'avalon', tier: 6 }),
  },
  currentZone: 'Lymhurst', showOverlay: p => previews.push(p),
  applyZone: () => assert.fail('Lookup changed player position'),
  applyTip: () => assert.fail('Lookup attempted to record a portal'),
  store: { snapshot: () => assert.fail('Lookup touched map state') },
});
vm.runInContext(source.slice(source.indexOf('let uIOhook ='), source.indexOf('// ---------- захват экрана ----------')), ctx);
vm.runInContext(source.slice(source.indexOf('let search = null,'), source.indexOf("ipcMain.handle('open-shots'")), ctx);
vm.runInContext('setupHook()', ctx);
hook.emit('keydown', { keycode: 10 });
hook.emit('keydown', { keycode: 10 });
assert.equal(pending.length, 1, 'Holding lookup key must open only once');
pending.shift()();
assert.equal(vm.runInContext('searchMode', ctx), 'lookup');
const firstWindow = vm.runInContext('search', ctx);
hook.emit('keyup', { keycode: 10 });
clock += 1000;
hook.emit('keydown', { keycode: 10 });
pending.shift()();
assert.equal(vm.runInContext('search', ctx), null, 'Second press closes lookup without window focus');
assert.equal(firstWindow.isDestroyed(), true);
clock += 1000;
hook.emit('keydown', { keycode: 10 });
assert.equal(pending.length, 0, 'Holding the closing key must not reopen lookup');
hook.emit('keyup', { keycode: 10 });
hook.emit('keydown', { keycode: 10 });
pending.shift()();
assert.ok(vm.runInContext('search', ctx), 'Third press opens lookup again');
const sender = vm.runInContext('search.webContents', ctx);
ipc.emit('search-pick', { sender: {} }, { name: 'Pebos-Avosrom' });
ipc.emit('search-pick', { sender }, { name: 'Lymhurst' });
assert.equal(previews.length, 0, 'Foreign sender and world zone must be rejected');
// Even Ctrl+Enter / a portal-shaped payload stays a lookup: mode is owned by main.
ipc.emit('search-pick', { sender }, { name: 'Pebos-Avosrom', mode: 'here', closes: 300, capMax: 20 });
assert.equal(previews.length, 1);
assert.equal(previews[0].lookup, true);
assert.equal(previews[0].showMap, true);
assert.equal(ctx.currentZone, 'Lymhurst');
assert.equal(events.filter(([ch]) => ch === 'zone-preview').length, 1);
assert.equal(saved, 0);
hook.emit('keyup', { keycode: 10 });
clock += 1000;
vm.runInContext("captureTarget = 'searchBinding'; captureResolve = () => {}", ctx);
hook.emit('keydown', { keycode: 9 });
assert.equal(config.searchBinding.code, 10, 'Conflicting bind must preserve old setting');
assert.equal(saved, 0);
vm.runInContext("captureTarget = 'searchBinding'; captureResolve = () => {}", ctx);
hook.emit('mousedown', { button: 4 });
assert.equal(config.searchBinding.button, 4);
assert.equal(saved, 1);
hook.emit('mousedown', { button: 4 });
assert.equal(pending.length, 1, 'Mouse binding must open lookup');
pending.shift()();
assert.equal(vm.runInContext('searchMode', ctx), 'lookup');
clock += 1000;
hook.emit('mousedown', { button: 4 });
pending.shift()();
assert.equal(vm.runInContext('search', ctx), null, 'Repeated mouse hotkey closes lookup too');
assert.equal(previews.length, 1, 'Closing lookup must not select a zone');
console.log('Lookup: keyboard/mouse toggle, repeat protection, abbreviations, rebind, conflict, sender checks and read-only selection passed.');
