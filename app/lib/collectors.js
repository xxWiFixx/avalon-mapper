'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
const access=require('./collector-access');
function create({root,user,secret,onStatus=()=>{},onTrafficChange=()=>{},workerFactory=data=>new Worker(path.join(__dirname,'collector-worker.js'),{workerData:data}),verificationKey,now=Date.now}={}) {
  let verified=null,caps=null,worker=null,epoch=0,options={market:false,mail:false},details=null;
  let pending=[],queuedBytes=0,inFlight=0,scheduled=false,dropped=0,requests=new Map(),requestId=0;
  let status={phase:'idle',packets:0,observations:0,mails:0,queued:0,uploaded:0,error:null};
  const read=file=>{try{return JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));}catch{return null;}};
  function allowed() {
    const u=user();
    if(!u?.signedIn||u.guest||!verified||u.userId!==verified.id||now()-verified.at>3600000)return null;
    return caps;
  }
  function loadAccess(){const key=readKey();caps=key&&verified?access.verify(read('collector-access.json'),key,verified.id):null;}
  function readKey(){try{return verificationKey||require('../data-static/collector-key.json').publicKey;}catch{return null;}}
  function getSettings() {
    const value=read('collector-settings.json');
    try {const s=JSON.parse(secret.decrypt(value?.enc));return s?.userId===verified?.id?s:null;}catch{return null;}
  }
  function saveSettings(){
    const enc=secret.encrypt(JSON.stringify({...details,...options,userId:verified.id}));
    if(!enc)throw new Error('secure_storage_unavailable');
    const file=path.join(root,'collector-settings.json');
    fs.writeFileSync(file+'.tmp',JSON.stringify({v:1,enc}),{mode:0o600});fs.renameSync(file+'.tmp',file);
  }
  function stop() {
    epoch++;pending=[];queuedBytes=0;inFlight=0;scheduled=false;
    for(const {resolve,timer}of requests.values()){clearTimeout(timer);resolve({error:'account_changed'});}requests.clear();
    if(worker){const old=worker;worker=null;try{old.postMessage({type:'stop'});}catch{}setTimeout(()=>Promise.resolve(old.terminate()).catch(()=>{}),1000).unref();}
  }
  function reset() {
    stop();verified=null;caps=null;details=null;options={market:false,mail:false};
    status={phase:'idle',packets:0,observations:0,mails:0,queued:0,uploaded:0,error:null};onTrafficChange();onStatus();
  }
  function acceptProfile(profile) {
    const u=user();
    if(!u?.signedIn||u.guest||profile?.id!==u.userId||!access.UUID.test(profile?.id||'')){reset();return;}
    const changed=verified?.id!==profile.id;
    if(changed)stop();verified={id:profile.id,at:now()};loadAccess();
    if(!allowed()){reset();return;}
    if(changed){details=getSettings()||{userId:profile.id,publicUpload:false,privateEndpoint:null,market:false,mail:false};options={market:details.market===true,mail:details.mail===true};}
    if(options.market||options.mail)start();onTrafficChange();onStatus();
  }
  function start(){
    if(worker||!allowed())return;
    const mine=epoch;
    const id=crypto.createHash('sha256').update(verified.id).digest('hex').slice(0,24);
    worker=workerFactory({file:path.join(root,'collector-data',id+'.sqlite'),privateEndpoint:details?.privateEndpoint||null,publicUpload:details?.publicUpload===true});
    const current=worker;
    current.on('message',m=>{
      if(epoch!==mine||worker!==current||!allowed())return;
      if(m.type==='ack'){inFlight=Math.max(0,inFlight-1);schedule();return;}
      if(m.type==='list'){const r=requests.get(m.id);if(r){clearTimeout(r.timer);requests.delete(m.id);r.resolve(m);}return;}
      if(m.type==='status'){const {type,...s}=m;status=s;onStatus();}
    });
    current.on('error',()=>{if(worker===current){status.error='collector_failed';options={market:false,mail:false};stop();onTrafficChange();onStatus();}});
    current.on('exit',()=>{if(worker===current){worker=null;options={market:false,mail:false};status.error='collector_stopped';onTrafficChange();onStatus();}});
    current.postMessage({type:'configure',...options});
  }
  async function configure(kind,value,proof) {
    if(!['market','mail'].includes(kind)||typeof value!=='boolean')return {ok:false,error:'invalid_action'};
    if(value){const profile=await proof();acceptProfile(profile);}
    if(!allowed()?.[kind])return {ok:false,error:'access_denied'};
    const previous={...options};options[kind]=value;
    try{saveSettings();}catch{options=previous;return {ok:false,error:'save_failed'};}
    if(value)start();
    worker?.postMessage({type:'configure',...options});
    if(!options.market&&!options.mail){pending=[];queuedBytes=0;}
    onTrafficChange();onStatus();return {ok:true};
  }
  function schedule(){
    if(scheduled||inFlight>=4||!pending.length)return;scheduled=true;
    setImmediate(()=>{
      scheduled=false;if(!worker||!allowed()||!needsTraffic()){pending=[];queuedBytes=0;return;}
      const packets=pending.splice(0,64);queuedBytes-=packets.reduce((n,p)=>n+p.payload.length,0);
      inFlight++;worker.postMessage({type:'packets',packets});schedule();
    });
  }
  function feed(payload,meta){
    if(!needsTraffic())return;
    if(!Buffer.isBuffer(payload)||payload.length<12||payload.length>65535||!meta?.peer||meta.peer.length>200)return;
    if(queuedBytes+payload.length>2*1024*1024){dropped++;return;}
    pending.push({payload:Buffer.from(payload),meta:{incoming:meta.incoming,peer:meta.peer}});queuedBytes+=payload.length;schedule();
  }
  function needsTraffic(){return !!allowed()&&(options.market||options.mail)&&!!worker;}
  function snapshot(){const caps=allowed();return caps?{allowed:true,...options,...status,dropped,
    destination:details?.privateEndpoint?(details.publicUpload?'private-public':'private'):details?.publicUpload?'public':null}:null;}
  async function list(page={}) {
    if(!allowed()?.mail)return {error:'access_denied'};
    const offset=page?.offset??0,limit=page?.limit??50;
    if(!Number.isInteger(offset)||offset<0||offset>1e7||!Number.isInteger(limit)||limit<1||limit>100)return {error:'invalid_page'};
    start();if(!worker)return {error:'unavailable'};
    const before=epoch,id=++requestId;
    const result=await new Promise(resolve=>{const timer=setTimeout(()=>{requests.delete(id);resolve({error:'read_timeout'});},5000);requests.set(id,{resolve,timer});worker.postMessage({type:'list',id,page:{offset,limit}});});
    if(before!==epoch||!allowed()?.mail)return {error:'account_changed'};
    return result.error?{error:result.error}:{rows:result.rows,total:result.total};
  }
  function disable(){options={market:false,mail:false};if(allowed())try{saveSettings();}catch{}worker?.postMessage({type:'configure',...options});pending=[];queuedBytes=0;onTrafficChange();onStatus();}
  function refreshAccess(){loadAccess();if(verified && !allowed())reset();}
  return {acceptProfile,reset,configure,feed,needsTraffic,snapshot,list,disable,refreshAccess,close:stop};
}
module.exports={create};
