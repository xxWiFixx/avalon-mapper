import React, { useEffect, useRef, useState } from 'react';
import { MapTrifold, SlidersHorizontal, X } from '@phosphor-icons/react';
import { useLanguage } from '../localization.jsx';
import { siteHref } from './config.js';
import '../../../app/assets/fonts/fonts.css';
import './generated/app-interface.css';
import '../../../app/ui/route-panel.css';
import '../../../app/ui/scout.css';
import './maps.css';
import '../../../app/ui/surface-motion.css';

export default function MapShell({ children, view = 'map', rightOpen = true, routePlacement = 'bottom', onSubscription = null }) {
  const { t, language, changeLanguage } = useLanguage();
  const [settings, setSettings] = useState(false);
  const dialog = useRef(null), shell = useRef(null);
  useEffect(() => {
    if (settings) dialog.current.showModal();
    else if (dialog.current.open) dialog.current.close();
  }, [settings]);
  useEffect(() => {
    const toolbar = shell.current?.querySelector('#graph-tools'), route = shell.current?.querySelector('#route-block');
    if (!toolbar || !route) return;
    const measure = () => {
      shell.current.style.setProperty('--workspace-toolbar-height', `${toolbar.offsetHeight}px`);
      shell.current.style.setProperty('--route-panel-height', `${route.offsetHeight}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar); observer.observe(route); measure();
    return () => observer.disconnect();
  }, [children]);
  return <div ref={shell} className={`mapper-web mapper-app ${rightOpen ? '' : 'no-card'}`} data-theme="site" data-mobile-view={view} data-route-placement={routePlacement}>
    <header className="app-header">
      <a className="app-brand" href={siteHref('', language)} aria-label={t('Avalon Mapper — начало страницы')}><span className="brand-mark"><img src={siteHref('assets/icon.png')} alt=""/></span><b>Avalon <span>Mapper</span></b></a>
      <nav className="app-tabs" aria-label={t('Основная навигация')}><a className="app-tab" href="#graph" aria-current="page" aria-selected="true"><MapTrifold/>{t('Карта')}</a></nav>
      <div className="map-header-actions"><div className="map-language" role="group" aria-label={t('Выбрать язык')}>{['ru', 'en'].map(value => <button key={value} lang={value} aria-pressed={language === value} onClick={() => changeLanguage(value)}>{value.toUpperCase()}</button>)}</div><button className="btn ghost app-settings" onClick={() => setSettings(true)} aria-label={t('Настройки')}><SlidersHorizontal/><span>{t('Настройки')}</span></button></div>
    </header>
    {children}
    <dialog ref={dialog} className="map-settings-dialog settings-solid" onCancel={event => { event.preventDefault(); setSettings(false); }} onClick={event => { if (event.target === dialog.current) setSettings(false); }}>
      <div className="map-dialog-heading"><h2>{t('Настройки')}</h2><button className="btn ghost square" onClick={() => setSettings(false)} aria-label={t('Закрыть')}><X/></button></div>
      {onSubscription && <div className="block"><button type="button" className="btn ghost" onClick={() => { setSettings(false); onSubscription(); }}>{t('Мои сервера')}</button></div>}
      <div className="block small muted">{t('Записи из приложения обновляются автоматически. Истёкшие порталы исчезают с карты.')}</div>
      <div className="block"><a className="btn ghost" href={siteHref('', language)}>{t('На сайт')}</a></div>
    </dialog>
  </div>;
}
