'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDatabase } = require('./helpers/shared-database');
const { makeBatch, hashCode, generateCode, normalizeCode } = require('../../tools/generate-funpay-codes.cjs');
let d, batch, cursor = 0;
const next = () => batch.codes[cursor++];
const redeem = (user, code, map = null) => d.rpc(user, 'billing_redeem_code', { p_code: code, p_map: map });
const countGrants = async () => (await d.db.query("select count(*)::int n from public.subscriptions where payment_ref like 'funpay-code:%'")).rows[0].n;
before(async () => {
  d = await createDatabase();
  batch = makeBatch(60);
  await d.db.query('select public.billing_register_codes($1,$2::jsonb)', [batch.batchId, JSON.stringify(batch.hashes)]);
  await d.db.exec('update public.billing_configuration set enabled=true');
});
after(async () => { await d?.close(); });

test('offline generator creates unique 150-bit codes and matching canonical SHA-256 hashes', () => {
  const sample = makeBatch(1000);
  assert.equal(new Set(sample.codes).size, 1000);
  assert.equal(new Set(sample.hashes).size, 1000);
  for (let i = 0; i < sample.codes.length; i++) {
    assert.match(sample.codes[i], /^AM30(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}){6}$/);
    assert.equal(hashCode(' \n' + sample.codes[i].toLowerCase() + ' '), sample.hashes[i]);
    assert.equal(normalizeCode(sample.codes[i]).length, 34);
  }
  assert.throws(() => makeBatch(0)); assert.throws(() => makeBatch(10001)); assert.throws(() => makeBatch(1.5));
});

test('batch registration is idempotent; changed content and cross-batch duplicates roll back completely', async () => {
  const register = (id, hashes) => d.db.query('select public.billing_register_codes($1,$2::jsonb) result', [id, JSON.stringify(hashes)]);
  assert.equal((await register(batch.batchId, [...batch.hashes].reverse())).rows[0].result.registered, 60);
  await assert.rejects(register(batch.batchId, [hashCode(generateCode())]), /code_batch_conflict/);
  const conflict = randomUUID();
  await assert.rejects(register(conflict, [hashCode(generateCode()), batch.hashes[0]]), /duplicate key/);
  assert.equal((await d.db.query('select count(*)::int n from public.billing_code_batches where id=$1', [conflict])).rows[0].n, 0);
  for (const invalid of [[], ['bad'], [batch.hashes[0], batch.hashes[0]], [null], [42]]) {
    await assert.rejects(register(randomUUID(), invalid), /invalid_code_batch/);
  }
});

test('one code grants exactly 30 days and one new map; retry never grants twice or extends time', async () => {
  const code = next();
  const started = Date.now();
  const first = await redeem('alice', code.toLowerCase());
  assert.equal(first.ok, true); assert.equal(first.mapId, null);
  assert.ok(Math.abs(Date.parse(first.expiresAt) - started - 30 * 86400000) < 3000);
  const prior = await countGrants();
  const retry = await redeem('alice', code);
  assert.equal(retry.alreadyRedeemed, true); assert.equal(retry.licenseId, first.licenseId);
  assert.equal(retry.expiresAt, first.expiresAt); assert.equal(await countGrants(), prior);
  const map = await d.rpc('alice', 'create_map', { p_title: 'One paid map' });
  const owned = (await d.rpc('alice', 'my_maps')).find(group => group.id === map);
  assert.equal(owned.role, 'admin'); assert.equal(owned.is_owner, true);
  const sync = require('../lib/sync').createSync({ fetch: async () => { throw new Error('offline'); } });
  sync.configure({ syncUrl: 'https://example.supabase.co', syncKey: 'public', syncAccountId: d.users.alice,
    accountPolicy: { personalMap: d.users.alice }, rooms: [{ ...owned, upload: true }] });
  assert.ok(sync.status().targets.includes(map), 'new paid server owner can upload portals immediately');
  await assert.rejects(d.rpc('alice', 'create_map', { p_title: 'No second slot' }), /group_subscription_required/);
  assert.equal((await redeem('alice', code)).mapId, map);
  assert.equal((await redeem('bob', code)).code, 'invalid_code');
  assert.equal((await redeem('alice', code, map)).code, 'invalid_code');
});

test('another owner, a custodian and a viewer cannot spend a code on a foreign map or elevate roles', async () => {
  const map = (await d.rpc('alice', 'my_maps')).find(x => x.title === 'One paid map').id;
  await d.rpc('bob', 'join_test_fixture', { p_map: map });
  await d.rpc('alice', 'set_member_role', { p_map: map, p_user: d.users.bob, p_role: 'admin' });
  await d.rpc('carol', 'join_test_fixture', { p_map: map });
  for (const user of ['bob', 'carol']) {
    const code = next();
    assert.equal((await redeem(user, code, map)).code, 'map_owner_required');
    const role = (await d.rpc(user, 'my_maps')).find(x => x.id === map).role;
    assert.equal(role, user === 'bob' ? 'admin' : 'viewer');
    // A denied target must not burn the code.
    assert.equal((await redeem(user, code)).ok, true);
  }
});

test('renewal extends current expiry, preserves members, and reactivates an expired group', async () => {
  const map = (await d.rpc('alice', 'my_maps')).find(x => x.title === 'One paid map').id;
  const first = (await d.rpc('alice', 'billing_status')).groups.find(x => x.mapId === map);
  const members = await d.rpc('alice', 'map_members_list', { p_map: map });
  const renewed = await redeem('alice', next(), map);
  assert.equal(Date.parse(renewed.expiresAt) - Date.parse(first.expiresAt), 30 * 86400000);
  assert.deepEqual(await d.rpc('alice', 'map_members_list', { p_map: map }), members);
  await d.db.query("update public.subscriptions set starts_at=now()-interval '61 days',expires_at=now()-interval '1 day' where map_id=$1", [map]);
  assert.equal((await d.rpc('bob', 'pull_map_snapshot', { p_map: map })).paused, true);
  const resumeAt = Date.now();
  const resumed = await redeem('alice', next(), map);
  assert.ok(Math.abs(Date.parse(resumed.expiresAt) - resumeAt - 30 * 86400000) < 3000);
  assert.notEqual((await d.rpc('bob', 'pull_map_snapshot', { p_map: map })).paused, true);
  assert.equal(Date.parse(resumed.status.groups.find(x => x.mapId === map).retainedUntil) - Date.parse(resumed.expiresAt), 120 * 86400000);
});

test('multiple requested redemptions cannot duplicate a grant or lose a renewal', async () => {
  const code = next();
  const initial = await countGrants();
  const results = await Promise.all([redeem('bob', code), redeem('carol', code)]);
  assert.equal(results.filter(x => x.ok).length, 1); assert.equal(await countGrants(), initial + 1);
  const map = (await d.rpc('alice', 'my_maps')).find(x => x.title === 'One paid map').id;
  const before = (await d.rpc('alice', 'billing_status')).groups.find(x => x.mapId === map).expiresAt;
  const renewals = await Promise.all([redeem('alice', next(), map), redeem('alice', next(), map)]);
  assert.ok(renewals.every(x => x.ok));
  const after = (await d.rpc('alice', 'billing_status')).groups.find(x => x.mapId === map).expiresAt;
  assert.equal(Date.parse(after) - Date.parse(before), 60 * 86400000);
});

test('invalid attempts commit a bounded per-account counter; guest and missing Discord identity are rejected', async () => {
  const code = next();
  assert.equal((await redeem('guest', code)).code, 'discord_required');
  await assert.rejects(redeem('nobody', code), /permission denied/);
  await d.db.query("delete from auth.identities where user_id=$1", [d.users.outsider]);
  assert.equal((await redeem('outsider', code)).code, 'discord_required');
  await d.db.query("insert into auth.identities(user_id,provider,provider_id) values($1,'discord','rate-limit-account')", [d.users.outsider]);
  for (let i = 0; i < 20; i++) assert.equal((await redeem('outsider', 'bad')).code, 'invalid_code');
  assert.equal((await redeem('outsider', code)).code, 'code_rate_limited');
  assert.equal((await d.db.query('select attempts from public.billing_code_attempts where account_id=$1', [d.users.outsider])).rows[0].attempts, 20);
  assert.equal((await redeem('carol', code)).ok, true);
});

test('permanent exemption is per UUID, rejects spending codes, and gives no creation or role bypass', async () => {
  const map = (await d.rpc('alice', 'my_maps')).find(x => x.title === 'One paid map').id;
  await d.db.query('select public.billing_set_permanent_group($1,true)', [map]);
  await d.db.query("update public.subscriptions set starts_at=now()-interval '61 days',expires_at=now()-interval '1 day' where map_id=$1", [map]);
  const group = (await d.rpc('alice', 'billing_status')).groups.find(x => x.mapId === map);
  assert.equal(group.active, true); assert.equal(group.permanent, true);
  assert.equal(group.expiresAt, null); assert.equal(group.retainedUntil, null);
  const code = next(); const prior = await countGrants();
  assert.equal((await redeem('alice', code, map)).code, 'group_permanent');
  assert.equal(await countGrants(), prior);
  await assert.rejects(d.rpc('alice', 'create_map', { p_title: 'One paid map' }), /group_subscription_required/);
  assert.equal((await redeem('alice', code)).ok, true);
  const sibling = await d.rpc('alice', 'create_map', { p_title: 'One paid map' });
  assert.equal((await d.rpc('alice', 'billing_status')).groups.find(x => x.mapId === sibling).permanent, false);
});

test('revoked codes cannot activate and revocation affects the exact grant', async () => {
  const code = next();
  await d.db.query('select public.billing_revoke_code($1)', [hashCode(code)]);
  assert.equal((await redeem('bob', code)).code, 'invalid_code');
  const redeemed = next(); const result = await redeem('carol', redeemed);
  await d.db.query('select public.billing_revoke_code($1)', [hashCode(redeemed)]);
  assert.equal((await redeem('carol', redeemed)).code, 'invalid_code');
  assert.ok((await d.db.query('select revoked_at from public.subscriptions where id=$1', [result.licenseId])).rows[0].revoked_at);
});

test('public clients cannot inspect code tables, register/revoke codes, or assign permanent access', async () => {
  for (const role of ['anon', 'authenticated']) {
    const denied = statement => assert.rejects(d.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [d.users.alice]);
      await tx.exec('set local role ' + role); await tx.query(statement);
    }), /permission denied/);
    for (const table of ['billing_codes', 'billing_code_batches', 'billing_code_attempts', 'billing_permanent_groups']) {
      await denied('select * from public.' + table);
    }
    await denied("select public.billing_register_codes(gen_random_uuid(),'[]'::jsonb)");
    await denied("select public.billing_revoke_code('bad')");
    await denied("select public.billing_code_batch_status(gen_random_uuid())");
    await denied("select public.billing_set_permanent_group(gen_random_uuid(),true)");
  }
});

test('migration reapply preserves redeemed codes, map roles, exemption, and rollout flags', async () => {
  const before = await countGrants();
  const groups = await d.rpc('alice', 'my_maps');
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migration-22-funpay-codes.sql'), 'utf8');
  await d.db.exec(sql);
  assert.equal(await countGrants(), before); assert.deepEqual(await d.rpc('alice', 'my_maps'), groups);
  const flags = (await d.db.query('select enabled,payment_ready from public.billing_configuration')).rows[0];
  assert.deepEqual(flags, { enabled: true, payment_ready: false });
  assert.equal((await d.db.query('select count(*)::int n from public.billing_permanent_groups')).rows[0].n, 1);
});

test('free-beta creation consumes a purchased slot but remains free without one while enforcement is off', async () => {
  await d.db.exec('update public.billing_configuration set enabled=false');
  const license = await redeem('owner', next());
  const map = await d.rpc('owner', 'create_map', { p_title: 'Beta paid slot' });
  assert.equal((await d.db.query('select map_id from public.subscriptions where id=$1', [license.licenseId])).rows[0].map_id, map);
  assert.ok(await d.rpc('owner', 'create_map', { p_title: 'Beta free group' }));
});
