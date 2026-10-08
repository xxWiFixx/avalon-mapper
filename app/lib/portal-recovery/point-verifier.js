'use strict';
// Offline candidate verification. Expected digits are never sent to OCR as a
// whitelist; the callback always reads an entire numerical alphabet.
const F=require('../frame'),sharp=require('sharp');
const G=require('./glyph-verifier');
const oldLayout=require('./completeness').layout;
const imageTools=require('./completeness-image');
let model;
const norm=text=>String(text||'').trim().replace(/\s+/g,'');
const unit=text=>norm(text).toLowerCase().replace(/h/g,'ч').replace(/m/g,'м').replace(/[cs]/g,'с').replace(/([чмс])\1+/gu,'$1');
function token(text){
 const t=unit(text),groups=[...t.matchAll(/(\d{1,2})([чмс])/gu)];
 if(!groups.length||groups.map(m=>m[0]).join('')!==t)return null;
 const form=groups.map(m=>m[2]).join('');
 if(!['ч','м','с','чм','мс'].includes(form))return null;
 let sec=0,offset=0;const blocks=[];
 for(const m of groups){const n=+m[1],u=m[2];if(u==='ч'?n>24:n>=60)return null;
  sec+=n*(u==='ч'?3600:u==='м'?60:1);blocks.push({digits:m[1],unit:u,start:offset,unitIndex:offset+m[1].length});offset+=m[0].length;}
 return sec<=86400?{text:t,seconds:sec,blocks}:null;
}
function join(gs,pad=1){const l=Math.min(...gs.map(g=>g.left)),t=Math.min(...gs.map(g=>g.top)),r=Math.max(...gs.map(g=>g.left+g.width)),b=Math.max(...gs.map(g=>g.top+g.height));return{left:l-pad,top:t-pad,width:r-l+2*pad,height:b-t+2*pad};}
function similar(a,b,s){return Math.abs(a.left-b.left)<=2*s&&Math.abs(a.left+a.width-b.left-b.width)<=2*s&&Math.abs(a.top+a.height-b.top-b.height)<=2*s;}
// Thresholding can split a thin unit (notably ч) into two strokes. Account for
// every component; never remove an extra digit or merge numerical glyphs.
function unitFragmentAlignment(extraction,gs,s){
 if(extraction.reason||extraction.glyphs.length<=gs.length||extraction.glyphs.length>gs.length+2)return false;
 const groups=gs.map(()=>[]);
 for(const part of extraction.glyphs){
  const matches=gs.map((g,i)=>part.left>=g.left-1&&part.left+part.width<=g.left+g.width+1?i:-1).filter(i=>i>=0);
  if(matches.length!==1)return false;
  groups[matches[0]].push(part);
 }
 return groups.every((parts,i)=>{
  if(parts.length===1)return similar(parts[0],gs[i],s);
  if(parts.length!==2||!/[чмс]/u.test(gs[i].char||'')||parts.some(p=>p.height>gs[i].height+1))return false;
  const gap=parts[1].left-parts[0].left-parts[0].width;
  return gap>=0&&gap<=2*s&&similar(join(parts,0),gs[i],s);
 });
}
async function render(frame,box,mode='gray'){
 if(mode!=='mask')return imageTools.image(frame,box,mode,6);
 const p=F.region(frame,box.left,box.top,box.width,box.height),raw=Buffer.alloc(p.width*p.height);
 const threshold=105;
 for(let i=0;i<raw.length;i++){const r=p.buf[4*i],g=p.buf[4*i+1],b=p.buf[4*i+2];raw[i]=Math.min(r,g,b)>threshold&&Math.max(r,g,b)-Math.min(r,g,b)<65?0:255;}
 return sharp(raw,{raw:{width:p.width,height:p.height,channels:1}}).resize(p.width*6,p.height*6,{kernel:'nearest'}).extend({left:16,right:16,top:16,bottom:16,background:'#fff'}).withMetadata({density:300}).png().toBuffer();
}

async function verify(frame,bar,{candidate,ocr,baseline=null,previousMethods=null,geometryMode='default'}={}){
 const reads=[],diagnostics={};
 const finish=(proposal,decision,reason)=>({proposal,decision,reason,reads,diagnostics});
 if(!candidate||!bar||typeof ocr!=='function')return finish(null,'unknown','candidate-or-ocr-unavailable');
 const parsed=token(candidate.text),gs=candidate.glyphs,roi=candidate.roi;
 if(!parsed||parsed.seconds!==candidate.seconds||!Array.isArray(gs)||gs.length!==parsed.text.length||!roi)return finish(null,'reject','candidate-format-or-geometry-mismatch');
 if(gs.some((g,i)=>g.char&&unit(g.char)!==parsed.text[i]))return finish(null,'reject','candidate-characters-disagree');
 if(gs.some(g=>![g.left,g.top,g.width,g.height].every(Number.isFinite)||g.width<=0||g.height<=0||g.left<0||g.top<0||g.left+g.width>frame.width||g.top+g.height>frame.height))return finish(null,'reject','candidate-outside-frame');
 const s=Math.max(.6,bar.scale||1),h=Math.max(...gs.map(g=>g.height));
 const linePosition=roi.top>=bar.by+bar.bh&&roi.top+roi.height<=bar.by+bar.bh+40*s&&roi.left>=bar.bx+170*s&&roi.left+roi.width<=bar.bx+Math.max(bar.span||270,270*s)+15*s;
 diagnostics.closingRowPosition=linePosition;
 if(!linePosition)return finish(null,'reject','candidate-outside-closing-row');
 if(!baseline?.name)return finish(null,'unknown','portal-name-not-confirmed');
 if(gs.some((g,i)=>i&&g.left<gs[i-1].left+gs[i-1].width)||gs.some(g=>g.left<roi.left-1||g.top<roi.top-1||g.left+g.width>roi.left+roi.width+1||g.top+g.height>roi.top+roi.height+1))return finish(null,'reject','candidate-overlap-or-cut-edge');
 const scan=oldLayout(frame,bar,roi);diagnostics.fullScan={stable:scan.stable,reason:scan.reason,glyphCount:scan.glyphs?.length};
 if(scan.stable&&(scan.glyphs.length!==gs.length||!scan.glyphs.every((g,i)=>similar(g,gs[i],s))))return finish(null,'reject','full-line-does-not-match-candidate');
 // Re-extract without labels. All supplied boxes must account for the pixel
 // components, and the original frame still supplies neighboring edge pixels.
 const checks=[];
 const thresholds=geometryMode==='local'?[150,170]:[110,130];
 for(const threshold of thresholds){const e=G.extract(frame,bar,{threshold,timerRegion:{...roi,left:roi.left-1,top:roi.top-1,width:roi.width+2,height:roi.height+2}});checks.push(e);}
 const aligned=checks.filter(e=>!e.reason&&e.glyphs.length===gs.length&&e.glyphs.every((g,i)=>similar(g,gs[i],s)));
 diagnostics.geometryMasks=checks.map(e=>({count:e.glyphs.length,reason:e.reason}));
 const fragmentAligned=checks.filter(e=>unitFragmentAlignment(e,gs,s));
 diagnostics.unitFragmentMasks=fragmentAligned.length;
 if(!aligned.length||aligned.length+fragmentAligned.length<2)return finish(null,'unknown','unstable-candidate-components');
 const e=aligned[0];
 const bottom=Math.max(...e.glyphs.map(g=>g.top+g.height));
 for(const side of['left','right']){
  const box={...roi,left:side==='left'?gs[0].left-16*s:gs.at(-1).left+gs.at(-1).width,width:16*s};
  const edge=G.extract(frame,bar,{threshold:110,timerRegion:box});
  const outside=edge.glyphs.filter(g=>g.height>=h*.84&&g.width<=12*s&&Math.abs(g.top+g.height-bottom)<=2*s&& (side==='left'?gs[0].left-g.left-g.width:g.left-gs.at(-1).left-gs.at(-1).width)<=7*s);
  if(outside.length){diagnostics.outside={side,glyphs:outside.map(({vector,...g})=>g)};return finish(null,'reject','unassigned-symbol-outside-candidate');}
 }
 model ||= G.loadModel();
 const unitMatches=[];
 for(const block of parsed.blocks){
  const i=block.unitIndex,match=G.classify(e.glyphs[i],model,{excludeEpisode:candidate.excludeEpisode});
  unitMatches.push({index:i,unit:block.unit,match});
  if(match.char!==block.unit||match.score>.15||match.margin<.06||e.glyphs[i].relativeHeight>.92)return finish(null,'unknown','unit-shape-not-confirmed');
 }
 diagnostics.units=unitMatches;
 // Literal digit/unit tokens only: no parseBottom repairs such as 4 -> ч,
 // inferred missing minutes or letter-to-number substitutions are allowed.
 const priorExactTokens=(baseline?.raw?.timerReads||[]).filter(r=>{
  const raw=unit(r.text||'');
  const matches=[...raw.matchAll(/(?:^|[^\d])((?:\d{1,2}[чмс]){1,2})(?!\d)/gu)];
  return matches.some(m=>{const t=token(m[1]);return t&&t.text===parsed.text&&t.seconds===parsed.seconds;});
 });
 diagnostics.priorExplicitCompleteRead=priorExactTokens.length>0;
 async function read(name,box,mode,psm,whitelist){const text=await ocr(await render(frame,box,mode),{psm,whitelist});reads.push({name,box,mode,psm,text});return text;}
 const blocks=[];
 for(const block of parsed.blocks){
  const numberGlyphs=gs.slice(block.start,block.unitIndex),numberBox=join(numberGlyphs,1),pairBox=join(gs.slice(block.start,block.unitIndex+1),1);
  const observations=[];
  for(const mode of['gray','mask']){
   const text=norm(await read('number-block',numberBox,mode,7,'0123456789'));
   observations.push({mode,text,valid:/^\d{1,2}$/.test(text)&&text.length===block.digits.length});
  }
  let valid=observations.filter(r=>r.valid),values=[...new Set(valid.map(r=>r.text))];
  if(values.length>1||values.some(v=>v!==block.digits)){diagnostics.blocks=blocks.concat({block,observations});return finish(null,'reject','number-block-disagrees');}
  if(!values.length){
   const digits=[];
   for(const g of numberGlyphs){const t=norm(await read('single-digit',join([g],1),'gray',10,'0123456789'));digits.push(t);}
   if(digits.some(t=>!/^\d$/.test(t))){diagnostics.blocks=blocks.concat({block,observations,digits});return finish(null,'unknown','number-block-not-confirmed');}
   if(digits.join('')!==block.digits){diagnostics.blocks=blocks.concat({block,observations,digits});return finish(null,'reject','single-digits-disagree');}
   observations.push({mode:'split-digits',text:digits.join(''),valid:true});
  }
  const pairText=unit(await read('number-with-unit',pairBox,'gray',7,'0123456789чЧмМсСhHmMsS'));
  const pairParsed=token(pairText),unitText=unit(await read('unit',join([gs[block.unitIndex]],1),'mask',10,'чЧмМсСhHmMsS'));
  const unitObservations=[unitText];
  // The separate number-block gate has already confirmed every visible digit.
  // The auxiliary number+unit read may omit a leading zero, but must preserve
  // the value, the unit and exactly one block (31 -> 1 remains a conflict).
  const pairMatches=!!pairParsed&&pairParsed.blocks.length===1&&pairParsed.blocks[0].unit===block.unit&&Number(pairParsed.blocks[0].digits)===Number(block.digits);
  if(pairParsed&&!pairMatches)return finish(null,'reject','number-with-unit-disagrees');
  let unitConfirmed=pairMatches||unitText===block.unit||priorExactTokens.length>0;
  if(!unitConfirmed)for(const mode of['gray','soft']){const t=unit(await read('unit-fallback',join([gs[block.unitIndex]],1),mode,8,'чЧмМсСhHmMsS'));unitObservations.push(t);if(t===block.unit){unitConfirmed=true;break;}}
  if(unitObservations.some(t=>/^[чмс]$/u.test(t)&&t!==block.unit))return finish(null,'reject','unit-readings-conflict');
  blocks.push({block,observations,pairText,unitText,unitObservations,unitConfirmed});
  if(!unitConfirmed){diagnostics.blocks=blocks;return finish(null,'unknown','unit-ocr-not-confirmed');}
 }
 diagnostics.blocks=blocks;
 // A recovered timer must belong to the closing-time line. Reuse only textual
 // observations, never their numeric answers, then seek fresh context if needed.
 const contextTexts=[...(baseline?.raw?.timerReads||[]),...(previousMethods?.completeness?.reads||[])].map(r=>r.text||'');
 let context=contextTexts.some(t=>/з[аоa]кро|closes|close\b/iu.test(t));
 const explicitPortalContext=!!baseline?.name&&linePosition&&priorExactTokens.length>0;
 if(!context&&!explicitPortalContext){const box={...roi,left:Math.max(0,roi.left-180*s),width:roi.width+Math.min(roi.left,180*s)};const text=await read('closing-context',box,'gray',7,'');contextTexts.push(text);context=/з[аоa]кро|closes|close\b/iu.test(text);}
 const anchoredContext=!context&&!explicitPortalContext&&require('./closing-anchor').confirms(frame,bar,candidate,contextTexts);
 diagnostics.contextEvidence=context?'closing-label':explicitPortalContext?'confirmed-portal-closing-row-and-prior-explicit-token':null;
 if(anchoredContext)diagnostics.contextEvidence='label-word-and-measured-closing-row-after-full-point-verification';
 context ||= explicitPortalContext||anchoredContext;
 diagnostics.contextConfirmed=context;
 if(!context)return finish(null,'unknown','closing-context-unconfirmed');
 return finish(parsed.seconds,'accept','numeric-blocks-units-and-full-line-confirmed');
}
module.exports={verify,token,render,unitFragmentAlignment};
