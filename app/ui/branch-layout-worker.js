importScripts('../node_modules/cytoscape/dist/cytoscape.min.js', 'graph-layout.js', 'branch-layout.js');
const engine = BRANCH_LAYOUT.create(cytoscape);
self.onmessage = event => {
  const { id, nodeIds, edgePairs, saved } = event.data;
  try {
    const started = performance.now();
    const result = engine.place(nodeIds, edgePairs, saved,
      progress => self.postMessage({ id, progress }));
    self.postMessage({ id, result, elapsedMs: performance.now() - started });
  } catch (error) { self.postMessage({ id, error: error.message }); }
};
