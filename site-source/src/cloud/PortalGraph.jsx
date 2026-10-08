import React, { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { ArrowClockwise, Minus, Plus } from '@phosphor-icons/react';
import { useLanguage } from '../localization.jsx';
import '../../../app/ui/graph-layout.js';
import '../../../app/ui/component-layout.js';
import '../../../app/ui/bridge-layout.js';
import './generated/graph-style.js';
import { createStableGraph, graphEdgeId } from './stable-graph.js';
import { createWebMapLayout } from './map-layout.js';
import { syncGraphSelection } from './graph-selection.js';

export function timeLeft(expiresAt, now, t) {
  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60000));
  const hours = Math.floor(minutes / 60);
  return hours ? t('{0}ч {1}м', [hours, String(minutes % 60).padStart(2, '0')]) : t('{0}м', [minutes]);
}
const nodeData = (name, zones) => {
  const zone = zones[name] || {}, isAvalon = zone.color === 'avalon', tier = zone.tier || 0;
  return { id: name, label: name, color: window.ZONE_COLORS[zone.color] || window.ZONE_COLORS.black,
    isAvalon, tier, ...(tier ? { tierIcon: window.tierBadge(tier, isAvalon && tier === 8) } : {}) };
};

// Keep the graph centred in the visible canvas, clear of the floating panels.
function visibleMapArea(cy) {
  const canvas = cy.container().getBoundingClientRect();
  const bounds = { left: 24, top: 24, right: cy.width() - 24, bottom: cy.height() - 24 };
  const shell = cy.container().closest('.mapper-web');
  const obstacles = [];
  for (const selector of ['.app-header', '#left', '#graph-tools', '#route-block', '#card']) {
    const element = shell?.querySelector(selector);
    if (!element || element.inert) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const obstacle = {
      left: Math.max(bounds.left, rect.left - canvas.left - 18),
      top: Math.max(bounds.top, rect.top - canvas.top - 18),
      right: Math.min(bounds.right, rect.right - canvas.left + 18),
      bottom: Math.min(bounds.bottom, rect.bottom - canvas.top + 18),
    };
    if (obstacle.left < obstacle.right && obstacle.top < obstacle.bottom) obstacles.push(obstacle);
  }
  const xs = [...new Set([bounds.left, bounds.right, ...obstacles.flatMap(o => [o.left, o.right])])].sort((a, b) => a - b);
  const ys = [...new Set([bounds.top, bounds.bottom, ...obstacles.flatMap(o => [o.top, o.bottom])])].sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i < xs.length - 1; i++) for (let j = i + 1; j < xs.length; j++) {
    for (let k = 0; k < ys.length - 1; k++) for (let l = k + 1; l < ys.length; l++) {
      const area = { left: xs[i], top: ys[k], right: xs[j], bottom: ys[l] };
      if (area.right - area.left < 96 || area.bottom - area.top < 96) continue;
      if (obstacles.some(o => area.left < o.right && area.right > o.left && area.top < o.bottom && area.bottom > o.top)) continue;
      const score = (area.right - area.left) * (area.bottom - area.top);
      if (!best || score > best.score) best = { ...area, score };
    }
  }
  return best;
}

function visibleMapFit(cy) {
  if (!cy?.nodes().length) return null;
  const area = visibleMapArea(cy);
  if (!area) return null;
  const box = cy.elements().boundingBox();
  const zoom = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), 1.5,
    (area.right - area.left) / Math.max(box.w, 1), (area.bottom - area.top) / Math.max(box.h, 1)));
  return { zoom, pan: {
    x: (area.left + area.right) / 2 - (box.x1 + box.x2) / 2 * zoom,
    y: (area.top + area.bottom) / 2 - (box.y1 + box.y2) / 2 * zoom,
  } };
}

function visibleMapFocus(cy, node, zoom) {
  const area = visibleMapArea(cy);
  if (!area) return null;
  const position = node.position();
  return { zoom, pan: {
    x: (area.left + area.right) / 2 - position.x * zoom,
    y: (area.top + area.bottom) / 2 - position.y * zoom,
  } };
}

export default function PortalGraph({ portals, zones, selectedZone, focusRequest, onSelectZone, onSetFrom, onSetTo, onAddStop, canAddStop, onDeletePortal, canDeletePortal, deleteArmed, scoutMatches, now, route, theme, mapKey, allowedMaps, accountId, rpc, canRearrange, isPersonal, children }) {
  const { t } = useLanguage();
  const container = useRef(null), graph = useRef(null), placement = useRef(null);
  const shared = useRef(null), revision = useRef(0), paintedKey = useRef(null);
  const resetting = useRef(null), focusRef = useRef(null), focusedKey = useRef(null), focusFrame = useRef(null), noticeTimer = useRef(null);
  const allowedRef = useRef(allowedMaps), selectedRef = useRef(selectedZone), scoutRef = useRef(scoutMatches);
  const contextRef = useRef(null), callbacks = useRef({});
  allowedRef.current = allowedMaps; selectedRef.current = selectedZone; scoutRef.current = scoutMatches; focusRef.current = focusRequest;
  callbacks.current = { onSetFrom, onSetTo, onAddStop, onDeletePortal, canDeletePortal };
  const [context, setContext] = useState(null);
  const [layoutBusy, setLayoutBusy] = useState(false), [layoutError, setLayoutError] = useState(null), [layoutNotice, setLayoutNotice] = useState(null), [resetBusy, setResetBusy] = useState(false);
  if (!placement.current) placement.current = createStableGraph();
  if (!shared.current) {
    let storage; try { storage = localStorage; } catch { /* session-only fallback */ }
    shared.current = createWebMapLayout({ storage, rpc, accountId, isAllowed: id => allowedRef.current.includes(id || 'all') });
  }
  const mapId = mapKey === 'all' ? null : mapKey;
  const mapRef = useRef(mapKey); mapRef.current = mapKey;
  const dragContext = useRef(null), translate = useRef(t);
  dragContext.current = { mapId, isPersonal }; translate.current = t;
  const onSelect = useRef(onSelectZone); onSelect.current = onSelectZone;
  const fit = () => { const cy = graph.current, viewport = visibleMapFit(cy); if (viewport) cy.viewport(viewport); };
  const focusZone = () => {
    const cy = graph.current, request = focusRef.current;
    if (!cy || !request || request.mapKey !== mapRef.current || request.key === focusedKey.current || cy.width() === 0) return;
    const node = cy.$id(request.name);
    if (!node.length) return;
    if (focusFrame.current) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      if (graph.current !== cy || focusRef.current?.key !== request.key || mapRef.current !== request.mapKey) return;
      const viewport = visibleMapFocus(cy, node, Math.max(cy.zoom(), 0.9));
      if (!viewport) return;
      cy.stop();
      cy.animate({ ...viewport, duration: 320, easing: 'ease-out' });
      focusedKey.current = request.key;
    });
  };
  async function arrange() {
    const cy = graph.current;
    if (!cy?.nodes().length || !canRearrange) return;
    const key = mapKey, previous = Object.fromEntries(cy.nodes().map(node => [node.id(), { ...node.position() }])), viewport = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    resetting.current = key;
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setResetBusy(true); setLayoutError(null); setLayoutNotice(null);
    try {
      const names = cy.nodes().map(node => node.id()).sort();
      const pairs = cy.edges().map(edge => [edge.source().id(), edge.target().id()]);
      const compact = window.COMPONENT_LAYOUT.buildVariants({ positions: previous, edges: pairs }, ['compact']).variants[0];
      cy.batch(() => cy.nodes().forEach(node => node.position(compact.positions[node.id()])));
      window.BRIDGE_LAYOUT.apply(cy);
      fit();
      const proposed = Object.fromEntries(cy.nodes().map(node => [node.id(), { ...node.position() }]));
      const positions = await shared.current.resolve(mapId, names, pairs, proposed);
      if (graph.current !== cy || mapRef.current !== key) return;
      cy.batch(() => cy.nodes().forEach(node => { if (positions[node.id()]) node.position(positions[node.id()]); }));
      window.BRIDGE_LAYOUT.apply(cy); placement.current.remember(cy); fit();
      setLayoutNotice(t('Расположение зон сохранено'));
      noticeTimer.current = setTimeout(() => setLayoutNotice(null), 4000);
    } catch {
      if (graph.current === cy && mapRef.current === key) { cy.batch(() => cy.nodes().forEach(node => { if (previous[node.id()]) node.position(previous[node.id()]); })); cy.viewport(viewport); window.BRIDGE_LAYOUT.apply(cy); setLayoutError(t('Не удалось сохранить расположение в облаке.')); }
    } finally { if (resetting.current === key) resetting.current = null; if (graph.current === cy) setResetBusy(false); }
  }
  useEffect(() => {
    const cy = cytoscape({ container: container.current, minZoom: .12, maxZoom: 2.5, wheelSensitivity: 4, style: window.graphStyle() });
    graph.current = cy;
    cy.on('tap', 'node', event => onSelect.current(event.target.id()));
    cy.on('tap', event => { setContext(null); contextRef.current = null; if (event.target === cy) onSelect.current(null); });
    cy.on('cxttap', 'node', event => {
      const name = event.target.id(), original = event.originalEvent;
      let x = Math.max(8, Math.min(window.innerWidth - 228, (original?.clientX || 20) + 2));
      const card = container.current.closest('.mapper-web')?.querySelector('#card');
      if (card && getComputedStyle(card).visibility !== 'hidden') {
        const cardLeft = card.getBoundingClientRect().left;
        if (x < cardLeft && x + 220 > cardLeft) x = Math.max(8, cardLeft - 228);
      }
      const y = Math.max(8, Math.min(window.innerHeight - 245, (original?.clientY || 20) + 2));
      contextRef.current = name;
      onSelect.current(name);
      setContext({ name, x, y });
    });
    const dismiss = () => { contextRef.current = null; setContext(null); };
    cy.on('pan zoom', dismiss);
    container.current.addEventListener('contextmenu', event => event.preventDefault());
    cy.on('grab', 'node', () => cy.edges().addClass('drag-lite'));
    cy.on('free', 'node', () => {
      window.BRIDGE_LAYOUT.apply(cy);
      cy.edges().removeClass('drag-lite'); placement.current.remember(cy);
      const { mapId: activeMap, isPersonal: personal } = dragContext.current;
      const key = mapRef.current, positions = Object.fromEntries(cy.nodes().map(node => [node.id(), { ...node.position() }]));
      shared.current.remember(activeMap, positions);
      if (activeMap && personal) void shared.current.resolve(activeMap, Object.keys(positions), cy.edges().map(edge => [edge.source().id(), edge.target().id()]), positions).catch(() => {
        if (graph.current === cy && mapRef.current === key) setLayoutError(translate.current('Не удалось сохранить расположение в облаке.'));
      });
    });
    let wasHidden = false;
    const resize = new ResizeObserver(() => {
      cy.resize(); const width = cy.width();
      if (width === 0) { wasHidden = true; return; }
      if (wasHidden) {
        wasHidden = false;
        const viewport = visibleMapFit(cy); if (viewport) cy.viewport(viewport);
      }
    });
    resize.observe(container.current);
    void document.fonts.ready.then(() => { if (graph.current === cy) cy.style(window.graphStyle()); });
    return () => { ++revision.current; if (focusFrame.current) cancelAnimationFrame(focusFrame.current); if (noticeTimer.current) clearTimeout(noticeTimer.current); shared.current.dispose(); resize.disconnect(); placement.current.clear(); cy.destroy(); graph.current = null; };
  }, []);
  useEffect(() => { graph.current?.style(window.graphStyle()); }, [theme]);
  useEffect(() => {
    const cy = graph.current;
    if (!cy) return;
    const version = ++revision.current;
    if (!allowedMaps.includes(mapKey)) {
      placement.current.sync(cy, { key: mapKey, allowedKeys: allowedMaps, nodes: [], edges: [], initialLayout: fit });
      window.BRIDGE_LAYOUT.apply(cy); paintedKey.current = mapKey; setLayoutBusy(false); return;
    }
    if (paintedKey.current !== mapKey) { placement.current.remember(cy); cy.elements().remove(); setLayoutBusy(true); setLayoutError(null); setLayoutNotice(null); }
    const routeSteps = route?.found ? route.steps : [];
    const names = [...new Set([...portals.flatMap(edge => [edge.a, edge.b]), ...routeSteps.flatMap(step => [step.from, step.to])])].sort();
    const label = edge => [edge.capMax ? t('на {0}', [edge.capMax]) : '', timeLeft(edge.expiresAt, now, t)].filter(Boolean).join(' · ');
    const edges = portals.map(edge => ({ id: graphEdgeId(edge.a, edge.b), source: edge.a, target: edge.b, label: label(edge), soon: edge.expiresAt - now < 1800000, recent: edge.updatedAt + 300000 > now, ghost: false }));
    const realPairs = new Set(edges.map(edge => edge.id));
    routeSteps.forEach(step => { const id = graphEdgeId(step.from, step.to); if (!realPairs.has(id)) { edges.push({ id, source: step.from, target: step.to, label: '', ghost: true }); realPairs.add(id); } });
    void shared.current.resolve(mapId, names, edges.map(edge => [edge.source, edge.target])).then(positions => {
    if (graph.current !== cy || version !== revision.current || mapRef.current !== mapKey || resetting.current === mapKey) return;
    placement.current.sync(cy, { key: mapKey, allowedKeys: allowedMaps, nodes: names.map(name => nodeData(name, zones)), edges, positions, initialLayout: fit });
    if (mapId && !isPersonal) cy.nodes().ungrabify(); else cy.nodes().grabify();
    cy.batch(() => {
      cy.elements().removeClass('route-dim route-hit route-ghost');
      cy.edges('[?ghost]').addClass('route-ghost');
      if (routeSteps.length) {
        cy.elements().addClass('route-dim');
        routeSteps.forEach(step => {
          cy.$id(step.from).removeClass('route-dim').addClass('route-hit');
          cy.$id(step.to).removeClass('route-dim').addClass('route-hit');
          const edges = cy.$id(step.from).edgesWith(cy.$id(step.to));
          if (edges.length) edges.removeClass('route-dim').addClass('route-hit');
        });
      }
      cy.nodes().unselect();
      if (selectedRef.current) cy.$id(selectedRef.current).select();
      const matches = scoutRef.current;
      cy.elements().removeClass('scout-match scout-dim');
      if (matches !== null) {
        const names = new Set(matches);
        cy.nodes().forEach(node => node.addClass(names.has(node.id()) ? 'scout-match' : 'scout-dim'));
        cy.edges().addClass('scout-dim');
      }
    });
    window.BRIDGE_LAYOUT.apply(cy); paintedKey.current = mapKey; setLayoutBusy(false); focusZone();
    }).catch(() => { if (graph.current === cy && version === revision.current) { setLayoutBusy(false); setLayoutError(t('Не удалось загрузить расположение карты.')); } });
  }, [portals, zones, now, t, route, mapKey, allowedMaps, isPersonal]);
  useEffect(() => {
    const cy = graph.current; if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass('scout-match scout-dim');
      if (scoutMatches !== null) {
        const names = new Set(scoutMatches);
        cy.nodes().forEach(node => node.addClass(names.has(node.id()) ? 'scout-match' : 'scout-dim'));
        cy.edges().addClass('scout-dim');
      }
    });
  }, [scoutMatches]);
  useEffect(() => {
    syncGraphSelection(graph.current, selectedZone);
  }, [selectedZone]);
  useEffect(() => { focusZone(); }, [focusRequest]);
  const zoom = factor => { const cy = graph.current; if (cy) cy.zoom({ level: Math.min(2.5, Math.max(.12, cy.zoom() * factor)), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); };
  return <>
    <div id="graph-tools">{children}<div className="map-view-actions"><button className="btn ghost" onClick={fit}>{t('Вписать')}</button><button className="btn ghost square" onClick={arrange} hidden={!canRearrange} disabled={resetBusy || layoutBusy || !canRearrange} title={t(canRearrange ? 'Перестроить карту' : 'Перестроить карту могут Хранитель и Проверенный.')} aria-label={t('Перестроить карту')}><svg className={resetBusy ? 'map-spinning' : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 10a8 8 0 0 0-13.7-3.7L4 8.5M4 14a8 8 0 0 0 13.7 3.7L20 15.5"/><path d="M4 4.5v4h4m12 11v-4h-4"/></svg></button></div></div>
    <div ref={container} id="cy" role="img" aria-label={t('Интерактивная карта порталов. Список порталов доступен рядом.')}/>
    <div className="graph-controls" role="group" aria-label={t('Масштаб карты')}><button className="btn ghost square" onClick={() => zoom(1.3)} aria-label={t('Увеличить карту')}><Plus/></button><button className="btn ghost square" onClick={() => zoom(1 / 1.3)} aria-label={t('Уменьшить карту')}><Minus/></button></div>
    {context && <div id="graph-menu" className="menu" role="menu" style={{ position: 'fixed', left: context.x, top: context.y, right: 'auto', width: 220 }}>
      <button type="button" role="menuitem" onClick={() => { callbacks.current.onSetFrom(context.name); setContext(null); contextRef.current = null; }}>{t('Начало маршрута')}</button>
      <button type="button" role="menuitem" onClick={() => { callbacks.current.onSetTo(context.name); setContext(null); contextRef.current = null; }}>{t('Конец маршрута')}</button>
      <button type="button" role="menuitem" disabled={!canAddStop} onClick={() => { callbacks.current.onAddStop(context.name); setContext(null); contextRef.current = null; }}>{t('Добавить остановку')}</button>
      {portals.filter(edge => edge.a === context.name || edge.b === context.name).flatMap(edge => edge.records.filter(canDeletePortal).map(record => {
        const key = `${record.map.id}:${edge.key}`;
        return <button type="button" role="menuitem" className="danger" key={key} onClick={() => { void callbacks.current.onDeletePortal(edge, record); if (deleteArmed === key) { setContext(null); contextRef.current = null; } }}>{t(deleteArmed === key ? 'Точно удалить портал в {0}?' : 'Удалить портал в {0}', [edge.a === context.name ? edge.b : edge.a])}</button>;
      }))}
    </div>}
    {layoutBusy ? <div className="graph-empty" role="status"><span>{t('Загрузка расположения карты…')}</span></div> : !portals.length && !route?.steps.length && <div className="graph-empty"><p>{t('Здесь появятся твои дороги.')}</p><span>{t('Запиши портал в приложении или открой карту группы.')}</span></div>}
    {layoutError && <div className="graph-layout-error map-notice" role="alert">{layoutError}</div>}
    {layoutNotice && !layoutError && <div className="graph-layout-error map-notice" role="status">{layoutNotice}</div>}
    <div id="graph-hint">{t('колесо — зум · тянуть — панорама · ПКМ по зоне — действия')}</div>
  </>;
}
