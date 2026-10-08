import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import cytoscape from 'cytoscape';
import postcss from 'postcss';
import { syncAppInterface } from '../scripts/app-interface.js';
import { createStableGraph, graphEdgeId } from '../src/cloud/stable-graph.js';
import { createWebMapLayout, clearAccountLayouts } from '../src/cloud/map-layout.js';
import { contentAmount, contentMatches } from '../src/cloud/scout-content.js';

syncAppInterface();
const { createRouter } = await import('../src/cloud/generated/router.js');
const require = createRequire(import.meta.url), appRouter = require('../../app/lib/router.js');
const appContent = require('../../app/lib/content-search.js');
const read = name => JSON.parse(fs.readFileSync(new URL('../../app/data-static/' + name, import.meta.url), 'utf8'));
const zones = Object.fromEntries([...read('zone-data.json').map(zone => ({ ...zone, color: 'avalon' })), ...read('royal-zones.json')].map(zone => [zone.name, zone]));
const world = read('world-adjacency.json'), t = (text, values) => values ? text.replace(/\{(\d+)\}/g, (_, i) => values[i]) : text;

test('web route adapter gives the app routes, real walking steps and portal timer rejection', () => {
  const web = createRouter(zones, world, t), now = Date.parse('2026-09-29T12:00:00Z');
  const edge = (a, b, minutes) => ({ a, b, expiresAt: now + minutes * 60000, capMax: 7 });
  const snapshot = { edges: [edge('Qiient-Qi-Odesas', 'Coues-Exakrom', 60), edge('Coues-Exakrom', 'Brons Hill', 60)] };
  const opts = { now, zoneColor: name => zones[name]?.color || null, worldAdjacency: world, outlandsPortalCity: 'Martlock' };
  for (const [method, args] of [
    ['findRoute', ['Qiient-Qi-Odesas', 'Martlock']],
    ['findRouteFromSafeCity', ['Qiient-Qi-Odesas']],
    ['findNearestExit', ['Qiient-Qi-Odesas']],
    ['findRoute', ['Qiient-Qi-Odesas', 'Unknown destination']],
  ]) assert.deepEqual(web[method](snapshot, ...args, opts), appRouter[method](snapshot, ...args, opts));
  const walking = web.findRoute(snapshot, 'Qiient-Qi-Odesas', 'Martlock', opts);
  assert.equal(walking.found, true);
  assert.ok(walking.steps.some(step => step.source === 'adjacency' && step.kind === 'walk'));
  const expiring = { edges: [edge('Qiient-Qi-Odesas', 'Coues-Exakrom', 1), edge('Coues-Exakrom', 'Brons Hill', 60)] };
  const blocked = web.findRoute(expiring, 'Qiient-Qi-Odesas', 'Martlock', opts);
  assert.equal(blocked.found, false, 'a portal that closes before arrival plus safety margin must not be routed');
});

test('web route stops and content filters follow the app planner and catalog', () => {
  const web = createRouter(zones, world, t), now = Date.parse('2026-09-29T12:00:00Z');
  const edges = [
    { a: 'Qiient-Qi-Odesas', b: 'Coues-Exakrom', expiresAt: now + 60 * 60000, capMax: 7 },
    { a: 'Coues-Exakrom', b: 'Brons Hill', expiresAt: now + 60 * 60000, capMax: 7 },
  ];
  const opts = { now, zoneColor: name => zones[name]?.color || null, worldAdjacency: world };
  const plan = { to: 'Brons Hill', waypoints: ['Coues-Exakrom'] };
  assert.deepEqual(web.findPlan({ edges }, 'Qiient-Qi-Odesas', plan, opts), appRouter.findPlan({ edges }, 'Qiient-Qi-Odesas', plan, opts));
  const open = [...new Set(edges.flatMap(edge => [edge.a, edge.b]))];
  for (const goal of [{ type: 'ore', tier: 0 }, { type: 'blue', tier: 6 }, { type: 'any-chest', tier: 0 }]) {
    for (const name of open) assert.equal(contentAmount(zones[name], goal), appContent.amount(zones[name], goal));
    for (const mode of ['any', 'all']) {
      const expected = open.filter(name => mode === 'all' ? [goal, { type: 'any-resource', tier: 0 }].every(item => appContent.amount(zones[name], item) > 0) : [goal, { type: 'any-resource', tier: 0 }].some(item => appContent.amount(zones[name], item) > 0));
      assert.deepEqual(contentMatches(zones, open, [goal, { type: 'any-resource', tier: 0 }], mode), expected);
    }
  }
});

test('cloud additions, removals and route overlays preserve positions and camera without rerunning full layout', t => {
  const cy = cytoscape({ headless: true }), stable = createStableGraph(); t.after(() => cy.destroy());
  let layouts = 0;
  const initialLayout = () => { layouts++; cy.$id('A').position({ x: 100, y: 150 }); cy.$id('B').position({ x: 280, y: 150 }); };
  const sync = (names, pairs) => stable.sync(cy, { key: 'personal', allowedKeys: ['personal'], nodes: names.map(id => ({ id })), edges: pairs.map(([source, target]) => ({ id: graphEdgeId(source, target), source, target })), initialLayout });
  sync(['A', 'B'], [['A', 'B']]);
  cy.viewport({ zoom: 1.4, pan: { x: 34, y: 47 } }); cy.$id('B').position({ x: 390, y: 260 });
  const original = cy.nodes().map(node => [node.id(), { ...node.position() }]);
  let redraws = 0;
  cy.on('data position', () => { redraws++; });
  for (let tick = 0; tick < 10; tick++) sync(['A', 'B'], [['A', 'B']]);
  assert.equal(redraws, 0, 'unchanged timer ticks must not rewrite graph elements');
  sync(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']]);
  for (const [id, position] of original) assert.deepEqual(cy.$id(id).position(), position);
  assert.deepEqual(cy.pan(), { x: 34, y: 47 }); assert.equal(cy.zoom(), 1.4); assert.equal(layouts, 1);
  assert.notDeepEqual(cy.$id('C').position(), cy.$id('D').position());
  sync(['A', 'B'], [['A', 'B']]);
  assert.equal(cy.nodes().length, 2);
  for (const [id, position] of original) assert.deepEqual(cy.$id(id).position(), position);
  assert.equal(layouts, 1);
});

test('switching maps restores their placement and revoked-map memory is discarded', t => {
  const cy = cytoscape({ headless: true }), stable = createStableGraph(); t.after(() => cy.destroy());
  let layouts = 0;
  const sync = (key, allowedKeys) => stable.sync(cy, { key, allowedKeys, nodes: [{ id: 'A' }], edges: [], initialLayout: () => { layouts++; cy.$id('A').position({ x: 10 * layouts, y: 20 }); } });
  sync('own', ['own', 'group']); cy.$id('A').position({ x: 444, y: 555 });
  sync('group', ['own', 'group']); sync('own', ['own', 'group']);
  assert.deepEqual(cy.$id('A').position(), { x: 444, y: 555 }); assert.equal(layouts, 2);
  sync('own', ['own']); sync('group', ['own', 'group']);
  assert.equal(layouts, 3, 'a revoked map must not retain placement memory if later rejoined');
  stable.clear(); sync('own', ['own']); assert.equal(layouts, 4);
});

test('shared app CSS remains scoped to the web map, including theme overrides', () => {
  const css = postcss.parse(fs.readFileSync(new URL('../src/cloud/generated/app-interface.css', import.meta.url), 'utf8'));
  css.walkRules(rule => {
    if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) assert.ok(selector.startsWith('.mapper-web'), selector);
  });
  assert.ok(css.toString().includes('.mapper-web[data-theme="light"]'));
});

const memoryStorage = () => {
  const values = new Map();
  return { get length() { return values.size; }, key: index => [...values.keys()][index], getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
test('site uses the shared cloud coordinate contract and keeps local positions through a reload without the RPC', async () => {
  const storage = memoryStorage(), accountId = 'account', mapId = 'personal';
  const calls = [], stored = { revision: 4, positions: { A: { x: 40, y: 80 } } };
  const rpc = async (name, body, options) => {
    calls.push({ name, body, options });
    assert.ok(['map_layout', 'map_layout_since'].includes(name)); assert.equal(body.p_map, mapId); assert.equal(options.timeoutMs, 2500);
    if (name === 'map_layout_since') return body.p_revision === stored.revision
      ? { revision: stored.revision, unchanged: true } : structuredClone(stored);
    if (body.p_positions) { assert.equal(body.p_revision, stored.revision); Object.assign(stored.positions, body.p_positions); stored.revision++; }
    return structuredClone(stored);
  };
  const layout = createWebMapLayout({ storage, rpc, accountId });
  const first = await layout.resolve(mapId, ['A', 'B'], [['A', 'B']]);
  assert.deepEqual(first.A, { x: 40, y: 80 }); assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'map_layout_since'); assert.equal(calls[1].name, 'map_layout');
  const second = await layout.resolve(mapId, ['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  assert.deepEqual(second.A, first.A); assert.deepEqual(second.B, first.B);
  assert.equal(calls.at(-1).body.p_replace, false);
  const offline = createWebMapLayout({ storage, rpc: async () => { throw new Error('RPC missing'); }, accountId });
  const restored = await offline.resolve(mapId, ['A', 'B', 'C'], [['A', 'B'], ['B', 'C']]);
  assert.deepEqual({ ...restored }, { ...second });
  clearAccountLayouts(storage, accountId); assert.equal(storage.length, 0);
});

test('explicit web rearrangement allows a slower cloud response without slowing routine reads', async () => {
  const calls = [];
  const rpc = async (name, body, options) => {
    calls.push({ name, body, options });
    if (name === 'map_layout_since') return { revision: 1, positions: { Alpha: { x: 0, y: 0 } } };
    return { revision: 2, positions: body.p_positions };
  };
  const layout = createWebMapLayout({ storage: memoryStorage(), rpc, accountId: 'account' });
  const proposed = { Alpha: { x: 360, y: 220 } };
  assert.deepEqual({ ...await layout.resolve('group', ['Alpha'], [], proposed) }, proposed);
  assert.deepEqual(calls.map(call => call.options.timeoutMs), [8000, 8000]);
  assert.equal(calls.at(-1).body.p_replace, true);
});

test('viewer keeps locally calculated positions when layout writes are denied', async () => {
  const storage = memoryStorage(), calls = [];
  const rpc = async (name, body) => {
    calls.push({ name, body });
    if (name === 'map_layout_since') return { revision: 3, positions: { A: { x: 40, y: 80 } } };
    throw Object.assign(new Error('read only'), { status: 403 });
  };
  const layout = createWebMapLayout({ storage, rpc, accountId: 'account' });
  const positions = await layout.resolve('group', ['A', 'B'], [['A', 'B']]);
  assert.deepEqual(positions.A, { x: 40, y: 80 });
  assert.ok(Number.isFinite(positions.B.x) && Number.isFinite(positions.B.y));
  assert.equal(calls.filter(call => call.body.p_positions).length, 1);
  const again = await layout.resolve('group', ['A', 'B'], [['A', 'B']]);
  assert.deepEqual(again, positions);
  assert.equal(calls.length, 2, 'denied writes are not retried on every render');
});

test('site falls back once on an older database without probing on every map', async () => {
  const calls = [], storage = memoryStorage();
  const rpc = async (name, body) => {
    calls.push(name);
    if (name === 'map_layout_since') throw Object.assign(new Error('missing'), { code: 'PGRST202' });
    return { revision: 1, positions: { A: { x: 10, y: 20 } } };
  };
  const layout = createWebMapLayout({ storage, rpc, accountId: 'account' });
  await layout.resolve('group', ['A'], []);
  await layout.resolve('other-group', ['A'], []);
  assert.deepEqual(calls, ['map_layout_since', 'map_layout', 'map_layout']);
  layout.dispose();
});

test('a layout response finishing after logout or revoked access cannot repopulate private browser storage', async () => {
  const storage = memoryStorage(); let finish;
  const result = new Promise(resolve => { finish = resolve; });
  const layout = createWebMapLayout({ storage, accountId: 'account', rpc: async () => result });
  const pending = layout.resolve('group', ['A'], []);
  await Promise.resolve(); layout.dispose(); clearAccountLayouts(storage, 'account');
  finish({ revision: 1, positions: { A: { x: 100, y: 200 } } }); await pending;
  assert.equal(storage.length, 0);
  let allowed = true;
  const revoked = createWebMapLayout({ storage, accountId: 'account', isAllowed: () => allowed, rpc: async () => ({ revision: 1, positions: { A: { x: 100, y: 200 } } }) });
  allowed = false; await revoked.resolve('group', ['A'], []);
  assert.equal(storage.length, 0);
});
