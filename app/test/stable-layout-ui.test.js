const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const cytoscape = require('cytoscape');
require('../ui/graph-layout');
require('../ui/bridge-layout');
require('../ui/stable-map-layout');
const source = fs.readFileSync(path.join(__dirname, '../ui/map.js'), 'utf8');
const block = source.slice(source.indexOf('// ---------- рендер ----------'), source.indexOf('// лёгкий тик:'));
function environment(remote = null) {
  const cy = cytoscape({ headless: true, styleEnabled: false });
  // Cytoscape rejects plain objects from another JS realm; cross the VM boundary
  // as Electron does, while keeping its real collection/position implementation.
  const add = cy.add.bind(cy);
  cy.add = elements => add(JSON.parse(JSON.stringify(elements)));
  const data = new Map();
  const ctx = vm.createContext({ cy, Set, Map, Object, Date, Promise, setInterval() {}, document: { hidden: false, getElementById: () => null },
    window: { STABLE_MAP_LAYOUT: globalThis.STABLE_MAP_LAYOUT, BRIDGE_LAYOUT:globalThis.BRIDGE_LAYOUT,
      localStorage: { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) } },
    ipc: remote && { mapLayout: remote }, cloudSignedIn: !!remote, layoutAccountId: remote ? 'alice' : null,
    chanView: 'local', cfg: { zoneWatch: false }, laidOut: false, viewChanged: false, pendingReveal: null,
    fitGraph() { cy.zoom(1); cy.pan({ x: 0, y: 0 }); },
    applyRouteHighlight() {}, ensureZoneInfo() {}, refreshSelectedEdge() {}, updateMapSearchResults() {},
    buildModel(snap) {
      const edges = new Map(snap.edges.map(([a, b]) => [[a, b].sort().join('|'), { id: [a, b].sort().join('|'), source: a, target: b }]));
      const nodes = new Map([...new Set(snap.edges.flat())].map(id => [id, { id, label: id }]));
      return { edges, nodes };
    },
  });
  vm.runInContext(block, ctx);
  return { cy, ctx, render: edges => { ctx.input = { edges }; return vm.runInContext('render(input)', ctx); },
    positions: () => Object.fromEntries(cy.nodes().map(n => [n.id(), { ...n.position() }])) };
}
test('production renderer preserves old nodes and camera for insertion, extra link, timer refresh and channel return', async () => {
  const e = environment();
  try {
    const base = [['Alpha', 'Beta'], ['Beta', 'Gamma']];
    await e.render(base);
    assert.equal(e.cy.nodes().length, 3);
    const before = e.positions();
    e.cy.zoom(1.3); e.cy.pan({ x: 71, y: 52 });
    const more = [...base, ['Beta', 'Delta']];
    await e.render(more);
    for (const id of Object.keys(before)) assert.deepEqual(e.positions()[id], before[id]);
    assert.equal(e.cy.zoom(), 1.3); assert.deepEqual(e.cy.pan(), { x: 71, y: 52 });
    const expanded = e.positions();
    await e.render([...more, ['Alpha', 'Gamma']]); await e.render(more);
    assert.deepEqual(e.positions(), expanded);
    e.ctx.chanView = 'group'; await e.render([['Alpha', 'Other']]);
    assert.equal(e.cy.nodes().every(n => !n.grabbable()), true);
    e.ctx.chanView = 'local'; await e.render(more);
    assert.deepEqual(e.positions(), expanded);
    assert.equal(e.cy.nodes().every(n => n.grabbable()), true);
  } finally { e.cy.destroy(); }
});
test('late layout response cannot overwrite a different channel', async () => {
  let release;
  const firstResponse = new Promise(resolve => { release = resolve; });
  const e = environment(async map => map === 'alice' ? firstResponse : { revision: 0, positions: { Other: { x: 200, y: 50 }, Zone: { x: 400, y: 50 } } });
  try {
    const pending = e.render([['Alpha', 'Beta']]);
    await Promise.resolve();
    e.ctx.chanView = 'room'; await e.render([['Other', 'Zone']]);
    release({ revision: 1, positions: { Alpha: { x: 0, y: 0 }, Beta: { x: 180, y: 0 } } });
    await pending;
    assert.deepEqual(e.cy.nodes().map(n => n.id()).sort(), ['Other', 'Zone']);
  } finally { e.cy.destroy(); }
});
test('idle remote layout checks leave Cytoscape untouched', async () => {
  const e = environment(async () => ({ revision: 1, positions: { Alpha: { x: 0, y: 0 }, Beta: { x: 180, y: 0 } } }));
  try {
    await e.render([['Alpha', 'Beta']]);
    let writes = 0;
    e.cy.on('data position', () => { writes++; });
    await vm.runInContext('checkRemoteLayout()', e.ctx);
    assert.equal(writes, 0, 'unchanged coordinates must not repaint the graph');
  } finally { e.cy.destroy(); }
});
