import React from 'react';
import { useLanguage } from '../localization.jsx';
import { timeLeft } from './PortalGraph.jsx';
import { routeMarkerColor } from './route-colors.js';

export default function RoutePanel({ from, to, setFrom, setTo, stops, setStops, portalCity, setPortalCity, onRequest, request, route, onClear, onImage, onSelectZone, selectedZone, ready, loadError, onRetry, now, zoneNames, zones }) {
  const { t } = useLanguage();
  const markerColor = name => routeMarkerColor(zones, name, window.ZONE_COLORS);
  const submit = (event, mode = 'path') => { event?.preventDefault(); onRequest(mode); };
  const clear = () => { setFrom(''); setTo(''); setStops([]); onClear(); };
  const changeStops = next => { setStops(next); onClear(); };
  return <form id="route-body" onSubmit={submit}>
    <div className="route-journey">
      <div className="route-field route-start"><label htmlFor="route-from-input">{t('Откуда')}</label><div className="ac-wrap"><input id="route-from-input" placeholder={t('Название зоны')} list="route-zone-names" value={from} onChange={event => { setFrom(event.target.value); onClear(); }} autoComplete="off"/></div></div>
      <div id="route-waypoints" className="scout-waypoints">{stops.map((stop, index) => <div className="scout-waypoint" key={stop.id}>
        <div className="route-field"><label htmlFor={`route-stop-${stop.id}`}>{t('Остановка {0}', [index + 1])}</label><div className="ac-wrap"><input id={`route-stop-${stop.id}`} list="route-zone-names" placeholder={t('Название зоны')} value={stop.name} onChange={event => changeStops(stops.map(item => item.id === stop.id ? { ...item, name: event.target.value } : item))} autoComplete="off"/></div></div>
        <div className="scout-waypoint-actions"><button className="btn" type="button" disabled={index === 0} title={t('Выше в маршруте')} aria-label={t('Выше в маршруте')} onClick={() => { const next = [...stops]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; changeStops(next); }}>↑</button><button className="btn" type="button" title={t('Убрать промежуточную зону')} aria-label={t('Убрать промежуточную зону')} onClick={() => changeStops(stops.filter(item => item.id !== stop.id))}>×</button></div>
      </div>)}<button className="route-add-stop" type="button" disabled={stops.length >= 6} title={t('До шести остановок, в указанном порядке')} onClick={() => changeStops([...stops, { id: crypto.randomUUID(), name: '' }])}>{t('+ Остановка')}</button></div>
      <div className="route-field route-destination"><label htmlFor="route-to">{t('Куда')}</label><div className="ac-wrap"><input id="route-to" placeholder={t('Название или часть названия')} list="route-zone-names" value={to} onChange={event => { setTo(event.target.value); onClear(); }} autoComplete="off"/></div></div>
      <datalist id="route-zone-names">{zoneNames.map(name => <option value={name} key={name}/>)}</datalist>
    </div>
    <div id="route-from" className="route-origin-actions"><button className="btn ghost" type="button" disabled={!selectedZone || from === selectedZone} title={selectedZone || t('Выбери зону на карте')} onClick={() => { setFrom(selectedZone); onClear(); }}>{t('Выбранная зона')}</button><button className={`btn ghost ${!from.trim() ? 'origin-selected' : ''}`} type="button" aria-pressed={!from.trim()} onClick={() => { setFrom(''); onClear(); document.getElementById('route-to')?.focus(); }}>{t('Из любого города')}</button></div>
    <div className="route-search-actions"><button id="route-go" className="btn key" disabled={!ready || !to.trim()}>{t('Найти путь')}</button><button id="route-exit" className="btn ghost" type="button" disabled={!ready || !from.trim()} onClick={() => submit(null, 'exit')}>{t('Найти безопасную зону')}</button><button id="route-clear" className="btn ghost" type="button" onClick={clear}>{t('Сбросить')}</button></div>
    <div id="route-out" className="route-out small muted" role="status">
      {!ready ? loadError ? <><p>{t('Не удалось загрузить справочник маршрутов.')}</p><button className="btn ghost" type="button" onClick={onRetry}>{t('Повторить')}</button></> : t('Загрузка справочника маршрутов…') : !request ? t('введи зону назначения и нажми «Найти путь»') : !route?.found ? route?.reason : <>
        <div className="route-title">{route.from} → {route.to}</div>
        {!route.steps.length && <p>{t('Ты уже в нужной зоне.')}</p>}
        <ol className="route-steps"><li className="rs start" style={{ '--zc': markerColor(route.from), '--i': 0 }}><span className="rs-kind">{t('Начало')}</span><button className="rz" type="button" onClick={() => onSelectZone(route.from)}>{route.from}</button></li>{route.steps.map((step, index) => <li className={`rs ${step.kind === 'walk' ? 'walk' : ''} ${index === route.steps.length - 1 ? 'last' : ''}`} key={`${index}:${step.to}`} style={{ '--zc': markerColor(step.to), '--i': index + 1 }}><span className="rs-kind">{t(step.source === 'realmgate' ? 'Городской портал' : step.kind === 'walk' ? 'Пешком' : step.kind === 'exit' ? 'Выход' : 'Портал')}</span><button className="rz" type="button" onClick={() => onSelectZone(step.to)}>{step.to}</button><span className="rs-meta">{step.expiresAt && <time className={step.risky ? 'soon' : ''}>{timeLeft(step.expiresAt, now, t)}</time>}{step.capMax && <> · {t('на {0}', [step.capMax])}</>}</span></li>)}</ol>
        <div className="route-sum"><span className="rs-stat">{t('Переходов')} <b>{route.hops}</b></span><span className="rs-stat">{t('В пути примерно')} <b>{t('{0}м', [Math.ceil(route.etaSec / 60)])}</b></span></div>
        {route.risky && <p className="route-risky">{t('Некоторые порталы скоро закроются. Не задерживайся в пути.')}</p>}
        {route.provisionalExit && <p className="route-uncertain">{route.reason}</p>}
      </>}
    </div>
    <div className="route-tools"><details className="route-options"><summary>{t('Привязанный портал чёрных земель')}: {portalCity || t('Не выбран')} · {t('Изменить')}</summary><label className="route-portal-setting" htmlFor="route-portal-city"><span>{t('Город привязки')}</span><select id="route-portal-city" value={portalCity} onChange={event => { setPortalCity(event.target.value); onClear(); }}><option value="">{t('Не выбран')}</option>{['Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford'].map(city => <option key={city}>{city}</option>)}</select></label><div className="route-portal-note small muted">{t('Ограничивает выход из города в чёрные земли. Вернуться можно через любой портал.')}</div></details></div>
    {route?.found && <div className="route-result-actions"><button type="button" className="btn ghost" onClick={onImage}>{t('Картинка')}</button></div>}
  </form>;
}
