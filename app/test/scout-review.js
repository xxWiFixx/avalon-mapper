window.addEventListener('load',async()=>{
  const data=await (await fetch('/scout-test/data')).json();
  const request=(action,payload)=>fetch('/scout-test/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(r=>r.json());
  window.scoutDemoApi={searchContent:r=>request('search',r),findPlan:r=>request('plan',r)};
  cloudSignedIn=false;chanView='local';layoutAccountId='scout-review';renderRevision++;
  zoneNames=data.zoneNames;
  for(const[name,z]of Object.entries(data.zoneInfo)){zoneInfoCache[name]=z;demoColors[name]=z.color;}
  renderSnapshot(data.snapshot,data.positions,true);
  fillFrom('Ouritos-Ofailos');
  const badge=document.createElement('div');badge.textContent='Тест поиска · сохранённая карта · данные аккаунта не меняются';
  badge.style.cssText='position:fixed;bottom:0;left:330px;z-index:999;background:#332b1c;color:#edd7a9;padding:5px 12px;font:12px system-ui';document.body.append(badge);
  document.getElementById('route-go').addEventListener('click',event=>{
    event.stopImmediatePropagation();window.scoutRunPlan({from:routeOrigin(),to:resolveDest(document.getElementById('route-to').value)});
  },true);
});
