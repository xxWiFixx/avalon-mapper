import React from 'react';
import { ArrowDown } from '@phosphor-icons/react';
import { useLanguage } from './localization.jsx';
import { AccountLink } from './cloud/AuthProvider.jsx';
import { siteHref } from './cloud/config.js';

export default function Header() {
  const { t, language, changeLanguage } = useLanguage();
  return <header className="header">
    <div className="wrap flex min-h-[72px] items-center justify-between gap-5">
      <a href={siteHref('') + '#top'} className="brand flex items-center gap-2.5" aria-label={t('Avalon Mapper — начало страницы')}><img src={siteHref('assets/icon.png')} alt="" width="28" height="28"/><span>Avalon <span className="font-normal text-muted">Mapper</span></span></a>
      <nav aria-label={t('Основная навигация')} className="flex items-center gap-7 text-[13px]">
        <a className="quiet-link hidden md:inline-flex" href={siteHref('') + '#capture'}>{t('Возможности')}</a>
        <a className="quiet-link hidden md:inline-flex" href={siteHref('') + '#together'}>{t('Для группы')}</a>
        <a className="quiet-link hidden md:inline-flex" href={siteHref('') + '#pricing'}>{t('Стоимость сервера')}</a>
        <div className="language-switch" role="group" aria-label={t('Выбрать язык')}>
          {['ru', 'en'].map(value => <button key={value} type="button" lang={value} aria-pressed={language === value} onClick={() => changeLanguage(value)}>{value.toUpperCase()}</button>)}
        </div>
        <AccountLink/>
        <a className="header-download" href="https://github.com/xxWiFixx/avalon-mapper/releases/latest">{t('Скачать')}{' '}<ArrowDown size={14}/></a>
      </nav>
    </div>
  </header>;
}
