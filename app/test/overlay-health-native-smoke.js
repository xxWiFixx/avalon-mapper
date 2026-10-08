'use strict';
// Actual main, sandboxed preloads and renderers; isolated state. No game capture,
// global hooks, network requests, visible test windows or real account data.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const project = path.resolve(__dirname, '../..');
fs.mkdirSync(path.join(project, 'out'), { recursive: true });
const source = process.env.MAPPER_OVERLAY_ASAR || path.join(project, 'app');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(require('electron'), [__filename], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code; });
} else {
  const { app, BrowserWindow, globalShortcut, powerMonitor, dialog } = require('electron');
  const profile = fs.mkdtempSync(path.join(project, 'out/overlay-health-native-'));
  app.setPath('userData', profile); app.setPath('sessionData', profile); app.setAppPath(source);
  if (source.endsWith('.asar')) Object.defineProperty(process, 'resourcesPath', { value: path.dirname(source) });
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({ nick: 'Overlay fixture', language: 'ru',
    rooms: [], onboardingSeen: true, zoneSource: 'off', zoneWatch: false, overlayEnabled: true,
    fameEnabled: true, damageEnabled: true, foodEnabled: true, saveShots: false, portalAudit: false }));
  fs.writeFileSync(path.join(profile, 'map.json'), '{}');
  for (const method of ['show', 'showInactive']) BrowserWindow.prototype[method] = function () { this._testVisible = true; };
  BrowserWindow.prototype.hide = function () { this._testVisible = false; };
  BrowserWindow.prototype.isVisible = function () { return this._testVisible === true; };
  globalShortcut.register = () => true; globalShortcut.unregisterAll = () => {}; globalShortcut.unregister = () => {};
  dialog.showErrorBox = (title, message) => { throw new Error(title + ': ' + message); };
  const hook = require(path.join(source, 'node_modules/uiohook-napi')).uIOhook;
  hook.start = () => {}; hook.stop = () => {};
  require(path.join(source, 'lib/privileges')).isElevated = async () => false;
  require(path.join(source, 'lib/recognize')).init = async () => {};
  let gameState = { found: true, focused: true, minimized: false };
  require(path.join(source, 'lib/game-window')).state = async () => gameState;
  let idleSeconds = 0; powerMonitor.getSystemIdleTime = () => idleSeconds;
  global.fetch = async () => { throw new Error('test_network_disabled'); };
  const metrics = require(path.join(source, 'lib/combat-metrics')), originalCreate = metrics.create;
  let combat;
  metrics.create = config => {
    combat = originalCreate(config);
    combat.foodSnapshot = () => ({ known: true, warning: true, alert: 'expiring', remainingMs: 30000 });
    return combat;
  };
  const errors = [], results = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = setTimeout(() => app.exit(2), 60000);
  const windows = () => BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
  const find = text => windows().find(window => window.webContents.getURL().includes(text));
  async function waitFor(fn, label) {
    for (let i = 0; i < 150; i++) { const result = fn(); if (result) return result; await delay(50); }
    throw new Error('Timed out: ' + label);
  }
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('preload-error', (_, __, error) => errors.push(error.message));
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  });
  app.whenReady().then(async () => {
    const main = await waitFor(() => find('/ui/index.html'), 'main');
    await waitFor(() => find('/ui/overlay.html') && find('/ui/food-overlay.html'), 'initial overlays');
    await delay(1200);
    await main.webContents.executeJavaScript("api.metricsAction('overlay-fame')");
    await main.webContents.executeJavaScript("api.metricsAction('overlay-damage')");
    const guid = number => Array(16).fill(number);
    combat.consume({ kind: 'response', code: 2, returnCode: 0, params: { 0: 1, 1: guid(1), 2: 'Fixture' } });
    combat.consume({ kind: 'event', code: metrics.CODE.PartyJoined, params: { 8: [guid(1), guid(2)], 9: ['Fixture', 'FixtureFriend'] } });
    combat.consume({ kind: 'event', code: metrics.CODE.UpdateFame, params: { 0: 1, 1: 100, 2: 1000000 } });
    combat.consume({ kind: 'event', code: metrics.CODE.HealthUpdate, params: { 0: 99, 2: -777, 6: 1 } });
    const before = combat.snapshot(); assert.ok(before.fame > 0); assert.equal(before.totalDamage, 777);
    const targets = ['/ui/overlay.html', '/ui/metrics.html?kind=fame', '/ui/metrics.html?kind=damage', '/ui/food-overlay.html'];
    for (const target of targets) {
      const old = await waitFor(() => find(target), target);
      assert.equal(old.webContents.getBackgroundThrottling(), false);
      assert.equal(old.webContents.getLastWebPreferences().sandbox, true);
      old.webContents.forcefullyCrashRenderer();
      const fresh = await waitFor(() => { const window = find(target); return window && window.id !== old.id && window; }, 'recovered ' + target);
      await waitFor(() => fresh.webContents.getURL().includes(target), 'loaded ' + target);
      await delay(200);
      assert.equal(await fresh.webContents.executeJavaScript('typeof window.api'), 'object');
      results.push({ phase: 'renderer-crash', kind: target, replaced: true });
    }
    const after = combat.snapshot(); assert.equal(after.fame, before.fame); assert.equal(after.overall.totalDamage, before.overall.totalDamage);
    assert.deepEqual(after.rows.map(row => row.name), before.rows.map(row => row.name));
    idleSeconds = 4 * 60 * 60; await delay(800);
    const idleIds = targets.map(target => find(target).id); idleSeconds = 0;
    await waitFor(() => targets.every((target, index) => find(target) && find(target).id !== idleIds[index]), 'return after four-hour idle');
    await delay(300); results.push({ phase: 'idle-return', simulatedIdleSeconds: 14400, replaced: true });
    await delay(5000); // Allow the normal wake grace before injecting a new hang.
    const hung = find('kind=damage');
    hung.webContents.executeJavaScript('for (;;) {}').catch(() => {});
    await delay(100); hung.webContents.emit('unresponsive');
    await waitFor(() => { const fresh = find('kind=damage'); return fresh && fresh.id !== hung.id; }, 'real frozen damage renderer');
    await delay(300); assert.equal(await find('kind=damage').webContents.executeJavaScript('typeof window.api'), 'object');
    results.push({ phase: 'renderer-hang', kind: 'damage', replaced: true });
    gameState = { found: true, focused: false, minimized: true }; await delay(800);
    const oldIds = targets.map(target => find(target).id);
    powerMonitor.emit('resume');
    await waitFor(() => targets.every((target, index) => find(target) && find(target).id !== oldIds[index]), 'resume recovery');
    await delay(300); assert.ok(targets.every(target => !find(target).isVisible()), 'inactive game stays hidden after recovery');
    gameState = { found: true, focused: true, minimized: false }; await delay(1000);
    assert.ok(find('kind=fame').isVisible()); assert.ok(find('kind=damage').isVisible());
    await main.webContents.executeJavaScript("api.metricsAction('overlay-damage')");
    powerMonitor.emit('unlock-screen'); await delay(2000);
    assert.equal(find('kind=damage'), undefined, 'deliberately closed damage window stays closed');
    assert.equal(combat.snapshot().fame, before.fame); assert.equal(combat.snapshot().overall.totalDamage, 777);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify({ passed: true, results,
      resumeRecovers: true, closedStaysClosed: true, countersRetained: true, source }, null, 2));
    console.log('PASS: actual main, four sandboxed overlay renderers, real crashes and infinite-loop hang, simulated four-hour idle return, resume, unlock, inactive visibility, deliberate close and retained fame/damage/party.');
    clearTimeout(deadline); app.quit();
  }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
  require(path.join(source, 'main.js'));
}
