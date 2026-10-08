'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDatabase } = require('./helpers/shared-database');
const { createSync } = require('../lib/sync');
let d;
// Historical migration-14/15 contract. Current group-only behavior is tested separately.
before(async () => { d = await createDatabase({ through: 15 }); });
after(async () => { await d?.close(); });
beforeEach(async () => {
  await d.db.exec('delete from public.edge_reports; delete from public.edges; delete from public.capture_receipts; delete from public.capture_usage; delete from public.subscriptions; update public.billing_configuration set enabled = true');
});
const expiry = () => new Date(Date.now() + 3600000).toISOString();
const capture = (name, id = randomUUID(), user = 'alice') => d.rpc(user, 'authorize_capture',
  { p_id: id, p_a: 'Origin', p_b: name, p_expires: expiry() });
const grant = (user, product, payment, map = null) => d.db.transaction(async tx => {
  await tx.exec('set local role service_role');
  return (await tx.query('select public.billing_grant($1,$2,$3,$4,$5) as id',
    [d.users[user], product, expiry(), payment, map])).rows[0].id;
});

test('exactly ten new recordings; one account on two PCs shares the counter', async () => {
  const results = await Promise.all(Array.from({ length: 11 }, (_, i) => capture('Destination ' + i)));
  assert.equal(results.filter(x => x.ok).length, 10);
  assert.equal(results.filter(x => x.code === 'daily_limit').length, 1);
  assert.equal((await d.rpc('alice', 'billing_status')).quota.used, 10);
  assert.equal((await capture('Bob destination', randomUUID(), 'bob')).ok, true);
});

test('rechecks and request retries are free, including another map and after using all ten slots', async () => {
  const id = randomUUID(); const body = { p_id: id, p_a: 'Origin', p_b: 'Destination', p_expires: expiry() };
  await d.rpc('alice', 'authorize_capture', body);
  await d.rpc('alice', 'authorize_capture', body);
  await Promise.all(Array.from({ length: 9 }, (_, i) => capture('Destination ' + i)));
  assert.equal((await capture('Destination')).ok, true);
  assert.equal((await d.rpc('alice', 'billing_status')).quota.used, 10);
  const changed = await d.rpc('alice', 'authorize_capture', { ...body, p_b: 'Tampered' });
  assert.equal(changed.code, 'invalid_receipt');
  assert.equal((await d.rpc('bob', 'authorize_capture', body)).code, 'invalid_receipt');
});

test('failed recognition and closed portals do not spend allowance; UTC day buckets reset independently', async () => {
  for (const value of [null, new Date(Date.now() - 1000).toISOString()]) {
    assert.equal((await d.rpc('alice', 'authorize_capture', { p_id: randomUUID(), p_a: 'Origin', p_b: 'Destination', p_expires: value })).ok, false);
  }
  assert.equal((await d.rpc('alice', 'billing_status')).quota.used, 0);
  await d.db.query("insert into public.capture_usage(user_id,day,used) values($1, (now() at time zone 'UTC')::date-1,10)", [d.users.alice]);
  assert.equal((await capture('Destination')).ok, true);
  assert.equal((await d.rpc('alice', 'billing_status')).quota.used, 1);
});

test('legacy Pro is not a subscription; only the service role grants and revokes paid rights', async () => {
  await d.db.query("update public.profiles set plan='pro' where id=$1", [d.users.alice]);
  assert.equal((await d.rpc('alice', 'billing_status')).unlimited, false);
  await assert.rejects(d.db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query('select public.billing_grant($1,$2,$3,$4,null)', [d.users.alice, 'personal', expiry(), 'forged']);
  }), e => e.code === '42501');
  const id = await grant('alice', 'personal', 'paid-personal');
  assert.ok(id); assert.equal((await d.rpc('alice', 'billing_status')).unlimited, true);
  for (let i = 0; i < 12; i++) assert.equal((await capture('Paid destination ' + i)).ok, true);
  assert.equal((await d.rpc('alice', 'billing_status')).quota.used, 0);
  await d.db.transaction(async tx => { await tx.exec('set local role service_role'); await tx.query("select public.billing_revoke('paid-personal')"); });
  assert.equal((await d.rpc('alice', 'billing_status')).unlimited, false);
});

test('one paid license creates one server; members join for free and only the organizer gets the included seat', async () => {
  await assert.rejects(d.rpc('alice', 'create_map', { p_title: 'Paid group' }), /group_subscription_required/);
  await grant('alice', 'group', 'paid-group');
  const map = await d.rpc('alice', 'create_map', { p_title: 'Paid group' });
  await d.rpc('bob', 'join_test_fixture', { p_map: map });
  assert.equal((await d.rpc('alice', 'billing_status')).unlimited, true);
  assert.equal((await d.rpc('bob', 'billing_status')).unlimited, false);
  assert.equal((await d.rpc('alice', 'billing_status')).licenses[0].mapId, map);
  await assert.rejects(d.rpc('alice', 'create_map', { p_title: 'Second unpaid group' }), /group_subscription_required/);
  // Payment retries after the license has been bound return the same entitlement.
  const license = (await d.db.query("select * from public.subscriptions where payment_ref='paid-group'")).rows[0];
  assert.equal((await d.db.query('select public.billing_grant($1,$2,$3,$4,null) as id',
    [d.users.alice, 'group', license.expires_at, 'paid-group'])).rows[0].id, license.id);
});

test('expiry pauses group synchronization without deleting portals, membership or pending uploads; renewal resumes it', async () => {
  await grant('alice', 'group', 'group-expiry');
  const map = await d.rpc('alice', 'create_map', { p_title: 'Preserved map' });
  await d.rpc('alice', 'push_edges', { p_map: map, p_edges: [{ a: 'Origin', b: 'Manual', source: 'manual', expiresAt: expiry() }] });
  await d.db.exec("update public.subscriptions set starts_at=now()-interval '2 days',expires_at=now()-interval '1 day' where payment_ref='group-expiry'");
  assert.equal((await d.rpc('alice', 'billing_status')).unlimited, false);
  assert.equal((await d.rpc('alice', 'pull_map_snapshot', { p_map: map })).paused, true);
  await assert.rejects(d.rpc('bob', 'join_test_fixture', { p_map: map }), /group_subscription_expired/);
  const client = createSync({ getToken: async () => 'alice', fetch: d.fetch, onSnapshot: () => assert.fail('Expired subscription erased the cached map') });
  client.configure({ syncUrl: 'https://test.supabase.co', syncKey: 'test', syncAccountId: d.users.alice,
    accountPolicy: { personalMap: d.users.alice }, rooms: [{ id: map, role: 'admin', upload: true }] });
  client.push({ a: 'Origin', b: 'Queued', source: 'manual', expiresAt: Date.now() + 3600000 });
  await client.flush(); assert.equal(client.state.outbox.filter(x => x.target === map).length, 1);
  await d.rpc('alice', 'account_policy');
  await client.flush(); await client.flush();
  assert.equal(client.state.outbox.filter(x => x.target === map).length, 1);
  client.state.readTargets = [map];
  await client.pull();
  assert.equal((await d.db.query('select count(*)::int as n from public.edges where map_id=$1', [map])).rows[0].n, 1);
  assert.equal((await d.rpc('alice', 'my_maps')).some(x => x.id === map), true);
  await grant('alice', 'group', 'group-renewal', map);
  assert.equal((await d.rpc('alice', 'pull_map_snapshot', { p_map: map })).paused, undefined);
});

test('automatic cloud writes need an account-bound receipt; manual writes stay unlimited', async () => {
  const policy = await d.rpc('alice', 'account_policy');
  const edge = { a: 'Origin', b: 'Destination', source: 'ocr', expiresAt: expiry() };
  await assert.rejects(d.rpc('alice', 'push_edges', { p_map: policy.personalMap, p_edges: [edge] }), /capture_authorization_required/);
  const response = await d.rpc('alice', 'authorize_capture', { p_id: randomUUID(), p_a: edge.a, p_b: edge.b, p_expires: edge.expiresAt });
  assert.equal((await d.db.query('select count(*)::int as n from public.edges where map_id=$1', [d.users.alice])).rows[0].n, 1);
  // Quota acceptance itself saves the private portal, even if the desktop loses the response.
  assert.equal(await d.rpc('alice', 'push_edges', { p_map: policy.personalMap, p_edges: [{ ...edge, captureReceipt: response.receipt }] }), 1);
  assert.equal(await d.rpc('alice', 'push_edges', { p_map: policy.personalMap, p_edges: [{ ...edge, b: 'Manual destination', source: 'manual' }] }), 1);
});

test('staged rollout keeps existing groups working and migration can be reapplied safely', async () => {
  await d.db.exec('update public.billing_configuration set enabled=false');
  const map = await d.rpc('carol', 'create_map', { p_title: 'Existing behavior' });
  for (let i = 0; i < 11; i++) assert.equal((await capture('Trial destination ' + i)).ok, true);
  const sql = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../supabase/migration-14-subscriptions.sql'), 'utf8');
  await d.db.exec(sql);
  assert.equal((await d.rpc('carol', 'my_maps')).some(x => x.id === map), true);
});
