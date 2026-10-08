'use strict';
// Run with Node. Real Windows input hook and secure Electron forms; isolated
// settings/map, no live account, tooltip capture, OCR worker or cloud requests.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { windowsHide: true, stdio: 'inherit', env: environment });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code; });
} else {
  const { app, BrowserWindow, ipcMain, screen } = require('electron');
  const vm = require('node:vm'), i18n = require('../lib/i18n'), store = require('../lib/store');
  const { webPrefs } = require('../lib/win-prefs'), place = require('../lib/overlay-place');
  const { loadFlow } = require('./helpers/manual-portal-flow');
  const { uIOhook, UiohookKey } = require('uiohook-napi');
  const out = path.resolve(__dirname, '../../out'); fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(out, 'manual-portal-native-')); app.setPath('userData', root);
  store.setDataDir(root); store.load();
  const config = { language: 'ru', theme: 'dark', onboardingSeen: true, zoneSource: 'traffic', zoneWatch: true,
    autoRecordPortals: false, saveLocal: true, nick: 'Hotkey test', overlayEnabled: true,
    overlayMap: true, overlayScale: 1, overlayHoldSec: 7, rooms: [], appVersion: require('../package.json').version };
  const errors = [], uploads = [], overlays = [], checks = [];
  let main, context, claims = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(check, label) {
    const end = Date.now() + 9000;
    while (Date.now() < end) { if (await check()) return; await delay(40); }
    throw new Error('Timed out: ' + label);
  }
  function record(label) { checks.push(label); console.log('PASS: ' + label); }
  function persist() { fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config)); }
  const deadline = setTimeout(() => { uIOhook.stop(); app.exit(2); }, 60000);
  ipcMain.on('get-language', event => { event.returnValue = config.language; });
  const handlers = { 'get-config': () => ({ ...config }), 'get-map': () => store.snapshot(), 'get-zone-names': () => [],
    'get-metrics': () => ({ enabled: false, fame: 0, rows: [] }), 'auth-status': () => ({ signedIn: false }),
    'update-status': () => ({}), 'rooms-list': () => ({ ok: true, rooms: [] }) };
  const preload = fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8');
  for (const match of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) {
    if (match[1] !== 'capture-binding' && !handlers[match[1]]) handlers[match[1]] = () => ({ ok: true });
  }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  app.on('web-contents-created', (_, contents) => {
    contents.on('preload-error', (_, __, error) => errors.push(error.message));
    contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  });
  const searchWindow = () => vm.runInContext('search', context);
  async function tap(code) {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) uIOhook.keyTap(code);
    else {
      // Windows may decline background focus after a popup closes. Never inject
      // keys into the user's foreground app: exercise the same hook callbacks.
      uIOhook.emit('keydown', { keycode: code });
      uIOhook.emit('keyup', { keycode: code });
    }
  }
  async function open() {
    await delay(400); await tap(config.manualBinding.code);
    await waitFor(() => searchWindow()?.isVisible() && searchWindow()?.isFocused(), 'manual form opens');
    const win = searchWindow();
    assert.equal(await win.webContents.executeJavaScript('document.activeElement.id'), 'q');
    assert.equal(await win.webContents.executeJavaScript('typeof require'), 'undefined');
    return win;
  }
  async function type(win, text) {
    await win.webContents.executeJavaScript(`document.getElementById('q').value=${JSON.stringify(text)};document.getElementById('q').dispatchEvent(new Event('input'));true`);
  }
  function enter(win, modifiers = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers });
  }
  async function screenshot(win, name) {
    if (win === main) await waitFor(() => win.webContents.executeJavaScript(`document.getElementById('app-splash').hidden`), 'startup animation finishes before screenshot');
    await delay(180); fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  }
  app.whenReady().then(async () => {
    const avalons = require('../data-static/zone-data.json').map(zone => ({ ...zone, color: 'avalon' }));
    const world = require('../data-static/royal-zones.json');
    const zones = new Map(avalons.concat(world).map(zone => [zone.name, zone]));
    context = vm.createContext({ config, profile: { secondary: false }, Date, setImmediate, console, require,
      // Keep test popups owned by the isolated test window, so closing one
      // returns Windows focus to this test rather than the user's other apps.
      ipcMain, BrowserWindow: function TestWindow(options) { return new BrowserWindow({ ...options, parent: main }); },
      screen, path, __dirname: path.resolve(__dirname, '..'), webPrefs, place,
      i18nText: i18n.t, overlayCapture: require('../lib/overlay-capture'),
      overlayBounds: () => { const area = screen.getPrimaryDisplay().workArea; return { x: area.x + 60, y: area.y + 80, width: 340, height: 430 }; },
      overlaysHidden: () => false, hideOverlay() {}, cancelPortalPreview() {}, lockNavigation() {},
      overlaySetup: false, dragTimer: null, damageWindowControls: null,
      currentZone: 'Lymhurst', zoneSeenAt: Date.now(), zoneRevision: 0,
      recognize: { ZONE_INFO: zones, zoneInfo: name => zones.get(name) }, readsScreen: () => false,
      captureZoneStrip: () => assert.fail('Manual hotkey captured the game'),
      saveConfig: persist, send: (channel, payload) => main?.webContents.send(channel, payload),
      store, net: { status: () => ({ targets: [] }), push: edge => uploads.push(edge) },
      subscriptions: { capture: () => { claims++; assert.fail('Manual input spent automatic quota'); } },
      portalTime: require('../lib/portal-time'), origin: require('../lib/origin'), zonePlan: () => ({ expires: false }),
      showOverlay: payload => overlays.push(payload),
      applyZone: zone => { context.currentZone = zone.zone; context.zoneSeenAt = Date.now(); },
    });
    loadFlow(context); vm.runInContext('setupHook(); initializeHotkeyBindings();', context);
    assert.equal(config.manualBinding.label, 'F8');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).manualBinding.label, 'F8');
    main = new BrowserWindow({ show: false, width: 1440, height: 1000, title: 'Avalon Mapper — hotkey test',
      webPreferences: webPrefs(path.join(__dirname, '../preload.js')) });
    main.webContents.on('did-finish-load', () => main.webContents.send('splash-start'));
    await main.loadFile(path.join(__dirname, '../ui/index.html')); main.show(); main.focus();
    await waitFor(() => main.isFocused(), 'test main window focus');
    await main.webContents.executeJavaScript(`openModal('modal-settings','set-hotkeys');true`);
    assert.equal(await main.webContents.executeJavaScript(`document.getElementById('manual-bind-label').textContent`), 'F8');
    await screenshot(main, 'manual-portal-hotkeys-ru.png');

    let form = await open();
    assert.equal(await form.webContents.executeJavaScript('document.title'), 'Куда ведёт портал');
    await delay(400); await tap(UiohookKey.F8);
    await waitFor(() => searchWindow() === null, 'same hotkey closes manual entry');
    record('real F8 opens a focused form; second F8 closes it without recording');

    main.focus();
    form = await open(); await type(form, 'couexa'); enter(form);
    await waitFor(() => form.webContents.executeJavaScript(`document.getElementById('echo').classList.contains('bad')`), 'missing time validation');
    assert.equal(searchWindow(), form); assert.equal(store.snapshot().edges.length, 0);
    await type(form, 'couexa 0'); enter(form);
    assert.equal(store.snapshot().edges.length, 0);
    await type(form, 'couexa 1 15');
    // Use the actual button coordinates, since font metrics can move the size row.
    const button = await form.webContents.executeJavaScript(`(() => {const r=document.querySelector('[data-size="20"]').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    form.webContents.sendInputEvent({ type: 'mouseDown', ...button, button: 'left', clickCount: 1 });
    form.webContents.sendInputEvent({ type: 'mouseUp', ...button, button: 'left', clickCount: 1 });
    await screenshot(form, 'manual-portal-form-ru.png');
    const before = Date.now(); enter(form);
    await waitFor(() => searchWindow() === null && store.snapshot().edges.length === 1, 'manual record saved');
    const edge = store.snapshot().edges[0];
    assert.deepEqual([edge.a, edge.b].sort(), ['Coues-Exakrom', 'Lymhurst']);
    assert.equal(edge.capMax, 20); assert.equal(edge.source, 'manual');
    assert.ok(edge.expiresAt >= before + 4500000 && edge.expiresAt <= Date.now() + 4500000);
    assert.equal(claims, 0); assert.equal(uploads.length, 1); assert.equal(overlays[0].manual, true);
    store.flush(); assert.ok(fs.existsSync(path.join(root, 'map.json')));
    record('real form validates missing/zero time and saves a 20-player portal with 75-minute expiry, no quota or network');

    main.focus();
    form = await open(); await type(form, 'Pebos-Avosrom'); enter(form, ['control']);
    await waitFor(() => context.currentZone === 'Pebos-Avosrom' && searchWindow() === null, 'Ctrl+Enter sets origin');
    assert.equal(store.snapshot().edges.length, 1); assert.equal(claims, 0);
    record('Ctrl+Enter sets the origin without adding an edge');

    main.focus();
    await main.webContents.executeJavaScript(`document.getElementById('manual-bind-btn').click();true`);
    await waitFor(() => vm.runInContext('!!captureResolve', context), 'binding capture');
    await tap(UiohookKey.F7);
    await waitFor(() => config.manualBinding.label === 'F7', 'manual binding changed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).manualBinding.label, 'F7');
    main.reload(); await waitFor(async () => {
      try { return await main.webContents.executeJavaScript(`document.getElementById('manual-bind-label').textContent==='F7'`); } catch { return false; }
    }, 'binding survives page reload');
    record('the Settings button captures F7, persists it and shows it after reload');

    config.language = 'en'; i18n.setLanguage('en'); persist();
    main.webContents.send('language-changed', 'en'); main.reload();
    await waitFor(async () => { try { return await main.webContents.executeJavaScript(`document.documentElement.lang==='en'`); } catch { return false; } }, 'English settings');
    await main.webContents.executeJavaScript(`openModal('modal-settings','set-hotkeys');true`);
    await screenshot(main, 'manual-portal-hotkeys-en.png');
    main.focus();
    form = await open(); await type(form, 'couexa 5 36');
    assert.equal(await form.webContents.executeJavaScript('document.title'), 'Portal destination');
    await screenshot(form, 'manual-portal-form-en.png');
    form.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    form.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(() => searchWindow() === null, 'Escape closes form');
    assert.equal(store.snapshot().edges.length, 1); assert.equal(claims, 0);
    record('rebound F7 opens the English form; Escape leaves the map and allowance unchanged');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'manual-portal-native-review.json'), JSON.stringify({ checks, errors, quotaClaims: claims, root }, null, 2));
  }).then(() => { clearTimeout(deadline); uIOhook.stop(); store.flush(); app.exit(0); })
    .catch(error => { console.error(error); clearTimeout(deadline); uIOhook.stop(); store.flush(); app.exit(1); });
}
