'use strict';
const {strictToken}=require('./completeness');
const REASON='retained-timer-contradicted-by-complete-pixels';
function supportedCandidates(segmentation){
 const all=(segmentation?.diagnostics?.attempts||[]).flatMap(a=>a.candidates||[]);
 if(segmentation?.candidate)all.unshift(segmentation.candidate);
 return all.filter(c=>Number.isFinite(c.seconds)&&strictToken(c.text)?.sec===c.seconds&&
  Array.isArray(c.glyphs)&&c.glyphs.length===c.text.length&&c.glyphs.every(g=>g.safe===true));
}
function contradictsRetained(previous,segmentation){
 if(previous?.reason!=='baseline-retained-unverified'||!Number.isFinite(previous.proposal))return false;
 const candidates=supportedCandidates(segmentation);
 return candidates.length>0&&candidates.every(c=>c.seconds!==previous.proposal);
}
module.exports={REASON,supportedCandidates,contradictsRetained};
