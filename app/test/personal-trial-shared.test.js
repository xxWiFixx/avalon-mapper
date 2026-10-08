'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDatabase } = require('./helpers/shared-database');
let d;
// Historical migration-15 contract, retained to verify upgrades from this schema.
before(async () => { d = await createDatabase({ through: 15 }); });
after(async () => { await d?.close(); });
beforeEach(async () => {
  await d.db.exec('delete from public.personal_trials; delete from public.edge_reports; delete from public.edges; delete from public.capture_receipts; delete from public.capture_usage; delete from public.subscriptions; update public.billing_configuration set enabled=true,trial_enabled=true,payment_ready=false');
});
const start = (user = 'alice') => d.rpc(user, 'billing_start_trial');
const record = name => d.rpc('alice', 'authorize_capture', { p_id: randomUUID(), p_a: 'Origin', p_b: name,
  p_expires: new Date(Date.now() + 3600000).toISOString() });

test('status never auto-starts the trial; activation grants exactly 120 server hours and no group server', async () => {
  const initial = await d.rpc('alice', 'billing_status');
  assert.equal(initial.trial.eligible, true);
  assert.equal(initial.unlimited, false);
  assert.equal(initial.trial.used, false);
  const result = await start();
  assert.equal(result.ok, true);
  assert.equal(result.status.unlimited, true);
  assert.equal(result.status.trial.active, true);
  assert.equal(Date.parse(result.status.trial.expiresAt) - Date.parse(result.status.trial.startsAt), 120 * 3600000);
  assert.equal(result.status.personalUntil, null);
  assert.deepEqual(result.status.licenses, []);
  await assert.rejects(d.rpc('alice', 'create_map', { p_title: 'Unpaid group' }), /group_subscription_required/);
  for (let i = 0; i < 12; i++) assert.equal((await record('Trial portal ' + i)).ok, true);
  assert.equal((await d.rpc('alice', 'billing_status')).quota.used, 0);
});

test('two computers, repeated requests and repeated migrations preserve the original trial end', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => start()));
  assert.ok(results.every(x => x.ok));
  assert.equal(new Set(results.map(x => x.status.trial.expiresAt)).size, 1);
  assert.equal((await d.db.query('select count(*)::int as n from public.personal_trials')).rows[0].n, 1);
  await d.db.exec(fs.readFileSync(path.resolve(__dirname, '../../supabase/migration-15-personal-trial.sql'), 'utf8'));
  assert.equal((await start()).status.trial.expiresAt, results[0].status.trial.expiresAt);
});

test('expiry restores ten recordings, preserves stored portals and never permits another trial', async () => {
  await start(); await record('Saved during trial');
  await d.db.exec("update public.personal_trials set starts_at=now()-interval '121 hours',expires_at=now()-interval '1 hour'");
  const expired = await d.rpc('alice', 'billing_status');
  assert.equal(expired.unlimited, false); assert.equal(expired.trial.active, false);
  assert.equal(expired.trial.eligible, false); assert.equal(expired.trial.used, true);
  assert.equal((await start()).code, 'trial_used');
  for (let i = 0; i < 10; i++) assert.equal((await record('Free portal ' + i)).ok, true);
  assert.equal((await record('Eleventh free portal')).code, 'daily_limit');
  assert.equal((await d.db.query('select count(*)::int as n from public.edges where map_id=$1', [d.users.alice])).rows[0].n, 11);
});

test('trial state follows the verified Discord identity rather than the Supabase UUID', async () => {
  const original = await start();
  // Simulate a recreated OAuth account by moving its provider identity to another UUID.
  await d.db.query("update auth.identities set provider_id=provider_id||'1' where user_id=$1", [d.users.bob]);
  await d.db.query("update auth.identities set user_id=$1 where user_id=$2 and provider='discord'", [d.users.bob, d.users.alice]);
  try {
    const recreated = await start('bob');
    assert.equal(recreated.ok, true);
    assert.equal(recreated.status.userId, d.users.bob);
    assert.equal(recreated.status.trial.expiresAt, original.status.trial.expiresAt);
    assert.equal(recreated.status.trial.eligible, false);
  } finally {
    await d.db.query("update auth.identities set user_id=$1 where provider='discord' and provider_id=$2", [d.users.alice, d.discordIds.alice]);
    await d.db.query("update auth.identities set provider_id=$1 where user_id=$2", [d.discordIds.bob, d.users.bob]);
  }
});

test('anonymous, guest and unverified identities cannot activate or forge a trial', async () => {
  await assert.rejects(start('nobody'), e => e.code === '42501');
  assert.equal((await start('guest')).code, 'discord_required');
  await d.db.query("update auth.identities set provider='email' where user_id=$1", [d.users.outsider]);
  try { assert.equal((await start('outsider')).code, 'discord_required'); }
  finally { await d.db.query("update auth.identities set provider='discord' where user_id=$1", [d.users.outsider]); }
  await assert.rejects(d.db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("insert into public.personal_trials(discord_id) values('123456789012345678')");
  }), e => e.code === '42501');
  await assert.rejects(d.db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query('select public.billing_status_paid()');
  }), e => e.code === '42501');
  assert.equal((await d.db.query('select count(*)::int as n from public.personal_trials')).rows[0].n, 0);
});

test('paid subscribers do not spend their trial; paid access survives trial expiry independently', async () => {
  const paidUntil = new Date(Date.now() + 10 * 86400000).toISOString();
  await d.db.query('select public.billing_grant($1,$2,$3,$4,null)', [d.users.alice, 'personal', paidUntil, 'trial-paid']);
  assert.equal((await start()).code, 'already_unlimited');
  assert.equal((await d.rpc('alice', 'billing_status')).trial.used, false);
  await d.db.query("select public.billing_revoke('trial-paid')");
  await start();
  await d.db.query('select public.billing_grant($1,$2,$3,$4,null)', [d.users.alice, 'personal', paidUntil, 'trial-paid-again']);
  await d.db.exec("update public.personal_trials set starts_at=now()-interval '121 hours',expires_at=now()-interval '1 hour'");
  const status = await d.rpc('alice', 'billing_status');
  assert.equal(status.unlimited, true); assert.equal(status.trial.active, false);
  assert.equal(Date.parse(status.unlimitedUntil), Date.parse(paidUntil));
});

test('turning off new trials preserves an existing trial and never enables payments or limits', async () => {
  await d.db.exec('update public.billing_configuration set enabled=false');
  const original = await start();
  await d.db.exec('update public.billing_configuration set trial_enabled=false');
  assert.equal((await start('bob')).code, 'trial_unavailable');
  assert.equal((await start()).status.trial.expiresAt, original.status.trial.expiresAt);
  const status = await d.rpc('alice', 'billing_status');
  assert.equal(status.unlimited, true); assert.equal(status.enabled, false); assert.equal(status.paymentReady, false);
});
