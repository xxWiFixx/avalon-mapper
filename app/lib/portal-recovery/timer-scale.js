'use strict';
const S=require('./segmentation');
// A session hint is not a measurement of this card. Only correct a materially
// inconsistent hint when the current frame contains a complete, safe timer row.
async function calibrate(frame,bar){
 const physical=bar?.bh/11,current=bar?.scale;
 if(!Number.isFinite(physical)||physical<.6||physical>3||!Number.isFinite(current)||Math.abs(current/physical-1)<.18)return {bar,changed:false};
 const measured={...bar,scale:physical};
 const segmentation=await S.analyze(frame,measured);
 const c=segmentation.candidate;
 if(segmentation.decision!=='accept'||!c)return {bar,changed:false,reason:'measured-row-not-confirmed'};
 const digitHeights=c.glyphs.filter(g=>/^[0-9]$/.test(g.char)).map(g=>g.height);
 if(!digitHeights.length||digitHeights.some(h=>h<7.5*physical||h>12*physical))return {bar,changed:false,reason:'font-and-bar-disagree'};
 return {bar:measured,changed:true,previousScale:current,measuredScale:physical,reason:'bar-height-and-complete-timer-row',row:c.roi};
}
module.exports={calibrate};
