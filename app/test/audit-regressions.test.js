const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const portalTime = require('../lib/portal-time');
const json = require('../lib/json-file');
const store = require('../lib/store');
const { createSync } = require('../lib/sync');
const { createAuth } = require('../lib/auth');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-audit-'));
const MAP = '11111111-1111-1111-1111-111111111111';
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function newStore() {
  store.flush();
  const dir = tmp();
  store.setDataDir(dir);
  store.state.edges = {}; store.state.players = {}; store.state.journal = [];
  return dir;
}
function newSync(opts = {}) {
  const s = createSync({ getToken: async () => 'test-token', flushMs: 0, ...opts });
  s.configure({ syncUrl: 'https://example.invalid', syncKey: 'test', rooms: [{ id: MAP, upload: true }] });
  return s;
}
function newAuth(fetch) {
  const a = createAuth({ fetch });
  a.configure({ url: 'https://example.invalid', key: 'test' });
  Object.assign(a.state, { accessToken: 'expired', refreshToken: 'refresh', expiresAt: 1 });
  return a;
}

test('desktop auth waits for ready, restores encrypted login and saves rotated credentials for the next launch', async () => {
  const dir = tmp(), file = path.join(dir, 'auth.json');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = main.indexOf('function initAuth()');
  assert.ok(start >= 0);
  const end = /\r?\n\}/.exec(main.slice(start));
  let ready = false, cryptoCalls = 0;
  const ctx = vm.createContext({
    auth: null, app: { isReady: () => ready }, path, Buffer, DATA_DIR: dir,
    console: { log() {} }, shell: {}, syncUrlOf: () => 'https://example.invalid', syncKeyOf: () => 'test',
    authLib: { createAuth: options => createAuth({ ...options, fetch: async () => response({
      access_token: 'next-access', refresh_token: 'next-refresh', expires_in: 3600, user: { id: 'u1' },
    }) }) },
    safeStorage: {
      isEncryptionAvailable: () => ready,
      encryptString(text) { cryptoCalls++; assert.ok(ready); return Buffer.from('sealed:' + text); },
      decryptString(buf) { cryptoCalls++; assert.ok(ready); return buf.toString().slice(7); },
    },
  });
  fs.writeFileSync(file, JSON.stringify({ v: 2, enc: Buffer.from('sealed:old-refresh').toString('base64'), userId: 'u1' }));
  vm.runInContext(main.slice(start, start + end.index + end[0].length), ctx);
  assert.throws(() => ctx.initAuth(), /ещё не готово/);
  assert.equal(cryptoCalls, 0, 'No premature read or migration');
  ready = true;
  ctx.initAuth();
  assert.equal(ctx.auth.state.refreshToken, 'old-refresh');
  assert.equal(ctx.auth.status().sessionOnly, false);
  assert.equal(await ctx.auth.token(), 'next-access');
  assert.equal(ctx.auth.status().sessionOnly, false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('next-refresh'), false);
  ctx.initAuth();
  assert.equal(ctx.auth.state.refreshToken, 'next-refresh');
  assert.equal(ctx.auth.status().signedIn, true);
  assert.equal(ctx.auth.status().sessionOnly, false);
  fs.unlinkSync(file); fs.rmdirSync(dir);
});

test('corrupt settings are backed up before falling back; atomic replacement leaves valid JSON', () => {
  const dir = tmp(), file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(json.readObject(file), {});
  const backup = fs.readdirSync(dir).find(n => n.startsWith('config.json.corrupt-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{broken');
  json.writeObject(file, { theme: 'coal' });
  assert.deepEqual(json.readObject(file), { theme: 'coal' });
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('map flush saves a portal immediately without waiting for the debounce timer', () => {
  const dir = newStore();
  store.addEdge('A', { name: 'B', closes: 3600 }, 'test');
  store.flush();
  const saved = json.readObject(path.join(dir, 'map.json'));
  assert.equal(saved.edges['A|B'].b, 'B');
  store.flush(); // idempotent shutdown
});

test('invalid persisted containers and entries cannot crash map loading', () => {
  const dir = newStore();
  json.writeObject(path.join(dir, 'map.json'), { edges: { bad: null }, players: { bad: {} }, journal: null });
  store.load();
  assert.deepEqual(store.snapshot().edges, []);
  assert.deepEqual(store.state.players, {});
  assert.deepEqual(store.state.journal, []);
});

test('legacy portals without a closing time are removed from the local file', () => {
  const dir = newStore();
  json.writeObject(path.join(dir, 'map.json'), {
    edges: { 'A|B': { a: 'A', b: 'B', updatedAt: Date.now(), expiresAt: null } },
    players: {}, journal: [],
  });
  store.load();
  assert.deepEqual(store.snapshot().edges, []);
  store.flush();
  assert.deepEqual(json.readObject(path.join(dir, 'map.json')).edges, {});
});

test('rescan preserves room confirmations and reporters', () => {
  newStore();
  store.mergeRemote([{ a: 'A', b: 'B', expiresAt: Date.now() + 3600000, updatedAt: Date.now(), confirms: 2, needed: 3, reporters: ['friend'] }], MAP);
  store.addEdge('A', { name: 'B', closes: 3600 }, 'test');
  assert.deepEqual(store.state.edges['A|B'].conf[MAP], { confirms: 2, needed: 3 });
  assert.deepEqual(store.state.edges['A|B'].who[MAP], ['friend']);
  store.flush();
});

test('a newer remote confirmation renews the lifetime even when no other fields changed', () => {
  newStore();
  const now = Date.now(), before = now - 5 * 3600000;
  store.mergeRemote([{ a: 'A', b: 'B', expiresAt: now + 3600000, updatedAt: before }], MAP);
  assert.equal(store.mergeRemote([{ a: 'A', b: 'B', expiresAt: now + 4 * 3600000, updatedAt: now }], MAP), 1);
  store.prune(now + 2 * 3600000);
  assert.ok(store.state.edges['A|B']);
  store.flush();
});

test('sync stop persists the pending upload queue immediately', () => {
  const file = path.join(tmp(), 'sync.json');
  const s = newSync({ file });
  s.push({ a: 'A', b: 'B', expiresAt: Date.now() + 3600000, updatedAt: Date.now() });
  s.stop();
  assert.equal(json.readObject(file).outbox.length, 1);
});

test('stalled network request times out, releases busy and keeps the unsent portal', async () => {
  const s = newSync({ requestTimeoutMs: 15, fetch: (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('request timeout')), { once: true });
  }) });
  s.push({ a: 'A', b: 'B', expiresAt: Date.now() + 3600000, updatedAt: Date.now() });
  await s.tick();
  assert.equal(s.state.busy, false);
  assert.equal(s.state.outbox.length, 1);
  assert.match(s.state.lastError, /timeout/);
  s.stop();
});

test('failed response body is not mistaken for a successful upload', async () => {
  const s = newSync({ fetch: async () => ({ ok: true, text: async () => { throw new Error('connection lost'); } }) });
  s.push({ a: 'A', b: 'B', expiresAt: Date.now() + 3600000, updatedAt: Date.now() });
  assert.equal(await s.flush(), 0);
  assert.equal(s.state.outbox.length, 1);
  s.stop();
});

test('sign out during token renewal cannot be undone by the late response', async () => {
  const request = deferred();
  const a = newAuth(() => request.promise);
  const renewing = a.token();
  a.signOut();
  request.resolve(response({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }));
  assert.equal(await renewing, null);
  assert.equal(a.status().signedIn, false);
});

test('rate limiting renewal does not erase the refresh token', async () => {
  const a = newAuth(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }));
  assert.equal(await a.token(), null);
  assert.equal(a.state.refreshToken, 'refresh');
});

test('concurrent token callers do not receive an expired token after failed renewal', async () => {
  const request = deferred();
  const a = newAuth(() => request.promise);
  const one = a.token(), two = a.token();
  request.resolve({ ok: false, status: 503, text: async () => 'unavailable' });
  assert.deepEqual(await Promise.all([one, two]), [null, null]);
});

test('overlapping traffic starts and stopping during elevation leave no orphan listener', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const requests = [], listeners = [];
  const context = vm.createContext({
    config: { zoneSource: 'traffic' }, quitting: false, zoneFromTraffic: true, zoneRevision: 0,
    metricsOptions: require('../lib/metrics-options'),
    privileges: { isElevated: () => { const d = deferred(); requests.push(d); return d.promise; } },
    zoneTraffic: { create: () => { const s = { starts: 0, stops: 0, start() { this.starts++; return { listening: [], failed: [] }; }, stop() { this.stops++; } }; listeners.push(s); return s; } },
      trafficHealth: { createHealth: () => ({ reset() {} }) }, captureSocket: {}, combat: { disconnect() {} },
    console: { log() {}, warn() {}, error() {} }, send() {}, pushConfig() {},
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(src.slice(src.indexOf('let traffic = null;'), src.indexOf('// Единственное место, где включается')), context);
  const first = context.startTraffic(), second = context.startTraffic();
  requests[1].resolve(true); await second;
  requests[0].resolve(true); await first;
  assert.equal(listeners.length, 1);
  assert.equal(context.zoneFromTraffic, false);
  const third = context.startTraffic();
  context.stopTraffic();
  requests[2].resolve(true); await third;
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].stops, 1);
});

for (const scenario of [
  { name: 'old screen OCR cannot overwrite a newer location', zone: 'A', cached: null, source: 'screen', expected: 'A' },
  { name: 'unreadable old frame uses traffic origin captured before transition', zone: null, cached: 'A', source: 'traffic', expected: 'A' },
  { name: 'old frame with no known origin is not attached to the new zone', zone: null, cached: null, source: 'traffic', expected: null },
  { name: 'switching tracking off invalidates in-flight OCR results', zone: 'A', cached: 'A', source: 'off', expected: null },
]) test(scenario.name, async () => {
  const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = src.indexOf('async function finishFrame(');
  const end = /\r?\n\}\r?\n/.exec(src.slice(start));
  const request = deferred(), origins = [], overlays = [];
  const initialSource = scenario.zone ? 'screen' : 'traffic';
  const context = vm.createContext({
    zoneRevision: 1, quitting: false, config: { zoneSource: initialSource }, portalTime,
    performance: { now: () => 0 }, recognize: { recognizeZone: () => request.promise },
    applyZone: () => assert.fail('old frame overwrote current zone'),
    applyTip: (_, opts) => origins.push(opts.zoneNow),
    showOverlay: p => overlays.push(p), send() {}, store: { snapshot: () => ({}) },
  });
  vm.runInContext(src.slice(start, start + end.index + end[0].length), context);
  // Traffic mode has no zone OCR. Its transition occurs during tooltip OCR,
  // before finishFrame receives the completed result.
  if (initialSource === 'traffic') context.zoneRevision = 2;
  const pending = context.finishFrame({ tip: { name: 'C' } }, { width: 10, height: 10 }, {
    strip: true, screenHeight: 1080, tz: 0, withTooltip: true, kind: 'hotkey', commit: true,
    observation: { revision: 1, source: initialSource, origin: scenario.cached },
  });
  context.zoneRevision = 2;
  context.config.zoneSource = scenario.source;
  request.resolve(scenario.zone ? { zone: scenario.zone } : null);
  await pending;
  if (scenario.expected) assert.deepEqual(origins, [scenario.expected]);
  else { assert.equal(origins.length, 0); assert.equal(overlays[0].staleOrigin, true); }
});

test('failed nonblocking setup cannot start a recv loop; Winsock is released once', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/capture-socket.js'), 'utf8');
  let cleaned = 0, closed = 0, timers = 0, fail = true;
  const native = {
    WSAStartup: () => 0, WSACleanup: () => { cleaned++; return 0; },
    socket: () => 12, bind: () => 0, WSAIoctl: () => 0, setsockopt: () => 0,
    ioctlsocket: () => fail ? -1 : 0, WSAGetLastError: () => 10022,
    closesocket: () => { closed++; return 0; },
  };
  const module = { exports: {} };
  const context = vm.createContext({
    module, Buffer, console, process,
    setInterval: () => { timers++; return 1; }, clearInterval() {},
    require: name => name === 'koffi' ? { load: () => ({ func: signature => native[/\b(\w+)\(/.exec(signature)[1]] }) }
      : name === './packet-pump' ? { create: () => { timers++; return { close() {} }; } } : require(name),
  });
  vm.runInContext(src, context);
  assert.throws(() => module.exports.open('127.0.0.1', () => {}), /FIONBIO/);
  assert.equal(timers, 0);
  assert.equal(cleaned, 1);
  assert.equal(closed, 1);
  fail = false;
  const socket = module.exports.open('127.0.0.1', () => {});
  socket.close(); socket.close();
  assert.equal(cleaned, 2);
  assert.equal(closed, 2);
});

test('legacy zoneWatch=false stays manual when the old config has no source field', () => {
  const src = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = src.indexOf('function normConfig()');
  const end = /\r?\n\}\r?\n/.exec(src.slice(start));
  const config = { zoneSource: 'screen', nick: 'test', rooms: [] };
  const context = vm.createContext({ config, savedConfig: { zoneWatch: false },
    metricsOptions: require('../lib/metrics-options'),
    ZONE_SOURCES: ['screen', 'traffic', 'off'], THEMES: ['dark', 'coal', 'light'],
    place: require('../lib/overlay-place'), sync: require('../lib/sync'), update: require('../lib/update'), console,
  });
  vm.runInContext(src.slice(start, start + end.index + end[0].length), context);
  context.normConfig();
  assert.equal(config.zoneSource, 'off');
  assert.equal(config.zoneWatch, false);
});
