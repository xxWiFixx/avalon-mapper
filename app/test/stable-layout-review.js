// Isolated candidate review. Real accounts, saved maps and cloud RPCs are not used.
window.addEventListener('load', async () => {
  cloudSignedIn = false; layoutAccountId = 'branch-layout-review'; chanView = 'local';
  renderRevision++;
  for (const id of ['left', 'card', 'card-toggle', 'btn-relayout']) {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  }
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#191919;padding:10px;color:white;display:flex;align-items:center;gap:16px;font:14px sans-serif;flex-wrap:wrap';
  const baseline = document.createElement('button'); baseline.textContent = '100 зон'; baseline.disabled = true;
  const add = document.createElement('button'); add.textContent = 'Добавить 50 зон'; add.disabled = true;
  const fit = document.createElement('button'); fit.textContent = 'Вписать тестовую карту';
  const result = document.createElement('span'); result.textContent = 'Расчёт 100 зон в фоновом потоке…';
  const detail = document.createElement('small'); detail.textContent = 'Тот же граф · без записи в облако';
  for (const b of [baseline, add, fit]) b.style.cssText = 'padding:8px 12px;background:#42351f;border:1px solid #947644;color:#fff;border-radius:5px;cursor:pointer';
  panel.append(baseline, add, fit, result, detail); document.body.append(panel);
  await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '../test/helpers/layout-fixture.js';
    script.onload = resolve; script.onerror = reject; document.head.append(script);
  });
  const fixture = window.LAYOUT_FIXTURE.make();
  const { ids, edges, tiers } = fixture;
  ids.forEach((id, i) => {
    demoColors[id] = i % 13 === 0 ? 'yellow' : i % 17 === 0 ? 'black' : 'avalon';
    zoneInfoCache[id] = { name: id, color: demoColors[id], tier: tiers[id] };
  });
  const pairsFor = count => edges.filter(pair => pair.every(id => ids.indexOf(id) < count));
  const snapshot = count => ({ players: {}, edges: pairsFor(count).map(([a,b],i) => ({
    a,b,scope:'local',capMax:i%7===0?20:7,expiresAt:Date.now()+6*3600000+i*60000,
    updatedAt:Date.now()-3600000,createdAt:Date.now()-3600000,
  })) });
  const worker = new Worker('branch-layout-worker.js');
  const results = {}; let requestId = 0;
  const pending = new Map();
  worker.onmessage = ({data}) => {
    const job = pending.get(data.id); if (!job) return;
    if (data.progress) {
      result.textContent = '100 зон: проверка варианта ' + data.progress.candidate + ' / 3 — ' + data.progress.crossings + ' пересечений';
      return;
    }
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error)); else job.resolve(data);
  };
  worker.onerror = () => {
    result.textContent = 'Ошибка фонового расчёта';
    for(const job of pending.values()) job.reject(new Error('worker_failed'));
    pending.clear();
  };
  const calculate = (count, saved) => new Promise((resolve,reject) => {
    const id = ++requestId; pending.set(id,{resolve,reject});
    worker.postMessage({id,nodeIds:ids.slice(0,count),edgePairs:pairsFor(count),saved});
  });
  const fitNow = () => { cy.resize(); fitGraph(); };
  fit.onclick = fitNow;
  let shifted = 0;
  function display(count, fitView) {
    const entry = results[count];
    renderSnapshot(snapshot(count),entry.result.positions,false);
    cy.nodes().removeClass('fresh');
    if(count===150) ids.slice(100).forEach(id=>cy.$id(id).addClass('fresh'));
    const s=entry.result.stats;
    result.textContent = count + ' зон · ' + pairsFor(count).length + ' связей · пересечений: ' + s.crossings +
      ' · наложений узлов/подписей: ' + s.overlaps + (count===150?' · сдвинуто старых: '+shifted+' / 100':'');
    detail.textContent = count===150 ? 'Новые 50 — зелёные · камера при добавлении сохранена' : 'Тот же граф · без записи в облако';
    if(fitView) requestAnimationFrame(()=>requestAnimationFrame(fitNow));
  }
  baseline.onclick = () => display(100,true);
  add.onclick = async () => {
    if(results[150]) { display(150,true); return; }
    add.disabled = true;
    const before = graphPositions(), zoom = cy.zoom(), pan = {...cy.pan()};
    result.textContent = 'Размещаю новые 50 зон, первые 100 закреплены…';
    try {
      results[150] = await calculate(150,results[100].result.positions);
      const after=results[150].result.positions;
      shifted=Object.keys(before).filter(id=>before[id].x!==after[id]?.x||before[id].y!==after[id]?.y).length;
      display(150,false);
      const cameraStable=zoom===cy.zoom()&&pan.x===cy.pan().x&&pan.y===cy.pan().y;
      detail.textContent='Новые 50 — зелёные · камера: '+(cameraStable?'без изменений':'изменилась')+
        ' · расчёт '+(results[150].elapsedMs/1000).toFixed(2)+' с в фоне';
      add.textContent='150 зон';
    } catch(error) { result.textContent='Ошибка: '+error.message; }
    finally { add.disabled=false; }
  };
  renderSnapshot({players:{},edges:[]},{},true);
  try {
    results[100]=await calculate(100,{});
    display(100,true);
    baseline.disabled=false; add.disabled=false;
  } catch(error) { result.textContent='Ошибка: '+error.message; }
  window.addEventListener('pagehide',()=>worker.terminate(),{once:true});
});
