'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/shared-database');

test('portal authors are delayed and restricted to guardians in every public read endpoint', async t => {
  const h = await createDatabase();
  t.after(() => h.close());
  const map = await h.rpc('alice', 'create_map', { p_title: 'Private group' });
  await h.rpc('bob', 'join_test_fixture', { p_map: map });
  await h.rpc('alice', 'push_edges', { p_map: map, p_edges: [{
    a: 'Qiient-Qi-Odesas', b: 'Coues-Exakrom', source: 'ocr', by: 'spoofed-name',
    expiresAt: new Date(Date.now() + 3600e3).toISOString(),
  }] });

  const ownerBefore = await h.rpc('alice', 'pull_map_snapshot', { p_map: map });
  const memberBefore = await h.rpc('bob', 'pull_map_snapshot', { p_map: map });
  assert.equal(ownerBefore.edges[0].by_nick, null);
  assert.equal(memberBefore.edges[0].by_nick, null);
  assert.deepEqual(ownerBefore.edges[0].reporters, []);
  assert.deepEqual(memberBefore.edges[0].reporters, []);
  assert.ok(Date.parse(ownerBefore.edges[0].first_seen_at) > Date.now() - 60000);
  assert.equal((await h.rpc('alice', 'pull_edges', { p_map: map }))[0].by_nick, null);

  // Move the server-owned first-seen clock past the privacy boundary. No new
  // portal scan is needed for the guardian's snapshot version to change.
  const originalRevision = (await h.db.query('select sync_version from public.maps where id = $1', [map])).rows[0].sync_version;
  await h.db.query("update public.edges set first_seen_at = now() - interval '16 minutes' where map_id = $1", [map]);
  await h.db.query('update public.maps set sync_version = $2 where id = $1', [map, originalRevision]);
  const ownerAfter = await h.rpc('alice', 'pull_map_snapshot', { p_map: map, p_version: ownerBefore.version });
  const memberAfter = await h.rpc('bob', 'pull_map_snapshot', { p_map: map, p_version: memberBefore.version });
  assert.equal(ownerAfter.unchanged, false);
  assert.equal(ownerAfter.edges[0].by_nick, 'alice', 'the authenticated profile, not user-supplied JSON, is the author');
  assert.equal(memberAfter.unchanged, true, 'ordinary members need no new snapshot at the reveal boundary');
  assert.deepEqual(ownerAfter.edges[0].reporters, []);
  assert.equal((await h.rpc('alice', 'pull_edges', { p_map: map }))[0].by_nick, 'alice');
  assert.equal((await h.rpc('bob', 'pull_edges', { p_map: map }))[0].by_nick, null);

  await h.rpc('alice', 'set_member_role', { p_map: map, p_user: h.users.bob, p_role: 'admin' });
  const guardian = await h.rpc('bob', 'pull_map_snapshot', { p_map: map, p_version: memberAfter.version });
  assert.equal(guardian.unchanged, false);
  assert.equal(guardian.edges[0].by_nick, 'alice');
});
