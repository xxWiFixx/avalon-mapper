'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDatabase } = require('./helpers/shared-database');
let d;
before(async () => { d = await createDatabase(); await d.db.exec('update public.billing_configuration set enabled=true'); });
after(async () => { await d?.close(); });
const expiry = () => new Date(Date.now() + 3600000).toISOString();
const edge = (name, source = 'ocr') => ({ a: 'Origin', b: name, source, capMax: 7, capMaxKnown: true, expiresAt: expiry() });

test('everyone can save more than ten automatic portals without receipts, preserving private-map permissions', async () => {
  for (const user of ['alice', 'guest']) {
    const { personalMap } = await d.rpc(user, 'account_policy');
    const edges = Array.from({ length: 25 }, (_, i) => edge('Free destination ' + i));
    assert.equal(await d.rpc(user, 'push_edges', { p_map: personalMap, p_edges: edges }), 25);
    const status = await d.rpc(user, 'billing_status');
    assert.equal(status.recordingFree, true); assert.equal(status.unlimited, true);
    assert.equal(status.quota.limit, null); assert.equal(status.trial.eligible, false);
  }
  await assert.rejects(d.rpc('bob', 'push_edges', { p_map: d.users.alice, p_edges: [edge('Intruder')] }));
  await assert.rejects(d.rpc('nobody', 'billing_status'));
});

test('legacy capture calls remain valid beyond ten and cannot reuse another account receipt', async () => {
  let body;
  for (let i = 0; i < 15; i++) {
    body = { p_id: randomUUID(), p_a: 'Legacy origin', p_b: 'Legacy destination ' + i, p_expires: expiry() };
    assert.equal((await d.rpc('bob', 'authorize_capture', body)).ok, true);
  }
  assert.equal((await d.rpc('bob', 'authorize_capture', body)).ok, true);
  assert.equal((await d.rpc('alice', 'authorize_capture', body)).code, 'invalid_receipt');
  assert.equal((await d.rpc('bob', 'authorize_capture', { ...body, p_id: randomUUID(), p_expires: new Date(0).toISOString() })).code, 'invalid_portal');
  assert.equal((await d.db.query('select count(*)::int n from public.capture_usage')).rows[0].n, 0);
  assert.equal((await d.rpc('alice', 'billing_start_trial')).code, 'personal_plan_removed');
  assert.equal((await d.db.query('select count(*)::int n from public.personal_trials')).rows[0].n, 0);
});

test('a group still needs one paid license; members record for free and expiry pauses only group synchronization', async () => {
  await assert.rejects(d.rpc('alice', 'create_map', { p_title: 'Unlicensed' }), /group_subscription_required/);
  await assert.rejects(d.db.query('select public.billing_grant($1,$2,$3,$4,null)', [d.users.alice, 'personal', expiry(), 'removed-product']), /invalid_subscription/);
  await assert.rejects(d.db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query('select public.billing_grant($1,$2,$3,$4,null)', [d.users.alice, 'group', expiry(), 'forged']);
  }), /permission denied/);
  const expires = expiry();
  const grant = () => d.db.query('select public.billing_grant($1,$2,$3,$4,null) id', [d.users.alice, 'group', expires, 'paid-channel']);
  assert.equal((await grant()).rows[0].id, (await grant()).rows[0].id);
  const map = await d.rpc('alice', 'create_map', { p_title: 'Paid channel' });
  await assert.rejects(d.rpc('alice', 'create_map', { p_title: 'Second channel' }), /group_subscription_required/);
  await d.rpc('bob', 'join_test_fixture', { p_map: map });
  await assert.rejects(d.rpc('bob', 'push_edges', { p_map: map, p_edges: [edge('Viewer write')] }));
  await d.rpc('alice', 'set_member_role', { p_map: map, p_user: d.users.bob, p_role: 'member' });
  assert.equal(await d.rpc('bob', 'push_edges', { p_map: map, p_edges: Array.from({ length: 25 }, (_, i) => edge('Member portal ' + i)) }), 25);
  await d.db.exec("update public.subscriptions set starts_at=now()-interval '2 days',expires_at=now()-interval '1 day' where payment_ref='paid-channel'");
  assert.equal((await d.rpc('bob', 'pull_map_snapshot', { p_map: map })).paused, true);
  await assert.rejects(d.rpc('bob', 'push_edges', { p_map: map, p_edges: [edge('Paused')] }), /group_subscription_expired/);
  await d.rpc('bob', 'account_policy');
  assert.equal(await d.rpc('bob', 'push_edges', { p_map: d.users.bob, p_edges: [edge('Still free')] }), 1);
  await d.db.query('select public.billing_grant($1,$2,$3,$4,$5)', [d.users.alice, 'group', expiry(), 'renewed-channel', map]);
  assert.equal((await d.rpc('bob', 'pull_map_snapshot', { p_map: map })).edges.length, 25);
  const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migration-16-group-only-subscriptions.sql'), 'utf8');
  await d.db.exec(sql);
  assert.equal((await d.rpc('alice', 'my_maps')).some(x => x.id === map), true);
  assert.equal((await d.rpc('bob', 'pull_map_snapshot', { p_map: map })).edges.length, 25);
  assert.equal((await d.rpc('alice', 'billing_status')).enabled, true);
});

test('anon and authenticated clients cannot bypass RPC checks by reading protected tables', async () => {
  for (const table of ['maps', 'edges', 'profiles', 'map_members', 'subscriptions', 'billing_configuration', 'map_layouts']) {
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(d.db.transaction(async tx => {
        await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [d.users.alice]);
        await tx.exec('set local role ' + role);
        await tx.query('select count(*) from public.' + table);
      }), /permission denied/, `${role} read ${table}`);
    }
  }
});
