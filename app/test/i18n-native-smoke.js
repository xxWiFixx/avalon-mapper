// Run with Node. Hidden, isolated Electron windows; no game capture or live account.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.versions.electron){
  const {spawn}=require('node:child_process');
  const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),[__filename],{windowsHide:true,stdio:'inherit',env:environment});
  child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code;});
}else{
 const {app,BrowserWindow,ipcMain}=require('electron');
 const vm=require('node:vm'),i18n=require('../lib/i18n'),{webPrefs}=require('../lib/win-prefs');
 const testRoot=path.resolve(__dirname,'../../out/native-locale-smoke');fs.mkdirSync(testRoot,{recursive:true});
 const root=fs.mkdtempSync(path.join(testRoot,'run-'));app.setPath('userData',root);app.setPath('sessionData',root);
 const config={language:'ru',theme:'dark',onboardingSeen:true,zoneSource:'off',zoneWatch:false,nick:'Nomad',overlayEnabled:true,overlayMap:true,overlayScale:1,overlayHoldSec:7,saveLocal:true,autoRecordPortals:true,rooms:[]};
 const windows=[],errors=[];
 const deadline=setTimeout(()=>app.exit(2),45000);
 ipcMain.on('get-language',event=>{event.returnValue=config.language;});
 const uiRoute=(from,to)=>({found:true,from,to,steps:[{from,to,kind:'portal',expiresAt:Date.now()+3600000,capMax:7}],etaSec:60});
 const handlers={ 'get-config':()=>({...config}), 'get-map':()=>({edges:[],players:[]}), 'get-zone-names':()=>[],
 'find-route':(_,from,to)=>uiRoute(from,to), 'find-nearest-exit':(_,from)=>uiRoute(from,'Pen Gent'),
 'find-route-from-city':(_,to)=>uiRoute('Fort Sterling',to),
 'search-content':()=>({matches:[{name:'Pynos-Opabrom',open:true}]}),
 'get-metrics':()=>({enabled:false,fame:0,rows:[]}), 'auth-status':()=>({signedIn:false}), 'update-status':()=>({}), 'rooms-list':()=>({ok:true,rooms:[]}) };
 const preload=fs.readFileSync(path.join(__dirname,'../preload.js'),'utf8');
 for(const match of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g))if(match[1]!=='set-option'&&!handlers[match[1]])handlers[match[1]]=()=>({ok:true});
 for(const [name,fn]of Object.entries(handlers))ipcMain.handle(name,fn);
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function waitFor(win,language){
  const end=Date.now()+12000;
  while(Date.now()<end){
   try{if(await win.webContents.executeJavaScript(`document.documentElement.lang === '${language}' && document.readyState === 'complete'`))return;}catch{}
   await delay(100);
  }throw new Error('Window did not load '+language);
 }
 async function create(page,preload,query={}){
  const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:webPrefs(path.join(__dirname,'../'+preload+'.js'))});windows.push(win);
  win.webContents.on('preload-error',(_,__,error)=>errors.push(error.message));
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  win.webContents.on('did-finish-load',()=>{if(page==='index')win.webContents.send('splash-start');});
  await win.loadFile(path.join(__dirname,'../ui/'+page+'.html'),{query});return win;
 }
 app.whenReady().then(async()=>{
  const main=await create('index','preload');
  const others=[await create('overlay','preload-overlay'),await create('metrics','preload-metrics',{kind:'damage'}),await create('metrics','preload-metrics',{kind:'fame'}),await create('search','preload-search'),await create('picker','preload-picker'),await create('food-overlay','preload-metrics')];
  const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
  vm.runInNewContext(source.slice(source.indexOf('const OPTIONS = {'),source.indexOf('// ---------- комнаты ----------')),{
   config,win:main,profile:{title:'Avalon Mapper'},i18nText:i18n.t,require:()=>i18n,ipcMain,BrowserWindow,
   configForWindow:()=>({...config}),flushConfig(){},saveConfig(){fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));},console});
  await waitFor(main,'ru');
  assert.equal(await main.webContents.executeJavaScript(`!!document.querySelector('.metrics-food [data-metric="food"]')`),true);
  assert.equal(await main.webContents.executeJavaScript(`['#side','#graph-tools','.app-header'].every(s=>{const c=getComputedStyle(document.querySelector(s)).backgroundColor;return c.startsWith('rgba(')&&Number(c.slice(c.lastIndexOf(',')+1,-1))<1})`),true);
  assert.equal(await main.webContents.executeJavaScript(`(()=>{const map=document.querySelector('#cy').getBoundingClientRect(),side=document.querySelector('#side').getBoundingClientRect(),header=document.querySelector('.app-header').getBoundingClientRect();return map.left<=side.left&&map.right>=side.right&&map.top<=header.top&&map.bottom>=side.bottom})()`),true,'the actual map must render behind translucent chrome');
  others[5].webContents.send('metrics-updated',{foodBuff:{warning:true,remainingMs:45000}});
  for(let i=0;i<50;i++){if(await others[5].webContents.executeJavaScript(`document.getElementById('food-detail').textContent.includes('меньше минуты')`))break;await delay(20);}
  assert.equal(await others[5].webContents.executeJavaScript(`document.getElementById('food-detail').textContent`),'Осталось меньше минуты');
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('route-clear').hidden`),false);
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('route-exit').textContent`),'Найти безопасную зону');
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('changes-entry').hidden`),false);
  await main.webContents.executeJavaScript(`document.getElementById('changes-toggle').click();true`);
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('changes-dialog').open`),true);
  assert.match(await main.webContents.executeJavaScript(`document.getElementById('changes-list').textContent`),/нет активных порталов/i);
  await main.webContents.executeJavaScript(`document.getElementById('changes-close').click();true`);
  await main.webContents.executeJavaScript(`
    cy.add({group:'nodes',data:{id:'Pynos-Opabrom',name:'Pynos-Opabrom',tier:6,color:'avalon'},position:{x:0,y:0}});
    cy.center(cy.$id('Pynos-Opabrom'));cy.zoom(1);
    document.getElementById('app-splash')?.remove();
    applyFold('route-body',false);
    cy.$id('Pynos-Opabrom').emit({type:'cxttap',originalEvent:{clientX:700,clientY:330}});true`);
  assert.equal(await main.webContents.executeJavaScript(`document.querySelector('#graph-menu [data-act="via"]').textContent`),'Добавить остановку');
  await main.webContents.executeJavaScript(`document.querySelector('#graph-menu [data-act="via"]').click();true`);
  assert.equal(await main.webContents.executeJavaScript(`document.querySelector('.scout-waypoint input').value`),'Pynos-Opabrom');
  assert.equal(await main.webContents.executeJavaScript(`document.querySelector('[data-fold="route-body"]').getAttribute('aria-expanded')`),'true');
  assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.scout-waypoint').length`),1);
  await main.webContents.executeJavaScript(`for(let i=0;i<5;i++)window.scoutAddWaypoint('Pynos-Opabrom');openGraphMenu('Pynos-Opabrom',{x:700,y:330});true`);
  assert.equal(await main.webContents.executeJavaScript(`document.querySelector('#graph-menu [data-act="via"]').disabled`),true);
  assert.equal(await main.webContents.executeJavaScript(`window.scoutCanAddWaypoint()`),false);
  assert.equal(await main.webContents.executeJavaScript(`window.scoutAddWaypoint('Pynos-Opabrom')`),false);
  assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.scout-waypoint').length`),6);
  await main.webContents.executeJavaScript(`document.getElementById('route-clear').click();closeGraphMenu();true`);
  assert.equal(await main.webContents.executeJavaScript(`window.scoutCanAddWaypoint()`),true);
  assert.equal(await main.webContents.executeJavaScript(`document.querySelectorAll('.scout-waypoint').length`),0);
  await require('./helpers/workspace-ui-checks')(main,assert);
  await main.webContents.executeJavaScript(`openModal('modal-settings','set-maps');document.querySelector('[data-opt="autoRecordPortals"]').click();true`);
  for(let i=0;i<100&&config.autoRecordPortals!==false;i++)await delay(20);
  assert.equal(config.autoRecordPortals,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config.json'))).autoRecordPortals,false);
  main.reload();await waitFor(main,'ru');
  assert.equal(await main.webContents.executeJavaScript(`document.querySelector('[data-opt="autoRecordPortals"]').checked`),false);
  await main.webContents.executeJavaScript(`document.getElementById('interface-language').value='en';document.getElementById('interface-language').dispatchEvent(new Event('change'));true`);
  for(const window of [main,...others])await waitFor(window,'en');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'config.json'))).language,'en');
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('acc-gear').textContent.trim()`),'Settings');
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('route-exit').textContent`),'Find a safe zone');
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('changes-toggle').textContent.trim()`),'Change log');
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('route-clear').hidden`),false);
  assert.equal(await main.webContents.executeJavaScript(`document.getElementById('set-misc').hidden`),false);
  main.reload();await waitFor(main,'en');
  assert.equal(await main.webContents.executeJavaScript(`typeof require`),'undefined');
  assert.equal(await others[2].webContents.executeJavaScript(`document.documentElement.lang`),'en');
  assert.equal(await main.webContents.executeJavaScript(`document.querySelector('[data-opt="autoRecordPortals"]').checked`),false);
  assert.deepEqual(errors,[]);
  if(process.env.MAPPER_GLASS_PREVIEW){
   await main.webContents.executeJavaScript(`document.getElementById('app-splash')?.remove();cy.add([{data:{id:'glass-a',name:'Glass A',tier:6,color:'avalon'},position:{x:150,y:500}},{data:{id:'glass-b',name:'Glass B',tier:6,color:'avalon'},position:{x:560,y:500}},{data:{id:'glass-edge',source:'glass-a',target:'glass-b'}}]);cy.viewport({zoom:1,pan:{x:0,y:0}});true`);
   main.showInactive();await delay(350);
   fs.writeFileSync(path.join(root,'glass-preview.png'),(await main.webContents.capturePage()).toPNG());
   main.hide();
  }
  console.log('PASS: context menu and route controls, translucent panels, food reminder, settings and RU → EN work in secure windows.');
 }).then(()=>{clearTimeout(deadline);app.exit(0);}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
}
