'use strict';
const {recognizeTimer}=require('../portal-timer');
const completeness=require('./completeness'),glyph=require('./glyph-verifier'),v3=require('./pipeline-v3');
const timerRecovery=require('./timer-recovery'),cardTimerRecovery=require('./card-timer-recovery');
const {createFrameOcr}=require('./ocr-memo');
const {createCardRecovery}=require('./card-recovery');
function createPipeline(helpers){
const R={DICT:helpers.DICT,_internal:{crop:helpers.crop}},cardRecovery=createCardRecovery(helpers);
const validSeconds=value=>Number.isInteger(value)&&value>=0&&value<=86400;
async function timerMethods(frame,portal,{ocr,excludeEpisode,modelPath}){
 const timer=await recognizeTimer(frame,portal.raw.bar,{ocr,crop:R._internal.crop});
 const baseline={...portal,closes:timer.closes,timerUncertain:timer.timerUncertain,raw:{...portal.raw,...timer.raw,bar:portal.raw.bar}};
 const bar=baseline.raw.bar,methods={};
 methods.completeness=await completeness.verify(frame,bar,{ocr,baseline,timerRegion:baseline.raw.timerRegion,reads:baseline.raw.timerReads||[]});
 methods.glyph=await glyph.recognize(frame,bar,{modelPath,excludeEpisode});
 const full=methods.completeness.diagnostics?.fullBox;
 if(full&&methods.completeness.diagnostics.stable)methods.glyphFullCrop=await glyph.recognize(frame,bar,{modelPath,excludeEpisode,timerRegion:{...full,kind:'light'}});
 const result=await v3.evaluate(frame,baseline,methods,{ocr,excludeEpisode,modelPath});
 return {baseline,methods,result};
}
async function evaluate(frame,baseline,previousMethods,previousResult,{ocr,screenHeight,onName,excludeEpisode=null,modelPath}={}){
 const start=performance.now(),result={previous:previousResult,final:{...previousResult,proposal:validSeconds(previousResult?.proposal)?previousResult.proposal:null},card:null,timer:null,cardTimer:null,recoveredV3:null,portalName:baseline?.name??null};
 let memo=null,renderCache=null;
 const finish=stage=>{result.stage=stage;result.additionalMs=performance.now()-start;result.ocrMemo=memo?.stats()??null;result.renderCacheEntries=renderCache?.size??0;memo?.clear();renderCache?.clear();return result;};
 if(validSeconds(previousResult?.proposal))return finish('accepted-v3-preserved');
 if(['conflicting-pixel-candidates','point-reading-conflicts-with-existing-value',require('./timer-conflict').REASON].includes(previousResult?.reason))return finish('previous-conflict-preserved');
 if(typeof ocr==='function'){memo=createFrameOcr(ocr);ocr=memo.ocr;}
 renderCache=new Map();
 let portal=baseline,methods=previousMethods;
 if(!portal?.raw?.bar){
  result.card=await cardRecovery.recover(frame,{ocr,screenHeight,excludeEpisode,modelPath});
  const recovered=result.card.portal;
  if(result.card.decision!=='accept'||!recovered?.raw?.bar||!R.DICT.includes(recovered.name))return finish('card-not-confirmed');
  const bar=recovered.raw.bar;
  if(!['bx','by','bh'].every(k=>Number.isFinite(bar[k]))||bar.bh<=0)return finish('invalid-card-geometry');
  portal={...recovered,closes:null};
  result.portalName=portal.name;
  if(typeof onName==='function')onName({name:portal.name,...helpers.zoneInfo(portal.name)});
  result.recoveredV3=await timerMethods(frame,portal,{ocr,excludeEpisode,modelPath});
  portal=result.recoveredV3.baseline;methods=result.recoveredV3.methods;
  const v=result.recoveredV3.result;
  if(['candidate-conflict-refused','point-conflict-refused','retained-conflict-refused'].includes(v.stage))return finish('recovered-timer-conflict');
  // A newly discovered card must not acquire a timer through the soft v3 path.
  if(validSeconds(v.final?.proposal)&&['already-confirmed-v2','existing-value-newly-confirmed','value-recovered'].includes(v.stage)){
   result.final={proposal:v.final.proposal,reason:'recovered-card-and-verified-timer'};
   return finish('card-and-timer-recovered');
  }
 }
 if(!R.DICT.includes(portal?.name))return finish('portal-name-not-confirmed');
 if(!['bx','by','bh'].every(k=>Number.isFinite(portal?.raw?.bar?.[k]))||portal.raw.bar.bh<=0)return finish('invalid-card-geometry');
 result.timer=await timerRecovery.recover(frame,portal,methods,{ocr,excludeEpisode,modelPath,renderCache});
 if(result.timer.decision==='accept'&&validSeconds(result.timer.proposal)){
  result.final={proposal:result.timer.proposal,reason:result.card?'recovered-card-and-timer-detail':'timer-detail-recovery'};
  return finish(result.card?'card-and-timer-recovered':'timer-recovered');
 }
 if(result.card&&result.timer.decision==='unknown'){
  result.cardTimer=await cardTimerRecovery.recover(frame,portal,methods,{ocr,excludeEpisode,modelPath,previousRecovery:result.timer,renderCache});
  if(result.cardTimer.decision==='accept'&&validSeconds(result.cardTimer.proposal)){
   result.final={proposal:result.cardTimer.proposal,reason:'recovered-card-and-original-timer-blocks'};
   return finish('card-and-timer-recovered');
  }
 }
 return finish('timer-not-confirmed');
}
return {evaluate,timerMethods,validSeconds};
}
module.exports={createPipeline};
