// Native renderer checks: hit testing catches controls covered by floating panels.
module.exports = async function checkWorkspace(win, assert) {
  const run = code => win.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function hit(selector) {
    const result = await run(`(async()=>{
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el)return {error:'missing'};
      el.scrollIntoView({block:'nearest',inline:'nearest'});
      await new Promise(r=>setTimeout(r,80));
      const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {clickable:!!r.width && !!r.height && (target===el || el.contains(target)),
        coveredBy:target?.id||target?.className||target?.tagName};
    })()`);
    assert.equal(result.clickable,true,selector+' '+JSON.stringify(result));
  }
  async function click(selector) { await hit(selector);await run(`document.querySelector(${JSON.stringify(selector)}).click();true`);await pause(80); }
  await run(`document.getElementById('app-splash')?.remove();applyFold('route-body',true);showCard({name:'Qiient-Qi-Odesas',color:'avalon',tier:6});document.querySelector('[data-route-position="bottom"]').click();true`);
  const graphBefore=await run(`JSON.stringify({width:cy.width(),positions:cy.nodes().map(n=>[n.id(),n.position()])})`);
  await click('#card-close');
  assert.equal(await run(`document.getElementById('card').inert`),true);
  await run(`showCard({name:'Qiient-Qi-Odesas',color:'avalon',tier:6},undefined,false);true`);
  assert.equal(await run(`document.body.classList.contains('no-card')`),true,'background data must not reopen a closed card');
  await click('#card-toggle');
  assert.equal(await run(`JSON.stringify({width:cy.width(),positions:cy.nodes().map(n=>[n.id(),n.position()])})`),graphBefore);
  await click('[data-fold="route-body"]');await pause(400);
  assert.equal(await run(`document.querySelector('[data-fold="route-body"]').getAttribute('aria-expanded')`),'false');
  assert.equal(await run(`document.getElementById('route-body').inert`),true);
  await click('[data-fold="route-body"]');await pause(400);
  await click('#route-clear');
  await click('.route-add-stop');
  await hit('.scout-waypoint input');
  await click('.scout-waypoint-actions button:last-child');
  assert.equal(await run(`document.querySelectorAll('.scout-waypoint').length`),0);
  await run(`window.scoutAddWaypoint('Pynos-Opabrom');window.scoutAddWaypoint('Ouritos-Ofailos');true`);
  await click('.scout-waypoint:last-child .scout-waypoint-up');
  assert.equal(await run(`document.querySelector('.scout-waypoint input').value`),'Ouritos-Ofailos');
  await run(`zoneNames=[{name:'Pynos-Opabrom',color:'avalon',tier:6}];const el=document.getElementById('route-to');el.focus();el.value='Pynos';el.dispatchEvent(new Event('input',{bubbles:true}));true`);
  await hit('#route-ac .ac-item');
  assert.equal(await run(`document.getElementById('route-ac').matches(':popover-open')`),true);
  await run(`document.querySelector('#route-ac .ac-item').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));true`);
  assert.equal(await run(`document.getElementById('route-to').value`),'Pynos-Opabrom');
  assert.equal(await run(`document.getElementById('route-ac').hidden`),true);
  await click('.route-options summary');await hit('#route-portal-city');await click('.route-options summary');
  await click('#route-clear');
  if(await run(`document.querySelector('.scout-heading').getAttribute('aria-expanded')==='false'`))await click('.scout-heading');
  await click('.scout-add');
  await hit('.scout-goal:last-child select');
  await run(`document.querySelector('.scout-goal:last-child .scout-kind').value='blue';document.querySelector('.scout-goal:last-child .scout-kind').dispatchEvent(new Event('change',{bubbles:true}));true`);
  await pause(150);
  assert.equal(await run(`document.querySelector('.scout-status').textContent`),'Подсвечено зон: 1');
  await click('.scout-goal:last-child .scout-remove');
  await click('.scout-clear');
  assert.equal(await run(`document.getElementById('scout-enabled').checked`),false);
  await click('.scout-heading');await click('.scout-heading');
  assert.equal(await run(`document.querySelectorAll('.scout-info').length`),0);
  await run(`setCurZone('Qiient-Qi-Odesas');fillFrom('Ouritos-Ofailos');true`);
  await click('#route-here');
  assert.equal(await run(`document.getElementById('route-from-input').value`),'Qiient-Qi-Odesas');
  await run(`document.getElementById('route-to').value='Pynos-Opabrom';true`);
  await click('#route-go');
  assert.equal(await run(`document.querySelectorAll('#route-out .rs').length>1`),true);
  await hit('#route-guide');await hit('#route-image');
  await click('#route-guide');
  await run(`applyFold('route-body',false);setRouteTo('Ouritos-Ofailos');true`);
  assert.equal(await run(`document.getElementById('route-body').inert`),false);
  assert.equal(await run(`document.querySelectorAll('#route-out .rs').length`),0);
  assert.equal(await run(`document.getElementById('route-to').value`),'Ouritos-Ofailos');
  await click('#route-clear');
  assert.equal(await run(`document.querySelectorAll('#route-out .rs').length`),0);
  await click('#route-exit');
  assert.equal(await run(`document.querySelectorAll('#route-out .rs').length>1`),true);
  await click('#route-clear');
  await click('#route-from-city');
  await run(`document.getElementById('route-to').value='Pynos-Opabrom';true`);
  await click('#route-go');
  assert.equal(await run(`document.querySelectorAll('#route-out .rs').length>1`),true);
  await click('#route-clear');
  await run(`for(let i=0;i<6;i++)window.scoutAddWaypoint('Pynos-Opabrom');true`);
  for(const [width,height] of [[1440,1000],[1024,768],[800,600]]) {
    win.setSize(width,height);await pause(350);
    for(const selector of ['#card-close','#card-toggle','#find-avalon','#btn-me','#btn-fit','#btn-relayout','#route-go','#route-exit','#route-clear','.scout-waypoint:last-child input','.scout-waypoint:last-child .scout-waypoint-up','.scout-waypoint:last-child .scout-waypoint-actions button:last-child'])await hit(selector);
    const geometry=await run(`(()=>{
      const r=document.getElementById('route-block').getBoundingClientRect(),g=document.getElementById('graph').getBoundingClientRect(),c=document.getElementById('card').getBoundingClientRect();
      return {inside:r.left>=g.left && r.right<=g.right+1 && r.top>=g.top && r.bottom<=g.bottom,apart:c.bottom<=r.top+1};
    })()`);
    assert.deepEqual(geometry,{inside:true,apart:true},width+'x'+height+' '+JSON.stringify(await run(`(()=>{const r=document.getElementById('route-block').getBoundingClientRect(),c=document.getElementById('card').getBoundingClientRect();return {route:r.toJSON(),card:c.toJSON(),routeHeight:getComputedStyle(document.getElementById('graph')).getPropertyValue('--route-panel-height'),viewport:innerWidth}})()`)));
  }
  win.setSize(1440,1000);await pause(100);
  await click('#route-clear');
  async function checkFit(placement,width,height) {
    win.webContents.setZoomFactor(width>1300 && placement!=='bottom' ? .6 : 1);
    win.setSize(width,height);await pause(180);
    await click(`[data-route-position="${placement}"]`);
    await run(`fitGraph(false);true`);
    const geometry=await run(`(()=>{
      const canvas=document.getElementById('cy').getBoundingClientRect();
      const panel=document.getElementById('route-block').getBoundingClientRect();
      const card=document.getElementById('card').getBoundingClientRect();
      const bb=cy.elements().renderedBoundingBox();
      const safe=visibleMapArea();
      return {mode:document.body.dataset.routePlacement,pressed:document.querySelector('[data-route-position="${placement}"]').getAttribute('aria-pressed'),viewportWidth:innerWidth,bbox:bb,safe,
        clearOfPanels:!!safe&&bb.x1>=safe.left-2&&bb.x2<=safe.right+2&&bb.y1>=safe.top-2&&bb.y2<=safe.bottom+2,
        panelInside:panel.left>=canvas.left-1&&panel.right<=canvas.right+1&&panel.top>=canvas.top-1&&panel.bottom<=canvas.bottom+1,
        cardInside:card.left>=canvas.left-1&&card.right<=canvas.right+1};
    })()`);
    assert.equal(geometry.mode,placement);
    assert.equal(geometry.pressed,'true');
    assert.equal(geometry.panelInside,true,placement+' panel '+JSON.stringify(geometry));
    assert.equal(geometry.cardInside,true,placement+' card '+JSON.stringify(geometry));
    assert.equal(geometry.clearOfPanels,true,placement+' fit '+JSON.stringify(geometry));
    await run(`setCurZone('Pynos-Opabrom');centerOnMe();true`);await pause(450);
    const centered=await run(`(()=>{const r=cy.$id('Pynos-Opabrom').renderedPosition(),s=visibleMapArea();return Math.abs(r.x-(s.left+s.right)/2)<2&&Math.abs(r.y-(s.top+s.bottom)/2)<2})()`);
    assert.equal(centered,true,placement+' my zone');
  }
  await checkFit('bottom',1440,1000);
  await checkFit('left',1600,1000);
  await checkFit('right',1600,1000);
  await click('#tab-damage');
  assert.equal(await run(`getComputedStyle(document.getElementById('route-block')).display`),'none','right dock must be hidden in statistics');
  await click('#tab-map');
  await checkFit('left',1024,768);
  await run(`applyFold('route-body',false);true`);await pause(350);
  await run(`fitGraph(false);true`);
  assert.equal(await run(`(()=>{const p=cy.$id('Pynos-Opabrom').renderedPosition(),s=visibleMapArea();return p.x>=s.left&&p.x<=s.right&&p.y>=s.top&&p.y<=s.bottom})()`),true,'collapsed route fit');
  await run(`applyFold('route-body',true);true`);await pause(350);
  win.webContents.setZoomFactor(1);
  await run(`document.querySelector('[data-route-position="bottom"]').click();true`);
  win.setSize(1440,1000);await pause(100);
  await click('#tab-damage');
  assert.equal(await run(`getComputedStyle(document.getElementById('route-block')).display`),'none');
  await click('#tab-map');await hit('#route-go');
  console.log('PASS: floating panels, fit clear of panels at bottom/left/right and narrow fallback, pointer hit targets at 1440/1024/800, autocomplete selection, stops/reorder/remove, filters, routes/safe exit/city/guide/reset, statistics and stable graph.');
};
