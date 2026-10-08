import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callbackDetails, cloudConfig, siteRoot } from '../src/cloud/config.js';
import { createSiteAuth } from '../src/cloud/auth-core.js';
import { createMapReader, mapList, readSnapshot, visiblePortals } from '../src/cloud/maps.js';
import { routeMarkerColor } from '../src/cloud/route-colors.js';
import { syncGraphSelection } from '../src/cloud/graph-selection.js';

const alice = '10000000-0000-4000-8000-000000000001';
const bob = '10000000-0000-4000-8000-000000000002';
const group = '20000000-0000-4000-8000-000000000001';
const clock = Date.parse('2026-09-29T12:00:00Z');
const row = changes => ({ a: 'Qiient-Qi-Odesas', b: 'Coues-Exakrom', cap_max: 7, cap_max_known: true,
  expires_at: '2026-09-29T16:00:00Z', updated_at: '2026-09-29T11:59:00Z', confirms: 1, needed: 0, ...changes });
const snapshot = edges => ({ version: '1', unchanged: false, role: 'admin', edges });
const discord = id => ({ id, identities: [{ provider: 'discord' }], user_metadata: { name: id === alice ? 'Alice' : 'Bob' } });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('site root works for nested hosting, English pages and static callback routes', () => {
  for (const pathname of ['/mapper/', '/mapper/map/', '/mapper/map/index.html', '/mapper/auth/callback/', '/mapper/en/']) {
    assert.equal(siteRoot('https://example.com' + pathname + '?lang=en#map').href, 'https://example.com/mapper/');
  }
  assert.equal(siteRoot('https://example.com/en/', 'https://example.com/').href, 'https://example.com/');
  const callback = callbackDetails('https://example.com/auth/callback/?code=single-use-secret&returnTo=https://attacker.invalid#access_token=bad');
  assert.equal(callback.code, 'single-use-secret');
  assert.equal(callback.cleanURL, 'https://example.com/auth/callback/');
  assert.equal(callbackDetails('https://example.com/?code=unrelated').code, null);
});

test('browser configuration rejects administrative secrets', () => {
  assert.ok(cloudConfig().key.startsWith('sb_publishable_'));
  assert.throws(() => cloudConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_never-in-a-browser' }));
  const jwt = role => 'eyJ.' + btoa(JSON.stringify({ role })) + '.signature';
  assert.throws(() => cloudConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: jwt('service_role') }));
  assert.equal(cloudConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: jwt('anon') }).key, jwt('anon'));
  assert.throws(() => cloudConfig({ VITE_SUPABASE_URL: 'https://example.com/@attacker.invalid' }));
});

test('login verifies Discord with Auth instead of trusting cached browser user data', async () => {
  const auth = createSiteAuth({ auth: { getSession: async () => ({ data: { session: { user: discord(alice) } } }),
    getUser: async () => ({ data: { user: discord(bob) } }) } });
  await auth.restore();
  assert.equal(auth.getState().user.id, bob);
  const guest = createSiteAuth({ auth: { getSession: async () => ({ data: { session: {} } }),
    getUser: async () => ({ data: { user: { ...discord(alice), is_anonymous: true } } }) } });
  await guest.restore();
  assert.equal(guest.getState().user, null);
  assert.equal(guest.getState().error, 'discord_required');
});

test('logout clears identity immediately and a late verification cannot restore it', async () => {
  const pending = deferred();
  const auth = createSiteAuth({ auth: { getSession: async () => ({ data: { session: {} } }), getUser: () => pending.promise,
    signOut: async ({ scope }) => { assert.equal(scope, 'local'); return {}; } } });
  const restoring = auth.restore();
  await Promise.resolve();
  await auth.signOut();
  assert.equal(auth.getState().user, null);
  pending.resolve({ data: { user: discord(alice) } });
  await restoring;
  assert.equal(auth.getState().user, null);
});

test('rechecking a verified session keeps the map mounted and a changed account clears it immediately', async () => {
  const pending = deferred();
  let checks = 0, account = alice;
  const auth = createSiteAuth({ auth: {
    getSession: async () => ({ data: { session: { user: discord(account) } } }),
    getUser: () => account === bob || ++checks === 1 ? Promise.resolve({ data: { user: discord(account) } }) : pending.promise,
  } });
  await auth.restore();
  const refresh = auth.restore();
  await Promise.resolve();
  assert.equal(auth.getState().user.id, alice);
  assert.equal(auth.getState().loading, false);
  pending.resolve({ data: { user: discord(alice) } });
  await refresh;
  assert.equal(auth.getState().user.id, alice);
  account = bob;
  auth.sessionEvent('SIGNED_IN', { user: discord(bob) });
  assert.equal(auth.getState().user, null);
});

test('a stalled session check ends with a retryable error instead of an endless sign-in spinner', async () => {
  const auth = createSiteAuth({ auth: { getSession: () => new Promise(() => {}) } }, { verificationTimeoutMs: 15 });
  await auth.restore();
  assert.equal(auth.getState().loading, false);
  assert.equal(auth.getState().error, 'session_unavailable');
});

test('an expired browser session clears the identity and a newly verified Discord account replaces it', async () => {
  let active = discord(alice);
  const auth = createSiteAuth({ auth: {
    getSession: async () => ({ data: { session: active ? { user: active } : null } }),
    getUser: async () => ({ data: { user: active } }),
  } });
  await auth.restore();
  assert.equal(auth.getState().user.id, alice);
  active = null;
  await auth.restore();
  assert.equal(auth.getState().user, null);
  assert.equal(auth.getState().loading, false);
  active = discord(bob);
  await auth.restore();
  assert.equal(auth.getState().user.id, bob);
});

test('sign-in uses the existing Discord provider and code exchange failures show no private identity', async () => {
  const calls = [];
  const auth = createSiteAuth({ auth: { signInWithOAuth: async options => { calls.push(options); return {}; },
    exchangeCodeForSession: async () => ({ error: new Error('bad verifier') }) } });
  await auth.signIn('https://example.com/auth/callback/');
  assert.deepEqual(calls[0], { provider: 'discord', options: { redirectTo: 'https://example.com/auth/callback/', scopes: 'identify' } });
  await auth.restore({ code: 'invalid' });
  assert.equal(auth.getState().user, null);
  assert.equal(auth.getState().error, 'oauth_failed');
});

test('only owned personal storage and authorized group memberships become map choices', () => {
  const maps = mapList(alice, { personalMap: alice }, [
    { id: group, kind: 'group', role: 'viewer', title: 'Friends' },
    { id: '20000000-0000-4000-8000-000000000002', kind: 'group', role: 'member', title: 'Guild' },
    { id: bob, kind: 'personal', role: 'admin' },
    { id: group, kind: 'group', role: 'admin' },
    { id: '00000000-0000-4000-8000-000000000000', kind: 'public', role: 'admin' },
  ]);
  assert.deepEqual(maps.map(map => map.id), [alice, group, '20000000-0000-4000-8000-000000000002']);
  assert.throws(() => mapList(alice, { personalMap: bob }, []));
});

test('expired portals and free-slot counts do not masquerade as active portal capacities', () => {
  const result = readSnapshot(snapshot([row({ first_seen_at: '2026-09-29T11:00:00Z', by_nick: 'Alice' }), row({ a: 'Expired', expires_at: '2026-09-29T11:00:00Z' }),
    row({ a: 'Unknown size', cap_max_known: false, cap_max: 7, cap_num: 3 }),
    row({ a: 'Large', cap_max: 20 }), row({ a: 'Invalid size', cap_max: 6 }), row({ a: 'Bad clock', expires_at: 'bad' })]), null, clock);
  assert.equal(result.edges.length, 4);
  assert.equal(result.edges.find(edge => edge.a === 'Large' || edge.b === 'Large').capMax, 20);
  assert.equal(result.edges.find(edge => edge.a === 'Unknown size' || edge.b === 'Unknown size').capMax, null);
  assert.ok(result.edges.every(edge => [null, 7, 20].includes(edge.capMax)));
  assert.equal(result.edges.find(edge => edge.by === 'Alice')?.firstSeenAt, Date.parse('2026-09-29T11:00:00Z'));
  assert.equal(readSnapshot({ denied: true }, result, clock).edges.length, 0);
  assert.equal(readSnapshot({ paused: true }, result, clock).version, null);
  assert.throws(() => readSnapshot({ version: '2', role: 'viewer', unchanged: true }, result, clock));
});

test('all-maps view merges portals while preserving the distinct observation in each group', () => {
  const maps = mapList(alice, { personalMap: alice }, [{ id: group, kind: 'group', role: 'viewer', title: 'Friends' }]);
  const snapshots = { [alice]: readSnapshot(snapshot([row()]), null, clock),
    [group]: readSnapshot({ ...snapshot([row({ cap_max: 20, updated_at: '2026-09-29T12:00:00Z' })]), role: 'viewer' }, null, clock) };
  const union = visiblePortals(maps, snapshots, 'all', clock);
  assert.equal(union.length, 1); assert.equal(union[0].capMax, 20); assert.equal(union[0].records.length, 2);
  assert.equal(visiblePortals(maps, snapshots, alice, clock)[0].capMax, 7);
  assert.equal(visiblePortals(maps, snapshots, 'all', clock + 5 * 3600000).length, 0);
});

test('pending requests cannot leak one account into the next or after sign-out', async () => {
  const pending = deferred();
  const reader = createMapReader({ rpc: () => pending.promise, now: () => clock });
  reader.setAccount(alice);
  const refreshing = reader.refresh();
  reader.setAccount(bob);
  pending.resolve({ personalMap: alice });
  await refreshing;
  assert.equal(reader.getState().accountId, bob);
  assert.equal(reader.getState().maps.length, 0);
  reader.setAccount(null);
  assert.deepEqual(reader.getState().snapshots, {});
});

test('removed membership is cleared before snapshot fetches and denied groups clear cached portals', async () => {
  let member = true, denied = false;
  const reader = createMapReader({ now: () => clock, rpc: async (name, body) => {
    if (name === 'account_policy') return { personalMap: alice };
    if (name === 'my_maps') return member ? [{ id: group, kind: 'group', role: 'viewer' }] : [];
    if (name === 'pull_map_snapshot') return body.p_map === group && denied ? { denied: true } : snapshot([row()]);
  } });
  reader.setAccount(alice); await reader.refresh(); reader.select(group);
  assert.equal(visiblePortals(reader.getState().maps, reader.getState().snapshots, group, clock).length, 1);
  denied = true; await reader.refresh();
  assert.equal(visiblePortals(reader.getState().maps, reader.getState().snapshots, group, clock).length, 0);
  member = false; await reader.refresh();
  assert.equal(reader.getState().selection, alice);
  assert.equal(reader.getState().snapshots[group], undefined);
});

test('selected group survives a new reader but revoked membership falls back to the personal map', async () => {
  const preferences = new Map();
  const selectionStorage = { getItem: key => preferences.get(key) || null, setItem: (key, value) => preferences.set(key, value) };
  let member = true;
  const rpc = async name => {
    if (name === 'account_policy') return { personalMap: alice };
    if (name === 'my_maps') return member ? [{ id: group, kind: 'group', role: 'viewer' }] : [];
    return snapshot([]);
  };
  const first = createMapReader({ rpc, selectionStorage, now: () => clock });
  first.setAccount(alice); await first.refresh(); first.select(group);
  const resumed = createMapReader({ rpc, selectionStorage, now: () => clock });
  resumed.setAccount(alice);
  assert.equal(resumed.getState().selection, group);
  await resumed.refresh();
  assert.equal(resumed.getState().selection, group);
  member = false; await resumed.refresh();
  assert.equal(resumed.getState().selection, alice);
  assert.equal(preferences.get(`avalon-map-selection:${alice}`), alice);
  const otherAccount = createMapReader({ rpc: async name => name === 'account_policy' ? { personalMap: bob } : name === 'my_maps' ? [] : snapshot([]), selectionStorage, now: () => clock });
  otherAccount.setAccount(bob); await otherAccount.refresh();
  assert.equal(otherAccount.getState().selection, bob);
});

test('route markers use the same canonical zone colours as map nodes', () => {
  const palette = { avalon: '#a78bfa', yellow: '#eab308', black: '#27272a' };
  const zones = { Avalon: { color: 'avalon' }, Yellow: { color: 'yellow' }, Black: { color: 'black' } };
  assert.equal(routeMarkerColor(zones, 'Avalon', palette), palette.avalon);
  assert.equal(routeMarkerColor(zones, 'Yellow', palette), palette.yellow);
  assert.equal(routeMarkerColor(zones, 'Black', palette), palette.black);
  assert.equal(routeMarkerColor(zones, 'Unknown', palette), undefined);
});

test('selecting a map zone highlights it without changing pan or zoom', () => {
  const events = [];
  const cy = { nodes: () => ({ unselect: () => events.push('clear') }), $id: name => ({ length: 1, select: () => events.push(name) }),
    viewport: () => { throw new Error('selection must not move the camera'); } };
  syncGraphSelection(cy, 'Qiient-Qi-Odesas');
  assert.deepEqual(events, ['clear', 'Qiient-Qi-Odesas']);
  syncGraphSelection(cy, null);
  assert.deepEqual(events, ['clear', 'Qiient-Qi-Odesas', 'clear']);
});

test('an expired login clears every cached map and requests local sign-out', async () => {
  let expired = false, signOuts = 0;
  const reader = createMapReader({ now: () => clock, onUnauthorized: () => signOuts++, rpc: async name => {
    if (name === 'account_policy') return { personalMap: alice };
    if (name === 'my_maps') return [];
    if (expired) throw Object.assign(new Error('expired'), { status: 401 });
    return snapshot([row()]);
  } });
  reader.setAccount(alice); await reader.refresh();
  expired = true; await reader.refresh();
  assert.equal(reader.getState().accountId, null); assert.deepEqual(reader.getState().snapshots, {}); assert.equal(signOuts, 1);
});
