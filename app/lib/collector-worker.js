'use strict';
const {parentPort,workerData}=require('node:worker_threads');
const protocol=require('./combat-protocol');
const {createDecoder,gameConnection}=require('./collector-decode');
const database=require('./collector-store');
const {upload}=require('./collector-upload');
const store=database.create(workerData.file),stream=protocol.createStream({requests:true});
let options={market:false,mail:false},closed=false,busy=false,controller=null,lastRequestAt=0,lastClean=Date.now();
let state={phase:'idle',packets:0,dropped:0,encrypted:false,lastAt:null,error:null};
const destinations=()=>[workerData.privateEndpoint?'private':null,workerData.publicUpload?'public':null].filter(Boolean);
const send=()=>{if(!closed)parentPort.postMessage({type:'status',...state,...store.summary()});};
const decoder=createDecoder({onMarket(event){if(options.market){store.market(event,destinations());state.lastAt=Date.now();state.encrypted=false;lastRequestAt=0;state.error=null;}},
  onMail(event){if(options.mail){store.mail(event);state.lastAt=Date.now();}}});
async function drain() {
  if(closed||busy||!options.market||!destinations().length)return;
  busy=true;controller=new AbortController();
  try {
    for(const destination of destinations()){
      if(closed||!options.market)break;
      const row=store.next(destination);if(!row)continue;
      try {await upload(row,destination,{privateEndpoint:workerData.privateEndpoint,signal:controller.signal});if(!closed)store.done(row.id);state.error=null;}
      catch(e){if(!closed){store.retry(row.id,row.attempts);state.error=/^(?:upload_http_\d+|pow_http_\d+|invalid_pow|pow_budget_exceeded|private_region_mismatch)$/.test(e.message)?e.message:'upload_unavailable';}}
    }
  } finally {busy=false;controller=null;send();}
}
const timer=setInterval(()=>{if(Date.now()-lastClean>3600000){store.clean();lastClean=Date.now();}send();drain().catch(()=>{state.error='upload_unavailable';});},1500);
timer.unref();
parentPort.on('message',async message=>{
  if(message.type==='stop'){closed=true;controller?.abort();clearInterval(timer);store.close();parentPort.close();return;}
  if(closed)return;
  if(message.type==='configure'){
    options={market:message.market===true,mail:message.mail===true};
    if(!options.market)controller?.abort();
    if(!options.market&&!options.mail){stream.reset();decoder.reset();state.phase='idle';}
    else state.phase='listening';
    send();return;
  }
  if(message.type==='list'){
    try {parentPort.postMessage({type:'list',id:message.id,rows:store.list(message.page),total:store.summary().mails});}
    catch {parentPort.postMessage({type:'list',id:message.id,error:'read_failed'});}return;
  }
  if(message.type!=='packets')return;
  try {
    if(!options.market&&!options.mail)return;
    for(const packet of message.packets){
      const pl=Buffer.from(packet.payload),meta=packet.meta;
      if(!gameConnection(meta))continue;
      state.packets++;
      if(pl[2]===1){if(options.market&&meta.incoming&&Date.now()-lastRequestAt<3000)state.encrypted=true;continue;}
      for(const m of stream.feed(pl,meta.peer)){
        if(m.kind==='request'&&[81,82,95].includes(m.code))lastRequestAt=Date.now();
        decoder.feed(m,meta);
      }
    }
  } catch {state.error='decode_failed';}
  finally {parentPort.postMessage({type:'ack'});}
});
store.clean();send();
