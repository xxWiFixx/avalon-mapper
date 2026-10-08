'use strict';
// A narrow follow-up for an already complete pixel candidate whose binary
// number crops were unreadable. Read its numbers from the original pixels.
const R=require('./timer-recovery'),P=require('./point-verifier');
const G=require('./glyph-verifier');
let cachedModel,cachedModelPath;
function boxOf(gs,pad=1){const left=Math.min(...gs.map(g=>g.left)),top=Math.min(...gs.map(g=>g.top)),right=Math.max(...gs.map(g=>g.left+g.width)),bottom=Math.max(...gs.map(g=>g.top+g.height));return {left:left-pad,top:top-pad,width:right-left+2*pad,height:bottom-top+2*pad};}
function literal(text){const n=String(text||'').toLowerCase().replace(/\s+/g,'').replace(/h/g,'ч').replace(/m/g,'м').replace(/[cs]/g,'с').replace(/([чмс])\1+/gu,'$1');return [...n.matchAll(/(?:^|[^\d])((?:\d{1,2}[чмс]){1,2})(?!\d)/gu)].map(m=>P.token(m[1])).filter(Boolean);}
async function recover(frame,baseline,previousMethods,{ocr,excludeEpisode=null,modelPath,previousRecovery,renderCache=new Map()}={}){
 const reads=[],diagnostics={},finish=(proposal,decision,reason,candidate=null)=>({proposal,decision,reason,candidate,reads,diagnostics});
 const prev=previousRecovery,c=prev?.candidate,point=prev?.diagnostics?.point,bar=baseline?.raw?.bar;
 if(prev?.decision!=='unknown'||prev?.reason!=='cleaned-number-block-not-confirmed'||point?.decision!=='unknown'||point?.reason!=='number-block-not-confirmed')return finish(null,'unknown','original-block-followup-not-applicable');
 if(!bar||!baseline?.name||!c||typeof ocr!=='function')return finish(null,'unknown','portal-candidate-or-ocr-missing');
 const parsed=P.token(c.text),gs=c.glyphs;if(!parsed||parsed.seconds!==c.seconds||gs?.length!==parsed.text.length||gs.some((g,i)=>g.char!==parsed.text[i]))return finish(null,'reject','candidate-format-mismatch');
 if(gs.some(g=>g.left<0||g.top<0||g.width<=0||g.height<=0||g.left+g.width>frame.width||g.top+g.height>frame.height))return finish(null,'reject','candidate-outside-frame');
 const pd=point.diagnostics;
 if(!pd.closingRowPosition||!pd.fullScan?.stable||pd.fullScan.glyphCount!==gs.length||pd.geometryMasks?.length!==2||pd.geometryMasks.some(m=>m.reason||m.count!==gs.length)||pd.units?.length!==parsed.blocks.length)return finish(null,'unknown','previous-structural-gates-incomplete');
 if(pd.blocks?.some(b=>b.observations?.some(o=>o.valid&&o.text!==b.block.digits)))return finish(null,'reject','previous-number-conflict');
 if(pd.blocks?.some(b=>b.digits?.some((digit,i)=>/^\d$/.test(String(digit))&&String(digit)!==b.block.digits[i])))return finish(null,'reject','previous-single-digit-conflict');
 const s=Math.max(.6,Math.min(3,bar.bh/11||bar.scale||1)),contextBox={left:Math.max(0,Math.round(bar.bx+115*s)),top:Math.round(bar.by+bar.bh+5*s),width:Math.round(190*s),height:Math.round(24*s)};
 // Recheck current frame components; never trust a candidate when pixels have
 // been replaced or the visible line has lost a character after its discovery.
 const cleaned=R.foregroundFrame(frame,contextBox,c.threshold,c.chroma),roi={...c.roi,left:c.roi.left-1,top:c.roi.top-1,width:c.roi.width+2,height:c.roi.height+2};
 const e=G.extract(cleaned,bar,{threshold:110,timerRegion:roi});
 if(e.reason||e.glyphs.length!==gs.length||e.glyphs.some((g,i)=>Math.abs(g.left-gs[i].left)>2*s||Math.abs(g.left+g.width-gs[i].left-gs[i].width)>2*s||Math.abs(g.top+g.height-gs[i].top-gs[i].height)>2*s))return finish(null,'reject','source-components-changed');
 if(!cachedModel||cachedModelPath!==modelPath){cachedModel=G.loadModel(modelPath);cachedModelPath=modelPath;}
 const model=cachedModel,units=[];
 for(const block of parsed.blocks){const g=e.glyphs[block.unitIndex],match=G.classify(g,model,{excludeEpisode});units.push({unit:block.unit,match});if(match.char!==block.unit||match.score>.15||match.margin<.06||g.relativeHeight>.92)return finish(null,'unknown','current-unit-shape-not-confirmed',c);}
 diagnostics.units=units;
 async function read(name,box,local,whitelist,psm=7){const text=await ocr(await R.blueImage(frame,box,local,renderCache),{psm,whitelist});reads.push({name,box,local,psm,text,source:'original-blue-channel'});return text;}
 const full=await read('original-complete-token',boxOf(gs,2),false,'0123456789чЧмМсСhHmMsS'),fullToken=P.token(full);
 if(!fullToken||fullToken.text!==parsed.text)return finish(null,fullToken?'reject':'unknown','original-complete-token-not-confirmed',c);
 const cb={left:contextBox.left,top:Math.round(c.roi.top-2*s),width:contextBox.width,height:Math.round(c.roi.height+4*s)},context=await read('original-closing-context',cb,true,''),tokens=literal(context);
 if(!/з[аоa]кро|closes|close\b/iu.test(context)||!tokens.some(t=>t.text===parsed.text)||tokens.some(t=>t.seconds!==parsed.seconds))return finish(null,'unknown','full-closing-context-not-confirmed',c);
 const blocks=[];
 for(const block of parsed.blocks){const box=boxOf(gs.slice(block.start,block.unitIndex),1),observations=[];
  for(const local of[false,true]){const text=String(await read('original-number-block',box,local,'0123456789')).replace(/\s+/g,'');observations.push({local,text,valid:/^\d{1,2}$/.test(text)&&text.length===block.digits.length});}
  blocks.push({block,observations});diagnostics.blocks=blocks;
  if(observations.some(o=>o.valid&&o.text!==block.digits))return finish(null,'reject','original-number-block-conflict',c);
  if(!observations.some(o=>o.valid&&o.text===block.digits))return finish(null,'unknown','original-number-block-unreadable',c);
  const pairText=await read('original-number-with-unit',boxOf(gs.slice(block.start,block.unitIndex+1),1),false,'0123456789чЧмМсСhHmMsS'),pair=P.token(pairText);
  if(pair&&(pair.blocks.length!==1||pair.blocks[0].unit!==block.unit||+pair.blocks[0].digits!==+block.digits))return finish(null,'reject','original-number-with-unit-conflict',c);
  let unitRead=await read('original-unit',boxOf([gs[block.unitIndex]],1),false,'чЧмМсСhHmMsS',10),unitToken=P.token('0'+String(unitRead||'').replace(/\s+/g,''));
  if(!unitToken){const box=boxOf([gs[block.unitIndex]],1);unitRead=await ocr(await P.render(cleaned,box,'mask'),{psm:10,whitelist:'чЧмМсСhHmMsS'});reads.push({name:'cleaned-unit',box,text:unitRead,source:'locally-cleaned-frame'});unitToken=P.token('0'+String(unitRead||'').replace(/\s+/g,''));}
  if(unitToken&&unitToken.blocks.length===1&&unitToken.blocks[0].unit!==block.unit)return finish(null,'reject','original-unit-conflict',c);
  if(!pair&&(!unitToken||unitToken.blocks.length!==1||unitToken.blocks[0].unit!==block.unit))return finish(null,'unknown','original-unit-unreadable',c);
  blocks.at(-1).pairText=pairText;blocks.at(-1).unitRead=unitRead;
 }
 diagnostics.structuralSource='unchanged-frozen-point-verifier';diagnostics.independence='All readings are transformations of one screenshot; frozen pixel templates and OCR are different algorithms, not independent measurements.';
 return finish(parsed.seconds,'accept','original-number-blocks-confirmed-after-binary-abstention',c);
}
module.exports={recover};
