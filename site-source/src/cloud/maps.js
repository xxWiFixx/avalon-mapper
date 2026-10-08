export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
import '../../../app/ui/sync-wire.js';
const syncWire=globalThis.AvalonSyncWire;
const ROLES = new Set(['viewer', 'member', 'verified', 'moderator', 'admin']);
const zoneName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\x00-\x1f]/.test(value);
export const portalKey = (a, b) => [a, b].sort().join('\0');

export function mapList(accountId, policy, groups) {
  if (!UUID.test(accountId) || policy?.personalMap !== accountId || !Array.isArray(groups)) throw new Error('invalid_maps');
  const maps = [{ id: accountId, kind: 'personal', title: null, role: 'admin', isOwner: true, confirmRequired: 0 }];
  for (const group of groups) {
    if (group.kind !== 'group' || !UUID.test(group.id || '') || group.id === accountId || !ROLES.has(group.role)) continue;
    if (maps.some(map => map.id === group.id)) continue;
    maps.push({ id: group.id, kind: 'group', title: String(group.title || '').slice(0, 80), role: group.role, isOwner: group.is_owner === true,
      confirmRequired: Number(group.confirm_required) || 0 });
  }
  return maps;
}

export function readSnapshot(snapshot, previous, now = Date.now()) {
  if (snapshot?.denied) return { status: 'denied', version: null, edges: [] };
  if (snapshot?.paused) return { status: 'paused', version: null, edges: [] };
  if (!snapshot || !ROLES.has(snapshot.role) || typeof snapshot.version !== 'string'
      || typeof snapshot.unchanged !== 'boolean') throw new Error('invalid_snapshot');
  if (snapshot.unchanged) {
    if (!previous || previous.status !== 'ready' || previous.version !== snapshot.version) throw new Error('invalid_snapshot');
    return { ...previous, role: snapshot.role, edges: previous.edges.filter(edge => edge.expiresAt > now) };
  }
  if (!Array.isArray(snapshot.edges)) throw new Error('invalid_snapshot');
  const edges = new Map();
  for (const edge of snapshot.edges) {
    if (!zoneName(edge.a) || !zoneName(edge.b) || edge.a === edge.b) continue;
    const updatedAt = Date.parse(edge.updated_at);
    const firstSeenAt = Date.parse(edge.first_seen_at || edge.updated_at);
    const expiresAt = edge.expires_at == null ? updatedAt + 6 * 3600000 : Date.parse(edge.expires_at);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(firstSeenAt) || !Number.isFinite(expiresAt) || expiresAt <= now) continue;
    const [a, b] = [edge.a, edge.b].sort();
    const key = portalKey(a, b);
    const record = { a, b, expiresAt, updatedAt, firstSeenAt,
      capMax: edge.cap_max_known !== false && [7, 20].includes(edge.cap_max) ? edge.cap_max : null,
      source: edge.source === 'manual' ? 'manual' : 'ocr',
      by: typeof edge.by_nick === 'string' ? edge.by_nick.slice(0, 80) : null,
      confirmations: Math.max(0, Number(edge.confirms) || 0), needed: Math.max(0, Number(edge.needed) || 0),
      reporters: Array.isArray(edge.reporters) ? edge.reporters.filter(name => typeof name === 'string').map(name => name.slice(0, 80)) : [],
    };
    if (!edges.has(key) || edges.get(key).updatedAt < updatedAt) edges.set(key, record);
  }
  return { status: 'ready', version: snapshot.version, role: snapshot.role, edges: [...edges.values()] };
}

export function visiblePortals(maps, snapshots, selection, now = Date.now()) {
  const merged = new Map();
  for (const map of maps) {
    if (selection !== 'all' && selection !== map.id) continue;
    const snapshot = snapshots[map.id];
    if (snapshot?.status !== 'ready') continue;
    for (const edge of snapshot.edges) {
      if (edge.expiresAt <= now) continue;
      const key = portalKey(edge.a, edge.b);
      const old = merged.get(key);
      const records = [...(old?.records || []), { ...edge, map }];
      // Different rooms can hold different observations: show the most recent,
      // while retaining each room's actual expiry and capacity in the detail view.
      const chosen = !old || old.updatedAt < edge.updatedAt ? edge : old;
      merged.set(key, { ...chosen, key, records });
    }
  }
  return [...merged.values()].sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
}

export function createMapReader({ rpc, onChange = () => {}, onUnauthorized = () => {}, now = Date.now, selectionStorage = null, compactReads=false }) {
  let revision = 0, flight = null;
  let compactSupported = null;
  let state = { accountId: null, maps: [], snapshots: {}, selection: null, loading: false, error: null, updatedAt: null };
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const storageKey = accountId => `avalon-map-selection:${accountId}`;
  const savedSelection = accountId => {
    if (!UUID.test(accountId || '')) return null;
    try { const value = selectionStorage?.getItem(storageKey(accountId)); return UUID.test(value || '') ? value : null; } catch { return null; }
  };
  const rememberSelection = (accountId, selection) => {
    if (!UUID.test(accountId || '')) return;
    try { selectionStorage?.setItem(storageKey(accountId), selection); } catch { /* blocked storage */ }
  };
  function setAccount(accountId) {
    if (state.accountId === accountId) return;
    ++revision; flight = null;
    emit({ accountId, maps: [], snapshots: {}, selection: savedSelection(accountId), loading: !!accountId, error: null, updatedAt: null });
  }
  function select(selection) {
    if (state.maps.some(map => map.id === selection)) {
      emit({ selection }); rememberSelection(state.accountId, selection);
    }
  }
  async function refresh() {
    if (!state.accountId) return;
    if (flight) return flight;
    const started = revision, accountId = state.accountId;
    const current = () => started === revision && state.accountId === accountId;
    emit({ loading: true });
    const task = (async () => {
      try {
        let compact=null;
        if(compactReads&&compactSupported!==false&&state.maps.length<=128){
          const versions=Object.fromEntries(state.maps.map(map=>[map.id,state.snapshots[map.id]?.version||null]));
          try{compact=syncWire.batch(await rpc('pull_maps_compact',{p_versions:versions,p_context:true}));compactSupported=true;}
          catch(error){if((error.status===404&&['PGRST202','42883'].includes(error.code))||(error.code==='22023'&&error.message.includes('invalid_batch')))compactSupported=false;else throw error;}
        }
        if(!current())return;
        const policy = compact ? compact.policy : await rpc('account_policy', {});
        if (!current()) return;
        const groups = compact ? compact.groups : await rpc('my_maps', {});
        if (!current()) return;
        const maps = mapList(accountId, policy, groups);
        const selection = maps.some(map => map.id === state.selection) ? state.selection : accountId;
        rememberSelection(accountId, selection);
        const snapshots = Object.fromEntries(maps.filter(map => state.snapshots[map.id]).map(map => [map.id, state.snapshots[map.id]]));
        // Revoke removed membership before any further network requests.
        emit({ maps, snapshots, selection, error: null });
        let failures = 0;
        // Bound parallelism for accounts with many rooms.
        for (let offset = 0; offset < maps.length && current(); offset += 4) {
          const batch = maps.slice(offset, offset + 4);
          const results = await Promise.allSettled(batch.map(async map => {
            const previous = snapshots[map.id];
            const result = compact ? syncWire.unwrap(compact.snapshots[map.id]) : await rpc('pull_map_snapshot', { p_map: map.id, p_version: previous?.version || null });
            return readSnapshot(result, previous, now());
          }));
          if (!current()) return;
          for (let index = 0; index < results.length; index++) {
            const result = results[index], map = batch[index];
            if (result.status === 'fulfilled') snapshots[map.id] = result.value;
            else if (result.reason?.status === 401 || result.reason?.code === '28000') {
              setAccount(null); onUnauthorized(); return;
            } else if (result.reason?.status === 403 || result.reason?.code === '42501') {
              snapshots[map.id] = { status: 'denied', version: null, edges: [] };
            } else { failures++; }
          }
          emit({ snapshots: { ...snapshots } });
        }
        if (current()) emit({ loading: false, updatedAt: now(), error: failures ? 'partial_sync' : null });
      } catch (error) {
        if (!current()) return;
        if (error.status === 401 || error.code === '28000') { setAccount(null); onUnauthorized(); }
        else if (error.status === 403 || error.code === '42501') emit({ maps: [], snapshots: {}, selection: null, loading: false, error: 'access_denied' });
        else emit({ loading: false, error: error.message === 'invalid_maps' ? 'invalid_maps' : 'sync_failed' });
      }
    })();
    flight = task;
    try { await task; } finally { if (flight === task) flight = null; }
  }
  return { setAccount, select, refresh, getState: () => state };
}
