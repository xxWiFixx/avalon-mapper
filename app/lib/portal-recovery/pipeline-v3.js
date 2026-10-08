'use strict';
// Offline extension of the frozen v2 reader. No file IDs or truth labels enter
// decisions; an episode key only excludes that episode's training templates.
const oldCombine = require('./combine').combine;
const {strictToken} = require('./completeness');
const segmentation = require('./segmentation');
const point = require('./point-verifier');
const conflict = require('./timer-conflict');
const known = Number.isFinite;
function pixelCandidate(result,source) {
  if(!known(result?.proposal))return null;
  const text=result.diagnostics?.text, glyphs=result.glyphs;
  if(!text||!glyphs||glyphs.length!==text.length)return null;
  const parsed=strictToken(text);
  if(!parsed||parsed.sec!==result.proposal)return null;
  const variant=result.diagnostics.variants?.find(v=>v.safe&&v.text===text&&v.seconds===result.proposal);
  return {text,seconds:result.proposal,roi:result.diagnostics.roi,source,
    glyphs:glyphs.map((g,i)=>({...g,char:text[i],...(variant?.chars?.[i]||{})})),
    evidence:{templateAccepted:true,matchingMasks:result.diagnostics.variants?.filter(v=>v.safe&&v.text===text).length||0}};
}
function explicitMatchingRead(base,candidate) {
  return (base?.raw?.timerReads||[]).some(read=>{
    // No parseBottom/normDigits: a digit such as 4 must not be inferred as ч
    // when deciding whether an OCR observation explicitly confirms the units.
    const token=strictToken(read.text);
    return token&&token.sec===candidate.seconds&&token.text===candidate.text&&token.glyphCount===candidate.glyphs.length;
  });
}
async function evaluate(frame,baseline,previousMethods,{ocr,excludeEpisode=null,modelPath}={}) {
  const old=oldCombine(baseline,previousMethods||{}),start=performance.now();
  const result={previous:old,final:{...old},segmentation:null,point:null,candidate:null,additionalMs:0};
  const finish=(reason)=>{if(reason)result.stage=reason;result.additionalMs=performance.now()-start;return result;};
  const bar=baseline?.raw?.bar;
  if(!bar)return finish('no-confirmed-portal');
  if(baseline.raw.timerRegion?.kind==='red')return finish('existing-red-branch');
  const previouslyPixelConfirmed=known(old.proposal)&&[previousMethods.glyph?.proposal,previousMethods.glyphFullCrop?.proposal].includes(old.proposal);
  if(known(old.proposal)&&((previousMethods.completeness?.decision==='accept'&&previouslyPixelConfirmed)||old.reason==='minor-zero-confirmed-by-full-pixel-reading'))return finish('already-confirmed-v2');
  let t=performance.now();
  result.segmentation=await segmentation.analyze(frame,bar,{timerRegion:baseline.raw.timerRegion,
    baseline,previousMethods,excludeEpisode,modelPath});
  result.segmentation.ms=performance.now()-t;
  const retainedConflict=conflict.contradictsRetained(old,result.segmentation);
  const refuseContradicted=()=>{result.final={proposal:null,reason:conflict.REASON};return finish('retained-conflict-refused');};
  const segmented=result.segmentation.decision==='accept'&&known(result.segmentation.proposal)?result.segmentation.candidate:null;
  const candidates=[segmented,pixelCandidate(previousMethods.glyphFullCrop,'v2-full-crop'),pixelCandidate(previousMethods.glyph,'v2-native-crop')].filter(Boolean);
  const values=[...new Set(candidates.map(c=>c.seconds))];
  if(values.length>1){
    result.final={proposal:null,reason:'conflicting-pixel-candidates'};
    return finish('candidate-conflict-refused');
  }
  const candidate=candidates[0]?{...candidates[0],excludeEpisode}:null;
  if(!candidate)return retainedConflict?refuseContradicted():finish('no-candidate-retain-v2');
  result.candidate=candidate;
  if(segmented&&candidate.seconds===old.proposal&&explicitMatchingRead(baseline,candidate)){
    result.final={proposal:old.proposal,reason:'new-segmentation-matches-explicit-ocr'};
    return finish('existing-value-newly-confirmed');
  }
  t=performance.now();
  result.point=await point.verify(frame,bar,{candidate,ocr,baseline,previousMethods});
  result.point.ms=performance.now()-t;
  if(result.point.decision==='accept'&&known(result.point.proposal)&&result.point.proposal===candidate.seconds){
    result.final={proposal:candidate.seconds,reason:candidate.seconds===old.proposal?'point-verification-confirms-existing':'point-verification-recovers-value'};
    return finish(candidate.seconds===old.proposal?'existing-value-newly-confirmed':'value-recovered');
  }
  const explicitConflictReasons=['number-block-disagrees','single-digits-disagree','number-with-unit-disagrees','unit-readings-conflict'];
  if(result.point.decision==='reject'&&candidate.seconds===old.proposal&&known(old.proposal)&&explicitConflictReasons.includes(result.point.reason)){
    result.final={proposal:null,reason:'point-reading-conflicts-with-existing-value'};
    return finish('point-conflict-refused');
  }
  return retainedConflict?refuseContradicted():finish('point-not-confirmed-retain-v2');
}
module.exports={evaluate,pixelCandidate,explicitMatchingRead};
