// Shared by the desktop renderer and website. No DOM or Electron dependencies.
(function (root) {
  const REMOTE_CHECK_MS = 5000;
  function create({ storage, remote, mergeRemote, now = Date.now, graph = root.GRAPH_LAYOUT } = {}) {
    const states = new Map(), queues = new Map();
    function clean(value) {
      return Object.fromEntries(Object.entries(value || {}).filter(([id, p]) =>
        id.length <= 100 && graph.validPosition(p)).slice(-5000));
    }
    function stateFor(key) {
      if (!states.has(key)) {
        let positions = {};
        try { positions = clean(JSON.parse(storage?.getItem('map-layout-v1:' + key) || '{}')); } catch (_) { /* fresh cache */ }
        let edges=null;try { edges=JSON.parse(storage?.getItem('map-layout-edges:' + key)||'null'); }catch(_){}
        states.set(key, { positions, serverPositions: null, edges, serialized: JSON.stringify(positions), checked: -Infinity, retryAt: 0, revision: null, signature: '' });
      }
      return states.get(key);
    }
    function persist(key, state) {
      const serialized = JSON.stringify(state.positions);
      if (serialized === state.serialized) return;
      try { storage?.setItem('map-layout-v1:' + key, serialized); state.serialized = serialized; } catch (_) { /* quota/private mode */ }
    }
    async function resolve({ key, mapId = null, nodeIds, edgePairs, replacePositions = null }) {
      const previous = queues.get(key) || Promise.resolve();
      const job = previous.catch(() => {}).then(async () => {
        const state = stateFor(key);
        const signature = String(graph.seedFrom(nodeIds, edgePairs));
        const compute = () => graph.incremental(nodeIds, edgePairs, state.positions);
        let positions;
        // An explicit rearrangement is a user retry, even after a transient
        // background read failure put automatic checks on cooldown.
        const needsRemote = mapId && remote && (replacePositions || now() >= state.retryAt) &&
          (replacePositions || signature !== state.signature || now() - state.checked >= REMOTE_CHECK_MS);
        if (needsRemote) {
          try {
            let shared = await remote(mapId, null, state.revision, false, !!replacePositions);
            if (shared?.unchanged === true) {
              if (state.revision === null || !state.serverPositions || shared.revision !== state.revision) throw new Error('invalid_layout');
              shared = { revision: state.revision, positions: state.serverPositions };
            }
            if (!shared || !shared.positions || !Number.isSafeInteger(shared.revision)) throw new Error('invalid_layout');
            state.serverPositions = clean(shared.positions);
            for (let attempt = 0; attempt < 4; attempt++) {
              // Server coordinates are authoritative; unsynced local nodes remain usable offline.
              state.positions = { ...state.positions, ...clean(shared.positions) };
              state.revision = shared.revision;
              positions = replacePositions ? clean(replacePositions) : compute();
              const missing = Object.fromEntries(Object.entries(positions).filter(([id]) => !Object.hasOwn(shared.positions, id)));
              if (!replacePositions && !Object.keys(missing).length) break;
              const saved = await remote(mapId, replacePositions ? positions : missing, shared.revision, !!replacePositions, !!replacePositions);
              if (!saved || !saved.positions || !Number.isSafeInteger(saved.revision)) throw new Error('invalid_layout');
              shared = saved;
              state.serverPositions = clean(saved.positions);
              if (!saved.conflict) {
                state.positions = replacePositions ? clean(saved.positions) : { ...state.positions, ...clean(saved.positions) };
                state.revision = saved.revision;
                positions = compute();
                break;
              }
              // Discard ONLY rejected proposals before recalculating against the winner.
              for (const id of Object.keys(missing)) if (!Object.hasOwn(shared.positions, id)) delete state.positions[id];
            }
            if (replacePositions && shared.conflict) throw new Error('layout_conflict');
            state.positions = { ...state.positions, ...clean(shared.positions) };
            positions = compute();
            if(!replacePositions && mergeRemote && root.BRIDGE_LAYOUT){
              for(let attempt=0;attempt<4;attempt++){
                const proposal=root.BRIDGE_LAYOUT.proposals(positions,edgePairs,state.edges)[0];
                if(!proposal)break;
                const moved=await mergeRemote(mapId,proposal.bridge,proposal.positions,shared.revision);
                if(moved.retry)throw new Error('merge_pending');
                state.serverPositions=clean(moved.positions);
                state.positions={...state.positions,...clean(moved.positions)};
                positions=compute();shared=moved;
                if(moved.skipped)break;
              }
            }
            state.checked = now(); state.retryAt = 0; state.signature = signature;
          } catch (error) {
            if (!replacePositions) state.retryAt = now() + 30000;
            if (replacePositions) throw error; // Never pretend an owner reset was published.
          }
        } else if (replacePositions && mapId && remote) {
          throw new Error('layout_offline');
        }
        if (replacePositions && (!mapId || !remote)) state.positions = clean(replacePositions);
        positions = positions || compute();
        if(!mapId && !replacePositions && root.BRIDGE_LAYOUT){
          for(let i=0;i<4;i++){const proposal=root.BRIDGE_LAYOUT.proposals(positions,edgePairs,state.edges)[0];if(!proposal)break;Object.assign(positions,proposal.positions);}
        }
        if(!mapId || state.signature===signature || !state.edges){
          if(JSON.stringify(state.edges)!==JSON.stringify(edgePairs)){
            state.edges=edgePairs.map(p=>p.slice());
            try{storage?.setItem('map-layout-edges:'+key,JSON.stringify(state.edges));}catch(_){}
          }
        }
        const next = clean({ ...state.positions, ...positions });
        if (JSON.stringify(next) !== JSON.stringify(state.positions)) {
          state.positions = next; persist(key, state);
        } else persist(key, state);
        return positions;
      });
      queues.set(key, job);
      job.finally(() => { if (queues.get(key) === job) queues.delete(key); }).catch(() => {});
      return job;
    }
    // Manual dragging is local-only. Shared maps are locked in the renderer.
    function remember(key, positions) {
      const state = stateFor(key);
      state.positions = clean({ ...state.positions, ...positions }); persist(key, state);
    }
    return { resolve, remember };
  }
  root.STABLE_MAP_LAYOUT = { create };
})(typeof window !== 'undefined' ? window : globalThis);
