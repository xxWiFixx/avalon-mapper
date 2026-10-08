const {test}=require('node:test'),assert=require('node:assert/strict');
const {createDatabase}=require('./helpers/shared-database');
test('cloud reset roles, rigid small merge, CAS and one-time protection',async()=>{
 const h=await createDatabase();try{
 const map=await h.rpc('alice','create_map',{p_title:'Bridges'});await h.rpc('bob','join_test_fixture',{p_map:map});
 const edges=[['Aa','Ab'],['Ba','Bb'],['Bb','Bc'],['Aa','Ba']].map(([a,b])=>({a,b,source:'ocr',expiresAt:new Date(Date.now()+3600000).toISOString()}));
 await h.rpc('alice','push_edges',{p_map:map,p_edges:edges});
 const p={Aa:{x:1500,y:0},Ab:{x:1680,y:0},Ba:{x:0,y:0},Bb:{x:0,y:180},Bc:{x:0,y:360}};
 const save=(user,pos,revision,replace=false)=>h.rpc(user,'map_layout',{p_map:map,p_positions:JSON.stringify(pos),p_revision:revision,p_replace:replace});
 await save('alice',p,0);
 await assert.rejects(save('bob',p,1,true),/layout_role_required/);
 await h.rpc('alice','set_member_role',{p_map:map,p_user:h.users.bob,p_role:'viewer'});
 await assert.rejects(save('bob',p,1,true),/layout_role_required/);
 await h.rpc('alice','set_member_role',{p_map:map,p_user:h.users.bob,p_role:'verified'});
 assert.deepEqual((await save('bob',p,1,true)).positions,p);
 await h.rpc('alice','set_member_role',{p_map:map,p_user:h.users.bob,p_role:'admin'});
 assert.deepEqual((await save('bob',p,1,true)).positions,p);
 const merge=(user,pos,revision)=>h.rpc(user,'map_layout_merge',{p_map:map,p_bridge:'{Aa,Ba}',p_positions:JSON.stringify(pos),p_revision:revision});
 await assert.rejects(merge('outsider',{Aa:{x:-180,y:0},Ab:{x:-360,y:0}},1),/map_access_denied/);
 await assert.rejects(merge('bob',{Aa:{x:-180,y:0},Ab:{x:-360,y:0}},1),/non_rigid_merge/);
 const result=await merge('bob',{Aa:{x:-360,y:0},Ab:{x:-180,y:0}},1);
 assert.equal(result.revision,2);assert.deepEqual(result.positions.Ba,p.Ba);assert.deepEqual(result.positions.Bb,p.Bb);
 assert.equal((await merge('alice',{Aa:{x:-360,y:0},Ab:{x:-180,y:0}},1)).conflict,true);
 assert.equal((await merge('alice',{Aa:{x:-350,y:0},Ab:{x:-170,y:0}},2)).skipped,true);
 assert.deepEqual((await h.rpc('bob','map_layout',{p_map:map})).positions,result.positions);
 const fs=require('node:fs'),path=require('node:path');
 await h.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migration-18-map-layout-bridges.sql'),'utf8'));
 assert.deepEqual((await h.rpc('alice','map_layout',{p_map:map})).positions,result.positions);
 }finally{await h.close();}
});

test('viewers can read a group layout but cannot seed or move its coordinates',async()=>{
 const h=await createDatabase();try{
  const map=await h.rpc('alice','create_map',{p_title:'Read-only layout'});
  await h.rpc('bob','join_test_fixture',{p_map:map});
  const expiresAt=new Date(Date.now()+3600000).toISOString();
  await h.rpc('alice','push_edges',{p_map:map,p_edges:[['Aa','Ba'],['Ba','Bb'],['Bb','Bc']]
    .map(([a,b])=>({a,b,source:'ocr',expiresAt}))});
  const call=(user,positions,revision)=>h.rpc(user,'map_layout',{p_map:map,p_positions:JSON.stringify(positions),p_revision:revision});
  await assert.rejects(call('bob',{Aa:{x:1,y:1}},0),/layout_write_denied/);
  const initial={Aa:{x:1500,y:0},Ba:{x:0,y:0},Bb:{x:0,y:180},Bc:{x:0,y:360}};
  assert.equal((await call('alice',initial,0)).revision,1);
  assert.deepEqual((await h.rpc('bob','map_layout',{p_map:map})).positions,initial);
  const move=()=>h.rpc('bob','map_layout_merge',{p_map:map,p_bridge:'{Aa,Ba}',
    p_positions:JSON.stringify({Aa:{x:-180,y:0}}),p_revision:1});
  await assert.rejects(move(),/layout_write_denied/);
  await h.rpc('alice','set_member_role',{p_map:map,p_user:h.users.bob,p_role:'member'});
  assert.equal((await move()).revision,2);
  await h.rpc('alice','push_edges',{p_map:map,p_edges:[{a:'Bc',b:'Bd',source:'ocr',expiresAt}]});
  assert.equal((await call('bob',{Bd:{x:0,y:540}},2)).revision,3);
 }finally{await h.close();}
});
