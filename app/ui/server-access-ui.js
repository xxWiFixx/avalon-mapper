/* Shared server controls for desktop and web. All permissions are rechecked by SQL. */
(function(root){
  'use strict';
  const roles=[['viewer','Наблюдатель'],['member','Разведчик'],['verified','Проверенный'],['moderator','Модератор'],['admin','Хранитель']];
  const rank=role=>roles.findIndex(item=>item[0]===role);
  const canManage=map=>map.isOwner||['admin','moderator'].includes(map.role);
  const canChange=(map,actor,person,role)=>person.id!==actor&&!person.isOwner&&canManage(map)
    &&(map.isOwner||(rank(person.role)<rank(map.role)&&rank(role)<rank(map.role)));
  const canRemove=(map,actor,person)=>person.id!==actor&&!person.isOwner&&(map.isOwner||(map.role==='admin'&&person.role!=='admin'));
  const escape=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function open({map,accountId,rpc,kind='roles',t=text=>text,isCurrent=()=>true,onChanged=()=>{},host=document.body}){
    if(!canManage(map))return null;
    const dialog=document.createElement('dialog');dialog.className='server-dialog';host.append(dialog);
    let closed=false,busy=false,tab='members',people=[],bans=[],invites=[],fresh=null,error='',notice='',armed='',mode='once',hours=24,showInvites=false;
    const current=()=>!closed&&isCurrent();
    const label=text=>escape(t(text));
    const close=()=>{closed=true;dialog.close();dialog.remove();};
    const member=row=>({id:row.user_id,nick:row.nick||t('игрок'),role:row.role,isOwner:row.is_owner});
    const run=async work=>{if(busy||!current())return;busy=true;error='';notice='';render();try{await work();}catch{if(current())error=t('Не удалось выполнить действие. Проверь соединение и права доступа.');}finally{busy=false;if(current())render();}};
    const reload=async()=>{
      if(kind==='invite'&&showInvites){const rows=await rpc('active_map_invites',{p_map:map.id});if(current())invites=rows||[];}
      else if(kind==='invite')return;
      else if(tab==='bans'){const rows=await rpc('map_bans_list',{p_map:map.id});if(current())bans=rows||[];}
      else {const rows=await rpc('map_members_list',{p_map:map.id});if(current())people=(rows||[]).map(member);}
    };
    function render(){
      const disabled=busy?' disabled':'';
      let body='';
      if(kind==='invite'){
        body='<p class="server-muted">'+label('Новые участники входят наблюдателями. Роль назначает хранитель или модератор.')+'</p>'
          +'<form data-create-invite><label>'+label('Тип приглашения')+'<select name="mode"'+disabled+'>'+[['once','Одноразовое'],['timed','На срок'],['forever','Бессрочное']].map(([v,n])=>'<option value="'+v+'"'+(mode===v?' selected':'')+'>'+label(n)+'</option>').join('')+'</select></label>'
          +(mode==='timed'?'<label>'+label('Срок действия')+'<select name="hours"'+disabled+'>'+[[1,'1 час'],[24,'24 часа'],[168,'7 дней'],[720,'30 дней']].map(([v,n])=>'<option value="'+v+'"'+(hours===v?' selected':'')+'>'+label(n)+'</option>').join('')+'</select></label>':'')
          +'<button class="btn key"'+disabled+'>'+label('Создать приглашение')+'</button></form>'
          +(fresh?'<div class="server-code"><label>'+label('Код приглашения')+'<input readonly value="'+escape(fresh.code)+'" aria-label="'+label('Код приглашения')+'"></label><button class="btn ghost" data-copy'+disabled+'>'+label('Скопировать')+'</button></div>':'')
          +'<p class="server-muted">'+label('После исключения старые приглашения для игрока недействительны. Бан запрещает вход по любому коду.')+'</p>'
          +'<button class="btn ghost" data-active-invites aria-expanded="'+showInvites+'"'+disabled+'>'+label('Активные приглашения')+'</button>'
          +(showInvites?'<div class="server-rows">'+(invites.length?invites.map(i=>
            '<div class="server-row"><div><strong>'+label(i.expires_at?'На срок':'Бессрочное')+'</strong><small>'+(i.expires_at?label('До')+' '+escape(new Date(i.expires_at).toLocaleString()):label('Без срока действия'))+' · '+label('Использований')+': '+i.uses+'</small>'
            +(i.code?'<code class="server-invite-code">'+escape(i.code)+'</code>':'<small>'+label('Этот код создан до обновления. Чтобы видеть его текст, отзови приглашение и создай новое.')+'</small>')+'</div>'
            +(i.code?'<button class="btn ghost" data-copy-invite="'+escape(i.id)+'"'+disabled+'>'+label('Скопировать')+'</button>':'')
            +'<button class="btn ghost" data-revoke="'+escape(i.id)+'"'+disabled+'>'+label('Отозвать')+'</button></div>'
          ).join(''):'<p class="server-muted">'+label('Активных многоразовых приглашений нет.')+'</p>')+'</div>':'');
      }else{
        body='<nav class="server-tabs"><button class="btn ghost" data-tab="members" aria-pressed="'+(tab==='members')+'">'+label('Участники')+'</button>'+(map.isOwner||map.role==='admin'?'<button class="btn ghost" data-tab="bans" aria-pressed="'+(tab==='bans')+'">'+label('Забаненные')+'</button>':'')+'</nav>';
        if(tab==='bans') body+='<div class="server-rows">'+(bans.length?bans.map(p=>'<div class="server-row"><strong>'+escape(p.nick)+'</strong><button class="btn ghost" data-unban="'+escape(p.user_id)+'"'+disabled+'>'+label('Разблокировать')+'</button></div>').join(''):'<p class="server-muted">'+label('Забаненных участников нет.')+'</p>')+'</div>';
        else{
          body+='<p class="server-muted">'+label('Наблюдатель → Разведчик → Проверенный → Модератор → Хранитель. Владелец всегда хранитель; свою роль менять нельзя.')+'</p><div class="server-rows">';
          body+=people.map(p=>'<div class="server-row"><div><strong>'+escape(p.nick)+'</strong><small>'+label(p.isOwner?'Владелец':p.id===accountId?'Это ты':'Участник')+'</small></div><select aria-label="'+label('Роль')+' '+escape(p.nick)+'" data-role-user="'+escape(p.id)+'"'+(busy||!roles.some(([r])=>canChange(map,accountId,p,r))?' disabled':'')+'>'+roles.filter(([r])=>r===p.role||canChange(map,accountId,p,r)).map(([r,n])=>'<option value="'+r+'"'+(r===p.role?' selected':'')+'>'+label(n)+'</option>').join('')+'</select>'+(canRemove(map,accountId,p)?'<div class="server-actions">'+[['kick','Исключить'],['ban','Забанить']].map(([a,n])=>'<button class="btn ghost" data-'+a+'="'+escape(p.id)+'"'+disabled+'>'+label(armed===a+':'+p.id?'Подтвердить':n)+'</button>').join('')+'</div>':'')+'</div>').join('');
          body+='</div>';
          if(map.isOwner||map.role==='admin')body+='<form data-policy class="server-policy"><label>'+label('Подтверждений для разведчика (0 — сразу)')+'<input name="need" type="number" min="0" max="10" value="'+(Number(map.confirmRequired)||0)+'"'+disabled+'></label><button class="btn ghost"'+disabled+'>'+label('Применить')+'</button></form>';
        }
      }
      dialog.innerHTML='<header><div><small>'+escape(map.title)+'</small><h2>'+label(kind==='invite'?'Пригласить участников':'Участники и роли')+'</h2></div><button class="btn ghost" data-close aria-label="'+label('Закрыть')+'">×</button></header><div class="server-dialog-body">'+body+'<p class="server-error" role="alert">'+escape(error)+'</p><p class="server-muted" role="status">'+escape(busy?t('Загрузка…'):notice)+'</p></div>';
    }
    dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
    dialog.addEventListener('change',e=>{
      if(e.target.name==='mode'){mode=e.target.value;render();}
      if(e.target.name==='hours')hours=Number(e.target.value);
      if(e.target.dataset.roleUser){const id=e.target.dataset.roleUser,role=e.target.value,p=people.find(p=>p.id===id);if(!p||!canChange(map,accountId,p,role))return render();void run(async()=>{await rpc('set_member_role',{p_map:map.id,p_user:id,p_role:role});if(current()){await reload();await onChanged();}});}
    });
    dialog.addEventListener('submit',e=>{e.preventDefault();if(e.target.hasAttribute('data-create-invite'))void run(async()=>{const value=await rpc('create_map_invite',{p_map:map.id,p_mode:mode,p_hours:hours});if(current()){fresh=value;await reload();}});
      if(e.target.hasAttribute('data-policy')){const need=Number(new FormData(e.target).get('need'));void run(async()=>{await rpc('set_map_policy',{p_map:map.id,p_confirm:need});if(current()){map.confirmRequired=need;await onChanged();notice=t('Сохранено');}});}});
    dialog.addEventListener('click',e=>{
      if(e.target===dialog||e.target.closest('[data-close]'))return close();
      const b=e.target.closest('button');if(!b||busy)return;
      if(b.hasAttribute('data-active-invites')){showInvites=!showInvites;void run(reload);}
      if(b.dataset.copyInvite){const i=invites.find(i=>i.id===b.dataset.copyInvite);if(i?.code)void run(async()=>{await navigator.clipboard.writeText(i.code);notice=t('Код скопирован');});}
      if(b.dataset.tab){tab=b.dataset.tab;void run(reload);}
      if(b.hasAttribute('data-copy')&&fresh)void run(async()=>{await navigator.clipboard.writeText(fresh.code);notice=t('Код скопирован');});
      if(b.dataset.revoke)void run(async()=>{await rpc('revoke_map_invite',{p_map:map.id,p_invite:b.dataset.revoke});if(current()){if(fresh?.id===b.dataset.revoke)fresh=null;await reload();}});
      if(b.dataset.unban)void run(async()=>{await rpc('unban_member',{p_map:map.id,p_user:b.dataset.unban});if(current())await reload();});
      for(const action of ['kick','ban'])if(b.dataset[action]){
        const id=b.dataset[action],p=people.find(p=>p.id===id);if(!p||!canRemove(map,accountId,p))return;
        if(armed!==action+':'+id){armed=action+':'+id;return render();}
        void run(async()=>{await rpc(action==='kick'?'kick_member':'ban_member',{p_map:map.id,p_user:id});if(current()){armed='';await reload();await onChanged();}});
      }
    });
    render();dialog.showModal();if(kind!=='invite')void run(reload);return {close};
  }
  root.AvalonServerAccess={open,roles,rank,canManage,canChange,canRemove};
  if(typeof module!=='undefined')module.exports=root.AvalonServerAccess;
})(globalThis);
