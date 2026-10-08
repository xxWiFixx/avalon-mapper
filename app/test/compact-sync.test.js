'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {createDatabase}=require('./helpers/shared-database'),wire=require('../ui/sync-wire'),{createSync}=require('../lib/sync');
const {gzipSync}=require('node:zlib');const fs=require('node:fs'),path=require('node:path');
let d,map,readerModule;
before(async()=>{d=await createDatabase();map=await d.rpc('alice','create_map',{p_title:'Compact sync'});await d.rpc('bob','join_test_fixture',{p_map:map});readerModule=await import('../../site-source/src/cloud/maps.js');
 const edges=Array.from({length:150},(_,i)=>({a:'Avalon-'+String(i).padStart(3,'0'),b:'World-'+String(i%37).padStart(3,'0'),capMax:i%3===0?20:7,capMaxKnown:true,source:i%2?'manual':'ocr',expiresAt:new Date(Date.now()+(i+1)*60000).toISOString()}));
 for(let i=0;i<edges.length;i+=75)await d.rpc('alice','push_edges',{p_map:map,p_edges:edges.slice(i,i+75)});
});
after(()=>d.close());
const compact=(user='alice',versions={[map]:null},context=false)=>d.rpc(user,'pull_maps_compact',{p_versions:versions,p_context:context});
const normalize=s=>readerModule.readSnapshot(s,null,Date.now()-1000);
test('compact reads preserve all portal fields across all five roles',async()=>{
 for(const role of ['viewer','member','verified','moderator','admin']){
  await d.rpc('alice','set_member_role',{p_map:map,p_user:d.users.bob,p_role:role});
  const before=await d.rpc('bob','pull_map_snapshot',{p_map:map}),after=wire.batch(await compact('bob')).snapshots[map];
  assert.deepEqual(normalize(after),normalize(before));
 }
});
test('unchanged versions omit rows; changed and deleted portals refresh normally',async()=>{
 const old=wire.batch(await compact()).snapshots[map];const unchanged=wire.batch(await compact('alice',{[map]:old.version})).snapshots[map];assert.equal(unchanged.unchanged,true);assert.equal(unchanged.edges,undefined);
 await d.rpc('alice','delete_edge',{p_map:map,p_a:'Avalon-149',p_b:'World-001'});
 const updated=wire.batch(await compact('alice',{[map]:old.version})).snapshots[map];assert.equal(updated.unchanged,false);assert.equal(updated.edges.length,149);
});
test('batched transport still hides authors for fifteen minutes and after demotion',async()=>{
 assert.equal(wire.batch(await compact()).snapshots[map].edges[0].by_nick,null);
 await d.db.query("update edges set first_seen_at=now()-interval '16 minutes' where map_id=$1",[map]);
 const keeper=wire.batch(await compact('bob')).snapshots[map];assert.equal(keeper.edges[0].by_nick,'alice');
 await d.rpc('alice','set_member_role',{p_map:map,p_user:d.users.bob,p_role:'moderator'});
 const mod=wire.batch(await compact('bob',{[map]:keeper.version})).snapshots[map];assert.equal(mod.unchanged,false);assert.equal(mod.edges[0].by_nick,null);
});
test('batch checks membership, subscription, personal privacy and guest authentication each time',async()=>{
 assert.equal(wire.batch(await compact('outsider')).snapshots[map].denied,true);
 assert.equal(wire.batch(await compact('bob',{[d.users.alice]:null})).snapshots[d.users.alice].denied,true);
 await assert.rejects(compact(''),/permission denied/);
 await d.db.exec('update billing_configuration set enabled=true');
 assert.equal(wire.batch(await compact()).snapshots[map].paused,true);
 await d.db.exec('update billing_configuration set enabled=false');
 const old=wire.batch(await compact('bob')).snapshots[map];await d.rpc('alice','kick_member',{p_map:map,p_user:d.users.bob});
 assert.equal(wire.batch(await compact('bob',{[map]:old.version})).snapshots[map].denied,true);
 await d.rpc('bob','join_test_fixture',{p_map:map});
});
test('website loads identical maps with one request and handles subsequent refreshes',async()=>{
 const calls=[];const reader=readerModule.createMapReader({compactReads:true,rpc:(name,body)=>{calls.push(name);return d.rpc('alice',name,body);}});
 reader.setAccount(d.users.alice);await reader.refresh();assert.equal(reader.getState().error,null);assert.equal(reader.getState().snapshots[map].edges.length,149);assert.deepEqual(calls,['pull_maps_compact']);
 reader.select(map);await reader.refresh();assert.equal(reader.getState().selection,map);assert.equal(reader.getState().snapshots[map].edges.length,149);assert.equal(calls.length,2);
 reader.select('all');assert.equal(reader.getState().selection,map);
});
test('desktop batches reads and retains the legacy fallback without repeated probes',async()=>{
 let snapshots=0;const cfg={syncUrl:'https://project.invalid',syncKey:'public',syncAccountId:d.users.alice,accountPolicy:{personalMap:d.users.alice},rooms:[{id:map,upload:true,role:'admin'}]};
 const net=createSync({compactReads:true,fetch:d.fetch,getToken:async()=>'alice',onSnapshot:()=>{snapshots++;},flushMs:0});net.configure(cfg);const before=d.calls.length;await net.tick(true);assert.equal(snapshots,2);assert.deepEqual(d.calls.slice(before).map(c=>c.fn),['pull_maps_compact']);net.stop();
 let probes=0;const legacy=createSync({compactReads:true,fetch:async(url,init)=>{if(url.endsWith('/pull_maps_compact')){probes++;return{ok:false,status:404,text:async()=>JSON.stringify({code:'PGRST202'})};}return d.fetch(url,init);},getToken:async()=>'alice',onSnapshot:()=>{},flushMs:0});legacy.configure(cfg);await legacy.tick(true);await legacy.tick(true);assert.equal(probes,1);legacy.stop();
});
test('compact batches discard responses after an account switch',async()=>{
 let release,arrive;const pending=new Promise(r=>release=r),arrived=new Promise(r=>arrive=r);const reader=readerModule.createMapReader({compactReads:true,rpc:async(name,body)=>{const value=await d.rpc('alice',name,body);arrive();await pending;return value;}});
 reader.setAccount(d.users.alice);const work=reader.refresh();await arrived;reader.setAccount(d.users.bob);release();await work;assert.deepEqual(reader.getState().maps,[]);assert.deepEqual(reader.getState().snapshots,{});
});
test('record measured response savings for a 149-portal map and one personal map',async()=>{
 const policy=await d.rpc('alice','account_policy'),groups=await d.rpc('alice','my_maps');const personal=await d.rpc('alice','pull_map_snapshot',{p_map:d.users.alice}),group=await d.rpc('alice','pull_map_snapshot',{p_map:map}),packed=await compact('alice',{},true);
 const old=[policy,groups,personal,group].map(x=>JSON.stringify(x));const next=JSON.stringify(packed);const rawOld=old.reduce((sum,s)=>sum+Buffer.byteLength(s),0),rawNew=Buffer.byteLength(next),gzipOld=old.reduce((sum,s)=>sum+gzipSync(s).length,0),gzipNew=gzipSync(next).length;
 const result={scenario:'Initial/changed map: 149 portals + personal map',oldRequests:4,newRequests:1,rawOld,rawNew,gzipOld,gzipNew,rawSavingPercent:Math.round((1-rawNew/rawOld)*100),gzipSavingPercent:Math.round((1-gzipNew/gzipOld)*100),note:'Payload benchmark, not a forecast of total Supabase egress. Includes metadata; excludes HTTP headers.'};
 const output=path.resolve(__dirname,'../../out/compact-sync-benchmark.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));assert.ok(rawNew<rawOld);assert.ok(gzipNew<gzipOld);console.log(JSON.stringify(result));
});
test('website falls back once for older servers and oversized batches, never on permission errors',async()=>{
 for(const failure of [{status:404,code:'PGRST202',message:'missing'},{status:400,code:'22023',message:'invalid_batch'}]){
  let probes=0;const reader=readerModule.createMapReader({compactReads:true,rpc:(name,body)=>{if(name==='pull_maps_compact'){probes++;throw Object.assign(new Error(failure.message),failure);}return d.rpc('alice',name,body);}});
  reader.setAccount(d.users.alice);await reader.refresh();await reader.refresh();assert.equal(probes,1);assert.equal(reader.getState().error,null);assert.equal(reader.getState().snapshots[map].edges.length,149);
 }
 let calls=0;const denied=readerModule.createMapReader({compactReads:true,rpc:()=>{calls++;throw Object.assign(new Error('denied'),{status:403,code:'42501'});}});denied.setAccount(d.users.alice);await denied.refresh();assert.equal(calls,1);assert.equal(denied.getState().error,'access_denied');
});
