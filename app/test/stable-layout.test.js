'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../ui/graph-layout');
require('../ui/stable-map-layout');
const G = globalThis.GRAPH_LAYOUT;
const makeStorage = () => {
  const data = new Map();
  return { writes: 0, getItem: key => data.get(key), setItem(key, value) { this.writes++; data.set(key, value); } };
};
test('new branches avoid crossings, node boxes and timer labels without moving old nodes', () => {
  const saved = { Hub: { x: 0, y: 0 }, North: { x: 0, y: -180 }, East: { x: 180, y: 0 }, South: { x: 0, y: 180 } };
  const pairs = [['Hub', 'North'], ['Hub', 'East'], ['Hub', 'South'], ['Hub', 'New branch']];
  const result = G.incremental([...Object.keys(saved), 'New branch'], pairs, saved);
  for (const [id, p] of Object.entries(saved)) {
    assert.deepEqual(result[id], p);
    assert.equal(G.overlap(G.nodeBox(p), G.nodeBox(result['New branch'])), false);
    if (id !== 'Hub') assert.equal(G.hitsBox(result.Hub, result['New branch'], G.nodeBox(p)), false);
  }
  for (const [a, b] of pairs.slice(0, 3)) {
    assert.equal(G.crosses(result.Hub, result['New branch'], result[a], result[b]), false);
    assert.equal(G.overlap(G.pillBox(result.Hub, result['New branch']), G.pillBox(result[a], result[b])), false);
  }
});
test('multiple anchors, reversed arrival order and extra edges keep existing positions exactly', () => {
  const ids = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
  const pairs = [['Alpha', 'Beta'], ['Beta', 'Gamma'], ['Gamma', 'Delta'], ['Delta', 'Epsilon'], ['Alpha', 'Epsilon']];
  const p = G.incremental(ids, pairs);
  assert.deepEqual(G.incremental(ids.slice().reverse(), pairs.slice().reverse().map(p => p.slice().reverse())), p);
  assert.deepEqual(G.incremental(ids, pairs.concat([['Beta', 'Epsilon']]), p), p);
});
test('restart, channel switch, expiry/reappearance, and timer refresh retain coordinates; no repeat layout', async () => {
  const storage = makeStorage(); let runs = 0;
  const graph = { ...G, incremental(...args) { if (args[0].some(id => !args[2][id])) runs++; return G.incremental(...args); } };
  const create = () => globalThis.STABLE_MAP_LAYOUT.create({ storage, graph });
  const input = { key: 'user:map', nodeIds: ['Alpha', 'Beta'], edgePairs: [['Alpha', 'Beta']] };
  const c = create(), first = await c.resolve(input);
  const writes = storage.writes;
  for (let i = 0; i < 10; i++) assert.deepEqual(await c.resolve(input), first);
  assert.equal(storage.writes, writes); assert.equal(runs, 1);
  await c.resolve({ key: 'user:other', nodeIds: ['Alpha', 'Other'], edgePairs: [['Alpha', 'Other']] });
  await c.resolve({ ...input, nodeIds: ['Alpha'], edgePairs: [] });
  assert.deepEqual(await create().resolve(input), first);
});
test('two clients share coordinates; conflict retry recomputes only unaccepted new nodes', async () => {
  let shared = { revision: 0, positions: {} }, conflict = true;
  const remote = async (_, positions, revision, replace) => {
    if (!positions) return structuredClone(shared);
    if (conflict) { conflict = false; shared = { revision: 1, positions: { Alpha: { x: 300, y: 400 } } }; }
    if (revision !== shared.revision) return { ...structuredClone(shared), conflict: true };
    shared = { revision: revision + 1, positions: replace ? positions : { ...positions, ...shared.positions } };
    return structuredClone(shared);
  };
  const input = { key: 'alice:map', mapId: 'map', nodeIds: ['Alpha', 'Beta'], edgePairs: [['Alpha', 'Beta']] };
  const a = globalThis.STABLE_MAP_LAYOUT.create({ storage: makeStorage(), remote });
  const b = globalThis.STABLE_MAP_LAYOUT.create({ storage: makeStorage(), remote });
  const first = await a.resolve(input), second = await b.resolve({ ...input, key: 'bob:map' });
  assert.deepEqual(first, second); assert.deepEqual(first.Alpha, { x: 300, y: 400 });
  assert.ok(Math.hypot(first.Beta.x - 300, first.Beta.y - 400) < 510);
});
test('a second client picks up a published layout within the five-second check window', async () => {
  let clock = 0, reads = 0;
  let shared = { revision: 1, positions: { Alpha: { x: 0, y: 0 }, Beta: { x: 180, y: 0 } } };
  const remote = async () => { reads++; return structuredClone(shared); };
  const client = globalThis.STABLE_MAP_LAYOUT.create({ storage: makeStorage(), remote, now: () => clock });
  const input = { key: 'bob:group', mapId: 'group', nodeIds: ['Alpha', 'Beta'], edgePairs: [['Alpha', 'Beta']] };
  assert.deepEqual(JSON.parse(JSON.stringify(await client.resolve(input))), shared.positions);
  shared = { revision: 2, positions: { Alpha: { x: 420, y: 70 }, Beta: { x: 600, y: 70 } } };
  clock = 4999;
  assert.deepEqual(JSON.parse(JSON.stringify(await client.resolve(input))), { Alpha: { x: 0, y: 0 }, Beta: { x: 180, y: 0 } });
  assert.equal(reads, 1);
  clock = 5000;
  assert.deepEqual(JSON.parse(JSON.stringify(await client.resolve(input))), shared.positions);
  assert.equal(reads, 2);
});
test('an unchanged revision transfers no positions and a later update still reaches the second client', async () => {
  let clock = 0;
  let shared = { revision: 1, positions: { Alpha: { x: 0, y: 0 }, Beta: { x: 180, y: 0 } } };
  const calls = [];
  const remote = async (_, positions, revision) => {
    calls.push({ positions, revision });
    if (revision === shared.revision) return { revision, unchanged: true };
    return structuredClone(shared);
  };
  const client = globalThis.STABLE_MAP_LAYOUT.create({ storage: makeStorage(), remote, now: () => clock });
  const input = { key: 'bob:group', mapId: 'group', nodeIds: ['Alpha', 'Beta'], edgePairs: [['Alpha', 'Beta']] };
  assert.deepEqual({ ...await client.resolve(input) }, shared.positions);
  clock = 5000;
  assert.deepEqual({ ...await client.resolve(input) }, shared.positions);
  assert.deepEqual(calls.map(c => c.revision), [null, 1]);
  shared = { revision: 2, positions: { Alpha: { x: 300, y: 20 }, Beta: { x: 480, y: 20 } } };
  clock = 10000;
  assert.deepEqual({ ...await client.resolve(input) }, shared.positions);
  assert.deepEqual(calls.map(c => c.revision), [null, 1, 1]);
});
test('an unchanged reply does not hide a local zone whose upload failed', async () => {
  let clock = 0, writes = 0;
  const shared = { revision: 1, positions: { Alpha: { x: 0, y: 0 } } };
  const remote = async (_, positions, revision) => {
    if (!positions) return revision === shared.revision
      ? { revision: shared.revision, unchanged: true } : structuredClone(shared);
    writes++;
    if (writes === 1) throw Error('temporary network failure');
    assert.equal(revision, shared.revision);
    Object.assign(shared.positions, positions); shared.revision++;
    return structuredClone(shared);
  };
  const client = globalThis.STABLE_MAP_LAYOUT.create({ storage: makeStorage(), remote, now: () => clock });
  const input = { key: 'alice:group', mapId: 'group', nodeIds: ['Alpha', 'Beta'], edgePairs: [['Alpha', 'Beta']] };
  const first = await client.resolve(input);
  assert.equal(writes, 1); assert.equal(shared.positions.Beta, undefined);
  clock = 30000;
  assert.deepEqual({ ...await client.resolve(input) }, { ...first });
  assert.equal(writes, 2);
  assert.deepEqual(shared.positions.Beta, first.Beta);
});
test('offline backoff preserves cached map; account/channel data remains isolated; failed reset is reported', async () => {
  const storage = makeStorage(); let calls = 0;
  const c = globalThis.STABLE_MAP_LAYOUT.create({ storage, remote: async () => { calls++; throw Error('offline'); } });
  const input = { key: 'alice:map', mapId: 'map', nodeIds: ['Alpha', 'Beta'], edgePairs: [['Alpha', 'Beta']] };
  const first = await c.resolve(input);
  for (let i = 0; i < 4; i++) assert.deepEqual(await c.resolve(input), first);
  assert.equal(calls, 1);
  await assert.rejects(c.resolve({ ...input, replacePositions: first }), /offline/);
  assert.equal(calls, 2, 'a manual reset bypasses the background cooldown');
  await c.resolve({ ...input, key: 'bob:map' }); assert.equal(calls, 3);
});

test('manual reset retries after an earlier manual failure and rejects repeated revision conflicts', async () => {
  const input = { key: 'alice:map', mapId: 'map', nodeIds: ['Alpha'], edgePairs: [],
    replacePositions: { Alpha: { x: 300, y: 200 } } };
  let reads = 0, writes = 0;
  const remote = async (_, positions, revision) => {
    if (!positions) {
      reads++;
      if (reads === 1) throw Error('temporary timeout');
      return { revision: 1, positions: { Alpha: { x: 0, y: 0 } } };
    }
    writes++;
    assert.equal(revision, 1);
    return { revision: 2, positions };
  };
  const client = globalThis.STABLE_MAP_LAYOUT.create({ storage: makeStorage(), remote });
  await assert.rejects(client.resolve(input), /temporary timeout/);
  assert.deepEqual({ ...await client.resolve(input) }, input.replacePositions);
  assert.equal(reads, 2); assert.equal(writes, 1);

  let conflicts = 0;
  const contended = globalThis.STABLE_MAP_LAYOUT.create({ storage: makeStorage(), remote: async (_, positions) => {
    if (!positions) return { revision: 0, positions: { Alpha: { x: 0, y: 0 } } };
    conflicts++;
    return { revision: conflicts, positions: { Alpha: { x: conflicts, y: 0 } }, conflict: true };
  } });
  await assert.rejects(contended.resolve(input), /layout_conflict/);
  assert.equal(conflicts, 4, 'an unpublished reset must never appear successful');
});
test('inserting one node on a 1000-node map has a bounded cost', () => {
  const saved = {}, pairs = [];
  for (let i = 0; i < 1000; i++) {
    saved['Zone ' + i] = { x: i % 40 * 180, y: Math.floor(i / 40) * 180 };
    if (i % 40) pairs.push(['Zone ' + (i - 1), 'Zone ' + i]);
  }
  const start = performance.now();
  const result = G.incremental([...Object.keys(saved), 'New zone'], [...pairs, ['Zone 520', 'New zone']], saved);
  const ms = performance.now() - start;
  console.log('1000-node insertion: ' + ms.toFixed(1) + ' ms');
  assert.ok(ms < 2000, 'insertion exceeded generous CI budget');
  for (const id of Object.keys(saved)) assert.deepEqual(result[id], saved[id]);
});
