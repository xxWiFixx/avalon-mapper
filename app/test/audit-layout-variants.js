'use strict';
// Independent audit of the exported coordinates, separate from optimizer scoring.
const fs=require('node:fs'),assert=require('node:assert/strict');
const [reportPath,sourcePath]=process.argv.slice(2);
const r=JSON.parse(fs.readFileSync(reportPath)),source=JSON.parse(fs.readFileSync(sourcePath));
assert.deepEqual(r.edges,source.snapshot.edges,'All original portals must remain');
assert.equal(r.edges.length,103);
const orient=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const strict=(a,b,c,d)=>orient(a,b,c)*orient(a,b,d)<0&&orient(c,d,a)*orient(c,d,b)<0;
function touching(a,b,c,d){
  const on=(p,q,v)=>Math.abs(orient(p,q,v))<1e-8&&v.x>=Math.min(p.x,q.x)&&v.x<=Math.max(p.x,q.x)&&v.y>=Math.min(p.y,q.y)&&v.y<=Math.max(p.y,q.y);
  return strict(a,b,c,d)||on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);
}
for(const v of r.variants) {
  const p=v.positions,ids=Object.keys(p);assert.deepEqual(ids.slice().sort(),Object.keys(source.snapshot.positions).sort());
  let crossings=0,overlaps=0,lineBoxes=0;
  for(const q of Object.values(p))assert.ok(Number.isFinite(q.x)&&Number.isFinite(q.y));
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){
    const a=p[ids[i]],b=p[ids[j]];if(Math.abs(a.x-b.x)<110&&Math.abs(a.y-b.y)<80)overlaps++;
  }
  for(let i=0;i<r.edges.length;i++) {
    const[a,b]=r.edges[i];
    for(let j=i+1;j<r.edges.length;j++) {
      const[c,d]=r.edges[j];if(new Set([a,b,c,d]).size===4&&strict(p[a],p[b],p[c],p[d]))crossings++;
    }
    for(const id of ids)if(id!==a&&id!==b) {
      const q=p[id],corners=[{x:q.x-55,y:q.y-23},{x:q.x+55,y:q.y-23},{x:q.x+55,y:q.y+57},{x:q.x-55,y:q.y+57}];
      const inside=v=>v.x>=q.x-55&&v.x<=q.x+55&&v.y>=q.y-23&&v.y<=q.y+57;
      if(inside(p[a])||inside(p[b])||corners.some((c,k)=>touching(p[a],p[b],c,corners[(k+1)%4])))lineBoxes++;
    }
  }
  assert.equal(crossings,0);assert.equal(overlaps,0);assert.equal(lineBoxes,0);
  assert.deepEqual({crossings,overlaps,lineBoxes},{crossings:v.stats.crossings,overlaps:v.stats.overlaps,lineBoxes:v.stats.lineBoxes});
  console.log(v.id+': 124 nodes / 103 edges; 0 crossings; 0 node/name box overlaps; 0 edges through unrelated boxes');
}
assert.equal(new Set(r.components.flatMap(c=>c.ids)).size,124);
assert.equal(r.components.reduce((s,c)=>s+c.ids.length,0),124);
assert.equal(r.components.reduce((s,c)=>s+c.edges.length,0),103);
console.log('All 24 components preserve every node and portal.');
