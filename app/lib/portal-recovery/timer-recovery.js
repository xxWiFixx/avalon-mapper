'use strict';
// Offline fallback for a faint timer blended with a colored map underneath.
// A wider row and color-tolerant foreground mask preserve the original glyphs;
// no expected value, portal name or archive identity drives the decision.
const F=require('../frame'),sharp=require('sharp');
const sha256=data=>require('node:crypto').createHash('sha256').update(data).digest('hex');
const S=require('./segmentation'),G=require('./glyph-verifier'),P=require('./point-verifier');
let model,loadedPath;
function runs(mask,width,height){const out=[];let start=-1;for(let x=0;x<=width;x++){let n=0;if(x<width)for(let y=0;y<height;y++)n+=mask[y*width+x];if(n&&start<0)start=x;if(!n&&start>=0){out.push([start,x]);start=-1;}}return out;}
function maskedData(frame,roi){const d=F.region(frame,roi.left,roi.top,roi.width,roi.height);if(!d)return null;
 // v4 discarded S.masks()'s local contrast array and five old masks. Read only
 // the identical RGB minima/spreads used by its six color masks.
 d.v=new Float32Array(d.width*d.height);d.chroma=new Float32Array(d.v.length);
 for(let i=0;i<d.v.length;i++){const r=d.buf[i*4],g=d.buf[i*4+1],b=d.buf[i*4+2];d.v[i]=Math.min(r,g,b);d.chroma[i]=Math.max(r,g,b)-d.v[i];}
 d.variants=[];for(const threshold of[75,90,105])for(const chroma of[90,110]){
 const mask=new Uint8Array(d.width*d.height);for(let i=0;i<mask.length;i++)mask[i]=d.v[i]>=threshold&&d.chroma[i]<chroma?1:0;
 d.variants.push({key:`color-${threshold}-${chroma}`,mask,runs:runs(mask,d.width,d.height),threshold,chroma});}return d;}
function exactGlyphCache(data){
 // Within one ROI the model, excluded episode and scale are fixed. Identical
 // glyph pixels + dimensions + line height produce the identical classifier
 // input, even if found at another position or in another threshold mask.
 const aliases=new Map(),values=new Map(),masks=new Map(data.variants.map(v=>[v.key,v.mask]));
 function canonical(key){if(aliases.has(key))return aliases.get(key);const [ink,coords,lineHeight]=key.split(':'),[x,y,w,h]=coords.split(',').map(Number),mask=masks.get(ink);let pixels='';
  for(let dy=0;dy<h;dy++)for(let dx=0;dx<w;dx++)pixels+=mask[(y+dy)*data.width+x+dx];
  const exact=`${w},${h},${lineHeight}:${pixels}`;aliases.set(key,exact);return exact;}
 return {get:key=>values.get(canonical(key)),set:(key,value)=>values.set(canonical(key),value)};
}
function foregroundFrame(frame,box,threshold,chroma){const result={...frame,data:Buffer.from(frame.data)},p=F.region(frame,box.left,box.top,box.width,box.height);if(!p)return null;
 for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){const at=(y*p.width+x)*4,r=p.buf[at],g=p.buf[at+1],b=p.buf[at+2],v=Math.min(r,g,b),max=Math.max(r,g,b),to=((p.top+y)*frame.width+p.left+x)*4,ink=v>=threshold&&max-v<chroma?230:25;
 result.data[to]=ink;result.data[to+1]=ink;result.data[to+2]=ink;}
 return result;}
async function blueImage(frame,box,local=false,renderCache=null){const p=F.region(frame,box.left,box.top,box.width,box.height);if(!p)return null;
 // Caller-owned per-frame/per-invocation rendering cache, never an OCR memo.
 // Without an explicit cache this public helper always computes afresh.
 const key=renderCache?`${p.left},${p.top},${p.width},${p.height},${!!local}:${sha256(p.buf)}`:null;
 if(renderCache?.has(key))return Buffer.from(renderCache.get(key));
 const pixels=Buffer.alloc(p.width*p.height);
 for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++){const i=y*p.width+x;if(!local){pixels[i]=255-p.buf[i*4+2];continue;}
  const neighbors=[];for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<p.width&&yy>=0&&yy<p.height)neighbors.push(p.buf[(yy*p.width+xx)*4+2]);}neighbors.sort((a,b)=>a-b);
  pixels[i]=255-Math.min(255,Math.max(0,p.buf[i*4+2]-neighbors[Math.floor(neighbors.length*.3)])*6);}
 const png=await sharp(pixels,{raw:{width:p.width,height:p.height,channels:1}}).normalise().resize(p.width*6,p.height*6).extend({left:16,right:16,top:16,bottom:16,background:'#fff'}).withMetadata({density:300}).png().toBuffer();
 if(renderCache)renderCache.set(key,Buffer.from(png));return png;}
async function recover(frame,baseline,previousMethods,{ocr,excludeEpisode=null,modelPath,renderCache=new Map()}={}){
 const reads=[],diagnostics={},finish=(proposal,decision,reason,candidate=null)=>({proposal,decision,reason,candidate,reads,diagnostics});
 const bar=baseline?.raw?.bar;if(!bar||!baseline?.name||typeof ocr!=='function')return finish(null,'unknown','confirmed-portal-or-ocr-missing');
 if(baseline.raw.timerRegion?.kind==='red')return finish(null,'unknown','red-timer-outside-fallback');
 if(!model||loadedPath!==modelPath){model=G.loadModel(modelPath);loadedPath=modelPath;}
 const s=Math.max(.6,Math.min(3,bar.bh/11||bar.scale||1));
 const rois=[{kind:'light',left:Math.round(bar.bx+180*s),top:Math.round(bar.by+bar.bh+9*s),width:Math.round(115*s),height:Math.round(16*s),scale:s},
 {kind:'light',left:Math.round(bar.bx+180*s),top:Math.round(bar.by+bar.bh+5*s),width:Math.round(125*s),height:Math.round(24*s),scale:s}];
 const proposals=[],attempts=[];
 for(const roi of rois){const data=maskedData(frame,roi);if(!data)continue;const cache=exactGlyphCache(data),sameInk=new Map(),sameSegmentation=new Map();
  for(const ink of data.variants){const bytes=Buffer.from(ink.mask).toString('base64');if(!sameInk.has(bytes))sameInk.set(bytes,ink.key);ink.canonicalKey=sameInk.get(bytes);}
  for(const ink of data.variants)for(const guide of data.variants){
   // segmentation uses only guide.runs, not its pixels/key. Reuse exactly equal
 // inputs, then restore original mask/guide labels and multiplicity below.
   const key=ink.canonicalKey+':'+JSON.stringify(guide.runs);let raw=sameSegmentation.get(key);
   if(!raw){raw=S.segmentation(data,{...ink,key:ink.canonicalKey},guide,roi,model,excludeEpisode,cache);sameSegmentation.set(key,raw);}
   const r={...raw,candidates:raw.candidates?.map(c=>({...c,mask:ink.key,guide:guide.key}))};
   attempts.push({roi,ink:ink.key,guide:guide.key,reason:r.reason,texts:r.candidates?.map(c=>c.text)||[]});
   for(const c of r.candidates||[])proposals.push({...c,scale:s,threshold:ink.threshold,chroma:ink.chroma,searchBox:roi});}}
 const supported=proposals.filter(p=>proposals.some(q=>p.mask!==q.mask&&S.compatible(p,q,s)));
 const values=[...new Set(supported.map(p=>p.seconds))];diagnostics.segmentation={rois,attempts,candidateCount:proposals.length,supportedCount:supported.length,values};
 if(values.length!==1)return finish(null,values.length>1?'reject':'unknown',values.length>1?'color-segmentation-conflict':'no-complete-color-segmentation');
 // Confident shorter suffixes in another color mask are not enough to select a
 // value. Every accepted segmentation must retain the same complete text.
 if(proposals.some(p=>p.seconds!==values[0]))return finish(null,'reject','color-masks-disagree-on-completeness');
 const candidate=supported.slice().sort((a,b)=>Math.max(...a.glyphs.map(g=>g.score))-Math.max(...b.glyphs.map(g=>g.score)))[0];
 candidate.excludeEpisode=excludeEpisode;
 // Independently preprocess the original blue channel, preserving every source
 // pixel instead of the binary mask, and require a complete explicit token.
 const box={...candidate.roi,left:candidate.roi.left-2,top:candidate.roi.top-2,width:candidate.roi.width+4,height:candidate.roi.height+4};
 const text=await ocr(await blueImage(frame,box,false,renderCache),{psm:7,whitelist:'0123456789чЧмМсСhHmMsS'}),token=P.token(text);
 reads.push({name:'original-blue-full-line',text,box});diagnostics.originalToken=token;
 if(!token||token.text!==candidate.text)return finish(null,token?'reject':'unknown','original-color-line-not-confirmed',candidate);
 const contextReadBox={left:Math.max(0,Math.round(bar.bx+115*s)),top:Math.round(candidate.roi.top-2*s),width:Math.round(190*s),height:Math.round(candidate.roi.height+4*s)};
 const contextText=await ocr(await blueImage(frame,contextReadBox,true,renderCache),{psm:7});
 reads.push({name:'original-blue-closing-context',text:contextText,box:contextReadBox});
 const normalized=contextText.toLowerCase().replace(/\s+/g,'').replace(/h/g,'ч').replace(/m/g,'м').replace(/[cs]/g,'с').replace(/([чмс])\1+/gu,'$1');
 const literal=[...normalized.matchAll(/(?:^|[^\d])((?:\d{1,2}[чмс]){1,2})(?!\d)/gu)].map(m=>P.token(m[1])).filter(Boolean);
 if(!/з[аоa]кро|closes|close\b/iu.test(contextText)||!literal.some(t=>t.text===candidate.text)||literal.some(t=>t.seconds!==candidate.seconds))return finish(null,'unknown','full-closing-context-not-confirmed',candidate);
 const contextBox={kind:'light',left:Math.max(0,Math.round(bar.bx+115*s)),top:Math.round(bar.by+bar.bh+5*s),width:Math.round(190*s),height:Math.round(24*s)};
 const cleaned=foregroundFrame(frame,contextBox,candidate.threshold,candidate.chroma);
 // A partial gold bar must not crop a visibly complete timer. This local search
 // extent is derived from the measured glyph edge; it is not saved as capacity
 // or used to change the source bar coordinates.
 const verificationBar={...bar,span:Math.max(bar.span||0,candidate.roi.left+candidate.roi.width-bar.bx+4*s)};
 diagnostics.verificationSearchSpan=verificationBar.span;
 const observedBaseline={...baseline,raw:{...baseline.raw,timerReads:[...(baseline.raw.timerReads||[]),{text,family:'original-blue-full-line'},{text:contextText,family:'original-blue-closing-context'}]}};
 // Original pixels have not lost strokes to thresholding. A complete point
 // verification here is sufficient; every digit, unit and outside edge is still
 // checked. The cleaned image remains a fallback, never a veto of this proof.
 const originalPoint=await P.verify(frame,verificationBar,{candidate,ocr,baseline:observedBaseline,previousMethods});
 reads.push(...originalPoint.reads.map(r=>({...r,source:'original-frame'})));diagnostics.originalPoint=originalPoint;
 if(originalPoint.decision==='accept'&&originalPoint.proposal===candidate.seconds)return finish(candidate.seconds,'accept','complete-color-pixels-and-original-point-verification',candidate);
 if(originalPoint.decision==='reject')return finish(null,'reject','original-'+originalPoint.reason,candidate);
 const point=await P.verify(cleaned,verificationBar,{candidate,ocr,baseline:observedBaseline,previousMethods});
 reads.push(...point.reads.map(r=>({...r,source:'locally-cleaned-frame'})));diagnostics.point=point;
 if(point.decision!=='accept'||point.proposal!==candidate.seconds)return finish(null,point.decision==='reject'?'reject':'unknown','cleaned-'+point.reason,candidate);
 return finish(candidate.seconds,'accept','complete-color-pixels-and-original-ocr-agree',candidate);
}
module.exports={recover,maskedData,foregroundFrame,blueImage};
