import React, { useState } from 'react';
import { useLanguage } from '../localization.jsx';

const types = [['ore', 'Руда'], ['blue', 'Синие сундуки'], ['gold', 'Золотые сундуки'], ['green', 'Зелёные сундуки'],
  ['fiber', 'Волокно'], ['hide', 'Шкуры'], ['wood', 'Дерево'], ['rock', 'Камень'],
  ['any-resource', 'Любой ресурс'], ['any-chest', 'Любые сундуки']];
const firstGoal = () => ({ type: 'ore', tier: 0, id: crypto.randomUUID() });

export default function ScoutPanel({ goals, setGoals, match, setMatch, enabled, setEnabled, count }) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem('web-scout-open') === 'true'; } catch { return false; } });
  const toggle = () => setExpanded(value => { try { localStorage.setItem('web-scout-open', String(!value)); } catch { /* private mode */ } return !value; });
  const update = (id, patch) => { setGoals(current => current.map(goal => goal.id === id ? { ...goal, ...patch } : goal)); setEnabled(true); };
  return <section className={`block scout-panel ${enabled ? 'scout-active' : ''}`} aria-label={t('Ресурсы и сундуки')}>
    <button className="scout-heading" type="button" aria-controls="web-scout-body" aria-expanded={expanded} onClick={toggle}>
      <span className="scout-heading-text"><span className="scout-title">{t('Ресурсы и сундуки')}</span><span className="scout-status">{t(enabled ? count ? 'Подсвечено зон: {0}' : 'Подходящих зон на этой карте нет.' : 'Подсветка выключена.', [count])}</span></span>
      <svg className="fold-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4"/></svg>
    </button>
    <div id="web-scout-body" className="scout-body" hidden={!expanded}>
      <label className="scout-check"><span>{t('Подсветка на карте')}</span><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)}/></label>
      <div className="scout-goals">{goals.map(goal => <div className="scout-goal" key={goal.id}>
        <label className="scout-field"><span>{t('Содержимое')}</span><select className="scout-kind" value={goal.type} onChange={event => update(goal.id, { type: event.target.value })}>{types.map(([value, name]) => <option value={value} key={value}>{t(name)}</option>)}</select></label>
        <label className="scout-field"><span>{t('Тир')}</span><select className="scout-tier" value={goal.tier} onChange={event => update(goal.id, { tier: Number(event.target.value) })}><option value={0}>{t('Все')}</option>{[4, 5, 6, 7, 8].map(value => <option key={value} value={value}>T{value}</option>)}</select></label>
        <button type="button" className="scout-remove" hidden={goals.length === 1} aria-label={t('Убрать цель')} onClick={() => { setGoals(current => current.filter(item => item.id !== goal.id)); setEnabled(true); }}>×</button>
      </div>)}</div>
      <button className="scout-add" type="button" disabled={goals.length >= 4} onClick={() => { setGoals(current => [...current, firstGoal()]); setEnabled(true); }}>{t('+ Добавить условие')}</button>
      <div className="scout-filters"><label className="scout-field"><span>{t('Показывать зоны')}</span><select value={match} onChange={event => { setMatch(event.target.value); setEnabled(true); }}><option value="any">{t('Хотя бы одна цель')}</option><option value="all">{t('Все цели в одной зоне')}</option></select></label></div>
      <div className="scout-footer"><button className="scout-clear" type="button" disabled={!enabled} onClick={() => setEnabled(false)}>{t('Сбросить')}</button></div>
    </div>
  </section>;
}

export { firstGoal };
