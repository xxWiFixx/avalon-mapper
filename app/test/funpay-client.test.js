'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { generateCode } = require('../../tools/generate-funpay-codes.cjs');
const { createSync } = require('../lib/sync');
const { createSubscriptions } = require('../lib/subscriptions');
function handler({ state = { signedIn: true, guest: false, userId: 'alice' }, redeem = async () => ({ ok: false, code: 'invalid_code' }), refresh = async () => ({ userId: 'alice', ready: true }) } = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('billing-redeem-code'");
  const end = source.indexOf("ipcMain.handle('billing-purchase'", start);
  let callback, calls = 0;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, value) => { assert.equal(name, 'billing-redeem-code'); callback = value; } },
    auth: { status: () => state }, sync: { UUID_RE: require('../lib/sync').UUID_RE },
    net: { billingRedeemCode: (...args) => { calls++; return redeem(...args); }, tick: async () => {} },
    subscriptions: { refresh },
    console: { error: () => assert.fail('Code activation must never log errors or request bodies') }
  });
  return { call: (...args) => callback(null, ...args), state, calls: () => calls };
}

test('code IPC rejects malformed inputs and guest accounts without contacting billing', async () => {
  const h = handler();
  for (const value of [null, 12, {}, '', 'x'.repeat(129)]) assert.equal((await h.call(value)).code, 'invalid_code');
  assert.equal((await h.call(generateCode(), 'not-a-uuid')).code, 'invalid_code');
  assert.equal(h.calls(), 0);
  h.state.guest = true;
  assert.equal((await h.call(generateCode())).code, 'discord_required'); assert.equal(h.calls(), 0);
});

test('code IPC sanitizes upstream errors and ignores activation response after account changes', async () => {
  const secret = generateCode();
  const h = handler({ redeem: async () => { throw new Error('unexpected response body ' + secret); } });
  const failed = await h.call(secret);
  assert.equal(failed.code, 'code_activation_failed');
  assert.ok(!JSON.stringify(failed).includes(secret));
  let finish;
  const changed = handler({ redeem: () => new Promise(resolve => { finish = resolve; }) });
  const pending = changed.call(generateCode());
  changed.state.userId = 'bob';
  finish({ ok: true, licenseId: 'old-account', status: { userId: 'alice' } });
  const result = await pending;
  assert.equal(result.code, 'account_changed');
  assert.equal(result.licenseId, undefined);
});

test('code IPC rechecks account after asynchronous status refresh', async () => {
  let finishRefresh;
  const h = handler({ redeem: async () => ({ ok: true, licenseId: 'old-license' }),
    refresh: () => new Promise(resolve => { finishRefresh = resolve; }) });
  const pending = h.call(generateCode());
  await new Promise(resolve => setImmediate(resolve));
  h.state.userId = 'bob'; finishRefresh({ userId: 'bob', ready: true });
  assert.equal((await pending).code, 'account_changed');
});

test('sync sends codes to the fixed RPC and rejects malformed or stale requests', async () => {
  const calls = []; let resolveText;
  const net = createSync({ getToken: async () => 'test-token', fetch: async (url, options) => {
    calls.push({ url, options }); return { ok: true, text: () => new Promise(resolve => { resolveText = resolve; }) };
  } });
  const cfg = { syncUrl: 'https://example.supabase.co', syncKey: 'public', syncAccountId: 'alice' };
  net.configure(cfg);
  await assert.rejects(net.billingRedeemCode('bad'), /invalid_code/);
  assert.equal(calls.length, 0);
  const code = generateCode(), pending = net.billingRedeemCode(code);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/billing_redeem_code');
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_code: code, p_map: null });
  net.configure({ ...cfg, syncAccountId: 'bob' }); resolveText(JSON.stringify({ ok: true, licenseId: 'alice-only' }));
  await assert.rejects(pending, error => error.code === 'account_changed');
});

test('permanent group stays active while ordinary group countdown expires from server time', async () => {
  const now = Date.now(); let clock = now;
  const status = createSubscriptions({ accountId: () => 'alice', now: () => clock,
    status: async () => ({ userId: 'alice', serverTime: new Date(now).toISOString(), groups: [
      { mapId: 'permanent', active: true, permanent: true, expiresAt: null },
      { mapId: 'paid', active: true, permanent: false, expiresAt: new Date(now + 1000).toISOString() }
    ] }) });
  await status.refresh(); clock += 1001;
  assert.equal(status.snapshot().groups[0].active, true);
  assert.equal(status.snapshot().groups[1].active, false);
});
