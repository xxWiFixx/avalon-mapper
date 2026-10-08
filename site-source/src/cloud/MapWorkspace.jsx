import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowClockwise, BookOpen, CaretRight, Check, ClockCounterClockwise, ListBullets, MapTrifold, MagnifyingGlass, Plus, User, Users, X, Path } from '@phosphor-icons/react';
import { useLanguage } from '../localization.jsx';
import { getRuntime, LoginPanel, SignOutButton, useAuth } from './AuthProvider.jsx';
import { siteHref } from './config.js';
import { createMapReader, UUID, visiblePortals } from './maps.js';
import PortalGraph, { timeLeft } from './PortalGraph.jsx';
import MapShell from './MapShell.jsx';
import RoutePanel from './RoutePanel.jsx';
import ScoutPanel, { firstGoal } from './ScoutPanel.jsx';
import ServerAccessDialog from './ServerAccessDialog.jsx';
import SubscriptionDialog from './SubscriptionDialog.jsx';
import { contentMatches } from './scout-content.js';
import { createRouter } from './generated/router.js';
import { createZoneActivities } from './generated/activities.js';
import { clearAccountLayouts } from './map-layout.js';
import '../../../app/ui/route-image.js';

const mapName = (map, t) => map?.kind === 'personal' ? t('Личная карта') : map?.title || t('Карта группы');
const authRPC = async (name, body, options) => (await getRuntime()).rpc(name, body, options);
const colorNames = { avalon: 'Авалон', blue: 'Синяя', yellow: 'Жёлтая', red: 'Красная', black: 'Чёрная', city: 'Город', 'city-black': 'Город' };

function Fold({ title, children, open = true }) {
  const [expanded, setExpanded] = useState(open);
  return <><button className="fold-head" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span className="label">{title}</span><svg className="fold-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button><div className="fold-wrap"><div>{children}</div></div></>;
}
const routePositions = new Set(['bottom', 'left', 'right']);
function initialRoutePlacement() {
  try { const saved = localStorage.getItem('web-route-placement'); if (routePositions.has(saved)) return saved; } catch { /* private mode */ }
  return 'bottom';
}
function RoutePlacementButton({ position, active, onClick, t }) {
  return <button type="button" aria-label={t(`Маршрут ${position === 'bottom' ? 'снизу' : position === 'left' ? 'слева' : 'справа'}`)} title={t(`Маршрут ${position === 'bottom' ? 'снизу' : position === 'left' ? 'слева' : 'справа'}`)} aria-pressed={active} onClick={onClick}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/>{position === 'bottom' ? <path d="M2 11h16"/> : <path d={position === 'left' ? 'M8 3v14' : 'M12 3v14'}/>}</svg>
  </button>;
}
function ZoneImage({ zone, t }) {
  const [status, setStatus] = useState('loading');
  return <div className={`card-map ${status === 'ready' ? 'ready' : ''}`}>
    {status === 'failed' ? <p className="map-missing">{t('Карта зоны недоступна')}</p> : <img src={siteHref(`assets/map/zones/${zone.image}`)} alt={t('Карта зоны {0}', [zone.name])} onLoad={() => setStatus('ready')} onError={() => setStatus('failed')}/>}
  </div>;
}

function AvalonDirectory({ zones, open, onClose, t }) {
  const dialog = useRef(null), [query, setQuery] = useState(''), [selected, setSelected] = useState('');
  const activities = useMemo(() => createZoneActivities(t), [t]);
  const avalons = useMemo(() => Object.values(zones).filter(zone => zone.color === 'avalon').sort((a, b) => a.name.localeCompare(b.name)), [zones]);
  const matches = useMemo(() => avalons.filter(zone => zone.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 100), [avalons, query]);
  const zone = zones[selected] || matches[0];
  useEffect(() => { if (!dialog.current) return; if (open && !dialog.current.open) dialog.current.showModal(); else if (!open && dialog.current.open) dialog.current.close(); }, [open]);
  useEffect(() => { if (open) { setQuery(''); setSelected(''); } }, [open]);
  return <dialog ref={dialog} className="map-settings-dialog map-directory-dialog" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="map-dialog-heading"><h2>{t('Справочник Авалонов')}</h2><button className="btn ghost square" onClick={onClose} aria-label={t('Закрыть')}><X/></button></div>
    <label className="label" htmlFor="avalon-directory-search">{t('Найти Авалон')}</label><input id="avalon-directory-search" type="search" value={query} onChange={event => { setQuery(event.target.value); setSelected(''); }} placeholder={t('Название Авалона')} autoComplete="off"/>
    <div className="map-directory-body"><div className="map-directory-results">{matches.map(item => <button type="button" className={zone?.name === item.name ? 'on' : ''} key={item.name} onClick={() => setSelected(item.name)}><span>{item.name}</span><small>{item.tier ? `T${item.tier}` : ''}</small></button>)}{!matches.length && <p className="small muted">{t('Авалон не найден')}</p>}</div>
      <div className="map-directory-detail">{zone ? <><h3>{zone.name}</h3><div className="card-tags">{zone.tier && <span className="chip chip-tier">T{zone.tier}</span>}{zone.type && <span className="chip chip-road">{zone.type}</span>}</div>{zone.image && <ZoneImage key={zone.name} zone={zone} t={t}/>}<div className="acts">{activities.listActivities(zone).map((item, index) => <span className={`act ${item.big ? 'big' : ''} ${item.sub ? 'pair' : ''}`} title={activities.actTitle(item, zone)} key={`${item.icon}-${index}`}><span className="ic"><img src={siteHref(`assets/map/icons/${item.icon}.webp`)} alt={item.ru}/>{item.sub && <span className="sub"><img src={siteHref(`assets/map/icons/${item.sub}.webp`)} alt=""/></span>}</span>{!item.res && item.count > 1 && <b>{item.count}</b>}</span>)}</div></> : <p className="small muted">{t('Выбери Авалон из списка')}</p>}</div></div>
  </dialog>;
}

function ChangeLogDialog({ open, onClose, map, entries, now, zones, t }) {
  const dialog = useRef(null);
  useEffect(() => { if (!dialog.current) return; if (open && !dialog.current.open) dialog.current.showModal(); else if (!open && dialog.current.open) dialog.current.close(); }, [open]);
  const locale = document.documentElement.lang === 'en' ? 'en-US' : 'ru-RU';
  const zoneName = name => <span className="changes-zone" data-color={zones[name]?.color || 'unknown'}>{name}</span>;
  return <dialog ref={dialog} className="map-settings-dialog map-changes-dialog" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <div className="map-dialog-heading"><h2>{t('Журнал изменений')}</h2><button className="btn ghost square" onClick={onClose} aria-label={t('Закрыть')}><X/></button></div>
    <p className="small muted">{mapName(map, t)} · {t('Активные порталы. Автор записи открывается через 15 минут.')}</p>
    <div className="map-changes-list">{entries.length ? entries.map(edge => <div className="map-changes-item" key={portalKeyForLog(edge)}><strong>{zoneName(edge.a)}{' ⇄ '}{zoneName(edge.b)}</strong><span>{t('Закроется: {0} · через {1}', [new Date(edge.expiresAt).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }), timeLeft(edge.expiresAt, now, t)])}</span><span>{now - edge.firstSeenAt < 15 * 60e3 ? t('Автор появится через {0}', [timeLeft(edge.firstSeenAt + 15 * 60e3, now, t)]) : t('Добавил: {0}', [edge.by || t('Неизвестно')])}</span></div>) : <p className="small muted">{t('В этой карте нет активных порталов.')}</p>}</div>
  </dialog>;
}
const portalKeyForLog = edge => `${edge.a}\0${edge.b}`;

export default function MapWorkspace({ rpc = authRPC }) {
  const auth = useAuth(), { t } = useLanguage();
  const [state, setState] = useState(null), [now, setNow] = useState(Date.now);
  const [zones, setZones] = useState({}), [world, setWorld] = useState(null), [zoneError, setZoneError] = useState(false), [worldError, setWorldError] = useState(false), [assetRetry, setAssetRetry] = useState(0);
  const [search, setSearch] = useState(''), [selectedZone, selectZone] = useState(null), [searchOpen, setSearchOpen] = useState(false);
  const [focusRequest, setFocusRequest] = useState(null);
  const [view, setView] = useState('map'), [joinOpen, setJoinOpen] = useState(false), [rightOpen, setRightOpen] = useState(true);
  const [routePlacement, setRoutePlacement] = useState(initialRoutePlacement), [routeExpanded, setRouteExpanded] = useState(true);
  const [invite, setInvite] = useState(''), [joinState, setJoinState] = useState(null);
  const [activationCode, setActivationCode] = useState(''), [creationError, setCreationError] = useState('');
  const creationFlight = useRef(false);
  const [mapDialogMode, setMapDialogMode] = useState('create'), [newTitle, setNewTitle] = useState(''), [createState, setCreateState] = useState(null), [createdCode, setCreatedCode] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [portalCity, setPortalCity] = useState(''), [request, setRequest] = useState(null);
  const [stops, setStops] = useState([]), [scoutGoals, setScoutGoals] = useState(() => [firstGoal()]), [scoutMatch, setScoutMatch] = useState('any'), [scoutEnabled, setScoutEnabled] = useState(false);
  const [channelMenu, setChannelMenu] = useState(false), [deleteArmed, setDeleteArmed] = useState(null), [deleteError, setDeleteError] = useState(null);
  const [leaveArmed, setLeaveArmed] = useState(false), [leaveError, setLeaveError] = useState('');
  const [rolesOpen, setRolesOpen] = useState(false), [rolesMapId, setRolesMapId] = useState(null);
  const [accessKind,setAccessKind]=useState('roles'),[menuAnchor,setMenuAnchor]=useState({x:60,y:150});
  const serverMenuRef=useRef(null);
  useEffect(()=>{if(!channelMenu||!serverMenuRef.current)return;const el=serverMenuRef.current;el.style.left=Math.max(8,Math.min(menuAnchor.x,window.innerWidth-el.offsetWidth-8))+'px';el.style.top=Math.max(8,Math.min(menuAnchor.y,window.innerHeight-el.offsetHeight-8))+'px';const hide=e=>{if(e.type==='keydown'&&e.key!=='Escape')return;if(e.type==='pointerdown'&&el.contains(e.target))return;setChannelMenu(false);};document.addEventListener('pointerdown',hide);document.addEventListener('keydown',hide);window.addEventListener('resize',hide);return()=>{document.removeEventListener('pointerdown',hide);document.removeEventListener('keydown',hide);window.removeEventListener('resize',hide);};},[channelMenu,menuAnchor]);
  const [menuMapId, setMenuMapId] = useState(null), [subscriptionTarget, setSubscriptionTarget] = useState(undefined);
  const [changesOpen, setChangesOpen] = useState(false), [directoryOpen, setDirectoryOpen] = useState(false);
  const [imageState, setImageState] = useState(null);
  const reader = useRef(null), authRef = useRef(auth), joinDialog = useRef(null), imageDialog = useRef(null), focusSerial = useRef(0);
  const previousAccount = useRef(null);
  authRef.current = auth;
  useEffect(() => {
    if (previousAccount.current && !auth.loading && previousAccount.current !== auth.user?.id) {
      try { clearAccountLayouts(localStorage, previousAccount.current); } catch { /* storage unavailable */ }
    }
    if (auth.user?.id) previousAccount.current = auth.user.id;
  }, [auth.user?.id, auth.loading]);
  const allowedMaps = useMemo(() => [...(state?.maps || []).filter(map => !['denied', 'paused'].includes(state.snapshots[map.id]?.status)).map(map => map.id), 'all'], [state?.maps, state?.snapshots]);
  useEffect(() => {
    if (!state || state.loading || state.accountId !== auth.user?.id) return;
    try { clearAccountLayouts(localStorage, state.accountId, allowedMaps); } catch { /* storage unavailable */ }
  }, [state, allowedMaps, auth.user?.id]);
  useEffect(() => {
    setActivationCode(''); setCreationError(''); setNewTitle(''); setCreatedCode(''); selectZone(null); setSearch(''); setRequest(null); setFrom(''); setTo(''); setStops([]); setInvite(''); setJoinOpen(false); setSubscriptionTarget(undefined); setMenuMapId(null); setRolesMapId(null);
    let selectionStorage; try { selectionStorage = window.sessionStorage; } catch { /* storage unavailable */ }
    const model = createMapReader({ rpc, compactReads:true, selectionStorage, onChange: setState, onUnauthorized: () => { void authRef.current.signOut(); } });
    reader.current = model; model.setAccount(auth.user?.id || null); void model.refresh();
    const refresh = () => { if (!document.hidden && navigator.onLine) { setNow(Date.now()); void model.refresh(); } };
    const interval = setInterval(refresh, 15000), tick = setInterval(() => { if (!document.hidden && navigator.onLine) setNow(Date.now()); }, 5000);
    window.addEventListener('focus', refresh); window.addEventListener('online', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(interval); clearInterval(tick); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); model.setAccount(null); reader.current = null; };
  }, [auth.user?.id, rpc]);
  useEffect(() => {
    const abort = new AbortController();
    const load = async name => { const response = await fetch(siteHref('assets/map/' + name), { signal: abort.signal }); if (!response.ok) throw new Error(); return response.json(); };
    void load('zones.json').then(records => { setZones(Object.fromEntries(records.map(zone => [zone.name, zone]))); setZoneError(false); }).catch(error => { if (error.name !== 'AbortError') setZoneError(true); });
    void load('world-adjacency.json').then(adjacency => { setWorld(adjacency); setWorldError(false); }).catch(error => { if (error.name !== 'AbortError') setWorldError(true); });
    return () => abort.abort();
  }, [assetRetry]);
  useEffect(() => { if (joinDialog.current) { if (joinOpen) joinDialog.current.showModal(); else if (joinDialog.current.open) joinDialog.current.close(); } }, [joinOpen]);
  useEffect(() => { if (imageDialog.current) { if (imageState && !imageDialog.current.open) imageDialog.current.showModal(); else if (!imageState && imageDialog.current.open) imageDialog.current.close(); } }, [imageState]);
  useEffect(() => { setImageState(null); }, [request]);
  useEffect(() => { try { localStorage.setItem('web-route-placement', routePlacement); } catch { /* private mode */ } }, [routePlacement]);
  useEffect(() => { selectZone(null); setFocusRequest(null); setRequest(null); setFrom(''); setTo(''); setStops([]); setSearch(''); setDeleteArmed(null); setChannelMenu(false); setMenuMapId(null); setRolesOpen(false); setRolesMapId(null); setChangesOpen(false); setLeaveArmed(false); setLeaveError(''); }, [state?.selection]);
  const portals = useMemo(() => visiblePortals(state?.maps || [], state?.snapshots || {}, state?.selection, now), [state, now]);
  const names = useMemo(() => [...new Set(portals.flatMap(edge => [edge.a, edge.b]))].sort(), [portals]);
  const zoneNames = useMemo(() => [...new Set([...Object.keys(zones), ...names])].sort(), [zones, names]);
  const query = search.trim().toLowerCase();
  const searchMatches = useMemo(() => query ? names.filter(name => name.toLowerCase().includes(query) || String(zones[name]?.tier) === query).slice(0, 70) : [], [names, query, zones]);
  const router = useMemo(() => world && Object.keys(zones).length ? createRouter(zones, world, t) : null, [zones, world, t]);
  const route = useMemo(() => {
    if (!router || !request) return null;
    if (request.invalidStop) return { found: false, reason: t('Проверь промежуточные зоны.') };
    const opts = { now, outlandsPortalCity: portalCity, zoneColor: name => zones[name]?.color || null };
    const snapshot = { edges: portals };
    return request.mode === 'exit' ? router.findNearestExit(snapshot, request.from, opts)
      : request.waypoints.length ? router.findPlan(snapshot, request.from || null, { to: request.to, waypoints: request.waypoints }, opts)
      : request.mode === 'city' || !request.from ? router.findRouteFromSafeCity(snapshot, request.to, opts) : router.findRoute(snapshot, request.from, request.to, opts);
  }, [router, request, portals, now, portalCity, zones]);
  const activities = useMemo(() => createZoneActivities(t), [t]);
  const zone = zones[selectedZone], selectedPortals = selectedZone ? portals.filter(edge => edge.a === selectedZone || edge.b === selectedZone) : [];
  const selectedMap = state?.maps.find(map => map.id === state.selection);
  const menuMap = state?.maps.find(map => map.id === menuMapId) || selectedMap;
  const rolesMap = state?.maps.find(map => map.id === rolesMapId) || selectedMap;
  const scoutNames = useMemo(() => scoutEnabled ? contentMatches(zones, names, scoutGoals, scoutMatch) : null, [scoutEnabled, zones, names, scoutGoals, scoutMatch]);
  const canViewChanges = !!selectedMap && (selectedMap.isOwner || selectedMap.role === 'admin');
  const changes = useMemo(() => canViewChanges ? [...(state?.snapshots[selectedMap.id]?.edges || [])].filter(edge => edge.expiresAt > now).sort((a, b) => b.firstSeenAt - a.firstSeenAt).slice(0, 300) : [], [canViewChanges, selectedMap?.id, state?.snapshots, now]);
  const unavailable = (state?.maps || []).filter(map => (state.selection === 'all' || state.selection === map.id) && ['paused', 'denied'].includes(state.snapshots[map.id]?.status));
  const chooseZone = name => { selectZone(name); if (name && window.matchMedia('(max-width: 850px)').matches) setView('details'); if (name) setRightOpen(true); setSearchOpen(false); };
  const chooseSearchZone = name => {
    if (!names.includes(name)) return;
    selectZone(name);
    setRightOpen(true);
    setView('map');
    setSearchOpen(false);
    setFocusRequest({ name, mapKey: state.selection, key: ++focusSerial.current });
  };
  const chooseMap = id => reader.current?.select(id);
  const requestRoute = mode => {
    const canonical = value => zoneNames.find(name => name.toLowerCase() === value.trim().toLowerCase()) || value.trim();
    setRequest({ mode, from: canonical(from), to: canonical(to), waypoints: stops.map(stop => canonical(stop.name)), invalidStop: stops.some(stop => !stop.name.trim()) });
  };
  const setRouteStart = name => { setFrom(name); setRequest(null); setRouteExpanded(true); setView('details'); };
  const setRouteEnd = name => { setTo(name); setRequest(null); setRouteExpanded(true); setView('details'); };
  const addRouteStop = name => { if (stops.length >= 6) return; setStops(value => [...value, { id: crypto.randomUUID(), name }]); setRequest(null); setRouteExpanded(true); setView('details'); };
  const canDelete = record => !!record && (record.map.isOwner || record.map.role === 'admin');
  async function deletePortal(edge, record) {
    const key = `${record.map.id}:${edge.key}`;
    if (deleteArmed !== key) { setDeleteArmed(key); return; }
    setDeleteArmed(null); setDeleteError(null);
    try { await rpc('delete_edge', { p_map: record.map.id, p_a: edge.a, p_b: edge.b }); await reader.current?.refresh(); }
    catch { setDeleteError(t('Не удалось удалить портал. Проверь права доступа и попробуй снова.')); }
  }
  async function showRouteImage() {
    if (!route?.found) return;
    setImageState({ loading: true });
    try { const image = await window.RouteImage.render(route, { zoneInfo: zones, now: Date.now() }); setImageState({ image }); }
    catch (error) { setImageState({ error: error.message || t('Не удалось создать изображение маршрута.') }); }
  }
  function saveRouteImage() {
    if (!imageState?.image) return;
    const link = document.createElement('a');
    link.href = imageState.image.dataUrl;
    link.download = `avalon-route-${new Date(imageState.image.generatedAt).toISOString().slice(0, 10)}.png`;
    link.click();
  }
  async function copyRouteImage() {
    if (!imageState?.image) return;
    try {
      const blob = await (await fetch(imageState.image.dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setImageState(current => ({ ...current, notice: t('Картинка скопирована') }));
    } catch { setImageState(current => ({ ...current, notice: t('Не удалось скопировать картинку. Сохрани PNG.') })); }
  }
  async function join(event) {
    event.preventDefault(); const code = invite.trim();
    if (!/^AVI-[0-9A-F]{32}$/i.test(code)) { setJoinState('invalid'); return; }
    const accountId = auth.user?.id; setJoinState('busy');
    try { const result=await rpc('join_server_with_invite', {p_code:code}); if(!result?.ok)throw new Error('invalid_invite'); if (authRef.current.user?.id !== accountId) return;
      await reader.current?.refresh(); if (authRef.current.user?.id !== accountId) return;
      reader.current?.select(result.id); setJoinState('done'); setInvite(''); setJoinOpen(false);
    } catch { if (authRef.current.user?.id === accountId) setJoinState('failed'); }
  }
  const openMapDialog = (mode = 'create') => { setMapDialogMode(mode); setJoinState(null); setCreateState(null); setCreationError(''); setCreatedCode(''); setJoinOpen(true); };
  async function createGroup(event) {
    event.preventDefault();
    if (creationFlight.current) return;
    if (!newTitle.trim()) { setCreationError(t('Укажи название сервера.')); return; }
    if (!/^AM30[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{30}$/.test(activationCode.replace(/[-\s]/g, '').toUpperCase())) { setCreationError(t('Код недействителен или уже использован.')); return; }
    creationFlight.current = true;
    const accountId = auth.user?.id; setCreateState('busy'); setCreationError('');
    try {
      const result = await rpc('create_server_with_code', { p_title: newTitle.trim(), p_code: activationCode });
      if (!result?.ok) throw new Error(result?.code || 'code_activation_failed');
      const code = typeof result === 'string' ? result : Array.isArray(result) ? result[0] : result?.id;
      if (!UUID.test(String(code))) throw new Error('invalid_map_id');
      if (authRef.current.user?.id !== accountId) return;
      await reader.current?.refresh();
      if (authRef.current.user?.id !== accountId) return;
      reader.current?.select(code);
      setCreateState('done'); setNewTitle(''); setActivationCode(''); setJoinOpen(false);
    } catch (error) {
      if (authRef.current.user?.id === accountId) { setCreateState('failed'); setCreationError(t(({invalid_code:'Код недействителен или уже использован.', code_rate_limited:'Слишком много попыток. Попробуй позже.', license_expired:'Срок этого кода истёк. Используй новый код.', discord_required:'Для подписки войди через Discord.'})[error.message] || 'Не удалось создать сервер. Проверь соединение и повтори тот же код.')); }
    } finally { creationFlight.current = false;
    }
  }
  async function leaveGroup() {
    if (!menuMap || menuMap.kind !== 'group') return;
    if (!leaveArmed) { setLeaveArmed(true); return; }
    const accountId = auth.user?.id, id = menuMap.id;
    try {
      await rpc('leave_map', { p_map: id });
      if (authRef.current.user?.id !== accountId) return;
      if (state.selection === id) reader.current?.select(accountId);
      await reader.current?.refresh();
      setChannelMenu(false); setLeaveArmed(false); setLeaveError('');
    } catch { if (authRef.current.user?.id === accountId) { setLeaveError(t('Не удалось выйти из карты.')); setLeaveArmed(false); } }
  }
  const shell = children => <MapShell view={view} rightOpen={rightOpen} routePlacement={routePlacement} onSubscription={auth.user ? () => setSubscriptionTarget(null) : null}>{children}</MapShell>;
  if (!auth.user) return shell(<LoginPanel/>);
  if (state?.accountId !== auth.user.id) return shell(<div className="map-login" role="status">{t('Загрузка карт…')}</div>);
  const options = <>{!state.maps.length && <option value="">{t(state.loading ? 'Загрузка карт…' : 'Карты недоступны')}</option>}{state.maps.map(map => <option value={map.id} key={map.id}>{mapName(map, t)}</option>)}</>;
  return shell(<>
          {channelMenu && <div ref={serverMenuRef} className="menu map-channel-menu server-menu-fixed" role="menu">
            <button role="menuitem" type="button" onClick={() => { reader.current?.refresh(); setChannelMenu(false); }}>{t('Обновить карты')}</button>
            {menuMap?.kind === 'group' && menuMap.isOwner && <button role="menuitem" type="button" onClick={() => { setSubscriptionTarget(null); setChannelMenu(false); }}>{t('Подписка')}</button>}
            {menuMap?.kind === 'group' && (menuMap.isOwner || ['admin','moderator'].includes(menuMap.role)) && <button role="menuitem" type="button" onClick={() => {setAccessKind('invite');setRolesMapId(menuMap.id);setRolesOpen(true);setChannelMenu(false);}}>{t('Пригласить участников')}</button>}
            {menuMap?.kind === 'group' && (menuMap.isOwner || ['admin','moderator'].includes(menuMap.role)) && <button role="menuitem" type="button" onClick={() => { setAccessKind('roles');setRolesMapId(menuMap.id); setRolesOpen(true); setChannelMenu(false); }}>{t('Настройки ролей')}</button>}

            {menuMap?.kind === 'group' && !menuMap.isOwner && <button role="menuitem" className="danger" type="button" onClick={() => void leaveGroup()}>{t(leaveArmed ? 'Точно выйти?' : 'Выйти из карты')}</button>}
          </div>}
    <div className="mobile-map-picker"><select value={state.selection || ''} onChange={event => chooseMap(event.target.value)} aria-label={t('Выбрать карту')}>{options}</select><span className="small muted">{t('Порталов: {0}', [portals.length])}</span><button className="btn ghost square" onClick={() => openMapDialog()} aria-label={t('Создать карту или войти по коду')}><Plus/></button></div>
    <div id="left">
      <div id="left-top"><nav id="rail" aria-label={t('Мои карты')}><div className="rail-mark" aria-hidden="true"><img src={siteHref('assets/icon.png')} alt=""/></div><div className="rail-sep"/><button className="rail-btn add" onClick={() => openMapDialog()} aria-label={t('Создать карту или войти по коду')} title={t('Создать карту или войти по коду')}><span className="rail-ico"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></span></button>
        {state.maps.map(map => <button className={`rail-btn ${state.selection === map.id ? 'on' : ''}`} key={map.id} aria-label={mapName(map, t)} title={mapName(map, t)} aria-pressed={state.selection === map.id} onClick={() => chooseMap(map.id)} onContextMenu={event => { if (map.kind !== "group") return; event.preventDefault(); const r=event.currentTarget.getBoundingClientRect();setMenuAnchor({x:r.right+8,y:r.top});setMenuMapId(map.id); setLeaveArmed(false); setChannelMenu(true); }}><span className="rail-ico">{map.kind === 'personal' ? mapName(map, t)[0].toUpperCase() : (map.title || 'G').slice(0, 1).toUpperCase()}</span></button>)}
      </nav><aside id="side" aria-label={t('Список порталов')}>
        <div id="side-head">
          <button className="chan-head" type="button" aria-expanded={channelMenu} aria-haspopup="menu" onClick={event => {const r=event.currentTarget.getBoundingClientRect();setMenuAnchor({x:r.left,y:r.bottom+6}); setMenuMapId(null); if (channelMenu) setLeaveArmed(false); setChannelMenu(value => !value); }}><b>{mapName(selectedMap, t)}</b><svg className="chan-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button>
          <div className="chan-sub">{selectedMap?.kind === 'personal' ? t('На компьютере и в личном облаке') : selectedMap?.isOwner ? t('Карта друзей · ты владелец') : selectedMap?.role === 'admin' ? t('Карта друзей · ты хранитель') : selectedMap?.role === 'moderator' ? t('Карта друзей · ты модератор') : selectedMap?.role === 'verified' ? t('Карта друзей · проверенный') : selectedMap?.role === 'viewer' ? t('Карта друзей · наблюдатель') : selectedMap ? t('Карта друзей · участник') : t('Все доступные карты')}</div>
          {selectedMap?.kind === 'group' && <div className="chan-up-note"><i/>{t('сюда пишутся новые порталы')}</div>}

        </div>
        <div id="side-scroll">
          {state.error && <div className="map-notice" role="alert"><span>{t(state.error === 'partial_sync' ? 'Некоторые карты не обновились. Показываем последнее полученное состояние.' : 'Не удалось загрузить карты. Проверь соединение и попробуй снова.')}</span><button className="btn ghost" onClick={() => reader.current?.refresh()}>{t('Повторить')}</button></div>}
          {leaveError && <div className="map-notice" role="alert">{leaveError}</div>}
          {unavailable.map(map => <div className="map-notice" key={map.id} role="status">{mapName(map, t)} · {t(state.snapshots[map.id].status === 'paused' ? 'Синхронизация приостановлена. Владельцу нужно продлить подписку группы.' : 'Доступ к этой карте закрыт.')}</div>)}
          {zoneError && <p className="map-notice" role="alert">{t('Не удалось загрузить сведения о зонах. Порталы остаются доступны.')}</p>}
          <div className="block web-current-zone"><div className="label">{t('Текущая зона')}</div><div className="muted small">{t('На сайте зона персонажа недоступна')}</div></div>
          <div className="block"><div className="label">{t('Выбрано')}</div><div className="selected-info">{selectedZone ? <><b>{selectedZone}</b><div className="sel-acts"><button type="button" className={from === selectedZone ? 'on' : ''} onClick={() => setRouteStart(selectedZone)}>{t('Отсюда')}</button><button type="button" className={to === selectedZone ? 'on' : ''} onClick={() => setRouteEnd(selectedZone)}>{t('Сюда')}</button></div><div className="sel-portals"><div className="cap">{t('порталы этой зоны: {0}', [selectedPortals.length])}</div>{selectedPortals.map(edge => { const record = edge.records.find(canDelete), key = record && `${record.map.id}:${edge.key}`; return <div className="row" key={edge.key}><button type="button" className="nm" onClick={() => chooseZone(edge.a === selectedZone ? edge.b : edge.a)}>{edge.a === selectedZone ? edge.b : edge.a}</button><time className="tm">{edge.capMax ? t('на {0}', [edge.capMax]) + ' · ' : ''}{timeLeft(edge.expiresAt, now, t)}</time>{record && <button type="button" className={deleteArmed === key ? 'armed' : ''} title={t(deleteArmed === key ? 'Нажми ещё раз — портал исчезнет' : 'Удалить портал')} aria-label={t(deleteArmed === key ? 'Подтвердить удаление портала' : 'Удалить портал')} onClick={() => void deletePortal(edge, record)}>{deleteArmed === key ? t('точно?') : '×'}</button>}</div>; })}</div></> : <span className="small muted">{t('клик по зоне или порталу')}</span>}</div>{deleteError && <p className="map-notice" role="alert">{deleteError}</p>}</div>
          <ScoutPanel goals={scoutGoals} setGoals={setScoutGoals} match={scoutMatch} setMatch={setScoutMatch} enabled={scoutEnabled} setEnabled={setScoutEnabled} count={scoutNames?.length || 0}/>
        </div>
        {canViewChanges && <div className="block" id="changes-entry"><button className="btn ghost" type="button" onClick={() => setChangesOpen(true)}><ClockCounterClockwise size={15}/>{t('Журнал изменений')}</button></div>}
        <div className="block" id="legend-block"><div className="label">{t('Легенда')}</div><div className="legend">{['avalon', 'blue', 'yellow', 'red', 'black', 'city'].map(color => <span key={color}><i className={`dot ${color}`}/>{t(colorNames[color])}</span>)}</div></div>
      </aside></div>
      <div id="left-bottom"><div className="map-sync-line" role="status"><span className="map-sync-status">{state.loading ? <ArrowClockwise size={12} className="map-spinning"/> : <Check size={12}/>} {t(state.loading ? 'Обновление…' : state.error ? 'Не удалось обновить' : state.updatedAt ? 'Синхронизировано' : 'Подключение')}</span><button className="btn ghost square" onClick={() => reader.current?.refresh()} disabled={state.loading} aria-label={t('Обновить карты')} title={t('Обновить карты')}><ArrowClockwise/></button></div><div id="acc-bar"><div id="acc-me"><span className="acc-ava">{auth.user.avatar ? <img src={auth.user.avatar} alt="" referrerPolicy="no-referrer"/> : <i>{auth.user.name.slice(0, 2).toUpperCase()}</i>}</span><span className="acc-id"><b>{auth.user.name}</b><i className="acc-role">{t('Облачная карта')}</i></span></div><SignOutButton/></div></div>
    </div>
    <main id="graph" aria-label={t('Карта порталов')}><PortalGraph portals={portals} zones={zones} now={now} selectedZone={selectedZone} focusRequest={focusRequest} onSelectZone={chooseZone} onSetFrom={setRouteStart} onSetTo={setRouteEnd} onAddStop={addRouteStop} canAddStop={stops.length < 6} onDeletePortal={deletePortal} canDeletePortal={canDelete} deleteArmed={deleteArmed} scoutMatches={scoutNames} route={route} theme="site" mapKey={state.selection} allowedMaps={allowedMaps} accountId={auth.user.id} rpc={rpc} isPersonal={selectedMap?.kind === 'personal'} canRearrange={!!selectedMap && (selectedMap.isOwner || ['admin','moderator','verified'].includes(selectedMap.role))}>
      <div className="map-search"><button className="btn key" type="button" aria-controls="map-search-pop" aria-expanded={searchOpen} onClick={() => { setSearch(''); setSearchOpen(value => !value); }}><MagnifyingGlass/>{t('Поиск зон на карте')}</button>{searchOpen && <div id="map-search-pop" className="map-search-pop"><label htmlFor="map-search-input">{t('Поиск по открытой карте')}</label><input id="map-search-input" autoFocus type="search" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (searchMatches[0]) chooseSearchZone(searchMatches[0]); } else if (event.key === 'Escape') setSearchOpen(false); }} placeholder={t('Название или уровень: 4, 6, 8')}/><div className="map-search-results">{searchMatches.map(name => <button className="map-search-result" key={name} onClick={() => chooseSearchZone(name)}><i className={`dot ${zones[name]?.color || 'black'}`}/><span>{name}</span><span className="map-search-tier">{zones[name]?.tier ? `T${zones[name].tier}` : ''}</span></button>)}{!searchMatches.length && <p className="small muted">{t(query ? 'На открытой карте такой зоны нет' : names.length ? 'Введи название зоны или уровень 4, 6, 8' : 'В этой карте пока нет порталов')}</p>}</div></div>}</div>
      <button className="btn ghost map-directory-trigger" type="button" onClick={() => setDirectoryOpen(true)}><BookOpen size={17}/>{t('Справочник Авалонов')}</button>
      <button id="card-toggle" className="btn ghost" type="button" title={t(rightOpen ? 'Скрыть карточку зоны' : 'Показать карточку зоны')} aria-label={t(rightOpen ? 'Скрыть карточку зоны' : 'Показать карточку зоны')} aria-controls="card" aria-expanded={rightOpen} onClick={() => setRightOpen(value => !value)}><CaretRight/><span>{t('Карточка зоны')}</span></button>
    </PortalGraph></main>
    <div className="map-details"><aside id="card" aria-label={t('Карточка зоны')}>
      <div id="card-top"><Fold title={t('Карточка зоны')}>{selectedZone ? <><div className="card-head"><div className="map-zone-heading"><h2 className="card-name">{selectedZone}</h2><button className="map-icon-button" onClick={() => selectZone(null)} aria-label={t('Закрыть зону')}><X size={16}/></button></div><div className="card-tags">{zone?.tier && <span className="chip chip-tier">T{zone.tier}</span>}{zone?.color && <span className={`chip chip-${zone.color}`}>{t(colorNames[zone.color] || 'Зона')}</span>}{zone?.type && <span className="chip chip-road" title={activities.roadTypeRu(zone.type)}>{zone.type}</span>}</div></div>{zone?.image && <ZoneImage key={zone.name} zone={zone} t={t}/>}<div className="acts">{activities.listActivities(zone).map((item, index) => <span className={`act ${item.big ? 'big' : ''} ${item.sub ? 'pair' : ''}`} title={activities.actTitle(item, zone)} key={`${item.icon}-${index}`}><span className="ic"><img src={siteHref(`assets/map/icons/${item.icon}.webp`)} alt={item.ru}/>{item.sub && <span className="sub"><img src={siteHref(`assets/map/icons/${item.sub}.webp`)} alt=""/></span>}</span>{!item.res && item.count > 1 && <b>{item.count}</b>}</span>)}</div></> : <p className="small muted">{t('Нажми на зону на графе или найди её в справочнике.')}</p>}</Fold></div>
    </aside>
    <section id="route-block" aria-label={t('Маршрут')}><div className="route-head"><button className="fold-head" type="button" aria-expanded={routeExpanded} aria-controls="route-body-wrap" onClick={() => setRouteExpanded(value => !value)}><span className="label">{t('Маршрут')}</span><svg className="fold-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></button><div className="route-placement" role="group" aria-label={t('Расположение маршрута')}>{['left', 'bottom', 'right'].map(position => <RoutePlacementButton key={position} position={position} active={routePlacement === position} onClick={() => setRoutePlacement(position)} t={t}/>)}</div></div><div id="route-body-wrap" className={`fold-wrap ${routeExpanded ? '' : 'collapsed'}`}><div><RoutePanel from={from} to={to} setFrom={setFrom} setTo={setTo} stops={stops} setStops={setStops} portalCity={portalCity} setPortalCity={setPortalCity} onRequest={requestRoute} request={request} route={route} onClear={() => setRequest(null)} onImage={showRouteImage} onSelectZone={chooseZone} selectedZone={selectedZone} ready={!!router} loadError={worldError || zoneError} onRetry={() => { setZoneError(false); setWorldError(false); setAssetRetry(value => value + 1); }} now={now} zoneNames={zoneNames} zones={zones}/></div></div></section></div>
    <nav className="map-mobile-tabs" aria-label={t('Вид карты')}>{[['map', 'Карта', MapTrifold], ['list', 'Порталы', ListBullets], ['details', 'Зона и маршрут', Path]].map(([value, label, Icon]) => <button key={value} aria-pressed={view === value} onClick={() => setView(value)}><Icon size={19}/>{t(label)}</button>)}</nav>
    <dialog ref={joinDialog} className="map-settings-dialog" onCancel={event => { event.preventDefault(); setJoinOpen(false); }} onClick={event => { if (event.target === joinDialog.current) setJoinOpen(false); }}><div className="map-dialog-heading"><h2>{t('Карты друзей')}</h2><button className="btn ghost square" onClick={() => setJoinOpen(false)} aria-label={t('Закрыть')}><X/></button></div><div className="map-dialog-tabs" role="tablist"><button type="button" role="tab" aria-selected={mapDialogMode === 'create'} onClick={() => setMapDialogMode('create')}>{t('Создать свою')}</button><button type="button" role="tab" aria-selected={mapDialogMode === 'join'} onClick={() => setMapDialogMode('join')}>{t('Войти по коду')}</button></div>{mapDialogMode === 'create' ? <form className="map-join" onSubmit={createGroup}><label className="label" htmlFor="map-new-title">{t('Название')}</label><input id="map-new-title" required disabled={createState === 'busy'} maxLength={60} value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder={t('Гильдия, отряд, друзья')} autoComplete="off" spellCheck="false"/><label className="label" htmlFor="map-create-code">{t('Код активации')}</label><input id="map-create-code" required maxLength={128} value={activationCode} onChange={event=>setActivationCode(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck="false" placeholder="AM30-…" disabled={createState === 'busy'}/><p className="small muted">{t('Один код создаёт один сервер на 30 дней. Название одинаково для всех участников.')}</p><button className="btn key" disabled={createState === 'busy'}>{t(createState === 'busy' ? 'Создание…' : 'Создать сервер')}</button>{createdCode && <div className="map-created-code" role="status"><span>{t('Код карты')}: <code>{createdCode}</code></span><button className="btn ghost" type="button" onClick={() => void navigator.clipboard.writeText(createdCode)}>{t('Скопировать код')}</button></div>}{creationError && <p className="map-notice" role="alert">{creationError}</p>}</form> : <form className="map-join" onSubmit={join}><label className="label" htmlFor="map-invite">{t('Код приглашения')}</label><input id="map-invite" value={invite} onChange={event => setInvite(event.target.value)} placeholder="AVI-…" autoComplete="off" spellCheck="false" required/><button className="btn key" disabled={joinState === 'busy'}>{t(joinState === 'busy' ? 'Подключение' : 'Открыть карту')}<ArrowRight/></button>{['invalid', 'failed'].includes(joinState) && <p className="map-notice" role="alert">{t(joinState === 'invalid' ? 'Нужен код приглашения AVI от хранителя или модератора.' : 'Приглашение недействительно, истекло или доступ закрыт.')}</p>}</form>}</dialog>
    {rolesOpen && rolesMap?.kind === 'group' && (rolesMap.isOwner || ['admin','moderator'].includes(rolesMap.role)) && <ServerAccessDialog key={auth.user.id+rolesMap.id+accessKind} accountId={auth.user.id} kind={accessKind} map={rolesMap} rpc={rpc} onClose={() => setRolesOpen(false)} onChanged={() => reader.current?.refresh()}/>}
    {subscriptionTarget !== undefined && <SubscriptionDialog key={auth.user.id + ':' + (subscriptionTarget || '')} accountId={auth.user.id} mapId={null} rpc={rpc} onClose={() => setSubscriptionTarget(undefined)} onChanged={() => reader.current?.refresh()}/>}
    <ChangeLogDialog open={changesOpen && canViewChanges} onClose={() => setChangesOpen(false)} map={selectedMap} entries={changes} now={now} zones={zones} t={t}/>
    <AvalonDirectory open={directoryOpen} onClose={() => setDirectoryOpen(false)} zones={zones} t={t}/>
    <dialog ref={imageDialog} className="map-route-image-dialog" onCancel={event => { event.preventDefault(); setImageState(null); }} onClick={event => { if (event.target === imageDialog.current) setImageState(null); }}><div className="map-dialog-heading"><h2>{t('Картинка маршрута')}</h2><button className="btn ghost square" type="button" aria-label={t('Закрыть')} onClick={() => setImageState(null)}><X/></button></div><p className="small muted">{t('Скопируй картинку и вставь в чат другу или сохрани её в PNG.')}</p><div className="map-route-image-stage" role="region" aria-label={t('Предпросмотр маршрута')}>{imageState?.loading ? <p role="status">{t('Создаю картинку…')}</p> : imageState?.error ? <p role="alert">{imageState.error}</p> : imageState?.image && <img src={imageState.image.dataUrl} alt={t('Маршрут от {0} до {1}', [imageState.image.from, imageState.image.to])}/>}</div>{imageState?.notice && <p role="status" className="small muted">{imageState.notice}</p>}<div className="map-route-image-actions"><button className="btn key" type="button" disabled={!imageState?.image} onClick={() => void copyRouteImage()}>{t('Скопировать картинку')}</button><button className="btn ghost" type="button" disabled={!imageState?.image} onClick={saveRouteImage}>{t('Сохранить PNG')}</button></div></dialog>
  </>);
}
