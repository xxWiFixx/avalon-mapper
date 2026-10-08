const {test}=require('node:test'),assert=require('node:assert/strict');
const content=require('../lib/content-search'),router=require('../lib/router');
const now=1000000;
const E=(a,b,seconds=10000,maps=['local'])=>({a,b,expiresAt:now+seconds*1000,maps});
const options={now,worldAdjacency:{zones:{}},zoneColor:()=> 'avalon',avalonCrossSec:10,loadSec:0,safetyMarginSec:0,riskPenaltySec:0};
test('content filters: count, tier, AND/OR, closed/reference and map scope',()=>{
  const rows=[{name:'A',tier:6,res:{ore:{n:4}},chests:{blueBig:1}},{name:'B',tier:8,res:{ore:{n:2}},chests:{goldSmall:1}},{name:'C',tier:6,chests:{blueSmall:2}}];
  const snap={edges:[E('A','D'),E('B','E',1000,['group']),E('C','F',-1)]};
  const req={now,scope:'local',goals:[{type:'ore'},{type:'blue',tier:6}]};
  assert.deepEqual(content.search(snap,req,rows).matches.map(z=>z.name),['A']);
  assert.deepEqual(content.search(snap,{...req,includeClosed:true,sort:'name'},rows).matches.map(z=>z.name),['A','B','C']);
  assert.deepEqual(content.search(snap,{...req,includeClosed:true,match:'all'},rows).matches.map(z=>z.name),['A']);
  assert.deepEqual(content.goalSets(snap,req,rows),[['A'],['A']]);
  assert.throws(()=>content.goals([{type:'unknown'}]));
  assert.equal(content.amount(rows[1],{type:'gold',tier:6}),0);
});
test('ordered waypoints may revisit nodes; ETA is cumulative',()=>{
  const r=router.findPlan({edges:[E('A','B'),E('B','C'),E('B','D')]},'A',{waypoints:['C'],to:'D'},options);
  assert.equal(r.found,true);assert.deepEqual(r.steps.map(s=>s.to),['B','C','B','D']);
  assert.deepEqual(r.steps.map(s=>s.etaSec),[10,20,30,40]);
});
test('all-in-one routes to the nearest reachable joint match instead of separate content zones',()=>{
  const rows=[{name:'Ore',tier:6,res:{ore:{n:2}}},{name:'Chest',tier:6,chests:{blueBig:1}},
    {name:'Both',tier:6,res:{ore:{n:1}},chests:{blueSmall:1}},
    {name:'Disconnected',tier:6,res:{ore:{n:2}},chests:{blueBig:1}}];
  const snap={edges:[E('Start','Ore'),E('Ore','Chest'),E('Start','X'),E('X','Y'),E('Y','Both'),E('Disconnected','Island')]};
  const request={now,scope:'local',goals:[{type:'ore'},{type:'blue'}],match:'all'};
  const goalSets=content.goalSets(snap,request,rows);
  assert.deepEqual(goalSets,[['Both','Disconnected']]);
  assert.deepEqual(content.search(snap,request,rows).matches.map(z=>z.name).sort(),goalSets[0].slice().sort());
  const all=router.findPlan(snap,'Start',{goalSets},options);
  assert.equal(all.found,true);assert.deepEqual(all.steps.map(s=>s.to),['X','Y','Both']);
  const separate=router.findPlan(snap,'Start',{goalSets:content.goalSets(snap,{...request,match:'any'},rows)},options);
  assert.equal(separate.found,true);assert.deepEqual(separate.steps.map(s=>s.to),['Ore','Chest']);
  assert.equal(router.findPlan(snap,'Both',{goalSets},options).hops,0);
  const incompatible=content.goalSets(snap,{...request,goals:[{type:'ore',tier:6},{type:'blue',tier:8}]},rows);
  assert.deepEqual(incompatible,[[]]);assert.equal(router.findPlan(snap,'Start',{goalSets:incompatible},options).found,false);
});
test('goals are optimized jointly, not greedily nearest-first',()=>{
  const snap={edges:[E('A','B'),E('A','X'),E('X','Y'),E('Y','Z'),E('Z','C')]};
  const r=router.findPlan(snap,'A',{goalSets:[['B','Z'],['C']]},options);
  assert.equal(r.found,true);assert.deepEqual(r.steps.map(s=>s.to),['X','Y','Z','C']);
});
test('one zone satisfies several goals including at start',()=>{
  const r=router.findPlan({edges:[E('A','B')]},'A',{goalSets:[['A'],['A']]},options);
  assert.equal(r.found,true);assert.equal(r.hops,0);
});
test('later portal expiry is checked after earlier waypoints',()=>{
  const snap={edges:[E('A','B'),E('B','C'),E('C','D',25)]};
  assert.equal(router.findRoute(snap,'C','D',options).found,true);
  assert.equal(router.findPlan(snap,'A',{waypoints:['C'],to:'D'},options).found,false);
});
test('final destination remains final even if visited before content',()=>{
  const r=router.findPlan({edges:[E('A','B'),E('B','C')]},'A',{to:'B',goalSets:[['C']]},options);
  assert.deepEqual(r.steps.map(s=>s.to),['B','C','B']);assert.equal(r.to,'B');
});
test('missing/unreachable targets and invalid plans fail clearly',()=>{
  const snap={edges:[E('A','B'),E('C','D')]};
  assert.equal(router.findPlan(snap,'A',{goalSets:[[]]},options).reasonCode,'missing-content');
  assert.equal(router.findPlan(snap,'A',{goalSets:[['C']]},options).found,false);
  assert.equal(router.findPlan(snap,'A',{waypoints:Array(7).fill('B')},options).reasonCode,'invalid-plan');
});
test('catalog has real ore and chest goals',()=>{
  const rows=content.catalog();assert.ok(rows.some(z=>content.amount(z,{type:'ore'})>0));
  assert.ok(rows.some(z=>content.amount(z,{type:'blue'})>0));assert.ok(rows.some(z=>content.amount(z,{type:'gold'})>0));
});
test('worker service uses the scoped map and returns an English failure',async()=>{
  const service=require('../lib/planner-service');
  const opts={now,language:'en',worldAdjacency:{zones:{}},allowWalk:false,avalonZones:['A','B']};
  const found=await service.plan({edges:[E('A','B')]},{from:'A',to:'B',scope:'local'},opts);
  assert.equal(found.found,true);assert.equal(found.hops,1);
  const unavailable=await service.plan({edges:[E('A','B',1000,['other'])]},{from:'A',goals:[{type:'gold'}],scope:'local'},opts);
  assert.equal(unavailable.reasonCode,'missing-content');assert.match(unavailable.reason,/One target/);
});
test('planned guide tracks revisits instead of finishing at an early destination',()=>{
  const guideModule=require('../lib/route-guide');
  const guide={planned:true,to:'B',steps:[{from:'A',to:'B'},{from:'B',to:'C'},{from:'C',to:'B'}]};
  assert.equal(guideModule.board(guide,'A').left,3);
  assert.equal(guideModule.board(guide,'B').left,2);
  assert.equal(guideModule.board(guide,'B').left,2);
  assert.equal(guideModule.board(guide,'C').left,1);
  assert.equal(guideModule.board(guide,'B').state,'done');
});
test('worker respects all-in-one mode for the reported ore and blue chest case',async()=>{
  const service=require('../lib/planner-service');
  const blue='Coritos-Avemlum',ore='Xetitos-Emimsum';
  const both=content.catalog().find(z=>content.amount(z,{type:'ore'})&&content.amount(z,{type:'blue'})).name;
  const snap={edges:[E('Start',blue),E(blue,ore),E('Start','X'),E('X','Y'),E('Y',both)]};
  const req={from:'Start',scope:'local',goals:[{type:'ore'},{type:'blue'}]};
  const opts={now,language:'en',worldAdjacency:{zones:{}},allowWalk:false,avalonZones:['Start','X','Y',blue,ore,both],avalonCrossSec:10,loadSec:0,safetyMarginSec:0,riskPenaltySec:0};
  const separate=await service.plan(snap,req,opts);assert.equal(separate.to,ore);
  const combined=await service.plan(snap,{...req,match:'all'},opts);assert.equal(combined.to,both);assert.equal(combined.hops,3);
  const missing=await service.plan({edges:snap.edges.slice(0,2)},{...req,match:'all'},opts);
  assert.equal(missing.found,false);assert.equal(missing.reason,'No zone on the open map meets all selected conditions.');
});
