'use strict';
const crypto=require('node:crypto');
const {setTimeout:pause}=require('node:timers/promises');
const PUBLIC={europe:'https://pow.europe.albion-online-data.com',west:'https://pow.west.albion-online-data.com',east:'https://pow.east.albion-online-data.com'};
const TOPICS=new Set(['marketorders.ingest','markethistories.ingest']);
function privateURL(base,topic) {
  if(!TOPICS.has(topic))throw new Error('invalid_topic');
  const u=new URL(base);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.port
      ||u.pathname.split('/').filter(Boolean).length!==2 ||u.pathname.split('/').filter(Boolean)[0]!=='ingest')throw new Error('invalid_ingest_url');
  return base.replace(/\/$/,'')+'/'+topic;
}
function bodyJSON(body) {
  // uint64 ticks/prices must reach AODP as JSON numbers without IEEE754 rounding.
  return JSON.stringify(body,(key,value)=>['Timestamp','SilverAmount'].includes(key)&&typeof value==='string'&&/^\d{1,20}$/.test(value)
    ? JSON.rawJSON(value):value);
}
function bits(hash){return Buffer.from(hash.toString('hex')).reduce((s,b)=>s+b.toString(2).padStart(8,'0'),'');}
async function solvePow(pow,{signal,deadline=Date.now()+20000}={}) {
  if(typeof pow?.key!=='string'||pow.key.length>512||!pow.key.length||typeof pow.wanted!=='string'||!/^[01]{1,48}$/.test(pow.wanted))throw new Error('invalid_pow');
  let until=performance.now()+5;
  for(;;){
    signal?.throwIfAborted();if(Date.now()>deadline)throw new Error('pow_budget_exceeded');
    const nonce=crypto.randomBytes(16).toString('hex');
    const hash=crypto.createHash('sha256').update('aod^'+nonce+'^'+pow.key).digest();
    if(bits(hash).startsWith(pow.wanted))return nonce;
    if(performance.now()>=until){await pause(15,null,{signal});until=performance.now()+5;}
  }
}
async function boundedText(response,max=65536){
  const reader=response.body?.getReader();if(!reader){const t=await response.text();if(t.length>max)throw new Error('large_response');return t;}
  const chunks=[];let size=0;
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new Error('large_response');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks).toString('utf8');
}
async function upload(row,destination,{privateEndpoint,fetchImpl=fetch,signal}={}) {
  if(!TOPICS.has(row.topic)||!Object.hasOwn(PUBLIC,row.realm))throw new Error('invalid_market_payload');
  const body=bodyJSON(JSON.parse(row.data));
  const headers={'Content-Type':'application/json','User-Agent':'AvalonMapper/0.5.19 (embedded market collector)'};
  const limited=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(35000)]);
  let response;
  if(destination==='private'){
    if(row.realm!=='europe')throw new Error('private_region_mismatch');
    response=await fetchImpl(privateURL(privateEndpoint,row.topic),{method:'POST',body,headers,signal:limited,redirect:'error'});
  }else if(destination==='public'){
    const base=PUBLIC[row.realm];
    const challenge=await fetchImpl(base+'/pow',{signal:limited,headers:{'User-Agent':headers['User-Agent']},redirect:'error'});
    if(challenge.status!==200)throw new Error('pow_http_'+challenge.status);
    const pow=JSON.parse(await boundedText(challenge));
    const solution=await solvePow(pow,{signal:limited});
    const form=new URLSearchParams({key:pow.key,solution,serverid:String({west:1,east:2,europe:3}[row.realm]),natsmsg:body,identifier:crypto.randomUUID()});
    response=await fetchImpl(base+'/pow/'+row.topic,{method:'POST',body:form,signal:limited,headers:{'User-Agent':headers['User-Agent']},redirect:'error'});
  }else throw new Error('invalid_destination');
  await response.body?.cancel().catch(()=>{});
  if(response.status!==200)throw new Error('upload_http_'+response.status);
}
module.exports={PUBLIC,TOPICS,privateURL,bodyJSON,bits,solvePow,upload};
