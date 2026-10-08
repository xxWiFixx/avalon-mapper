import React, { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../localization.jsx';

const roles = [
  { id: 'viewer', name: 'Наблюдатель', sub: 'только смотрит карту' },
  { id: 'member', name: 'Разведчик', sub: 'смотрит и добавляет порталы' },
  { id: 'verified', name: 'Проверенный', sub: 'добавляет без подтверждений' },
  { id: 'admin', name: 'Хранитель', sub: 'роли, удаление, порог' },
];

export default function GroupMembersDialog({ map, rpc, onClose, onChanged }) {
  const { t } = useLanguage();
  const dialog = useRef(null);
  const [members, setMembers] = useState([]);
  const [need, setNeed] = useState(Number(map.confirmRequired) || 0);
  const [draftNeed, setDraftNeed] = useState(Math.max(1, Number(map.confirmRequired) || 3));
  const [selected, setSelected] = useState(null);
  const [armed, setArmed] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => { if (dialog.current?.open) dialog.current.close(); }; }, []);
  useEffect(() => {
    let active = true;
    rpc('map_members_list', { p_map: map.id }).then(rows => {
      if (!active) return;
      setMembers((Array.isArray(rows) ? rows : []).map(row => ({ id: String(row.user_id), nick: row.nick || t('игрок'), role: row.role || 'viewer', isOwner: !!row.is_owner })));
    }).catch(() => { if (active) setError(t('Не удалось получить список участников.')); });
    return () => { active = false; };
  }, [map.id, rpc, t]);
  const reload = async () => {
    const rows = await rpc('map_members_list', { p_map: map.id });
    setMembers((Array.isArray(rows) ? rows : []).map(row => ({ id: String(row.user_id), nick: row.nick || t('игрок'), role: row.role || 'viewer', isOwner: !!row.is_owner })));
  };
  async function changeRole(userId, role) {
    const member = members.find(item => item.id === userId);
    if (!member || member.isOwner || member.role === role || busy) return;
    if (!map.isOwner && (member.role === 'admin' || role === 'admin')) { setError(t('Назначать и снимать хранителей может только владелец карты.')); return; }
    setBusy(true); setError('');
    try { await rpc('set_member_role', { p_map: map.id, p_user: userId, p_role: role }); await reload(); setSelected(null); }
    catch { setError(t('Не удалось изменить роль. Проверь права доступа.')); }
    finally { setBusy(false); }
  }
  async function kick(userId) {
    if (armed !== userId) { setArmed(userId); return; }
    setBusy(true); setError('');
    try { await rpc('kick_member', { p_map: map.id, p_user: userId }); await reload(); setArmed(null); setSelected(null); }
    catch { setError(t('Не удалось исключить участника. Проверь права доступа.')); }
    finally { setBusy(false); }
  }
  async function savePolicy(value) {
    const next = Math.max(0, Math.min(10, Math.round(Number(value) || 0)));
    setBusy(true); setError('');
    try { const answer = await rpc('set_map_policy', { p_map: map.id, p_confirm: next }); setNeed(Number(Array.isArray(answer) ? answer[0] : answer) || 0); await onChanged(); }
    catch { setError(t('Не удалось изменить порог подтверждений.')); }
    finally { setBusy(false); }
  }
  const columns = roles.filter(role => need > 0 || role.id !== 'verified');
  return <dialog ref={dialog} className="map-settings-dialog map-roles-dialog" aria-label={t('Участники карты')} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="map-dialog-heading"><h2>{t('Участники')} · {map.title || t('Карта группы')}</h2><button type="button" className="btn ghost square" aria-label={t('Закрыть')} onClick={onClose}>×</button></div>
    <div className="roles-policy"><label className="roles-toggle"><input type="checkbox" checked={need > 0} disabled={busy} onChange={event => void savePolicy(event.target.checked ? draftNeed : 0)}/><span>{t('Проверенные участники')}</span></label><p className="small muted">{need > 0 ? t('Порталам разведчиков нужно {0} подтверждений.', [need]) : t('Разведчики добавляют порталы без подтверждений.')}</p>{need > 0 && <div className="roles-need"><label htmlFor="roles-need-input">{t('Подтверждений на портал')}</label><input id="roles-need-input" type="number" min="1" max="10" value={draftNeed} onChange={event => setDraftNeed(event.target.value)}/><button type="button" className="btn ghost" disabled={busy} onClick={() => void savePolicy(draftNeed)}>{t('Применить')}</button></div>}</div>
    {error && <p className="map-notice" role="alert">{error}</p>}
    <div className="roles-cols" style={{ '--cols': columns.length }}>{columns.map(role => <section className={`rcol ${selected ? 'can-drop' : ''}`} key={role.id} data-role={role.id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); if (id) void changeRole(id, role.id); }}>
      <div className="rcol-h"><b>{t(role.name)}</b><i>{t(role.sub)}</i>{selected && <button type="button" className="roles-place" disabled={busy} onClick={() => void changeRole(selected, role.id)}>{t('Переместить сюда')}</button>}</div>
      <div className="rcol-b">{members.filter(member => member.role === role.id || (need === 0 && role.id === 'member' && member.role === 'verified')).map(member => <div className={`rchip ${member.isOwner ? 'owner' : ''} ${selected === member.id ? 'picked' : ''}`} key={member.id} draggable={!member.isOwner} onDragStart={event => event.dataTransfer.setData('text/plain', member.id)}><button type="button" className="rchip-n" disabled={member.isOwner || busy} aria-pressed={selected === member.id} onClick={() => setSelected(value => value === member.id ? null : member.id)}>{member.nick}</button>{member.isOwner ? <i className="rchip-o">{t('владелец')}</i> : <button type="button" className="rchip-x" data-armed={armed === member.id ? '1' : '0'} disabled={busy} aria-label={t(armed === member.id ? 'Подтвердить исключение {0}' : 'Выгнать {0} из карты', [member.nick])} onClick={() => void kick(member.id)}>{armed === member.id ? '?' : '×'}</button>}</div>)}{!members.some(member => member.role === role.id || (need === 0 && role.id === 'member' && member.role === 'verified')) && <div className="rcol-empty">{t('пусто')}</div>}</div>
    </section>)}</div>
    <p className="small muted roles-hint">{t('Выбери участника и роль или перетащи его в другую колонку. Крестик исключает из карты.')}</p>
  </dialog>;
}
