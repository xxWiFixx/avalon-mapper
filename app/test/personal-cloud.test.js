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

test('upgrade removes publication and preserves existing personal and group maps', async t => {
  const server = await createDatabase({ through: 11 });
  t.after(() => server.close());
  await server.db.query("insert into public.maps (id, kind, title) values ($1, 'public', 'Legacy')", [PUBLIC_MAP_ID]);
  await server.db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-personal-cloud.sql'), 'utf8'));
  const alice = await server.rpc('alice', 'account_policy');
  const edge = timed('Qiient-Si-Tertum', 'Touos-Ataglos');
  await server.rpc('alice', 'push_edges', { p_map: alice.personalMap, p_edges: [edge] });
  const room = await server.rpc('alice', 'create_map', { p_title: 'Private group' });
  await server.rpc('bob', 'join_map', { p_map: room });
  await server.rpc('alice', 'push_edges', { p_map: room, p_edges: [edge] });
  assert.equal((await server.rpc('owner', 'pull_map_snapshot', { p_map: alice.personalMap })).edges.length, 1);
  assert.equal((await server.rpc('owner', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID })).edges.length, 1);

  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migration-13-private-cloud-only.sql'), 'utf8');
  await server.db.exec(sql);
  assert.equal((await server.rpc('owner', 'pull_map_snapshot', { p_map: alice.personalMap })).denied, true);
  assert.equal((await server.rpc('owner', 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID })).denied, true);
  assert.deepEqual(await server.rpc('owner', 'pull_edges', { p_map: PUBLIC_MAP_ID }), []);
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: alice.personalMap })).edges.length, 1);
  assert.equal((await server.rpc('bob', 'pull_map_snapshot', { p_map: room })).edges.length, 1);
  for (const fn of ['global_edges()', 'admin_personal_maps()', 'account_set_sharing(boolean)',
    'touch_global_from_personal_edge()', 'touch_global_from_sharing()']) {
    assert.equal((await server.db.query('select to_regprocedure($1) as fn', ['public.' + fn])).rows[0].fn, null, fn);
  }
  assert.equal((await server.db.query("select count(*)::int as n from pg_trigger where tgname in ('personal_edge_global_version', 'sharing_global_version')")).rows[0].n, 0);
  await server.db.exec(sql); // Safe to apply again, including to a clean install.
  await server.rpc('alice', 'delete_edge', { p_map: alice.personalMap, p_a: edge.a, p_b: edge.b });
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: alice.personalMap })).edges.length, 0);
  assert.equal((await server.rpc('bob', 'pull_map_snapshot', { p_map: room })).edges.length, 1);
});

test('free and Pro accounts have equally private cloud maps without privileged owner access', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  await server.db.query("update public.profiles set plan = 'pro' where id = $1", [server.users.bob]);
  const alice = await server.rpc('alice', 'account_policy');
  const bob = await server.rpc('bob', 'account_policy');
  assert.equal(alice.plan, 'free');
  assert.equal(bob.plan, 'pro');
  assert.equal(Object.hasOwn(alice, 'sharePublic'), false);
  assert.equal(Object.hasOwn(bob, 'canViewAll'), false);
  await server.rpc('alice', 'push_edges', { p_map: alice.personalMap,
    p_edges: [timed('Qiient-Si-Tertum', 'Touos-Ataglos'),
      { ...timed('Secent-Al-Nusis', 'Qiient-Si-Tertum'), expiresAt: null }] });
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: alice.personalMap })).edges.length, 1);
  for (const account of ['bob', 'owner', 'guest', 'outsider']) {
    assert.equal((await server.rpc(account, 'pull_map_snapshot', { p_map: alice.personalMap })).denied, true);
    assert.equal((await server.rpc(account, 'pull_map_snapshot', { p_map: PUBLIC_MAP_ID })).denied, true);
    assert.deepEqual(await server.rpc(account, 'pull_edges', { p_map: alice.personalMap }), []);
    assert.deepEqual(await server.rpc(account, 'pull_edges', { p_map: PUBLIC_MAP_ID }), []);
    await assert.rejects(server.rpc(account, 'push_edges', { p_map: alice.personalMap,
      p_edges: [timed('Secent-Al-Nusis', 'Touos-Ataglos')] }), /не в этой карте/);
  }
  await assert.rejects(server.rpc('owner', 'delete_edge', { p_map: alice.personalMap,
    p_a: 'Qiient-Si-Tertum', p_b: 'Touos-Ataglos' }), /хранитель/);
});

test('anonymous account keeps a private cloud map but cannot use group maps', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  const guest = await server.rpc('guest', 'account_policy');
  assert.equal(guest.plan, 'free');
  await server.rpc('guest', 'push_edges', { p_map: guest.personalMap,
    p_edges: [timed('Qiient-Si-Tertum', 'Touos-Ataglos')] });
  assert.equal((await server.rpc('guest', 'pull_map_snapshot', { p_map: guest.personalMap })).edges.length, 1);
  assert.equal((await server.rpc('owner', 'pull_map_snapshot', { p_map: guest.personalMap })).denied, true);
  await assert.rejects(server.rpc('guest', 'create_map', { p_title: 'Guest room' }), /Discord/);
  const room = await server.rpc('alice', 'create_map', { p_title: 'Room' });
  await assert.rejects(server.rpc('guest', 'join_map', { p_map: room }), /Discord/);
});

test('client ignores obsolete publication flags, roles, rooms and queued uploads', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  const policy = await server.rpc('alice', 'account_policy');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-private-cloud-'));
  const file = path.join(dir, 'queue.json');
  fs.writeFileSync(file, JSON.stringify({ outbox: [{ target: PUBLIC_MAP_ID,
    edge: timed('Qiient-Si-Tertum', 'Touos-Ataglos') }] }));
  const sync = createSync({ file, fetch: server.fetch, getToken: async () => 'alice', flushMs: 0, pullMs: 0 });
  t.after(() => sync.stop());
  sync.configure({ syncUrl: 'https://test.supabase.co', syncKey: 'public', uploadPublic: true,
    syncAccountId: server.users.alice, accountPolicy: { ...policy, canViewAll: true, sharePublic: true },
    rooms: [{ id: PUBLIC_MAP_ID, upload: true, role: 'admin' }] });
  assert.deepEqual(sync.status().targets, [policy.personalMap]);
  assert.deepEqual(sync.status().readTargets, [policy.personalMap]);
  sync.push({ ...timed('Qiient-Si-Tertum', 'Touos-Ataglos'), expiresAt: Date.now() + 3600000 });
  await sync.tick(true);
  assert.equal(server.calls.some(c => c.body.p_map === PUBLIC_MAP_ID), false);
  assert.equal((await server.rpc('alice', 'pull_map_snapshot', { p_map: policy.personalMap })).edges.length, 1);
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
