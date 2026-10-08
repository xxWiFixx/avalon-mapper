'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
if(!process.versions.electron){
  const {spawn}=require('node:child_process'),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(require('electron'),[__filename],{windowsHide:true,stdio:'inherit',env});
  child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code;});
}else{
  const {app,BrowserWindow,ipcMain}=require('electron'),{Worker}=require('node:worker_threads');
  const root=fs.mkdtempSync(path.resolve(__dirname,'../../out/collectors-native-'));app.setPath('userData',root);app.setPath('sessionData',root);
  let win,worker;const errors=[],actions=[];let language='ru';
  let state={enabled:false,fame:0,rows:[],collectors:null},rows=[];
  const deadline=setTimeout(()=>app.exit(2),35000),delay=ms=>new Promise(r=>setTimeout(r,ms));
  ipcMain.on('get-language',e=>{e.returnValue=language;});ipcMain.handle('get-metrics',()=>state);
  ipcMain.handle('collector-action',(_,kind,value)=>{actions.push([kind,value]);state.collectors[kind]=value;return {ok:true,state};});
  ipcMain.handle('collector-mails',(_,page)=>({rows:rows.slice(page.offset,page.offset+page.limit),total:rows.length}));
  async function waitFor(code){for(let i=0;i<80;i++){if(await win.webContents.executeJavaScript(code))return;await delay(30);}throw Error('Timed out: '+code);}
  async function click(selector){
    const hit=await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {hit:h===e||e.contains(h),disabled:!!e.disabled};})()`);
    assert.equal(hit.hit,true,selector);assert.equal(hit.disabled,false,selector);
    await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click();true`);await delay(50);
  }
  function vint(n){const a=[];do{let b=Number(n&127n);n>>=7n;if(n)b|=128;a.push(b);}while(n);return Buffer.from(a);}
  function val(v){if(typeof v==='string'){const b=Buffer.from(v);return Buffer.concat([Buffer.from([7]),vint(BigInt(b.length)),b]);}if(Array.isArray(v))return Buffer.concat([Buffer.from([23]),vint(BigInt(v.length)),...v.map(val)]);const n=BigInt(v);return Buffer.concat([Buffer.from([typeof v==='bigint'?10:9]),vint(n>=0?n*2n:-n*2n-1n)]);}
  function wire(code,params,seq){const p={...params,253:code};const b=Buffer.concat([Buffer.from([243,3,1,0,0,8]),vint(BigInt(Object.keys(p).length)),...Object.entries(p).map(([k,v])=>Buffer.concat([Buffer.from([+k]),val(v)]))]);const h=Buffer.alloc(24);h[3]=1;h[12]=6;h.writeUInt32BE(b.length+12,16);h.writeUInt32BE(seq,20);return {payload:Buffer.concat([h,b]),meta:{incoming:true,peer:'193.169.238.5:5056>192.168.1.1:54321'}};}
  app.whenReady().then(async()=>{
    // The actual Electron worker must support SQLite, not just system Node.
    worker=new Worker(path.resolve(__dirname,'../lib/collector-worker.js'),{workerData:{file:path.join(root,'worker.sqlite'),publicUpload:false,privateEndpoint:null}});
    const reply=new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',m=>{if(m.type==='list')resolve(m);});});
    worker.postMessage({type:'configure',mail:true,market:true});
    worker.postMessage({type:'packets',packets:[wire(2,{2:'TestCharacter',8:'3005'},1),wire(176,{0:7,1:'2|T4_BAG|30000000|15000000'},2),wire(174,{3:[7],7:['Bridgewatch Portal'],11:['MARKETPLACE_SELLORDER_FINISHED_SUMMARY'],12:[1800000000]},3)]});
    worker.postMessage({type:'list',id:1,page:{offset:0,limit:50}});
    const result=await reply;assert.equal(result.total,1);assert.equal(result.rows[0].total,3000);assert.equal(result.rows[0].city,'Bridgewatch');
    const exited=new Promise(r=>worker.once('exit',r));worker.postMessage({type:'stop'});assert.equal(await exited,0);worker=null;
    const url=f=>pathToFileURL(path.resolve(__dirname,'../'+f)).href;
    const file=path.join(root,'test.html');fs.writeFileSync(file,`<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="${url('ui/style.css')}"><link rel="stylesheet" href="${url('ui/metrics.css')}"></head><body><main style="padding:24px;max-width:1100px;margin:auto"><section id="metrics"></section></main><script src="${url('locales/en.js')}"></script><script src="${url('lib/i18n.js')}"></script><script src="${url('ui/i18n-dom.js')}"></script><script src="${url('ui/metrics-shared.js')}"></script><script src="${url('ui/collectors.js')}"></script><script src="${url('ui/metrics.js')}"></script></body></html>`);
    win=new BrowserWindow({show:false,width:1280,height:1100,webPreferences:require('../lib/win-prefs').webPrefs(path.resolve(__dirname,'../preload.js'))});
    win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});win.webContents.on('preload-error',(_,__,e)=>errors.push(e.message));
    await win.loadFile(file);await waitFor(`!!document.querySelector('.metrics-food')`);
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.metrics-collectors')`),false);
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('metrics').textContent.includes('Фейм по мобам')`),false);
    state.collectors={allowed:true,mail:false,market:false,mails:1,observations:0,queued:0,uploaded:0,destination:'private'};win.webContents.send('metrics-updated',state);
    await waitFor(`!!document.querySelector('[data-collector="market"]')`);await click('[data-collector="market"]');await click('[data-collector="mail"]');assert.deepEqual(actions,[['market',true],['mail',true]]);
    rows=Array.from({length:51},(_,i)=>({...result.rows[0],mailId:String(i),item:i===0?'<img src=x onerror="window.mailInjected=true">':'T4_BAG'}));
    await click('.collector-inbox summary');await waitFor(`document.querySelectorAll('.collector-mail-table tbody tr').length===50`);
    assert.equal(await win.webContents.executeJavaScript(`!!window.mailInjected||!!document.querySelector('.collector-mail-table img')`),false);
    await click('[data-mail-next]');await waitFor(`document.querySelectorAll('.collector-mail-table tbody tr').length===1`);await click('[data-mail-prev]');await waitFor(`document.querySelectorAll('.collector-mail-table tbody tr').length===50`);
    await click('[data-mail-refresh]');
    state.collectors=null;win.webContents.send('metrics-updated',state);await waitFor(`!document.querySelector('.metrics-collectors')`);assert.equal(await win.webContents.executeJavaScript(`document.body.textContent.includes('TestCharacter')`),false);
    language='en';await win.reload();await waitFor(`document.documentElement.lang==='en' && !!document.querySelector('.metrics-food')`);assert.equal(await win.webContents.executeJavaScript(`document.getElementById('metrics').textContent.includes('Fame by mob')`),false);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({ok:true,sqlite:true,worker:true,hiddenForOtherAccounts:true,controls:true,pagination:true,escapedMail:true,mobTableRemoved:true}));
    console.log('PASS: real Electron worker stores trades in SQLite; private controls, mail pagination, account hiding and RU/EN statistics work.');
  }).then(()=>{clearTimeout(deadline);app.exit(0);}).catch(e=>{console.error(e);worker?.terminate();clearTimeout(deadline);app.exit(1);});
}
