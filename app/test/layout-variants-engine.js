'use strict';
// Offline layout exploration. Does not read/write user maps or cloud coordinates.
require('../ui/graph-layout');
const G=globalThis.GRAPH_LAYOUT;
const clone=p=>Object.fromEntries(Object.entries(p).map(([id,q])=>[id,{...q}]));
const orient=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const cross=(a,b,c,d)=>orient(a,b,c)*orient(a,b,d)<0&&orient(c,d,a)*orient(c,d,b)<0;
function audit(p,edges) {
  let crossings=0,overlaps=0,lineBoxes=0,collinear=0,totalLength=0,maxLength=0;
  const ids=Object.keys(p);
  for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)
    if(G.overlap(G.nodeBox(p[ids[i]]),G.nodeBox(p[ids[j]])))overlaps++;
  for(let i=0;i<edges.length;i++) {
    const [a,b]=edges[i];const len=Math.hypot(p[a].x-p[b].x,p[a].y-p[b].y);
    totalLength+=len;maxLength=Math.max(maxLength,len);
    for(const id of ids)if(id!==a&&id!==b&&G.hitsBox(p[a],p[b],G.nodeBox(p[id])))lineBoxes++;
    for(let j=i+1;j<edges.length;j++) {
      const [c,d]=edges[j];if(new Set([a,b,c,d]).size!==4)continue;
      if(cross(p[a],p[b],p[c],p[d]))crossings++;
      if(Math.abs(orient(p[a],p[b],p[c]))<1e-6&&Math.abs(orient(p[a],p[b],p[d]))<1e-6) {
        const axis=Math.abs(p[a].x-p[b].x)>Math.abs(p[a].y-p[b].y)?'x':'y';
        if(Math.min(Math.max(p[a][axis],p[b][axis]),Math.max(p[c][axis],p[d][axis]))-
          Math.max(Math.min(p[a][axis],p[b][axis]),Math.min(p[c][axis],p[d][axis]))>1e-6)collinear++;
      }
    }
  }
  const bounds=box(p);
  return {crossings,overlaps,lineBoxes,collinear,totalLength,meanLength:totalLength/edges.length,maxLength,width:bounds.w,height:bounds.h,area:bounds.w*bounds.h};
}
function box(p) {
  const values=Object.values(p), xs=values.map(q=>q.x),ys=values.map(q=>q.y);
  const x=Math.min(...xs)-65,y=Math.min(...ys)-35;
  return {x,y,w:Math.max(...xs)+65-x,h:Math.max(...ys)+65-y};
}
function components(ids,edges) {
  const adj=Object.fromEntries(ids.map(id=>[id,[]]));for(const[a,b]of edges){adj[a].push(b);adj[b].push(a);}
  for(const list of Object.values(adj))list.sort();
  const seen=new Set(),result=[];
  for(const id of ids.slice().sort()) {
    if(seen.has(id))continue;const list=[id];seen.add(id);
    for(let i=0;i<list.length;i++)for(const n of adj[list[i]])if(!seen.has(n)){seen.add(n);list.push(n);}
    const set=new Set(list), links=edges.filter(([a,b])=>set.has(a)&&set.has(b));
    const root=list.slice().sort((a,b)=>adj[b].length-adj[a].length||a.localeCompare(b))[0];
    result.push({ids:list.sort(),edges:links,root});
  }
  return result.sort((a,b)=>b.ids.length-a.ids.length||a.root.localeCompare(b.root));
}
const score=s=>s.overlaps*1e12+s.collinear*1e11+s.crossings*1e9+s.lineBoxes*1e7+s.totalLength;
function relax(p,edges,passes=8) {
  const ids=Object.keys(p),adj=Object.fromEntries(ids.map(id=>[id,[]]));
  for(const[a,b]of edges){adj[a].push(b);adj[b].push(a);}
  for(let pass=0;pass<passes;pass++)for(const id of ids) {
    const old=p[id],others=ids.filter(n=>n!==id),segments=edges.filter(e=>!e.includes(id));
    const cost=q=>{
      let s=0;const bounds=G.nodeBox(q);
      for(const n of others) {
        if(G.overlap(bounds,G.nodeBox(p[n])))s+=1e10;
        for(const a of adj[id])if(a!==n&&G.hitsBox(q,p[a],G.nodeBox(p[n])))s+=1e7;
      }
      for(const[a,b]of segments) {
        if(G.hitsBox(p[a],p[b],bounds))s+=1e7;
        for(const n of adj[id])if(n!==a&&n!==b&&cross(q,p[n],p[a],p[b]))s+=1e9;
      }
      for(const a of adj[id])s+=(Math.hypot(q.x-p[a].x,q.y-p[a].y)-180)**2;
      return s;
    };
    let best=old,bestCost=cost(old);const step=[90,45,20,10][pass%4];
    for(let k=0;k<16;k++) {
      const a=k*Math.PI/8,q={x:old.x+Math.cos(a)*step,y:old.y+Math.sin(a)*step},s=cost(q);
      if(s<bestCost-.001){best=q;bestCost=s;}
    }
    p[id]=best;
  }
  return p;
}
function tree(c,seed) {
  const random=G.mulberry32(seed), adj=Object.fromEntries(c.ids.map(id=>[id,[]]));
  for(const[a,b]of c.edges){adj[a].push(b);adj[b].push(a);}
  for(const list of Object.values(adj))for(let i=list.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[list[i],list[j]]=[list[j],list[i]];}
  const root=seed%3?c.root:c.ids[seed%c.ids.length],seen=new Set([root]),children={},depth={[root]:0},queue=[root];
  for(let i=0;i<queue.length;i++) {
    const n=queue[i];children[n]=[];
    for(const v of adj[n])if(!seen.has(v)){seen.add(v);children[n].push(v);depth[v]=depth[n]+1;queue.push(v);}
  }
  const p={};let leaf=0;
  function walk(n) {
    children[n].forEach(walk);
    const ys=children[n].map(id=>p[id].y);
    p[n]={x:depth[n]*210,y:ys.length?(Math.min(...ys)+Math.max(...ys))/2:leaf++*125};
  }
  walk(root);return p;
}
function ring(c,seed) {
  const random=G.mulberry32(seed);let order=c.ids.slice();
  for(let i=order.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
  const radius=Math.max(110,155/(2*Math.sin(Math.PI/order.length)));
  const coordinates=order.map((_,i)=>({x:Math.cos(i*2*Math.PI/order.length)*radius,y:Math.sin(i*2*Math.PI/order.length)*radius}));
  const positions=()=>Object.fromEntries(order.map((id,i)=>[id,{...coordinates[i]}]));
  let best=score(audit(positions(),c.edges));
  for(let pass=0;pass<8;pass++) {
    let improved=false;
    for(let i=0;i<order.length;i++)for(let j=i+1;j<order.length;j++) {
      [order[i],order[j]]=[order[j],order[i]];
      const s=score(audit(positions(),c.edges));
      if(s<best-.001){best=s;improved=true;}else [order[i],order[j]]=[order[j],order[i]];
    }
    if(!improved)break;
  }
  return positions();
}
function rotate(p,angle) {
  const cs=Math.cos(angle),sn=Math.sin(angle);
  return Object.fromEntries(Object.entries(p).map(([id,q])=>[id,{x:q.x*cs-q.y*sn,y:q.x*sn+q.y*cs}]));
}
function pack(parts) {
  const items=parts.map(p=>({p,b:box(p)})).sort((a,b)=>b.b.h-a.b.h);
  const area=items.reduce((s,i)=>s+(i.b.w+110)*(i.b.h+110),0);
  let best=null;
  // Try shelf widths; choose an envelope suited to a desktop map, not a long strip.
  for(let factor=.65;factor<=2.1;factor+=.1) {
    const width=Math.max(...items.map(i=>i.b.w),Math.sqrt(area)*factor);
    const p={},placed=[];
    for(const item of items) {
      let choice=null;
      for(const x of [0,...placed.map(r=>r.x+r.w+110)]) {
        if(x+item.b.w>width)continue;
        let y=0;
        for(let iteration=0;iteration<=placed.length;iteration++) {
          const hits=placed.filter(r=>x<r.x+r.w+110&&x+item.b.w+110>r.x&&y<r.y+r.h+110&&y+item.b.h+110>r.y);
          if(!hits.length)break;
          y=Math.max(...hits.map(r=>r.y+r.h+110));
        }
        if(!choice||y<choice.y||y===choice.y&&x<choice.x)choice={x,y};
      }
      const {x,y}=choice;
      for(const[id,q]of Object.entries(item.p))p[id]={x:q.x-item.b.x+x,y:q.y-item.b.y+y};
      placed.push({x,y,w:item.b.w,h:item.b.h});
    }
    const b=box(p), value=Math.max(b.w/1.55,b.h);
    if(!best||value<best.value)best={p,value};
  }
  return best.p;
}
function buildVariants(snapshot) {
  const ids=Object.keys(snapshot.positions),cs=components(ids,snapshot.edges),variants=[];
  for(const mode of ['compact','branches','rings']) {
    let candidates=0;
    const parts=cs.map(c=>{
      let best=null;
      const consider=p=>{candidates++;const stats=audit(p,c.edges),s=score(stats);if(!best||s<best.score)best={p,score:s};};
      if(mode==='compact') {
        const original=Object.fromEntries(c.ids.map(id=>[id,{...snapshot.positions[id]}]));
        consider(original);
        for(let k=0;k<8;k++)consider(relax(rotate(original,k*Math.PI/4),c.edges,12));
      } else if(mode==='branches') {
        for(let k=1;k<=32;k++) {
          const p=tree(c,7919*k);
          // Keep horizontal levels; clear rare cycle/label collisions only if needed.
          const s=audit(p,c.edges);consider(p);
          if(s.crossings||s.overlaps||s.lineBoxes||s.collinear)consider(relax(clone(p),c.edges,6));
        }
      } else {
        for(let k=1;k<=16;k++) {
          const base=ring(c,k*7919);
          for(const scale of [1,1.25,1.5,2,3,4])for(let a=0;a<12;a++) {
            const p=rotate(base,a*Math.PI/12);
            for(const q of Object.values(p)){q.x*=scale;q.y*=scale;}
            consider(p);
          }
        }
      }
      if(mode==='compact') {
        // Equivalent quarter-turns preserve topology/length; prefer a landscape
        // envelope for focused viewing, but re-audit asymmetric name boxes.
        let envelope=Math.max(box(best.p).w/1.6,box(best.p).h);
        const original=best.p;
        const originalLength=audit(original,c.edges).totalLength;
        for(let quarter=1;quarter<4;quarter++) {
          const p=relax(rotate(original,quarter*Math.PI/2),c.edges,8),stats=audit(p,c.edges),s=score(stats),b=box(p);
          const size=Math.max(b.w/1.6,b.h);
          if(!stats.crossings&&!stats.overlaps&&!stats.lineBoxes&&!stats.collinear&&stats.totalLength<=originalLength*1.12&&size<envelope){best={p,score:s};envelope=size;}
        }
      }
      return best.p;
    });
    const positions=pack(parts);
    variants.push({id:mode,positions,stats:audit(positions,snapshot.edges),candidates});
  }
  return {variants,components:cs};
}
module.exports={audit,buildVariants,components};
