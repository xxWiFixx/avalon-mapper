'use strict';
const {createHash}=require('crypto');
const CONTRACT='stateless-png-psm-whitelist-v1';
// Construct once per evaluate(frame). No cross-frame, cross-worker or persistent
// cache; exact encoded bytes and every effective recognition option form a key.
function createFrameOcr(ocr){
 const cache=new Map(),stats={requests:0,executed:0,hits:0,bypassed:0,bytesHashed:0,hashMs:0};
 const recognize=async(png,options={})=>{
  stats.requests++;
  const eligible=ocr?.memoContract===CONTRACT&&(Buffer.isBuffer(png)||png instanceof Uint8Array)
   &&options&&Object.keys(options).every(k=>k==='psm'||k==='whitelist');
  if(!eligible){stats.executed++;stats.bypassed++;return ocr(png,options);}
  const t=performance.now();
  const digest=createHash('sha256').update(png).digest('hex');
  const key=JSON.stringify([digest,String(options.psm||7),options.whitelist||'']);
  stats.bytesHashed+=png.byteLength;stats.hashMs+=performance.now()-t;
  if(cache.has(key)){stats.hits++;return cache.get(key);}
  stats.executed++;
  // Cache only fulfilled primitive strings, including a genuine empty result.
  // An exception is propagated and can be retried; no rejected promise persists.
  const result=await ocr(png,options);
  if(typeof result==='string')cache.set(key,result);
  return result;
 };
 recognize.memoContract=ocr?.memoContract;
 return{ocr:recognize,stats:()=>({...stats,entries:cache.size}),clear:()=>cache.clear()};
}
module.exports={createFrameOcr,CONTRACT};
