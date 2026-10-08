// Shared desktop/web geometry. No viewport inputs, random numbers or account data.
(function(root){
  const G=root.GRAPH_LAYOUT;
  const key=pair=>JSON.stringify([...pair].sort());
  function component(start,edges){
    const found=new Set([start]),queue=[start],adj=new Map();
    for(const[a,b]of edges){if(!adj.has(a))adj.set(a,[]);if(!adj.has(b))adj.set(b,[]);adj.get(a).push(b);adj.get(b).push(a);}
    for(let i=0;i<queue.length;i++)for(const n of adj.get(queue[i])||[])if(!found.has(n)){found.add(n);queue.push(n);}
    return [...found].sort();
  }
  function proposals(positions,edges,previous){
    if(!previous)return [];
    const old=new Set(previous.map(key)),result=[];
    for(const pair of edges.filter(p=>!old.has(key(p))).sort((a,b)=>key(a).localeCompare(key(b)))){
      const rest=edges.filter(p=>key(p)!==key(pair));
      let small=component(pair[0],rest),large=component(pair[1],rest),anchor=pair[1],moving=pair[0];
      if(small.includes(pair[1]))continue; // A cycle, not a bridge between islands.
      if(small.length>large.length){[small,large]=[large,small];[anchor,moving]=[moving,anchor];}
      if(small.length>2||small.length>=large.length||small.some(n=>!positions[n])||!positions[anchor])continue;
      if(Math.hypot(positions[moving].x-positions[anchor].x,positions[moving].y-positions[anchor].y)<260)continue;
      const movingSet=new Set(small),fixed=Object.keys(positions).filter(n=>!movingSet.has(n));
      const affected=edges.filter(([a,b])=>movingSet.has(a)||movingSet.has(b)),stationary=edges.filter(([a,b])=>!movingSet.has(a)&&!movingSet.has(b));
      let best=null;
      for(const radius of [180,240,320,420])for(let i=0;i<48;i++){
        const angle=i*Math.PI/24,dx=positions[anchor].x+radius*Math.cos(angle)-positions[moving].x,dy=positions[anchor].y+radius*Math.sin(angle)-positions[moving].y;
        const patch=Object.fromEntries(small.map(n=>[n,{x:positions[n].x+dx,y:positions[n].y+dy}])),p={...positions,...patch};
        if(small.some(n=>!G.validPosition(p[n])||fixed.some(f=>G.overlap(G.nodeBox(p[n]),G.nodeBox(p[f])))))continue;
        let hits=0,crossings=0;
        for(const[a,b]of affected){if(!p[a]||!p[b])continue;for(const n of Object.keys(p))if(n!==a&&n!==b&&G.hitsBox(p[a],p[b],G.nodeBox(p[n])))hits++;
          for(const[c,d]of stationary)if(p[c]&&p[d]&&new Set([a,b,c,d]).size===4&&G.crosses(p[a],p[b],p[c],p[d]))crossings++;
        }
        for(const[a,b]of stationary)if(p[a]&&p[b])for(const n of small)if(G.hitsBox(p[a],p[b],G.nodeBox(p[n])))hits++;
        const score=hits*1e7+crossings*1e5+radius;
        if(!best||score<best.score)best={bridge:pair,positions:patch,score};
      }
      if(best&&best.score<1e7)result.push(best); // No line through a node/name box.
    }
    return result;
  }
  function path(a,b,obstacles){
    const clear=(p,q)=>!obstacles.some(r=>G.hitsBox(p,q,r));
    if(clear(a,b))return [a,b];
    // Bound the visibility graph on very large maps; every candidate segment is
    // still checked against ALL boxes. Outer corners provide an escape corridor.
    const near=obstacles.slice().sort((r,s)=>{
      const distance=r=>{const x=(r.l+r.r)/2,y=(r.t+r.b)/2;return Math.hypot(x-a.x,y-a.y)+Math.hypot(x-b.x,y-b.y);};return distance(r)-distance(s);
    }).slice(0,64);
    const outer={l:Math.min(a.x,b.x,...obstacles.map(r=>r.l))-50,r:Math.max(a.x,b.x,...obstacles.map(r=>r.r))+50,t:Math.min(a.y,b.y,...obstacles.map(r=>r.t))-50,b:Math.max(a.y,b.y,...obstacles.map(r=>r.b))+50};
    const points=[a,b,...[...near,outer].flatMap(r=>[{x:r.l-3,y:r.t-3},{x:r.r+3,y:r.t-3},{x:r.r+3,y:r.b+3},{x:r.l-3,y:r.b+3}])];
    const dist=new Float64Array(points.length).fill(Infinity),prev=new Int32Array(points.length).fill(-1),seen=new Uint8Array(points.length);dist[0]=0;
    for(let step=0;step<points.length;step++){
      let v=-1;for(let i=0;i<points.length;i++)if(!seen[i]&&(v<0||dist[i]<dist[v]))v=i;
      if(v<0||!Number.isFinite(dist[v]))break;
      if(v===1){const route=[];for(let n=1;n>=0;n=prev[n])route.push(points[n]);return route.reverse();}
      seen[v]=1;
      for(let n=0;n<points.length;n++)if(!seen[n]){const d=dist[v]+Math.hypot(points[v].x-points[n].x,points[v].y-points[n].y);if(d<dist[n]&&clear(points[v],points[n])){dist[n]=d;prev[n]=v;}}
    }
    return [a,b];
  }
  function routeEdges(positions,edges){
    const result={};
    for(const[a,b]of edges){if(!positions[a]||!positions[b])continue;
      const obstacles=Object.entries(positions).filter(([n])=>n!==a&&n!==b).map(([,p])=>{const r=G.nodeBox(p);return {l:r.l-8,r:r.r+8,t:r.t-8,b:r.b+8};});
      result[key([a,b])]=path(positions[a],positions[b],obstacles);
    }return result;
  }
  const cache=new WeakMap();
  function apply(cy){
    const nodes=cy.nodes().map(n=>[n.id(),{...n.position()}]),edges=cy.edges().map(e=>[e.source().id(),e.target().id()]);
    const signature=JSON.stringify([nodes,edges]);if(cache.get(cy)?.signature===signature)return;
    const routes=routeEdges(Object.fromEntries(nodes),edges);cache.set(cy,{signature});
    cy.batch(()=>cy.edges().forEach(e=>{
      const a=e.source().position(),b=e.target().position(),route=routes[key([e.source().id(),e.target().id()])];
      if(!route||route.length<3){e.removeStyle('curve-style segment-weights segment-distances edge-distances');return;}
      const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);if(!length)return;
      const bends=route.slice(1,-1);
      e.style({'curve-style':'segments','edge-distances':'node-position','segment-weights':bends.map(p=>((p.x-a.x)*dx+(p.y-a.y)*dy)/(length*length)),
        'segment-distances':bends.map(p=>((p.y-a.y)*dx-(p.x-a.x)*dy)/length)});
    }));
  }
  root.BRIDGE_LAYOUT={key,component,proposals,path,routeEdges,apply};
})(typeof window==='undefined'?globalThis:window);
