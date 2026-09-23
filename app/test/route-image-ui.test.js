const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../ui/map.js'), 'utf8');
const exportCode = source.slice(source.indexOf('let routeImageSerial ='), source.indexOf('// ПРОВОДНИК:'));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function environment(render, send) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', hidden: false, disabled: false, attributes: {},
      classList: { toggle() {} },
      style: { setProperty() {} },
      setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this[k]; },
    });
    return elements.get(id);
  };
  const route = { found: true, from: 'A', to: 'D', steps: [
    { from: 'A', to: 'B', kind: 'portal', expiresAt: Date.now() + 60_000 },
    { from: 'B', to: 'C', kind: 'walk' }, { from: 'C', to: 'D', kind: 'walk' },
  ] };
  const ctx = vm.createContext({
    Date, Set, Object, Promise,
    document: { getElementById: element, querySelector: element },
    window: { RouteImage: { render } },
    ipc: { exportRouteImage: send },
    lastRoute: { res: route }, routeBusy: false,
    zoneInfoCache: {}, zoneColorCache: {}, zoneNames: [], demoColors: {},
    openModal() {},
  });
  vm.runInContext(exportCode, ctx);
  return { ctx, route, element, run: code => vm.runInContext(code, ctx) };
}
const png = { dataUrl: 'data:image/png;base64,preview', from: 'A', to: 'D', width: 760, height: 800 };

test('image uses every step of the displayed route and freezes it before async rendering', async () => {
  const draw = deferred();
  let received;
  const env = environment(route => { received = route; return draw.promise; });
  const pending = env.run('openRouteImage()');
  env.route.steps[0].to = 'changed';
  env.ctx.lastRoute = { res: { steps: [] } };
  assert.deepEqual(Array.from(received.steps, step => step.to), ['B', 'C', 'D']);
  draw.resolve(png);
  await pending;
  assert.equal(env.element('route-image-preview').src, png.dataUrl);
  assert.equal(env.element('route-image-copy').disabled, false);
});

test('closing a preview discards a late render result', async () => {
  const draw = deferred();
  const env = environment(() => draw.promise);
  const pending = env.run('openRouteImage()');
  env.run('invalidateRouteImage()');
  draw.resolve(png);
  await pending;
  assert.equal(env.element('route-image-preview').hidden, true);
  assert.equal(env.element('route-image-save').disabled, true);
});

test('an earlier render cannot replace a newly opened route', async () => {
  const old = deferred(), fresh = deferred();
  let call = 0;
  const env = environment(() => (++call === 1 ? old.promise : fresh.promise));
  const first = env.run('openRouteImage()');
  env.run('invalidateRouteImage()');
  const second = env.run('openRouteImage()');
  fresh.resolve({ ...png, dataUrl: 'new-image' });
  await second;
  old.resolve(png);
  await first;
  assert.equal(env.element('route-image-preview').src, 'new-image');
});

test('save/copy exports the visible PNG, prevents duplicate dialogs, and recovers after cancel', async () => {
  const sent = [], saved = deferred();
  const env = environment(async () => png, (action, payload) => {
    sent.push({ action, payload }); return saved.promise;
  });
  await env.run('openRouteImage()');
  const pending = env.run('exportRouteImage("save")');
  await env.run('exportRouteImage("copy")');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.dataUrl, png.dataUrl);
  assert.equal(sent[0].payload.to, 'D');
  assert.equal(env.element('route-image-save').disabled, true);
  saved.resolve({ canceled: true });
  await pending;
  assert.match(env.element('route-image-status').textContent, /отменено/);
  assert.equal(env.element('route-image-save').disabled, false);
});

test('render or IPC errors are visible and never reported as successful exports', async () => {
  const env = environment(async () => { throw new Error('canvas unavailable'); });
  await env.run('openRouteImage()');
  assert.match(env.element('route-image-status').textContent, /canvas unavailable/);
  assert.equal(env.element('route-image-copy').disabled, true);
  env.ctx.window.RouteImage.render = async () => png;
  env.ctx.ipc.exportRouteImage = async () => { throw new Error('clipboard unavailable'); };
  await env.run('openRouteImage()');
  await env.run('exportRouteImage("copy")');
  assert.match(env.element('route-image-status').textContent, /clipboard unavailable/);
  assert.equal(env.element('route-image-copy').disabled, false);
});

test('failed and zero-hop searches clear the old route so metadata callbacks cannot restore it', () => {
  const ctx = vm.createContext({
    lastRoute: { res: { found: true } }, esc: String, setRouteHighlight() {}, routeMsg() {},
    guiding: false, invalidateRouteImage() {},
  });
  vm.runInContext(source.slice(source.indexOf('function discardRouteResult('), source.indexOf('// ---------- подсветка маршрута')), ctx);
  vm.runInContext('showRoute({found:false})', ctx);
  assert.equal(ctx.lastRoute, null);
  ctx.lastRoute = { res: { found: true } };
  vm.runInContext('showRoute({found:true,steps:[]})', ctx);
  assert.equal(ctx.lastRoute, null);
});

test('clearing the route while the image renders invalidates the preview and cannot enable export later', async () => {
  const draw = deferred();
  const env = environment(() => draw.promise);
  env.ctx.guiding = false;
  env.ctx.setRouteHighlight = () => {};
  vm.runInContext(source.slice(source.indexOf('function discardRouteResult('), source.indexOf('function showRoute(')), env.ctx);
  const pending = env.run('openRouteImage()');
  env.run('discardRouteResult()');
  draw.resolve(png);
  await pending;
  assert.equal(env.ctx.lastRoute, null);
  assert.equal(env.element('route-image-preview').hidden, true);
  assert.equal(env.element('route-image-copy').disabled, true);
  assert.match(env.element('route-image-status').textContent, /сброшен/);
});

test('empty input for a new route invalidates the previous result before showing the error', async () => {
  const env = environment(async () => png);
  await env.run('openRouteImage()');
  Object.assign(env.ctx, {
    guiding: false, routeOrigin: () => 'A', resolveDest: () => '',
    setRouteHighlight() {}, routeMsg() {},
  });
  env.ctx.ipc.findRoute = () => assert.fail('An empty destination must not reach the router');
  vm.runInContext(source.slice(source.indexOf('function discardRouteResult('), source.indexOf('function showRoute(')), env.ctx);
  vm.runInContext(source.slice(source.indexOf('let routeBusy ='), source.indexOf('function initRouteUI(')), env.ctx);
  await env.run('runRoute("to")');
  assert.equal(env.ctx.lastRoute, null);
  assert.equal(env.element('route-image-save').disabled, true);
});

test('city search uses the destination without requiring a current zone', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false });
    return elements.get(id);
  };
  element('route-to').value = 'Target';
  let selected = null;
  const ctx = vm.createContext({
    document: { getElementById: element },
    routeOrigin: () => assert.fail('Current zone is unnecessary for city search'),
    resolveDest: value => value,
    ipc: {
      findRoute: () => assert.fail('Manual route must not run'),
      findRouteFromCity: async to => {
        assert.equal(to, 'Target');
        return { found: true, from: 'Martlock', to };
      },
    },
    acClose() {}, discardRouteResult() {}, routeMsg() {}, esc: String,
    showRoute: (result, title) => { selected = { result, title }; },
  });
  vm.runInContext(source.slice(source.indexOf('let routeBusy ='), source.indexOf('function initRouteUI(')), ctx);
  await vm.runInContext('runRoute("city")', ctx);
  assert.equal(selected.result.from, 'Martlock');
  assert.match(selected.title, /Martlock/);
  assert.equal(element('route-from-city').disabled, false);
});
