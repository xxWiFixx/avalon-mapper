// Candidate branch placement: optimize only unpublished nodes, then freeze them.
// Existing coordinates are inputs, never variables. The renderer stays responsive
// by running this module in branch-layout-worker.js.
(function(root) {
  const G = root.GRAPH_LAYOUT;
  function create(cyto) {
    function count(positions, edges) {
      const orientation = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
      let count = 0;
      for (let i=0;i<edges.length;i++) for(let j=i+1;j<edges.length;j++) {
        const [ai,bi]=edges[i], [ci,di]=edges[j];
        if(ai===ci || ai===di || bi===ci || bi===di) continue;
        const a=positions[ai], b=positions[bi], c=positions[ci], d=positions[di];
        // Do not hide near-tangent crossings with a score epsilon in the audit.
        if(orientation(a,b,c)*orientation(a,b,d)<0 && orientation(c,d,a)*orientation(c,d,b)<0) count++;
      }
      return count;
    }
function improve(p,edges,free,passes=10){
 const ids=Object.keys(p), adj=Object.fromEntries(ids.map(n=>[n,[]])); for(const[a,b]of edges){adj[a].push(b);adj[b].push(a);}
 for(let pass=0;pass<passes;pass++){
 let moved=0;
 for(const id of free){const others=ids.filter(n=>n!==id).map(n=>({id:n,point:p[n],box:G.nodeBox(p[n])})), segments=edges.filter(e=>!e.includes(id)), anchors=adj[id];
 function score(q){let cost=0;const box=G.nodeBox(q);
 for(const n of others){const v=n.point;if(G.overlap(box,n.box))cost+=1e8;
 const ds=(q.x-v.x)**2+(q.y-v.y)**2;if(ds<125**2)cost+=(125**2-ds)*100;
 for(const a of anchors){if(a!==n.id&&G.hitsBox(q,p[a],n.box))cost+=50000;}}
 for(const[a,b]of segments){if(G.hitsBox(p[a],p[b],box))cost+=50000;for(const c of anchors)if(c!==a&&c!==b&&G.crosses(q,p[c],p[a],p[b]))cost+=1e6;}
 for(const a of anchors){const d=Math.hypot(q.x-p[a].x,q.y-p[a].y);cost+=(d-190)**2*.05;}
 return cost;}
 let best=p[id], bestScore=score(best);const original=best;
 function tryPoint(q){const s=score(q);if(s<bestScore-.01){bestScore=s;best=q;}}
 const step=[240,120,60,30][pass%4];
 for(let k=0;k<16;k++){let a=k*Math.PI/8;tryPoint({x:original.x+Math.cos(a)*step,y:original.y+Math.sin(a)*step});}
 if(pass<4) for(const a of anchors)for(const radius of[180,270,400])for(let k=0;k<12;k++){let angle=k*Math.PI/6;tryPoint({x:p[a].x+Math.cos(angle)*radius,y:p[a].y+Math.sin(angle)*radius});}
 if(best!==original){p[id]=best;moved++;}
 }
 if(!moved)break;
 }
 return p;
}
function initial(ids,edges,salt=0){const cy=cyto({headless:true,elements:[...ids.map(id=>({data:{id}})),...edges.map(([source,target],i)=>({data:{id:'edge'+i,source,target}}))]});const opts=G.options(ids.length,180);G.resetPositions(cy,opts.boundingBox.w);G.runSeeded(cy.layout({...opts,eles:G.sortedEles(cy)}),(G.seedFrom(ids,edges)+salt*7919)>>>0);const p=Object.fromEntries(cy.nodes().map(n=>[n.id(),{...n.position()}]));cy.destroy();return p;}

    function measure(positions, edges) {
      const ids = Object.keys(positions);
      let overlaps = 0;
      for (let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++)
        if(G.overlap(G.nodeBox(positions[ids[i]]),G.nodeBox(positions[ids[j]]))) overlaps++;
      return { crossings: count(positions, edges), overlaps };
    }
    function place(nodeIds, edgePairs, saved = {}, progress = () => {}) {
      const ids = [...new Set(nodeIds)].map(String).sort(), allowed = new Set(ids);
      const edges = [...new Map(edgePairs.filter(([a,b])=>a!==b && allowed.has(a) && allowed.has(b))
        .map(pair=>{const p=pair.slice().sort(); return [JSON.stringify(p),p];})).values()]
        .sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:JSON.stringify(a)>JSON.stringify(b)?1:0);
      const fixed = Object.fromEntries(ids.filter(id=>Object.hasOwn(saved,id) && G.validPosition(saved[id])).map(id=>[id,{...saved[id]}]));
      const free = ids.filter(id=>!fixed[id]);
      if(!free.length) return {positions:fixed, stats:measure(fixed,edges)};
      let positions;
      if(!Object.keys(fixed).length && ids.length>2) {
        let best=Infinity;
        // Choose without knowledge of future zones. Same topology, same candidates.
        for(let candidate=0;candidate<3;candidate++) {
          const trial=improve(initial(ids,edges,candidate),edges,ids,8);
          const stats=measure(trial,edges), score=stats.overlaps*100000+stats.crossings;
          if(score<best){best=score;positions=trial;}
          progress({phase:'initial',candidate:candidate+1,crossings:stats.crossings});
        }
      } else {
        positions=improve(G.incremental(ids,edges,fixed),edges,free,8);
      }
      return {positions:{...positions},stats:measure(positions,edges)};
    }
    return {place,measure};
  }
  root.BRANCH_LAYOUT={create};
})(typeof window!=='undefined'?window:globalThis);
