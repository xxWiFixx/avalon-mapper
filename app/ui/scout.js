// Content filters stay independent of the route; ordered waypoints use its output/guide.
(()=>{
  const t=(ru,en)=>globalThis.AvalonI18n?.language==='en'?en:ru;
  const api=()=>ipc||window.scoutDemoApi;
  const types=[['ore','Руда','Ore'],['blue','Синие сундуки','Blue chests'],['gold','Золотые сундуки','Gold chests'],
    ['green','Зелёные сундуки','Green chests'],['fiber','Волокно','Fiber'],['hide','Шкуры','Hide'],['wood','Дерево','Wood'],['rock','Камень','Stone'],
    ['any-resource','Любой ресурс','Any resource'],['any-chest','Любые сундуки','Any chest']];
  const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
  const button=(text,fn)=>{const b=make('button','btn',text);b.type='button';b.onclick=fn;return b;};
  const select=(values,label)=>{const el=make('select');el.setAttribute('aria-label',label);for(const[value,text]of values){const o=make('option',null,text);o.value=value;el.append(o);}return el;};
  const panel=make('section','block scout-panel');panel.id='scout-panel';
  panel.setAttribute('aria-label',t('Ресурсы и сундуки','Resources & chests'));
  document.getElementById('log').closest('.block').after(panel);
  const heading=button('',()=>setOpen(heading.getAttribute('aria-expanded')!=='true'));
  heading.className='scout-heading';heading.setAttribute('aria-controls','scout-body');heading.setAttribute('aria-label',t('Ресурсы и сундуки','Resources & chests'));
  const headingText=make('span','scout-heading-text');
  const status=make('span','scout-status');status.setAttribute('aria-live','polite');
  headingText.append(make('span','scout-title',t('Ресурсы и сундуки','Resources & chests')),status);
  const chevron=document.createElementNS('http://www.w3.org/2000/svg','svg');
  chevron.setAttribute('viewBox','0 0 12 12');chevron.setAttribute('aria-hidden','true');chevron.classList.add('fold-chev');
  const chevronPath=document.createElementNS('http://www.w3.org/2000/svg','path');chevronPath.setAttribute('d','M2 4l4 4 4-4');chevron.append(chevronPath);
  heading.append(headingText,chevron);
  const body=make('div','scout-body');body.id='scout-body';panel.append(heading,body);
  function setOpen(open){
    heading.setAttribute('aria-expanded',String(open));body.hidden=!open;
    try{localStorage.setItem('scout-panel-open',String(open));}catch{}
  }
  let initialOpen=false;try{initialOpen=localStorage.getItem('scout-panel-open')==='true';}catch{}
  setOpen(initialOpen);
  const highlight=window.SCOUT_HIGHLIGHT.create(cy);
  const enabled=make('input');enabled.type='checkbox';enabled.id='scout-enabled';
  const enableLabel=make('label','scout-check');enableLabel.append(make('span',null,t('Подсветка на карте','Map highlight')),enabled);body.append(enableLabel);
  const rows=make('div','scout-goals');body.append(rows);
  const goalsChanged=()=>{enabled.checked=true;refresh();};
  function addGoal(){
    if(rows.children.length>=4)return;
    const row=make('div','scout-goal');
    const kind=select(types.map(([id,ru,en])=>[id,t(ru,en)]),t('Содержимое','Content'));
    const tier=select([['0',t('Все','Any')],...[4,5,6,7,8].map(n=>[String(n),'T'+n])],t('Тир зоны','Zone tier'));
    kind.className='scout-kind';tier.className='scout-tier';
    const kindField=make('label','scout-field'),tierField=make('label','scout-field');
    kindField.append(make('span',null,t('Содержимое','Content')),kind);
    tierField.append(make('span',null,t('Тир','Tier')),tier);
    const remove=button('×',()=>{row.remove();if(!rows.children.length)addGoal();updateGoals();goalsChanged();});remove.className='scout-remove';remove.setAttribute('aria-label',t('Убрать цель','Remove goal'));remove.title=t('Убрать цель','Remove goal');
    row.append(kindField,tierField,remove);rows.append(row);kind.onchange=tier.onchange=goalsChanged;updateGoals();
  }
  const goals=()=>[...rows.children].map(row=>({type:row.querySelector('.scout-kind').value,tier:Number(row.querySelector('.scout-tier').value)}));
  const add=button(t('+ Добавить условие','+ Add condition'),()=>{addGoal();goalsChanged();});add.className='scout-add';body.append(add);
  function updateGoals(){
    add.disabled=rows.children.length>=4;
    for(const row of rows.children)row.querySelector('.scout-remove').hidden=rows.children.length===1;
  }
  const filters=make('div','scout-filters');
  const match=select([['any',t('Хотя бы одна цель','Any selected target')],['all',t('Все цели в одной зоне','All targets in one zone')]],t('Совпадения','Match'));
  const matchField=make('label','scout-field');matchField.append(make('span',null,t('Показывать зоны','Show zones')),match);filters.append(matchField);body.append(filters);
  const clear=button(t('Сбросить','Reset'),()=>{enabled.checked=false;refresh();});clear.className='scout-clear';clear.disabled=true;clear.setAttribute('aria-label',t('Сбросить подсветку','Clear highlight'));
  const footer=make('div','scout-footer');footer.append(clear);body.append(footer);
  let serial=0,refreshTimer,paintedScope=null;
  const idle=()=>t('Подсветка выключена.','Highlight is off.');
  async function refresh(){
    const request=++serial,scope=chanView;
    panel.classList.toggle('scout-active',enabled.checked);clear.disabled=!enabled.checked;
    if(!enabled.checked){highlight.clear();status.textContent=idle();return;}
    if(scope!==paintedScope)highlight.clear();
    status.textContent=t('Поиск…','Searching…');
    if(!api()?.searchContent){highlight.clear();status.textContent=t('Поиск доступен внутри приложения.','Search is available in the app.');return;}
    try{
      const data=await api().searchContent({scope,goals:goals(),match:match.value,includeClosed:false});
      if(request!==serial||scope!==chanView||!enabled.checked)return;
      if(data.error)throw new Error(data.error);
      const names=data.matches.filter(z=>z.open&&cy.$id(z.name).length).map(z=>z.name);
      paintedScope=scope;highlight.set(names);
      status.textContent=names.length?t('Подсвечено зон: ','Highlighted zones: ')+names.length:t('Подходящих зон на этой карте нет.','No matching zones on this map.');
    }catch(error){if(request===serial){highlight.clear();status.textContent=t('Ошибка поиска: ','Search failed: ')+error.message;}}
  }
  enabled.onchange=refresh;match.onchange=goalsChanged;addGoal();status.textContent=idle();
  window.scoutPaint=highlight.paint;
  window.scoutRefresh=()=>{
    if(paintedScope!==chanView)highlight.clear();else highlight.paint();
    clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,150);
  };
  const wayHost=make('div','scout-waypoints'),wayRows=make('div');
  wayHost.append(wayRows);
  let nextId=0;
  const changed=()=>{++routeRequestSerial;discardRouteResult();routeMsg(t('Маршрут изменён. Нажми «Найти путь».','Route changed. Select Find route.'));};
  function updateWaypoints(){
    addWaypointButton.disabled=wayRows.children.length>=6;
    [...wayRows.children].forEach((row,index)=>{
      row.querySelector('label').textContent=t('Остановка ','Stop ')+(index+1);
      row.querySelector('.scout-waypoint-up').disabled=index===0;
    });
  }
  function addWaypoint(name=''){
    if(wayRows.children.length>=6){toast(t('Можно добавить не больше шести остановок.','You can add up to six stops.'));return false;}
    const row=make('div','scout-waypoint'),wrap=make('div','ac-wrap'),input=make('input'),ac=make('div','ac');ac.hidden=true;
    input.id='scout-via-'+(++nextId);ac.id=input.id+'-ac';input.value=name;input.placeholder=t('Название зоны','Zone name');input.setAttribute('aria-label',t('Промежуточная зона','Intermediate zone'));input.autocomplete='off';input.oninput=changed;
    const field=make('div','route-field'),label=make('label');label.htmlFor=input.id;
    wrap.append(input,ac);field.append(label,wrap);row.append(field);
    const up=button('↑',()=>{if(row.previousElementSibling)wayRows.insertBefore(row,row.previousElementSibling);updateWaypoints();changed();});up.classList.add('scout-waypoint-up');up.setAttribute('aria-label',t('Выше в маршруте','Move earlier'));up.title=t('Выше в маршруте','Move earlier');
    const remove=button('×',()=>{completion.close();row.remove();updateWaypoints();changed();});remove.setAttribute('aria-label',t('Убрать промежуточную зону','Remove waypoint'));remove.title=t('Убрать промежуточную зону','Remove waypoint');
    const actions=make('div','scout-waypoint-actions');actions.append(up,remove);row.append(actions);wayRows.append(row);updateWaypoints();
    const completion=makeAC(input.id,ac.id,()=>document.getElementById('route-to').focus());completion.bind();
    input.addEventListener('blur',()=>completion.close());
    input.addEventListener('keydown',event=>{if(event.key==='Enter')changed();});
    ac.addEventListener('mousedown',event=>{if(event.target.closest('.ac-item'))changed();});
    input.focus();if(name)completion.close();changed();return true;
  }
  const addWaypointButton=button(t('+ Остановка','+ Stop'),()=>addWaypoint());addWaypointButton.className='route-add-stop';addWaypointButton.setAttribute('aria-label',t('Добавить остановку','Add stop'));addWaypointButton.title=t('До шести остановок, в указанном порядке','Up to six stops, in order');wayHost.append(addWaypointButton);
  window.scoutAddWaypoint=addWaypoint;
  window.scoutCanAddWaypoint=()=>wayRows.children.length<6;
  document.getElementById('route-waypoints').append(wayHost);
  window.scoutWaypoints=()=>[...wayRows.querySelectorAll('input')].map(el=>el.value.trim()).filter(Boolean).map(resolveDest);
  document.getElementById('route-clear').addEventListener('click',()=>{wayRows.replaceChildren();updateWaypoints();});
  async function runPlan(options={}){
    if(routeBusy)return;
    let from=options.from===undefined?routeOrigin():options.from;
    const anyCity=options.from===null||from===i18nText('Из любого города');
    if(!from&&!anyCity){toast(t('Укажи старт в панели маршрута.','Set a start in the Route panel.'));return;}
    if(anyCity)from=null;
    if(!api()?.findPlan){toast(t('Поиск пути доступен внутри приложения.','Route planning is available in the app.'));return;}
    const waypoints=window.scoutWaypoints();if(waypoints.some(n=>!n)){toast(t('Проверь промежуточные зоны.','Check the intermediate zones.'));return;}
    acClose();document.activeElement?.blur();
    const controls=['route-go','route-from-city','route-exit'].map(id=>document.getElementById(id));
    const id=++routeRequestSerial,scope=chanView;routeBusy=true;controls.forEach(b=>b.disabled=true);discardRouteResult();routeMsg(i18nText('ищу путь…'));
    try {
      const res=await api().findPlan({from,to:options.to,waypoints,goals:options.goals||[],match:options.match,scope});
      if(id!==routeRequestSerial||scope!==chanView)return;
      showRoute(res,t('Маршрут через выбранные зоны','Route via selected zones'));
    }catch(error){if(id===routeRequestSerial)routeMsg(esc(error.message),'route-fail');}
    finally{routeBusy=false;controls.forEach(b=>b.disabled=false);}
  }
  window.scoutRunPlan=runPlan;
})();
