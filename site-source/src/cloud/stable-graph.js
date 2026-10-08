// Session-only placement memory. Cloud refreshes never move an existing zone.
// The shared controller supplies placement; full rearrangement is explicit.
const pair = (a, b) => JSON.stringify([a, b].sort());
export const graphEdgeId = (a, b) => 'portal:' + pair(a, b);
const copyPosition = position => ({ x: position.x, y: position.y });
const changedData = (element, data) => Object.entries(data).some(([key, value]) => element.data(key) !== value);

function freePosition(name, neighbors, positions) {
  const occupied = [...positions.values()];
  const anchors = neighbors.map(id => positions.get(id)).filter(Boolean);
  const center = anchors.length ? {
    x: anchors.reduce((sum, point) => sum + point.x, 0) / anchors.length,
    y: anchors.reduce((sum, point) => sum + point.y, 0) / anchors.length,
  } : { x: occupied.length ? Math.max(...occupied.map(point => point.x)) + 220 : 0, y: occupied.length ? occupied.reduce((sum, point) => sum + point.y, 0) / occupied.length : 0 };
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const phase = hash / 4294967296 * Math.PI * 2;
  const available = point => occupied.every(other => ((point.x - other.x) / 145) ** 2 + ((point.y - other.y) / 105) ** 2 >= 1);
  if (!anchors.length && available(center)) return center;
  for (let ring = 1; ring <= 24; ring++) {
    for (let angle = 0; angle < 16; angle++) {
      const theta = phase + angle * Math.PI / 8;
      const point = { x: center.x + Math.cos(theta) * ring * 165, y: center.y + Math.sin(theta) * ring * 165 };
      if (available(point)) return point;
    }
  }
  return { x: Math.max(0, ...occupied.map(point => point.x)) + 220, y: center.y };
}

export function createStableGraph() {
  const maps = new Map();
  let currentKey = null, current = null;
  function remember(cy) {
    if (!current) return;
    cy.nodes().forEach(node => current.positions.set(node.id(), copyPosition(node.position())));
    current.viewport = { zoom: cy.zoom(), pan: copyPosition(cy.pan()) };
    // Cap memory in a very long browser session; private names are never persisted.
    while (current.positions.size > 2000) current.positions.delete(current.positions.keys().next().value);
  }
  function sync(cy, { key, allowedKeys, nodes, edges, positions, initialLayout }) {
    const switching = currentKey !== key || !current;
    if (switching) {
      remember(cy);
      cy.elements().remove();
      currentKey = key;
      current = maps.get(key) || { positions: new Map(), initialized: false, viewport: null };
      maps.set(key, current);
    }
    for (const savedKey of maps.keys()) if (!allowedKeys.includes(savedKey)) maps.delete(savedKey);
    const nodeIds = new Set(nodes.map(node => node.id));
    const edgeIds = new Set(edges.map(edge => edge.id));
    const activePositions = new Map();
    cy.batch(() => {
      cy.edges().filter(edge => !edgeIds.has(edge.id())).remove();
      cy.nodes().filter(node => !nodeIds.has(node.id())).remove();
      const pending = new Map();
      for (const data of nodes) {
        const old = cy.$id(data.id), saved = positions?.[data.id] || current.positions.get(data.id);
        if (old.length) {
          if (changedData(old, data)) old.data(data);
          if (positions?.[data.id] && (Math.abs(old.position('x') - positions[data.id].x) >= .01
            || Math.abs(old.position('y') - positions[data.id].y) >= .01)) old.position(positions[data.id]);
          activePositions.set(data.id, copyPosition(old.position()));
        }
        else if (saved) { cy.add({ data, position: saved }); activePositions.set(data.id, saved); }
        else pending.set(data.id, data);
      }
      const neighbors = new Map(nodes.map(node => [node.id, []]));
      for (const edge of edges) { neighbors.get(edge.source)?.push(edge.target); neighbors.get(edge.target)?.push(edge.source); }
      while (pending.size) {
        const id = [...pending.keys()].find(name => neighbors.get(name).some(other => activePositions.has(other))) || pending.keys().next().value;
        const position = freePosition(id, neighbors.get(id), activePositions);
        cy.add({ data: pending.get(id), position });
        activePositions.set(id, position); pending.delete(id);
      }
      for (const data of edges) {
        const old = cy.$id(data.id);
        if (old.length) { if (changedData(old, data)) old.data(data); } else cy.add({ data });
      }
    });
    if (!current.initialized && nodes.length) {
      initialLayout(); current.initialized = true;
    } else if (switching && current.viewport) {
      cy.viewport(current.viewport);
    }
    remember(cy);
  }
  return { sync, remember, clear() { maps.clear(); currentKey = null; current = null; } };
}
