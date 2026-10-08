'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSync } = require('../lib/sync');

const mapId = '11111111-2222-3333-4444-555555555555';
function makeSync(fetch) {
  const sync = createSync({ fetch, getToken: async () => 'test-token' });
  sync.configure({ syncUrl: 'https://example.supabase.co', syncKey: 'public-key', rooms: [] });
  return sync;
}
function reply(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

test('desktop reads only a revision on an unchanged map and uses the writer RPC for changes', async () => {
  const calls = [];
  let state = { revision: 2, positions: { Alpha: { x: 10, y: 20 } } };
  const sync = makeSync(async (url, init) => {
    const fn = String(url).split('/rpc/')[1], body = JSON.parse(init.body);
    calls.push({ fn, body });
    if (fn === 'map_layout_since') return reply(body.p_revision === state.revision
      ? { revision: state.revision, unchanged: true } : state);
    if (fn === 'map_layout') {
      state = { revision: state.revision + 1, positions: body.p_positions };
      return reply(state);
    }
    throw Error('unexpected RPC');
  });
  assert.deepEqual(await sync.mapLayout(mapId), state);
  assert.deepEqual(await sync.mapLayout(mapId, null, 2), { revision: 2, unchanged: true });
  assert.deepEqual((await sync.mapLayout(mapId, { Alpha: { x: 50, y: 60 } }, 2, true)).positions,
    { Alpha: { x: 50, y: 60 } });
  assert.deepEqual(calls.map(call => call.fn), ['map_layout_since', 'map_layout_since', 'map_layout']);
  assert.equal(calls[1].body.p_revision, 2);
});

test('desktop falls back to the old read RPC only when the new function is absent', async () => {
  const calls = [];
  const sync = makeSync(async (url) => {
    const fn = String(url).split('/rpc/')[1]; calls.push(fn);
    if (fn === 'map_layout_since') return reply({ code: 'PGRST202', message: 'not found' }, 404);
    return reply({ revision: 0, positions: {} });
  });
  assert.deepEqual(await sync.mapLayout(mapId), { revision: 0, positions: {} });
  assert.deepEqual(await sync.mapLayout(mapId, null, 0), { revision: 0, positions: {} });
  assert.deepEqual(calls, ['map_layout_since', 'map_layout', 'map_layout']);
});
