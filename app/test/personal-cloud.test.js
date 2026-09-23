'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/shared-database');
const { createSync, PUBLIC_MAP_ID } = require('../lib/sync');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const timed = (a, b) => ({ a, b, capMax: 7, capMaxKnown: true,
  expiresAt: new Date(Date.now() + 3600000).toISOString(), source: 'ocr' });

test('personal cloud remains private while Pro reads the combined active map', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  await server.db.query("update public.profiles set plan = 'pro' where id = $1", [server.users.bob]);
  const alice = await server.rpc('alice', 'account_policy');
  const bob = await server.rpc('bob', 'account_policy');
  assert.equal(alice.plan, 'free');
  assert.equal(alice.sharePublic, true);
  assert.equal(alice.canViewAll, false);
  assert.equal(bob.canViewAll, true);
  await server.rpc('alice', 'push_edges', { p_map: alice.personalMap,
    p_edges: [timed('Qiient-Si-Tertum', 'Touos-Ataglos'),
      { ...timed('Secent-Al-Nusis', 'Qiient-Si-Tertum'), expiresAt: null }] });
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID })).denied, true);
  await assert.rejects(server.rpc('alice', 'pull_edges', { p_map: PUBLIC_MAP_ID }), /нужна подписка/);
  const shared = await server.rpc('bob', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID });
  assert.equal(shared.edges.length, 1);
  assert.equal(shared.edges[0].by_nick, null);
  assert.equal(shared.edges[0].needed, 0);
  assert.equal((await server.rpc('bob', 'pull_map_snapshot', { p_map: alice.personalMap })).denied, true);
  assert.equal((await server.rpc('owner', 'pull_map_snapshot', { p_map: alice.personalMap })).edges.length, 1);
  assert.equal((await server.rpc('owner', 'admin_personal_maps')).some(x => x.account_id === server.users.alice), true);
  await assert.rejects(server.rpc('alice', 'account_set_sharing', { p_share: false }), /подписчик/);
  await assert.rejects(server.rpc('alice', 'admin_personal_maps'), /владельцу/);
});

test('anonymous account keeps a private cloud map but cannot use group maps', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  const guest = await server.rpc('guest', 'account_policy');
  assert.equal(guest.plan, 'free');
  await server.rpc('guest', 'push_edges', { p_map: guest.personalMap,
    p_edges: [timed('Qiient-Si-Tertum', 'Touos-Ataglos')] });
  assert.equal((await server.rpc('guest', 'pull_map_snapshot', { p_map: guest.personalMap })).edges.length, 1);
  assert.equal((await server.rpc('owner', 'pull_map_snapshot', { p_map: guest.personalMap })).edges.length, 1);
  await assert.rejects(server.rpc('guest', 'create_map', { p_title: 'Guest room' }), /Discord/);
  const room = await server.rpc('alice', 'create_map', { p_title: 'Room' });
  await assert.rejects(server.rpc('guest', 'join_map', { p_map: room }), /Discord/);
});

test('Pro opt-out removes prior portals immediately and restores them on opt-in', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  await server.db.query("update public.profiles set plan = 'pro' where id = $1", [server.users.bob]);
  const bob = await server.rpc('bob', 'account_policy');
  await server.rpc('bob', 'push_edges', { p_map: bob.personalMap,
    p_edges: [timed('Qiient-Si-Tertum', 'Touos-Ataglos')] });
  const before = await server.rpc('bob', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID });
  assert.equal(before.edges.length, 1);
  const off = await server.rpc('bob', 'account_set_sharing', { p_share: false });
  assert.equal(off.sharePublic, false);
  const hidden = await server.rpc('bob', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID, p_version: before.version });
  assert.equal(hidden.unchanged, false);
  assert.equal(hidden.edges.length, 0);
  assert.equal((await server.rpc('bob', 'pull_map_snapshot', { p_map: bob.personalMap })).edges.length, 1);
  await server.rpc('bob', 'account_set_sharing', { p_share: true });
  assert.equal((await server.rpc('bob', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID })).edges.length, 1);
  await server.rpc('bob', 'delete_edge', { p_map: bob.personalMap,
    p_a: 'Qiient-Si-Tertum', p_b: 'Touos-Ataglos' });
  assert.equal((await server.rpc('bob', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID })).edges.length, 0);
});

test('signed-in client queues personal observations and deletions through an outage', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  const policy = await server.rpc('alice', 'account_policy');
  const sync = createSync({ fetch: server.fetch, getToken: async () => 'alice', flushMs: 0, pullMs: 0 });
  sync.configure({ syncUrl: 'https://test.supabase.co', syncKey: 'public',
    syncAccountId: server.users.alice, accountPolicy: policy, rooms: [] });
  const e = timed('Qiient-Si-Tertum', 'Touos-Ataglos');
  sync.push({ ...e, expiresAt: Date.parse(e.expiresAt) });
  assert.deepEqual(sync.status().targets, [policy.personalMap]);
  server.setOffline(true);
  await sync.flush();
  assert.equal(sync.status().queued, 1);
  server.setOffline(false);
  sync.state.failUntil = 0;
  await sync.flush();
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: policy.personalMap })).edges.length, 1);
  sync.removePersonal(e.a, e.b);
  await sync.flush();
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: policy.personalMap })).edges.length, 0);
});

test('a pending account policy keeps cloud observations queued', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  const sync = createSync({ fetch: server.fetch, getToken: async () => 'alice', flushMs: 0 });
  sync.configure({ syncUrl: 'https://test.supabase.co', syncKey: 'public',
    syncAccountId: server.users.alice, rooms: [] });
  const e = timed('Qiient-Si-Tertum', 'Touos-Ataglos');
  sync.push({ ...e, expiresAt: Date.parse(e.expiresAt) });
  assert.equal(await sync.flush(), 0);
  assert.equal(sync.status().queued, 1);
  const policy = await sync.accountPolicy();
  sync.configure({ syncUrl: 'https://test.supabase.co', syncKey: 'public',
    syncAccountId: server.users.alice, accountPolicy: policy, rooms: [] });
  assert.equal(await sync.flush(), 1);
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: policy.personalMap })).edges.length, 1);
});

test('a second device restores the personal map and observes cloud deletions', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  const policy = await server.rpc('alice', 'account_policy');
  const e = timed('Qiient-Si-Tertum', 'Touos-Ataglos');
  await server.rpc('alice', 'push_edges', { p_map: policy.personalMap, p_edges: [e] });
  const modulePath = require.resolve('../lib/store');
  delete require.cache[modulePath];
  const store = require('../lib/store');
  store.setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-cloud-restore-')));
  store.load();
  const sync = createSync({ fetch: server.fetch, getToken: async () => 'alice', flushMs: 0,
    onSnapshot: (rows, scope, pending) => store.replacePersonal(rows, scope, pending) });
  sync.configure({ syncUrl: 'https://test.supabase.co', syncKey: 'public',
    syncAccountId: server.users.alice, accountPolicy: policy, rooms: [] });
  await sync.pull();
  let rows = store.snapshot().edges;
  assert.equal(rows.length, 1);
  assert.equal(store.mapsOf(rows[0]).includes('local'), true);
  assert.equal(rows[0].cloudOnly, true);
  await server.rpc('alice', 'delete_edge', { p_map: policy.personalMap, p_a: e.a, p_b: e.b });
  await sync.pull();
  rows = store.snapshot().edges;
  assert.equal(rows.length, 0);
});
