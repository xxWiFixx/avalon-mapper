// Isolated visual comparison: no cloud calls or changes to existing coordinates.
window.addEventListener('load', async()=>{
  cloudSignedIn=false;layoutAccountId='layout-variants-review';chanView='local';renderRevision++;
  for(const id of ['left','card','card-toggle','graph-tools']){const e=document.getElementById(id);if(e)e.style.display='none';}
  const style=document.createElement('style');
  style.textContent=`
    #layout-review-head {position:fixed;inset:0 0 auto;z-index:99999;background:#191714;border-bottom:1px solid #51432c;padding:16px 20px;color:#eee;font:14px system-ui;}
    #layout-review-head h2 {font-size:19px;margin:0 0 10px;font-weight:600;}
    #layout-review-head nav {display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
    .layout-review-button {background:#292621;border:1px solid #63543c;border-radius:6px;color:#eee;padding:9px 13px;font:inherit;cursor:pointer;}
    .layout-review-button[aria-pressed=true] {background:#614a26;border-color:#e1b65f;}
    #layout-review-note {display:block;color:#beb7ab;margin-top:10px;line-height:1.5;}
    #layout-review-stats {display:block;color:#e4c27c;margin-top:6px;}
    #layout-review-islands {position:fixed;top:190px;bottom:0;left:0;width:250px;overflow:auto;z-index:9999;background:#191714;padding:12px;box-sizing:border-box;display:none;}
    #layout-review-islands button {display:block;width:100%;text-align:left;margin-bottom:7px;}
    #layout-review-selected {position:fixed;bottom:20px;right:20px;z-index:9999;padding:10px 14px;max-width:320px;background:#292621;border:1px solid #63543c;border-radius:6px;color:#eee;pointer-events:none;}
    #graph {position:fixed!important;top:190px!important;left:0;right:0;bottom:0;}
  `;document.head.append(style);
  const head=document.createElement('header');head.id='layout-review-head';
  const title=document.createElement('h2');title.textContent='Одна реальная карта · 124 зоны · 103 портала';
  const nav=document.createElement('nav'),note=document.createElement('span'),stats=document.createElement('span');
  note.id='layout-review-note';stats.id='layout-review-stats';head.append(title,nav,note,stats);document.body.append(head);
  const islands=document.createElement('aside');islands.id='layout-review-islands';document.body.append(islands);
  const selection=document.createElement('div');selection.id='layout-review-selected';selection.textContent='Колесо — масштаб · перетаскивание фона — панорама · нажми на зону';document.body.append(selection);
  cy.style().selector('edge').style({'label':'','width':1.7,'line-opacity':.7}).selector('node').style({'font-size':12,'min-zoomed-font-size':7}).update();
  let report,current='compact',atlas=false,subset=null;
  const descriptions={
    compact:'Короткие связи: участки уложены отдельно, расстояния между соседями выровнены. Хорошо для поиска пути глазами.',
    branches:'Ветви слева направо: у каждого участка выбран центральный узел. Уровни показывают шаги от него; линии остаются двусторонними.',
    rings:'Круговая схема: зоны каждого участка стоят по окружности. Все связи видны, но некоторые линии заметно длиннее.',
    atlas:'Мой вариант — атлас участков. Выбери слева нужный участок: его зоны и названия видны крупно. «Все участки» возвращает все 124 зоны.'
  };
  const buttons={};
  function button(label,action,parent=nav){const b=document.createElement('button');b.className='layout-review-button';b.textContent=label;b.onclick=action;parent.append(b);return b;}
  const fit=()=>{cy.resize();cy.minZoom(.03);cy.fit(cy.elements(':visible'),55);if(cy.zoom()>1.3)cy.zoom(1.3);cy.center(cy.elements(':visible'));};
  function show(mode,component=null){
    if(!report)return;
    title.textContent='Одна реальная карта · 124 зоны · 103 портала';
    atlas=mode==='atlas';current=atlas?'compact':mode;subset=component;
    const v=report.variants.find(v=>v.id===current),allowed=component?new Set(component.ids):new Set(Object.keys(v.positions));
    const edges=report.edges.filter(([a,b])=>allowed.has(a)&&allowed.has(b));
    renderSnapshot({players:{},edges:edges.map(([a,b])=>({a,b,scope:'local',expiresAt:Date.now()+3600000}))},v.positions,false);
    cy.style().selector('node').style({'font-size':component?18:12,'min-zoomed-font-size':component?0:7}).update();
    cy.nodes().ungrabify();cy.nodes().removeClass('fresh');
    // The selected node is the only highlighted item; no arbitrary data is hidden in full-map modes.
    for(const[id,b]of Object.entries(buttons))b.setAttribute('aria-pressed',String(id===mode));
    islands.style.display=atlas?'block':'none';document.getElementById('graph').style.left=atlas?'250px':'0';
    note.textContent=descriptions[mode];
    stats.textContent=component?component.root+' · '+component.ids.length+' из 124 зон · '+edges.length+' связей · 0 пересечений':
      'Все 124 зоны · 103 связи · пересечения: '+v.stats.crossings+' · наложения точек: '+v.stats.overlaps+' · линии через чужие подписи: '+v.stats.lineBoxes;
    selection.textContent=component?'Участок: '+component.root:'Колесо — масштаб · перетаскивание фона — панорама · нажми на зону';
    requestAnimationFrame(()=>requestAnimationFrame(fit));
  }
  buttons.compact=button('1. Короткие связи',()=>show('compact'));
  function bridgeDemo(pair){
    show('compact');
    title.textContent='Проверка новой связи · 124 зоны · 104 портала';
    const base=report.variants.find(v=>v.id==='compact').positions,edges=[...report.edges,pair];
    const proposal=window.BRIDGE_LAYOUT.proposals(base,edges,report.edges)[0];
    const positions={...base,...proposal?.positions};
    renderSnapshot({players:{},edges:edges.map(([a,b])=>({a,b,scope:'local',expiresAt:Date.now()+3600000}))},positions,false);
    cy.nodes().ungrabify();cy.nodes().removeClass('fresh');
    cy.$id(pair[0]).edgesWith(cy.$id(pair[1])).style({'line-color':'#f0c16b',width:4,opacity:1});
    const moved=proposal?Object.keys(proposal.positions).length:0;
    note.textContent=pair.join(' → ');stats.textContent='124 зоны · 104 связи · перемещено '+moved+' зон · остальные '+(124-moved)+' сохранили координаты';
    if(proposal){const audit=window.COMPONENT_LAYOUT.audit(positions,edges);stats.textContent+=' · пересечений: '+audit.crossings;}
    requestAnimationFrame(()=>fit());
  }
  button('Тест: маленький участок',()=>bridgeDemo(['Oynitos-Uromlum','Tetitos-Ayoslum']));
  button('Тест: два больших',()=>bridgeDemo(['Ouritos-Ofailos','Soues-Uzurtum']));
  buttons.branches=button('2. Ветви',()=>show('branches'));
  buttons.rings=button('3. Круговая схема',()=>show('rings'));
  buttons.atlas=button('4. Атлас участков',()=>show('atlas',report.components[0]));
  button('Вписать',fit);
  button('−',()=>{cy.zoom({level:cy.zoom()/1.3,renderedPosition:{x:cy.width()/2,y:cy.height()/2}});});
  button('+',()=>{cy.zoom({level:cy.zoom()*1.3,renderedPosition:{x:cy.width()/2,y:cy.height()/2}});});
  cy.on('tap','node',e=>{const n=e.target;selection.textContent=n.id()+' · связей: '+n.degree();});
  const observer=new ResizeObserver(()=>{if(report)fit();});observer.observe(document.getElementById('cy'));
  try {
    const response=await fetch('../test/layout-variants-report.json');if(!response.ok)throw new Error('Нет отчёта');report=await response.json();
    for(const[id,zone]of Object.entries(report.zoneInfo)){demoColors[id]=zone.color;zoneInfoCache[id]=zone;}
    button('Все участки · 124 зоны',()=>show('atlas'),islands);
    for(const c of report.components)button(c.root+' · '+c.ids.length+' зон',()=>show('atlas',c),islands);
    show('compact');
  }catch(error){stats.textContent='Ошибка: '+error.message;}
  window.addEventListener('pagehide',()=>observer.disconnect(),{once:true});
});
