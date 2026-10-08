'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../ui/graph-layout');
require('../ui/branch-layout');
require('./helpers/layout-fixture');
const engine = globalThis.BRANCH_LAYOUT.create(require('cytoscape'));

// Independent audit of the straight lines actually passed to Cytoscape.
// Common endpoints are junctions, not crossings. No edges are omitted/hidden.
function audit(positions, edges) {
  const orient = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  let crossings=0,overlaps=0;
  for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++) {
    const [ai,bi]=edges[i],[ci,di]=edges[j];
    if(new Set([ai,bi,ci,di]).size!==4)continue;
    const [a,b,c,d]=[ai,bi,ci,di].map(id=>positions[id]);
    if(orient(a,b,c)*orient(a,b,d)<0 && orient(c,d,a)*orient(c,d,b)<0)crossings++;
  }
  const points=Object.values(positions);
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)
    if(Math.abs(points[i].x-points[j].x)<110 && Math.abs(points[i].y-points[j].y)<80)overlaps++;
  return {crossings,overlaps};
}
for(const seed of [29092026,42,73]) test('100 + 50 zones: crossing budget and fixed original nodes, seed '+seed, () => {
  const f=globalThis.LAYOUT_FIXTURE.make(seed), ids100=f.ids.slice(0,100);
  const edges100=f.edges.filter(pair=>pair.every(id=>ids100.includes(id)));
  if(seed===29092026) { assert.equal(edges100.length,109); assert.equal(f.edges.length,164); }
  const started=performance.now();
  const first=engine.place(ids100,edges100), before=structuredClone(first.positions);
  const secondStart=performance.now(), second=engine.place(f.ids,f.edges,first.positions);
  const a=audit(first.positions,edges100), b=audit(second.positions,f.edges);
  console.log(JSON.stringify({seed,first:a,second:b,initialMs:Math.round(secondStart-started),addMs:Math.round(performance.now()-secondStart)}));
  assert.equal(Object.keys(first.positions).length,100);
  assert.equal(Object.keys(second.positions).length,150);
  assert.deepEqual(first.positions,before,'saved input was not mutated');
  for(const id of ids100)assert.deepEqual(second.positions[id],first.positions[id],id+' moved');
  assert.deepEqual(first.stats,a);assert.deepEqual(second.stats,b);
  assert.ok(a.crossings<=15,'100 zones exceed crossing budget');
  assert.ok(b.crossings<=15,'150 zones exceed crossing budget');
  assert.equal(a.overlaps,0);assert.equal(b.overlaps,0);
  const repeated=engine.place(f.ids,f.edges,second.positions);
  assert.deepEqual(repeated.positions,second.positions,'ordinary refresh must not rearrange anything');
});
