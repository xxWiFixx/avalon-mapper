import '../../../app/ui/graph-layout.js';
import '../../../app/ui/bridge-layout.js';
import '../../../app/ui/stable-map-layout.js';

const prefix = 'avalon-web-map-layout:';
export function createWebMapLayout({ storage, rpc, accountId, isAllowed = () => true }) {
  let disposed = false;
  let sinceSupported = null;
  const allowedKey = key => !disposed && isAllowed(key.slice(key.lastIndexOf(':') + 1));
  const scopedStorage = {
    getItem: key => allowedKey(key) ? storage?.getItem(prefix + key) : null,
    setItem: (key, value) => { if (allowedKey(key)) storage?.setItem(prefix + key, value); },
  };
  const root = typeof window === 'undefined' ? globalThis : window;
  const controller = root.STABLE_MAP_LAYOUT.create({ storage: scopedStorage,
    mergeRemote:(mapId,bridge,positions,revision)=>{
      if(disposed||!isAllowed(mapId))throw new Error('layout_unavailable');
      return rpc('map_layout_merge',{p_map:mapId,p_bridge:bridge,p_positions:positions,p_revision:revision},{timeoutMs:5000});
    },remote: async (mapId, positions = null, revision = null, replace = false, manual = false) => {
    if (disposed || !isAllowed(mapId)) throw new Error('layout_unavailable');
    const timeoutMs = manual ? 8000 : 2500;
    if (positions === null && !replace && sinceSupported !== false) {
      try {
        const result = await rpc('map_layout_since', { p_map: mapId, p_revision: revision }, { timeoutMs });
        if (disposed || !isAllowed(mapId)) throw new Error('layout_unavailable');
        sinceSupported = true;
        return result;
      } catch (error) {
        if (!['PGRST202', '42883'].includes(error.code)) throw error;
        // Stay compatible with a database that has not received migration 20 yet.
        sinceSupported = false;
      }
    }
    return rpc('map_layout', { p_map: mapId, p_positions: positions, p_revision: revision, p_replace: replace }, { timeoutMs });
  } });
  const context = mapId => ({ key: accountId + ':' + (mapId || 'all'), mapId });
  return {
    resolve: (mapId, nodeIds, edgePairs, replacePositions = null) => controller.resolve({ ...context(mapId), nodeIds, edgePairs, replacePositions }),
    remember: (mapId, positions) => controller.remember(context(mapId).key, positions),
    dispose: () => { disposed = true; },
  };
}

export function clearAccountLayouts(storage, accountId, allowedMaps = []) {
  if (!storage || !accountId) return;
  const accountPrefix = prefix + 'map-layout-v1:' + accountId + ':';
  const edgePrefix = prefix + 'map-layout-edges:' + accountId + ':';
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) for(const scope of [accountPrefix,edgePrefix]) if (key?.startsWith(scope) && !allowedMaps.includes(key.slice(scope.length))) storage.removeItem(key);
  } catch { /* storage may be disabled */ }
}
