// Historical topology and computed frames are served only by the local review server.
window.addEventListener('load', async () => {
  cloudSignedIn=false; layoutAccountId='real-layout-review'; chanView='local'; renderRevision++;
  for(const id of ['left','card','card-toggle','btn-relayout']) {
    const el=document.getElementById(id); if(el)el.style.display='none';
  }
  const panel=document.createElement('div');
  panel.style.cssText='position:fixed;top:0;left:0;right:0;z-index:99999;background:#191919;padding:10px;color:white;display:flex;align-items:center;gap:10px;font:14px sans-serif;flex-wrap:wrap';
  const info=document.createElement('span'), details=document.createElement('small');
  let report,index=0,timer=null,last=null;
  function button(label,action) {
    const b=document.createElement('button'); b.textContent=label;
    b.style.cssText='padding:8px 10px;background:#42351f;border:1px solid #947644;color:white;border-radius:5px;cursor:pointer';
    b.onclick=action; panel.append(b);return b;
  }
  const stop=()=>{clearInterval(timer);timer=null;play.textContent='Воспроизвести';};
  const fit=()=>{cy.resize();fitGraph();cy.center();};
  const resizeObserver=new ResizeObserver(()=>{if(last&&!timer)fit();});
  resizeObserver.observe(document.getElementById('cy'));
  // Historical times are used in the replay, not fake live countdown labels.
  cy.style().selector('edge').style('label','').update();
  function show(frame,label,fitView=false) {
    const previous=last?new Set(Object.keys(last.positions)):new Set();
    renderSnapshot({players:{},edges:frame.edges.map(([a,b])=>({a,b,scope:'local',expiresAt:Date.now()+3600000,capMax:7}))},frame.positions,false);
    cy.nodes().ungrabify();
    cy.nodes().removeClass('fresh');
    if(last)for(const id of Object.keys(frame.positions))if(!previous.has(id))cy.$id(id).addClass('fresh');
    last=frame;
    info.textContent=label+' · '+Object.keys(frame.positions).length+' зон · '+frame.edges.length+' связей · пересечений: '+frame.stats.crossings+' · наложений: '+frame.stats.overlaps;
    details.textContent=new Date(frame.t).toLocaleString('ru-RU')+' · '+frame.event+' · сдвинуто старых: '+frame.shifted;
    if(fitView)requestAnimationFrame(()=>requestAnimationFrame(fit));
  }
  const replay=(fitView=false)=>{range.value=index;show(report.frames[index],'Шаг '+(index+1)+' / '+report.frames.length,fitView);};
  button('Карта: 124 зоны',()=>{stop();last=null;show(report.snapshot,'Сохранённая карта',true);});
  button('Начало журнала',()=>{stop();index=0;last=null;replay(true);});
  button('Максимум зон',()=>{stop();index=report.summary.peak;last=null;replay(true);});
  button('Максимум пересечений',()=>{stop();index=report.summary.worst;last=null;replay(true);});
  const play=button('Воспроизвести',()=>{
    if(timer){stop();return;}
    if(index>=report.frames.length-1)index=0;
    // Set a fixed overview once; subsequent replay steps do not change the camera.
    show(report.frames[report.summary.peak],'Обзор',true);last=null;
    play.textContent='Пауза';timer=setInterval(()=>{replay();if(index===report.frames.length-1)stop();else index++;},450);
  });
  button('Следующий шаг',()=>{stop();index=Math.min(index+1,report.frames.length-1);replay();});
  button('Вписать',fit);
  const range=document.createElement('input');range.type='range';range.min=0;range.value=0;
  range.setAttribute('aria-label','Шаг истории');range.style.width='240px';
  range.oninput=()=>{stop();index=Number(range.value);replay();};
  panel.append(range,info,details);document.body.append(panel);
  try {
    const response=await fetch('../test/real-layout-report.json');if(!response.ok)throw new Error('Нет отчёта');
    report=await response.json();range.max=report.frames.length-1;
    for(const frame of [report.snapshot,...report.frames]) for(const id of Object.keys(frame.positions)) {
      const zone=report.zoneInfo[id]||{name:id,color:id.includes('-')?'avalon':'black'};
      demoColors[id]=zone.color;
      zoneInfoCache[id]=zone;
    }
    show(report.snapshot,'Сохранённая карта',true);
  }catch(error){info.textContent='Ошибка: '+error.message;}
  window.addEventListener('pagehide',()=>{stop();resizeObserver.disconnect();},{once:true});
});
