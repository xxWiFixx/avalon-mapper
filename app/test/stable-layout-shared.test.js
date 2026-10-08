'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/shared-database');
test('shared layout enforces access, CAS, immutable existing points, owner reset and upgrade idempotency', async () => {
  const h = await createDatabase();
  try {
    const map = await h.rpc('alice', 'create_map', { p_title: 'Stable map' });
    await h.rpc('bob', 'join_test_fixture', { p_map: map });
    await h.rpc('alice', 'push_edges', { p_map: map, p_edges: [
      { a: 'Alpha', b: 'Beta', expiresAt: new Date(Date.now() + 3600000).toISOString(), source: 'ocr' },
    ] });
    const call = (user, positions = null, revision = null, replace = false) => h.rpc(user, 'map_layout', {
      p_map: map, p_positions: positions && JSON.stringify(positions), p_revision: revision, p_replace: replace,
    });
    const since = (user, revision = null) => h.rpc(user, 'map_layout_since', { p_map: map, p_revision: revision });
    assert.deepEqual(await call('alice'), { revision: 0, positions: {} });
    assert.deepEqual(await since('alice'), { revision: 0, positions: {} });
    assert.deepEqual(await since('bob', 0), { revision: 0, unchanged: true });
    const p = { Alpha: { x: 0, y: 0 }, Beta: { x: 180, y: 0 } };
    assert.equal((await call('alice', p, 0)).revision, 1);
    assert.deepEqual(await since('bob', 0), { revision: 1, positions: p });
    assert.deepEqual(await since('bob', 1), { revision: 1, unchanged: true });
    const conflict = await call('bob', { Alpha: { x: 999, y: 999 } }, 0);
    assert.equal(conflict.conflict, true); assert.deepEqual(conflict.positions, p);
    assert.deepEqual((await call('bob', { Alpha: { x: 999, y: 999 }, Hidden: { x: 4, y: 4 } }, 1)).positions, p);
    await assert.rejects(call('outsider'), /map_access_denied/);
    await assert.rejects(call(null), /permission denied/);
    await assert.rejects(call('bob', p, 1, true), /layout_role_required/);
    await assert.rejects(call('alice', { Beta: { x: 1e20, y: 0 } }, 1), /invalid_position/);
    await assert.rejects(call('alice', { Beta: { x: 'bad', y: 0 } }, 1), /invalid_position/);
    const reset = { Alpha: { x: 0, y: 150 }, Beta: { x: 180, y: 150 } };
    assert.equal((await call('alice', reset, 1, true)).revision, 2);
    assert.deepEqual((await call('bob')).positions, reset);
    assert.deepEqual(await since('bob', 1), { revision: 2, positions: reset });
    const fs = require('node:fs'), path = require('node:path');
    await h.db.exec(fs.readFileSync(path.resolve(__dirname, '../../supabase/migration-17-stable-map-layout.sql'), 'utf8'));
    assert.deepEqual((await call('alice')).positions, reset);
    await h.rpc('alice', 'kick_member', { p_map: map, p_user: h.users.bob });
    await assert.rejects(call('bob'), /map_access_denied/);
    await assert.rejects(since('bob', 2), /map_access_denied/);
    assert.equal((await h.rpc('alice', 'pull_map_snapshot', { p_map: map })).edges.length, 1);
  } finally { await h.close(); }
});
test('personal coordinates stay private and inactive group subscription blocks layout access', async () => {
  const h = await createDatabase();
  try {
    const policy = await h.rpc('alice', 'account_policy');
    const read = (user, map) => h.rpc(user, 'map_layout', { p_map: map });
    const since = (user, map, revision = null) => h.rpc(user, 'map_layout_since', { p_map: map, p_revision: revision });
    assert.deepEqual((await read('alice', policy.personalMap)).positions, {});
    assert.deepEqual(await since('alice', policy.personalMap, 0), { revision: 0, unchanged: true });
    await assert.rejects(read('bob', policy.personalMap), /map_access_denied/);
    await assert.rejects(since('bob', policy.personalMap), /map_access_denied/);
    await assert.rejects(since(null, policy.personalMap), /permission denied/);
    const map = await h.rpc('alice', 'create_map', { p_title: 'Group' });
    await h.db.exec('update public.billing_configuration set enabled = true');
    await assert.rejects(read('alice', map), /group_subscription_expired/);
    await assert.rejects(since('alice', map), /group_subscription_expired/);
    assert.deepEqual((await read('alice', policy.personalMap)).positions, {});
  } finally { await h.close(); }
});
