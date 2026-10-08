import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useLanguage} from '../localization.jsx';
import {createBillingActions} from './billing-actions.js';
import '../../../app/ui/server-term.js';
import ServerHelp from './ServerHelp.jsx';

const errors={
  invalid_code:'Код недействителен или уже использован.',
  code_rate_limited:'Слишком много попыток. Попробуй позже.',
  map_owner_required:'Продлить подписку может только владелец сервера.',
  group_permanent:'Этот сервер бесплатный навсегда. Код не требуется.',
  discord_required:'Для подписки войди через Discord.',
  account_changed:'Аккаунт изменился. Открой подписку заново.',
  request_in_progress:'Дождись завершения активации.',
};
export default function SubscriptionDialog({accountId,mapId=null,rpc,onClose,onChanged}) {
  const {t,language}=useLanguage(),dialog=useRef(null),identity=useRef(accountId),alive=useRef(true),submitted=useRef(false);
  const [status,setStatus]=useState(null),[target,setTarget]=useState(mapId||''),[code,setCode]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[clock,setClock]=useState(Date.now),[checkedAt,setCheckedAt]=useState(Date.now);
  identity.current=accountId;
  const actions=useMemo(()=>createBillingActions({rpc,getAccountId:()=>alive.current?identity.current:null}),[rpc]);
  useEffect(()=>{alive.current=true;dialog.current?.showModal();return()=>{alive.current=false;identity.current=null;};},[]);
  const accept=value=>{setStatus(value);setCheckedAt(Date.now());setClock(Date.now());};
  const fail=e=>setError(t(errors[e.message]||'Не удалось проверить или активировать подписку. Проверь соединение и повтори попытку.'));
  useEffect(()=>{
    let active=true;setLoading(true);setStatus(null);setCode('');setError('');setNotice('');
    actions.status().then(value=>{if(active)accept(value);}).catch(e=>{if(active)fail(e);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[accountId,actions]);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),30000);return()=>clearInterval(timer);},[]);
  const groups=(status?.groups||[]).filter(group=>group.isOwner===true),owned=groups.filter(group=>group.isOwner===true),group=groups.find(item=>item.mapId===target);
  const permanent=!!group?.permanent,canRedeem=!!target&&owned.some(item=>item.mapId===target);
  const license=(status?.licenses||[]).filter(item=>!item.revoked&&item.mapId===target).sort((a,b)=>Date.parse(b.expiresAt)-Date.parse(a.expiresAt))[0];
  const expiry=group?.expiresAt||license?.expiresAt;
  const now=Number.isFinite(Date.parse(status?.serverTime))?Date.parse(status.serverTime)+Math.max(0,clock-checkedAt):clock;
  const remaining=expiry?Math.max(0,Date.parse(expiry)-now):0;
  const duration=globalThis.AvalonServerTerm.term(expiry,now,language);
  async function refresh(){setLoading(true);setError('');try{const value=await actions.status();if(alive.current)accept(value);}catch(e){if(alive.current)fail(e);}finally{if(alive.current)setLoading(false);}}
  async function redeem(event){
    event.preventDefault();if(submitted.current||!canRedeem||permanent)return;
    submitted.current=true;setBusy(true);setError('');setNotice('');
    const requestedAccount=accountId;
    try{
      const result=await actions.redeem(code,target||null);
      if(!alive.current||identity.current!==requestedAccount)return;
      accept(result.status);setCode('');setNotice(t(result.alreadyRedeemed?'Этот код уже активирован на твоём аккаунте.':'Код активирован. Подписка обновлена.'));
      await onChanged?.();
    }catch(e){if(alive.current&&identity.current===requestedAccount)fail(e);}
    finally{submitted.current=false;if(alive.current&&identity.current===requestedAccount)setBusy(false);}
  }
  return <dialog ref={dialog} className="map-settings-dialog map-subscription-dialog settings-solid" aria-label={t('Мои сервера')} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===dialog.current)onClose();}}>
    <div className="map-dialog-heading"><h2>{t('Мои сервера')}</h2><button type="button" className="btn ghost square" aria-label={t('Закрыть')} onClick={onClose}>×</button></div>
    <p className="small muted">{t('Один код — один сервер на 30 дней. Участники подключаются бесплатно.')}</p>
    <label className="label" htmlFor="subscription-target">{t('Сервер')}</label>
    <select id="subscription-target" value={target} disabled={busy||loading} onChange={event=>{setTarget(event.target.value);setError('');setNotice('');setCode('');}}>
      <option value="">{t('Все сервера')}</option>
      {groups.map(item=><option key={item.mapId} value={item.mapId}>{item.title||t('Сервер группы')}</option>)}
    </select>
    <div className="map-subscription-status" aria-live="polite">
      {loading?<p>{t('Проверяем подписку…')}</p>:permanent?<p><strong>{t('Бесплатно навсегда')}</strong></p>:target?<p>{expiry?<><strong>{t(remaining>0?'Осталось {0}':'Подписка завершена',[duration])}</strong><span>{t('Действует до {0}',[new Date(expiry).toLocaleString(language==='en'?'en-US':'ru-RU')])}</span></>:t('Код для этого сервера пока не активирован.')}</p>:<p>{t(groups.length?'Здесь только серверы, которые ты создал.':'Создай свой сервер через «+» слева.')}</p>}
      {!target&&!loading&&<div className="subscription-groups">{groups.map(item=><div className="subscription-group" key={item.mapId}><strong>{item.title||t('Сервер группы')}</strong><span>{item.permanent?t('Бесплатно навсегда'):globalThis.AvalonServerTerm.term(item.expiresAt,now,language)}</span><small>{t(item.isOwner?'Ты владелец':'Ты участник')}</small>{item.isOwner&&!item.permanent&&<button className="btn ghost" type="button" onClick={()=>{setTarget(item.mapId);setCode('');setError('');setNotice('');}}>{t('Продлить кодом')}</button>}</div>)}{!groups.length&&<p>{t('У тебя пока нет серверов')}</p>}</div>}
    </div>
    {!permanent&&canRedeem?<form className="map-join" onSubmit={redeem}><label className="label" htmlFor="subscription-code">{t('Код активации')}</label><input id="subscription-code" value={code} onChange={event=>setCode(event.target.value)} maxLength={128} autoComplete="off" autoCapitalize="characters" spellCheck="false" disabled={busy||loading} required placeholder="AM30-…"/><button className="btn key" disabled={busy||loading||!code.trim()||!status?.codeRedemptionReady}>{t(busy?'Активация…':target?'Продлить на 30 дней':'Активировать код')}</button><p className="small muted">{t('Продление добавляет 30 дней к оставшемуся сроку. После окончания подписки роли и участники сохраняются минимум 120 дней.')}</p></form>:!!target&&!permanent&&<p className="small muted">{t('Продлить подписку может только владелец сервера.')}</p>}
    {!loading&&status&&!status.codeRedemptionReady&&<p className="map-notice">{t('Активация кодов ещё не включена на сервере.')}</p>}
    {notice&&<p role="status">{notice}</p>}{error&&<p className="map-notice" role="alert">{error}</p>}
    <button className="btn ghost" type="button" onClick={()=>void refresh()} disabled={busy||loading}>{t('Обновить статус')}</button>
    <ServerHelp/>
  </dialog>;
}
