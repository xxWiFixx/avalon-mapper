// The original 100 -> 150 example, unchanged, shared by browser and Node tests.
(function(root) {
  function make(seed = 29092026) {
    const rnd = root.GRAPH_LAYOUT.mulberry32(seed);
    const ids = Array.from({length:150},(_,i)=>'Avalon-'+String(i+1).padStart(3,'0'));
    const edges=[], used=new Set(), tiers={};
    function add(a,b) { const key=[a,b].sort().join('|'); if(a===b||used.has(key))return; used.add(key);edges.push([a,b]); }
    for(let i=0;i<ids.length;i++) {
      tiers[ids[i]]=[4,6,8][Math.floor(rnd()*3)];
      if(!i)continue;
      const start=rnd()<.75?Math.max(0,i-9):0;
      add(ids[i],ids[start+Math.floor(rnd()*(i-start))]);
      if(i>5&&rnd()<.1)add(ids[i],ids[Math.floor(rnd()*i)]);
    }
    return {ids,edges,tiers};
  }
  root.LAYOUT_FIXTURE={make};
})(typeof window!=='undefined'?window:globalThis);
