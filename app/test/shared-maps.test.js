'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createDatabase } = require('./helpers/shared-database');
const { createSync } = require('../lib/sync');

function client(server, user, rooms, options = {}) {
  const modulePath = require.resolve('../lib/store');
  delete require.cache[modulePath];
  const store = require('../lib/store');
  const dir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'avalon-shared-map-'));
  store.setDataDir(dir);
  const config = { syncUrl: 'https://test.supabase.co', syncKey: 'test-public-key', syncAccountId: user, nick: user, rooms };
  const sync = createSync({ fetch: server.fetch, getToken: async () => user,
    file: path.join(dir, 'sync-outbox.json'),
    flushMs: 0, pullMs: 0, onMerge: (rows, scope) => store.mergeRemote(rows, scope),
    onSnapshot: (rows, scope, pending) => store.replaceRemote(rows, scope, pending), ...options });
  sync.configure(config);
  return { sync, store, config, dir, close() { sync.stop(); store.flush(); } };
}
const edge = extra => ({ a: 'Qiient-Si-Tertum', b: 'Touos-Ataglos', capMax: 20,
  capMaxKnown: true, source: 'ocr', expiresAt: Date.now() + 3600000, ...extra });
const wire = extra => edge({ expiresAt: new Date(Date.now() + 3600000).toISOString(), ...extra });

test('shared maps use the real SQL with separate authenticated clients', async t => {
  const server = await createDatabase();
  t.after(() => server.close());
  async function room(policy = 0) {
    const id = await server.rpc('alice', 'create_map', { p_title: 'Shared test' });
    for (const user of ['bob', 'carol']) await server.rpc(user, 'join_map', { p_map: id });
    await server.rpc('alice', 'set_member_role', { p_map: id, p_user: server.users.bob, p_role: 'member' });
    if (policy) await server.rpc('alice', 'set_map_policy', { p_map: id, p_confirm: policy });
    return id;
  }
  await t.test('viewer receives portals without being allowed to upload', async t => {
    const id = await room();
    const alice = client(server, 'alice', [{ id, upload: true, role: 'admin' }]);
    const carol = client(server, 'carol', [{ id, upload: true, role: 'viewer' }]);
    t.after(() => { alice.close(); carol.close(); });
    alice.sync.push(edge({ by: 'alice' }));
    await alice.sync.flush(); await carol.sync.pull();
    assert.equal(carol.store.snapshot().edges.length, 1);
    assert.equal(carol.sync.push(edge()), 0);
  });
  await t.test('turning off upload still receives the group map', async t => {
    const id = await room();
    await server.rpc('alice', 'push_edges', { p_map: id,
      p_edges: [edge({ by: 'alice', expiresAt: new Date(Date.now() + 3600000).toISOString() })] });
    const bob = client(server, 'bob', [{ id, upload: false, role: 'member' }]);
    t.after(() => bob.close());
    await bob.sync.pull();
    assert.equal(bob.store.snapshot().edges.length, 1);
  });
  await t.test('second independent confirmation is counted immediately', async () => {
    const id = await room(2);
    await server.rpc('alice', 'set_member_role', { p_map: id, p_user: server.users.carol, p_role: 'member' });
    for (const user of ['bob', 'carol']) await server.rpc(user, 'push_edges', {
      p_map: id, p_edges: [edge({ by: user, expiresAt: new Date(Date.now() + 3600000).toISOString() })] });
    const rows = await server.rpc('bob', 'pull_edges', { p_map: id });
    assert.equal(Number(rows[0].confirms), 2);
    assert.deepEqual(new Set(rows[0].reporters), new Set(['bob', 'carol']));
  });
  await t.test('portal without a timer is not stored in a group map', async () => {
    const id = await room();
    await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [edge({ expiresAt: null })] });
    const rows = await server.rpc('bob', 'pull_edges', { p_map: id });
    assert.equal(rows.length, 0);
  });
  await t.test('two contributors see the same portals, authors and corrections', async t => {
    const id = await room();
    const alice = client(server, 'alice', [{ id, upload: true, role: 'admin' }]);
    const bob = client(server, 'bob', [{ id, upload: true, role: 'member' }]);
    t.after(() => { alice.close(); bob.close(); });
    alice.sync.push(edge({ by: 'alice' }));
    await alice.sync.flush(); await alice.sync.pull(); await bob.sync.pull();
    const corrected = Date.now() + 120000;
    bob.sync.push(edge({ by: 'bob', expiresAt: corrected, capMax: 7 }));
    await bob.sync.flush(); await alice.sync.pull(); await bob.sync.pull();
    for (const c of [alice, bob]) {
      const [e] = c.store.snapshot().edges;
      assert.equal(c.store.snapshot().edges.length, 1);
      assert.equal(e.expiresAt, corrected);
      assert.equal(e.capMax, 7);
      assert.equal(e.conf[id].confirms, 2);
      assert.deepEqual(e.who[id], ['alice', 'bob']);
      assert.deepEqual(c.store.state.players, {});
    }
    alice.sync.push(edge({ by: 'alice', expiresAt: corrected }));
    await alice.sync.flush(); await bob.sync.pull();
    assert.deepEqual(bob.store.snapshot().edges[0].who[id], ['alice', 'bob']);
  });
  await t.test('deletion reaches a second client and keeps its other maps', async t => {
    const id = await room(), another = await room();
    await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [wire()] });
    const bob = client(server, 'bob', [{ id, upload: false, role: 'member' }]);
    t.after(() => bob.close());
    await bob.sync.pull();
    const e = bob.store.snapshot().edges[0];
    e.maps.push('local', another);
    await server.rpc('alice', 'delete_edge', { p_map: id, p_a: e.a, p_b: e.b });
    await bob.sync.pull();
    assert.deepEqual(bob.store.snapshot().edges[0].maps, ['local', another]);
    assert.equal(bob.store.snapshot().edges[0].conf[id], undefined);
  });
  await t.test('deleting from a selected room preserves the original local observation', async t => {
    const id = await room();
    const alice = client(server, 'alice', [{ id, upload: true, role: 'admin' }]);
    const bob = client(server, 'bob', [{ id, upload: false, role: 'member' }]);
    t.after(() => { alice.close(); bob.close(); });
    const observed = alice.store.addEdge('Qiient-Si-Tertum', { name: 'Touos-Ataglos',
      capMax: 20, capMaxKnown: true, closes: 3600 }, 'alice', 'ocr', ['local', id]);
    alice.sync.push(observed);
    await alice.sync.flush(); await alice.sync.pull(); await bob.sync.pull();
    await alice.sync.deleteEdge(id, observed.a, observed.b);
    alice.store.removeEdgeFromMap(observed.a, observed.b, id);
    await alice.sync.pull(); await bob.sync.pull();
    assert.deepEqual(alice.store.snapshot().edges[0].maps, ['local']);
    assert.equal(bob.store.snapshot().edges.length, 0);
  });
  await t.test('lowering the confirmation threshold reveals an older portal', async t => {
    const id = await room(2);
    await server.rpc('bob', 'push_edges', { p_map: id, p_edges: [wire()] });
    const carol = client(server, 'carol', [{ id, upload: false, role: 'viewer' }]);
    t.after(() => carol.close());
    await carol.sync.pull();
    assert.equal(carol.store.snapshot().edges.length, 0);
    await server.rpc('alice', 'set_map_policy', { p_map: id, p_confirm: 0 });
    await carol.sync.pull();
    assert.equal(carol.store.snapshot().edges.length, 1);
  });
  await t.test('unchanged rooms do not download their portals again', async t => {
    const id = await room();
    await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [wire()] });
    let snapshots = 0;
    const bob = client(server, 'bob', [{ id, upload: false, role: 'member' }], {
      onSnapshot: () => { snapshots++; },
    });
    t.after(() => bob.close());
    await bob.sync.pull(); await bob.sync.pull(); await bob.sync.pull();
    assert.equal(snapshots, 1);
    const result = await server.rpc('bob', 'pull_map_snapshot', {
      p_map: id, p_version: bob.sync.state.versions[id],
    });
    assert.equal(result.unchanged, true);
    assert.equal(result.edges, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 150);
  });
  await t.test('a reporter rename invalidates the room snapshot', async () => {
    const id = await room();
    await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [wire()] });
    const before = await server.rpc('bob', 'pull_map_snapshot', { p_map: id });
    await server.rpc('alice', 'ensure_profile', { p_nick: 'alice-renamed' });
    const after = await server.rpc('bob', 'pull_map_snapshot', { p_map: id, p_version: before.version });
    assert.equal(after.unchanged, false);
    assert.deepEqual(after.edges[0].reporters, ['alice-renamed']);
    await server.rpc('alice', 'ensure_profile', { p_nick: 'alice' });
  });
  await t.test('role promotion and revocation reach a running client', async t => {
    const id = await room();
    await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [wire()] });
    const carol = client(server, 'carol', [{ id, upload: true, role: 'viewer' }], {
      onAccess: (map, access) => {
        if (access.role === 'none') carol.config.rooms = [];
        else carol.config.rooms[0].role = access.role;
        carol.sync.configure(carol.config);
      },
    });
    t.after(() => carol.close());
    await carol.sync.pull();
    assert.equal(carol.sync.push(edge()), 0);
    await server.rpc('alice', 'set_member_role', { p_map: id, p_user: server.users.carol, p_role: 'member' });
    await carol.sync.pull();
    assert.equal(carol.sync.push(edge()), 1);
    await server.rpc('alice', 'kick_member', { p_map: id, p_user: server.users.carol });
    await carol.sync.pull();
    assert.equal(carol.store.snapshot().edges.length, 0);
    assert.equal(carol.sync.status().enabled, false);
    assert.equal(carol.sync.status().queued, 0);
  });
  await t.test('expired portals do not reuse previous confirmations', async () => {
    const id = await room(2);
    await server.rpc('bob', 'push_edges', { p_map: id, p_edges: [wire()] });
    await server.db.query("update public.edges set expires_at = now() - interval '1 second' where map_id = $1", [id]);
    await server.rpc('alice', 'set_member_role', { p_map: id, p_user: server.users.carol, p_role: 'member' });
    await server.rpc('carol', 'push_edges', { p_map: id, p_edges: [wire()] });
    const rows = await server.rpc('carol', 'pull_edges', { p_map: id });
    assert.equal(Number(rows[0].confirms), 1);
    assert.deepEqual(rows[0].reporters, ['carol']);
  });
  await t.test('outbox survives offline restart and reaches the other participant', async t => {
    const id = await room();
    let time = Date.now();
    const alice = client(server, 'alice', [{ id, upload: true, role: 'admin' }], { now: () => time });
    const bob = client(server, 'bob', [{ id, upload: false, role: 'member' }]);
    server.setOffline(true);
    alice.sync.push(edge({ by: 'alice' }));
    await alice.sync.tick(); alice.close();
    assert.equal(alice.sync.status().queued, 1);
    const restarted = client(server, 'alice', alice.config.rooms, { dataDir: alice.dir, now: () => time });
    t.after(() => { restarted.close(); bob.close(); server.setOffline(false); });
    time += 60000; server.setOffline(false);
    await restarted.sync.tick(); await bob.sync.pull();
    assert.equal(restarted.sync.status().queued, 0);
    assert.equal(bob.store.snapshot().edges.length, 1);
  });
  await t.test('a response started before leaving a room is discarded', async t => {
    const id = await room();
    await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [wire()] });
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const bob = client(server, 'bob', [{ id, upload: false, role: 'member' }], {
      fetch: async (...args) => { const result = await server.fetch(...args); entered(); await held; return result; },
    });
    t.after(() => bob.close());
    const response = bob.sync.pull(); await started;
    bob.sync.configure({ ...bob.config, rooms: [] }); release(); await response;
    assert.equal(bob.store.snapshot().edges.length, 0);
  });
  await t.test('a response from a previous account is discarded', async t => {
    const id = await room();
    await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [wire()] });
    let release, entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const bob = client(server, 'bob', [{ id, upload: false, role: 'member' }], {
      fetch: async (...args) => { const result = await server.fetch(...args); entered(); await held; return result; },
    });
    t.after(() => bob.close());
    const response = bob.sync.pull(); await started;
    bob.sync.configure({ ...bob.config, syncAccountId: 'outsider' }); release(); await response;
    assert.equal(bob.store.snapshot().edges.length, 0);
  });
  await t.test('repeated rate limits preserve unsent portals', async t => {
    const id = await room();
    for (const status of [400, 429]) {
      let limited = true, time = Date.now();
      const alice = client(server, 'alice', [{ id, upload: true, role: 'admin' }], {
        now: () => time,
        fetch: (...args) => limited ? Promise.resolve({ ok: false, status,
          text: async () => JSON.stringify({ code: 'P0001', message: 'слишком часто: push' }) }) : server.fetch(...args),
      });
      t.after(() => alice.close());
      alice.sync.push(edge());
      for (let n = 0; n < 4; n++) { await alice.sync.flush(); time += 600000; }
      assert.equal(alice.sync.status().queued, 1);
      limited = false; await alice.sync.flush();
      assert.equal(alice.sync.status().queued, 0);
    }
  });
  await t.test('outsiders cannot read a room, write portals or grant roles', async () => {
    const id = await room();
    assert.deepEqual(await server.rpc('outsider', 'pull_map_snapshot', { p_map: id }), { denied: true });
    for (const user of ['outsider', 'carol']) {
      await assert.rejects(server.rpc(user, 'push_edges', { p_map: id, p_edges: [wire()] }), { code: '42501' });
      await assert.rejects(server.rpc(user, 'set_member_role', {
        p_map: id, p_user: server.users[user], p_role: 'admin',
      }), { code: '42501' });
    }
    await assert.rejects(server.rpc('anonymous', 'pull_map_snapshot', { p_map: id }), { code: '42501' });
  });
  await t.test('a snapshot includes more than 2000 portals with the same timestamp', async () => {
    const id = await room();
    await server.db.query(`insert into public.edges(map_id,a,b,expires_at,updated_at,trusted)
      select $1, 'Alpha', 'Zone-' || lpad(n::text, 5, '0'), now()+interval '1 hour', now(), true
      from generate_series(1,2001) n`, [id]);
    const result = await server.rpc('carol', 'pull_map_snapshot', { p_map: id });
    assert.equal(result.edges.length, 2001);
  });
});

test('guardian portals are visible immediately and never labeled as pending after the server upgrade', async t => {
  const server = await createDatabase({ through: 8 });
  t.after(() => server.close());
  const id = await server.rpc('alice', 'create_map', { p_title: 'Trusted visibility' });
  await server.rpc('bob', 'join_map', { p_map: id });
  await server.rpc('carol', 'join_map', { p_map: id });
  await server.rpc('alice', 'set_member_role', { p_map: id, p_user: server.users.bob, p_role: 'member' });
  await server.rpc('alice', 'set_map_policy', { p_map: id, p_confirm: 3 });
  const trusted = wire(), pending = wire({ a: 'Casos-Aiagsum', b: 'Sebos-Oyohun' });
  await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [trusted] });
  await server.rpc('bob', 'push_edges', { p_map: id, p_edges: [pending] });
  const before = await server.rpc('carol', 'pull_map_snapshot', { p_map: id });
  assert.equal(before.edges.length, 1, 'a viewer already receives the guardian portal');
  assert.equal(before.edges[0].needed, 3, 'the old response wrongly labels it pending');

  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migration-09-trusted-portal-visibility.sql'), 'utf8');
  await server.db.exec(sql);
  const refreshed = await server.rpc('carol', 'pull_map_snapshot', { p_map: id, p_version: before.version });
  assert.equal(refreshed.unchanged, false, 'existing clients receive corrected metadata');
  assert.equal(refreshed.confirmRequired, 3, 'the policy for ordinary reporters is unchanged');
  assert.equal(refreshed.edges.length, 1);
  assert.equal(refreshed.edges[0].needed, 0);
  const legacy = await server.rpc('carol', 'pull_edges', { p_map: id });
  assert.equal(legacy[0].needed, 0);

  const viewer = client(server, 'carol', [{ id, upload: false, role: 'viewer' }]);
  const member = client(server, 'bob', [{ id, upload: false, role: 'member' }]);
  t.after(() => { viewer.close(); member.close(); });
  await viewer.sync.pull(); await member.sync.pull();
  assert.equal(viewer.store.snapshot().edges.length, 1);
  assert.equal(viewer.store.pendingIn(viewer.store.snapshot().edges[0], id), null);
  const memberEdges = member.store.snapshot().edges;
  assert.equal(memberEdges.length, 2, 'a reporter still sees their own pending portal');
  assert.equal(member.store.pendingIn(memberEdges.find(e => e.a === trusted.a), id), null);
  assert.equal(member.store.pendingIn(memberEdges.find(e => e.a === pending.a), id).needed, 3);
});

test('legacy server compatibility, online upgrade and repeatable migration', async t => {
  const server = await createDatabase({ through: 7 });
  t.after(() => server.close());
  const id = await server.rpc('alice', 'create_map', { p_title: 'Upgrade check' });
  await server.rpc('bob', 'join_map', { p_map: id });
  const original = wire();
  await server.rpc('alice', 'push_edges', { p_map: id, p_edges: [original] });
  let time = Date.now();
  const bob = client(server, 'bob', [{ id, role: 'viewer', upload: false }], { now: () => time });
  t.after(() => bob.close());
  await bob.sync.pull();
  assert.equal(bob.store.snapshot().edges.length, 1);
  assert.equal(bob.sync.status().legacyServer, true);
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migration-08-shared-map-sync.sql'), 'utf8');
  await server.db.exec(sql); await server.db.exec(sql);
  time += 61000; await bob.sync.pull();
  assert.equal(bob.sync.status().legacyServer, false);
  assert.equal(bob.store.snapshot().edges[0].expiresAt, Date.parse(original.expiresAt));
  await server.rpc('alice', 'delete_edge', { p_map: id, p_a: original.a, p_b: original.b });
  await bob.sync.pull();
  assert.equal(bob.store.snapshot().edges.length, 0);
});

test('graph deletion uses the selected room and its permissions, including locally recorded portals', async () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../ui/map.js'), 'utf8');
  const functions = ['edgeLabelData', 'edgeMaps', 'edgeDeleteScope', 'canDeleteEdge', 'removeEdgeData'];
  const code = functions.map(name => {
    const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(match, name + ' is present');
    return match[0];
  }).join('\n');
  let deletedFrom;
  const context = vm.createContext({ chanView: 'room-a', chanRooms: [{ id: 'room-a', role: 'admin' }],
    PUBLIC_ID: 'public', accTrusted: false, RECENT_MS: 300000, fmtLeft: () => '',
    ipc: { removeEdge: async (a, b, scope) => { deletedFrom = scope; return { ok: true, snapshot: {} }; } },
    render() {},
  });
  vm.runInContext(code, context);
  context.data = { a: 'A', b: 'B', ...context.edgeLabelData({ scope: 'local', maps: ['local', 'room-a', 'room-b'] }, Date.now()) };
  assert.equal(context.canDeleteEdge(context.data), true);
  await context.removeEdgeData(context.data);
  assert.equal(deletedFrom, 'room-a');
  context.chanRooms[0].role = 'viewer'; context.accTrusted = true;
  assert.equal(context.canDeleteEdge(context.data), false);
  context.chanView = 'local';
  assert.equal(context.canDeleteEdge(context.data), true);
  await context.removeEdgeData(context.data);
  assert.equal(deletedFrom, 'local');
});

test('incomplete snapshots and failed local writes do not erase data or advance the version', async t => {
  const id = '10000000-0000-4000-8000-000000000099';
  let result = { version: '1', unchanged: false }, applied = 0, writeFails = false;
  const sync = createSync({ flushMs: 0, getToken: async () => 'bob',
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(result) }),
    onSnapshot: () => { if (writeFails) throw new Error('write failed'); applied++; },
  });
  t.after(() => sync.stop());
  sync.configure({ syncUrl: 'https://test.invalid', syncKey: 'test', rooms: [{ id, role: 'viewer' }] });
  await sync.pull();
  assert.equal(applied, 0); assert.equal(sync.state.versions[id], undefined);
  result = { version: '2', unchanged: false, edges: [] }; writeFails = true;
  sync.state.failUntil = 0; await sync.pull();
  assert.equal(applied, 0); assert.equal(sync.state.versions[id], undefined);
  writeFails = false; sync.state.failUntil = 0; await sync.pull();
  assert.equal(applied, 1); assert.equal(sync.state.versions[id], '2');
});
