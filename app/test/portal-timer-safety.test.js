'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadRecovery}=require('./helpers/isolated-portal-recovery');
const C=loadRecovery(),{unitFragmentAlignment:align}=C.recovery('point-verifier'),guard=C.recovery('timer-conflict');
const g=(left,width,height,char)=>({left,top:10-height,width,height,char,safe:true});
const glyphs=[g(0,3,9,'1'),g(6,6,9,'5'),g(16,7,7,'ч'),g(27,7,9,'0'),g(37,6,9,'2'),g(47,8,7,'м')];
const split=[...glyphs.slice(0,2),g(16,3,5),g(20,3,7),...glyphs.slice(3)];
test('a split unit is covered entirely and numbers remain separate',()=>assert.equal(align({glyphs:split},glyphs,1),true));
test('an extra leading digit cannot be discarded',()=>assert.equal(align({glyphs:[g(-5,2,9,'1'),...split]},glyphs,1),false));
test('splitting or merging a numerical symbol is forbidden',()=>{
 const digits=[...split];digits.splice(0,1,g(0,1,9),g(2,1,9));assert.equal(align({glyphs:digits},glyphs,1),false);
});
test('missing and out-of-box parts cannot count as alignment',()=>{
 assert.equal(align({glyphs:split.slice(1)},glyphs,1),false);
 assert.equal(align({glyphs:[...split,g(24,2,7)]},glyphs,1),false);
 assert.equal(align({reason:'foreign-symbol',glyphs:split},glyphs,1),false);
});
const cand=(text,seconds)=>({text,seconds,glyphs:[...text].map(char=>({char,safe:true}))});
const seg=list=>({diagnostics:{attempts:[{candidates:list}]}}),retained={proposal:540,reason:'baseline-retained-unverified'};
test('all complete candidates contradict a retained timer',()=>assert.equal(guard.contradictsRetained(retained,seg([cand('19м',1140),cand('11ч09м',40140)])),true));
test('no evidence, a matching alternative, unsafe and malformed glyphs do not veto',()=>{
 assert.equal(guard.contradictsRetained(retained,seg([])),false);
 assert.equal(guard.contradictsRetained(retained,seg([cand('9м',540),cand('11ч09м',40140)])),false);
 const unsafe=cand('19м',1140);unsafe.glyphs[0].safe=false;
 assert.equal(guard.contradictsRetained(retained,seg([unsafe,cand('19м',540)])),false);
 assert.equal(guard.contradictsRetained({...retained,reason:'confirmed'},seg([cand('19м',1140)])),false);
});
test('later fallback cannot resurrect a vetoed timer or call OCR',async()=>{
 let calls=0;const p=C.recovery('pipeline-v5').createPipeline({DICT:['Example'],crop(){},findBarCands(){}});
 const r=await p.evaluate({},null,{}, {proposal:null,reason:guard.REASON},{ocr:async()=>{calls++;throw Error('must not run');}});
 assert.equal(r.final.proposal,null);assert.equal(r.final.reason,guard.REASON);assert.equal(r.stage,'previous-conflict-preserved');assert.equal(calls,0);
});
test('pipeline wiring rejects contradictory retention but accepts a verified replacement',async()=>{
 const isolated=loadRecovery(),segmentation=isolated.recovery('segmentation'),point=isolated.recovery('point-verifier'),v3=isolated.recovery('pipeline-v3');
 const complete=cand('15ч02м',54120),baseline={name:'Example',closes:18120,raw:{bar:{bx:0,by:0,bh:11},timerReads:[]}};
 segmentation.analyze=async()=>({...seg([complete]),decision:'accept',proposal:54120,candidate:complete});
 point.verify=async()=>({decision:'unknown',proposal:null,reason:'unstable-candidate-components'});
 let r=await v3.evaluate({},baseline,{},{});assert.equal(r.final.proposal,null);assert.equal(r.final.reason,guard.REASON);
 point.verify=async()=>({decision:'accept',proposal:54120});
 r=await v3.evaluate({},baseline,{},{});assert.equal(r.final.proposal,54120);assert.equal(r.stage,'value-recovered');
 point.verify=async()=>({decision:'reject',proposal:null,reason:'number-block-disagrees'});
 r=await v3.evaluate({},baseline,{},{});assert.equal(r.final.proposal,null);
 segmentation.analyze=async()=>({...seg([cand('19м',1140),cand('11ч09м',40140)]),decision:'unknown',proposal:null});
 r=await v3.evaluate({},baseline,{},{});assert.equal(r.final.proposal,null);assert.equal(r.final.reason,guard.REASON);
 segmentation.analyze=async()=>({...seg([cand('5ч02м',18120),complete]),decision:'unknown',proposal:null});
 r=await v3.evaluate({},baseline,{},{});assert.equal(r.final.proposal,18120);
});
test('existing red and strongly confirmed timers keep their fast paths',async()=>{
 const isolated=loadRecovery(),segmentation=isolated.recovery('segmentation'),v3=isolated.recovery('pipeline-v3');
 segmentation.analyze=async()=>{throw Error('unexpected slow path');};
 const baseline={name:'Example',closes:18120,raw:{bar:{bx:0,by:0,bh:11},timerRegion:{kind:'red'}}};
 assert.equal((await v3.evaluate({},baseline,{},{})).final.proposal,18120);
 baseline.raw.timerRegion.kind='light';
 assert.equal((await v3.evaluate({},baseline,{completeness:{decision:'accept',proposal:18120},glyph:{proposal:18120}},{})).stage,'already-confirmed-v2');
});
