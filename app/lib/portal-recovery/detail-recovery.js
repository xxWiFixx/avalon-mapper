'use strict';
const P=require('./point-verifier');
const local=require('./local-contrast');
const {supportedCandidates}=require('./timer-conflict');
const {createFrameOcr}=require('./ocr-memo');
const EXPLICIT=['number-block-disagrees','single-digits-disagree','number-with-unit-disagrees','unit-readings-conflict'];
function uniqueCandidates(segmentation){return [...new Map(supportedCandidates(segmentation).map(c=>[c.text,c])).values()];}
function resolution(attempts){
 const accepted=attempts.filter(a=>a.point?.decision==='accept'),values=[...new Set(accepted.map(a=>a.point.proposal))];
 if(values.length!==1)return null;
 // An unresolved alternative is not erased merely because another reading
 // succeeded. A shorter suffix must explicitly fail the completeness check.
 if(attempts.some(a=>a.candidate.seconds!==values[0]&&a.point?.reason!=='unassigned-symbol-outside-candidate'))return null;
 return values[0];
}
async function recover(frame,baseline,methods,segmentation,previous,{ocr}={}){
 const start=performance.now(),attempts=[],bar=baseline?.raw?.bar;
 const finish=(proposal,reason)=>({proposal,decision:Number.isFinite(proposal)?'accept':'unknown',reason,attempts,ms:performance.now()-start});
 if(!baseline?.name||!bar||bar.bh<=0||baseline.raw.timerRegion?.kind==='red'||typeof ocr!=='function')return finish(null,'confirmed-white-card-required');
 if(['conflicting-pixel-candidates','point-reading-conflicts-with-existing-value'].includes(previous?.reason))return finish(null,'explicit-conflict-preserved');
 if((previous?.points||[]).some(p=>p?.decision==='reject'&&EXPLICIT.includes(p.reason)))return finish(null,'explicit-numeric-conflict-preserved');
 const candidates=uniqueCandidates(segmentation);
 if(!candidates.length||candidates.length>3)return finish(null,'bounded-original-candidate-set-required');
 const memo=createFrameOcr(ocr);ocr=memo.ocr;
 try{
  const transformed=local.transform(frame,bar,0);
  if(transformed){
   const group=[];
   for(const candidate of candidates){
    const point=await P.verify(transformed.frame,bar,{candidate,baseline,previousMethods:methods,ocr,geometryMode:'local'});
    const a={method:'local-red-channel',candidate,point};attempts.push(a);group.push(a);
   }
   const value=resolution(group);if(Number.isFinite(value))return finish(value,'complete-local-contrast-point-verification');
   if(group.some(a=>EXPLICIT.includes(a.point.reason)))return finish(null,'local-numeric-conflict');
  }
  return finish(null,'local-contrast-not-fully-confirmed');
 }finally{memo.clear();}
}
module.exports={recover,uniqueCandidates,resolution};
