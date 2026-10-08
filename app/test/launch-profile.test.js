const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialize, initialConfig } = require('../lib/launch-profile');

function fakeApp() {
  const paths = { userData: 'C:\\profiles\\avalon-mapper', sessionData: 'C:\\profiles\\avalon-mapper' };
  const calls = [];
  return { paths, calls, getPath: name => paths[name],
    setPath(name, value) { calls.push([name, value]); paths[name] = value; } };
}

test('ordinary launches retain the original data directory and singleton namespace', () => {
  const app = fakeApp();
  const profile = initialize(app, { argv: ['electron', '.'], files: { mkdirSync() { throw new Error('primary unchanged'); } } });
  assert.equal(profile.secondary, false); assert.equal(profile.dataDir, app.paths.userData);
  assert.deepEqual(app.calls, []);
});

test('the explicit second account isolates both app state and Chromium sessions before taking its lock', () => {
  const app = fakeApp(), created = [];
  const profile = initialize(app, { argv: ['app.exe', '--second-account'],
    files: { mkdirSync(...args) { created.push(args); } } });
  assert.equal(profile.secondary, true);
  assert.equal(profile.primaryDataDir, 'C:\\profiles\\avalon-mapper');
  assert.equal(profile.dataDir, 'C:\\profiles\\avalon-mapper-second-account');
  assert.deepEqual(app.calls, [['userData', profile.dataDir], ['sessionData', profile.dataDir]]);
  assert.deepEqual(created, [[profile.dataDir, { recursive: true }]]);
  assert.match(profile.title, /Второй аккаунт/);
});

test('second-account defaults copy only public connection settings, never identity or personal data', () => {
  const primary = { syncUrl: 'https://fixture.invalid', syncKey: 'public-key', updateUrl: 'owner/repo', theme: 'light', language: 'en',
    nick: 'first', syncAccountId: 'first-id', rooms: [{ id: 'private-room' }], refreshToken: 'secret',
    guestSession: 'private', personalSeededFor: 'first-id', uploadPublic: true, binding: { label: 'F9' } };
  const second = initialConfig(primary);
  assert.equal(second.syncUrl, primary.syncUrl); assert.equal(second.syncKey, primary.syncKey);
  assert.equal(second.theme, 'light');
  assert.equal(second.language, 'en');
  for (const key of ['nick', 'syncAccountId', 'rooms', 'refreshToken', 'guestSession', 'personalSeededFor', 'uploadPublic', 'binding'])
    assert.equal(Object.hasOwn(second, key), false, key);
  assert.equal(second.zoneSource, 'off'); assert.equal(second.zoneWatch, false);
  assert.equal(second.fameEnabled, false); assert.equal(second.damageEnabled, false);
  assert.equal(second.overlayEnabled, false); assert.equal(second.onboardingSeen, true);
});
