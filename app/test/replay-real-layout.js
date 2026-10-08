'use strict';
// Read-only historical audit. Output contains topology/positions, never account data.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
require('../ui/graph-layout');
require('../ui/branch-layout');
const engine = globalThis.BRANCH_LAYOUT.create(require('cytoscape'));
const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node test/replay-real-layout.js INPUT_MAP OUTPUT_REPORT');
const original = fs.readFileSync(input);
const data = JSON.parse(original);
const journal = data.journal.slice().sort((a,b) => a.t-b.t);
const snapshotTime = journal.at(-1).t;
const edgeKey = e => [e.a,e.b].sort().join('|');
function audit(p, edges) {
  const o=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  let crossings=0,overlaps=0;
  for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++) {
    const names=[...edges[i],...edges[j]];
    if(new Set(names).size<4)continue;
    const [a,b,c,d]=names.map(n=>p[n]);
    if(o(a,b,c)*o(a,b,d)<0&&o(c,d,a)*o(c,d,b)<0)crossings++;
  }
  const points=Object.values(p);
  for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)
    if(Math.abs(points[i].x-points[j].x)<110&&Math.abs(points[i].y-points[j].y)<80)overlaps++;
  return {crossings,overlaps};
}
function frame(edges, t, saved, event) {
  const pairs=edges.map(e=>[e.a,e.b]), ids=[...new Set(pairs.flat())];
  const start=performance.now(), result=engine.place(ids,pairs,saved);
  const elapsedMs=performance.now()-start;
  const shifted=ids.filter(id=>saved[id]&&(saved[id].x!==result.positions[id].x||saved[id].y!==result.positions[id].y)).length;
  assert.equal(shifted,0,'Existing coordinates moved');
  const stats=audit(result.positions,pairs);
  assert.deepEqual(stats,result.stats);
  return {t,event,edges:pairs,positions:result.positions,stats,shifted,elapsedMs};
}
const snapshotEdges=Object.values(data.edges).filter(e=>e.expiresAt>snapshotTime);
const snapshot=frame(snapshotEdges,snapshotTime,{},'Сохранённая карта');
console.log('Snapshot',JSON.stringify({zones:Object.keys(snapshot.positions).length,edges:snapshot.edges.length,...snapshot.stats,elapsedMs:snapshot.elapsedMs}));
const active=new Map(), saved={}, frames=[]; let skipped=0, expired=0;
for(const event of journal) {
  let changed=false;
  for(const [key,e] of active) if(e.expiresAt<=event.t) {active.delete(key);expired++;changed=true;}
  if(event.type==='edge') {
    if(Number.isFinite(event.closes)&&event.closes>0) {
      active.set(edgeKey(event),{a:event.a,b:event.b,expiresAt:event.t+event.closes*1000});changed=true;
    } else skipped++;
  }
  if(!changed)continue;
  const f=frame([...active.values()],event.t,saved,event.type==='edge'?event.a+' → '+event.b:'Истечение порталов');
  Object.assign(saved,f.positions); frames.push(f);
}
const maxCrossings=Math.max(...frames.map(f=>f.stats.crossings));
const peak=frames.reduce((best,f,i)=>Object.keys(f.positions).length>Object.keys(frames[best].positions).length?i:best,0);
const worst=frames.findIndex(f=>f.stats.crossings===maxCrossings);
const summary={snapshot:{zones:Object.keys(snapshot.positions).length,edges:snapshot.edges.length,...snapshot.stats},
  events:journal.filter(e=>e.type==='edge').length,skipped,expired,frames:frames.length,
  peakZones:Object.keys(frames[peak].positions).length,peakEdges:frames[peak].edges.length,peak,worst,
  maxCrossings,maxOverlaps:Math.max(...frames.map(f=>f.stats.overlaps)),shifted:0,
  maxStepMs:Math.max(...frames.map(f=>f.elapsedMs)),totalStepMs:frames.reduce((s,f)=>s+f.elapsedMs,0)};
assert.ok(fs.readFileSync(input).equals(original),'Input changed');
const root=path.resolve(__dirname,'../..');
const zones={};
for(const z of JSON.parse(fs.readFileSync(path.join(root,'zone-data.json')))) zones[z.name]={name:z.name,tier:z.tier,color:'avalon'};
for(const z of JSON.parse(fs.readFileSync(path.join(root,'royal-zones.json')))) zones[z.name]={name:z.name,tier:z.tier,color:z.color};
const used=new Set([snapshot,...frames].flatMap(f=>Object.keys(f.positions)));
const zoneInfo=Object.fromEntries([...used].filter(id=>zones[id]).map(id=>[id,zones[id]]));
fs.writeFileSync(output,JSON.stringify({source:'Historical local copy; partial journal only',start:journal[0].t,end:snapshotTime,summary,snapshot,frames,zoneInfo}));
console.log(JSON.stringify(summary,null,2));
