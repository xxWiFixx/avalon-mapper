'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSubscriptions } = require('../lib/subscriptions');
const { createSync } = require('../lib/sync');
const portalTime = require('../lib/portal-time');
const now = Date.now();

test('delayed group entitlements cannot leak across accounts; recording remains free', async () => {
  let user = 'alice', finish;
  const billing = createSubscriptions({ accountId: () => user, status: () => new Promise(resolve => { finish = resolve; }) });
  const pending = billing.refresh(); user = 'bob'; billing.reset();
  finish({ userId: 'alice', licenses: [{ id: 'private-license', active: true }] }); await pending;
  assert.equal(billing.snapshot().ready, false);
  assert.equal(billing.snapshot().licenses, undefined);
  assert.equal(billing.snapshot().recordingFree, true);
});

test('group licenses expire locally, while recording does not depend on a paid or trial date', async () => {
  let time = now;
  const billing = createSubscriptions({ accountId: () => 'alice', now: () => time,
    status: async () => ({ userId: 'alice', serverTime: new Date(now).toISOString(), enabled: true,
      unlimited: false, personalUntil: null, quota: { used: 10, limit: 10 }, trial: { eligible: true },
      licenses: [{ active: true, expiresAt: new Date(now + 500).toISOString() }] }) });
  await billing.refresh();
  assert.equal(billing.snapshot().licenses[0].active, true);
  time += 501;
  const status = billing.snapshot();
  assert.equal(status.licenses[0].active, false);
  assert.equal(status.unlimited, true);
  assert.equal(status.quota, undefined); assert.equal(status.trial, undefined);
});

test('automatic saves work offline without a billing RPC; preview-only still prevents writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('function savePortal('), end = /\r?\n\}\r?\n/.exec(source.slice(start));
  const writes = [];
  const ctx = vm.createContext({ portalTime, config: { autoRecordPortals: true, saveLocal: true },
    subscriptions: new Proxy({}, { get() { assert.fail('Recording must not contact billing'); } }),
    saveEdge: (from, tip, kind) => { writes.push({ from, tip, kind }); return tip; } });
  vm.runInContext(source.slice(start, start + end.index + end[0].length), ctx);
  const tip = { name: 'Destination', expiresAt: now + 3600000 };
  for (let i = 0; i < 25; i++) ctx.savePortal('Origin', tip, 'ocr', edge => assert.equal(edge.name, tip.name));
  assert.equal(writes.length, 25);
  ctx.config.autoRecordPortals = false;
  ctx.savePortal('Origin', tip, 'ocr', (edge, error, skipped) => assert.equal(skipped, true));
  assert.equal(writes.length, 25);
  ctx.savePortal('Origin', tip, 'manual', () => {});
  assert.equal(writes.length, 26);
});

test('only group checkout is available; fixed backend and safe HTTPS validation are retained', async () => {
  const calls = []; let result = { url: 'https://checkout.example.com/session' };
  const net = createSync({ getToken: async () => 'test-token', fetch: async (url, init) => {
    calls.push({ url, init }); return { ok: true, text: async () => JSON.stringify(result) };
  } });
  net.configure({ syncUrl: 'https://project.supabase.co', syncKey: 'public-key' });
  assert.equal(await net.checkout('group', 'USD'), result.url);
  assert.equal(calls[0].url, 'https://project.supabase.co/functions/v1/billing-checkout');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), { product: 'group', currency: 'USD', mapId: null });
  await assert.rejects(net.checkout('personal', 'USD'), /invalid_purchase/);
  assert.equal(calls.length, 1);
  for (const url of ['javascript:alert(1)', 'file:///C:/test', 'http://checkout.example.com', 'https://localhost/test', 'https://user:password@example.com']) {
    result = { url }; await assert.rejects(net.checkout('group', 'USD'));
  }
  await assert.rejects(net.checkout('group', '0.01'));
});
