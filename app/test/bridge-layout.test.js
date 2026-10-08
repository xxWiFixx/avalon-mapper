const {test}=require('node:test'),assert=require('node:assert/strict');
require('../ui/graph-layout');require('../ui/bridge-layout');require('../ui/stable-map-layout');
const B=globalThis.BRIDGE_LAYOUT,G=globalThis.GRAPH_LAYOUT;
const p={Aa:{x:1500,y:0},Ab:{x:1680,y:0},Ba:{x:0,y:0},Bb:{x:0,y:180},Bc:{x:0,y:360}};
const old=[['Aa','Ab'],['Ba','Bb'],['Bb','Bc']],next=[...old,['Aa','Ba']];
test('only the smaller component translates; its shape and all other positions remain unchanged',()=>{
 const moves=B.proposals(p,next,old);assert.equal(moves.length,1);const m=moves[0].positions;
 assert.deepEqual(Object.keys(m).sort(),['Aa','Ab']);assert.ok(Math.hypot(m.Aa.x,m.Aa.y)<=421);
 assert.ok(Math.abs(m.Ab.x-m.Aa.x-180)<.001);assert.ok(Math.abs(m.Ab.y-m.Aa.y)<.001);
 assert.deepEqual(B.proposals(p,next,next),[]);assert.deepEqual(B.proposals(p,next,null),[]);
 const large={...p,Ac:{x:1860,y:0}};assert.deepEqual(B.proposals(large,[...next,['Ab','Ac']],[...old,['Ab','Ac']]),[]);
 assert.deepEqual(B.proposals(p,[...next,['Ab','Bc']],old),[]); // cycle: no disconnected piece to move
});
test('bent links avoid every intervening node box without moving endpoints',()=>{
 const positions={Start:{x:0,y:0},End:{x:800,y:0},Block:{x:400,y:0},Upper:{x:400,y:-110}};
 const r=B.routeEdges(positions,[['Start','End']])[B.key(['Start','End'])];assert.ok(r.length>2);
 assert.deepEqual(r[0],positions.Start);assert.deepEqual(r.at(-1),positions.End);
 for(let i=1;i<r.length;i++)for(const n of ['Block','Upper'])assert.equal(G.hitsBox(r[i-1],r[i],G.nodeBox(positions[n])),false);
});
test('offline controller moves once, persists the result, and never moves the large component',async()=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
 storage.setItem('map-layout-v1:test',JSON.stringify(p));
 const c=globalThis.STABLE_MAP_LAYOUT.create({storage}),input={key:'test',nodeIds:Object.keys(p),edgePairs:old};
 await c.resolve(input);const moved=await c.resolve({...input,edgePairs:next});
 for(const id of ['Ba','Bb','Bc'])assert.deepEqual(moved[id],p[id]);assert.notDeepEqual(moved.Aa,p.Aa);
 const restarted=globalThis.STABLE_MAP_LAYOUT.create({storage});assert.deepEqual(await restarted.resolve({...input,edgePairs:next}),moved);
});
