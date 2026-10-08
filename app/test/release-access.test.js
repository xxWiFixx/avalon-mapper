'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase } = require('./helpers/shared-database');
const { createSync } = require('../lib/sync');

const edge = (a='Qiient-Qi-Odesas', b='Coues-Exakrom') => ({
  a,b,source:'ocr',by:'forged-author',expiresAt:new Date(Date.now()+3600e3).toISOString()
});
async function sqlAs(h,user,sql,args=[]) {
  return h.db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [h.users[user] || '']);
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({is_anonymous:user==='guest'})]);
    await tx.exec('set local role '+(user==='anon'?'anon':'authenticated'));
    return tx.query(sql,args);
  });
}

test('release role matrix: viewer, scout, verified, guardian, owner and outsider', async t => {
  const h=await createDatabase(); t.after(()=>h.close());
  const map=await h.rpc('alice','create_map',{p_title:'Release role matrix'});
  for(const u of ['bob','carol']) await h.rpc(u,'join_test_fixture',{p_map:map});
  await h.rpc('alice','push_edges',{p_map:map,p_edges:[edge()]});
  for(const role of ['viewer','member','verified','admin']) {
    await h.rpc('alice','set_member_role',{p_map:map,p_user:h.users.bob,p_role:role});
    assert.equal((await h.rpc('bob','pull_map_snapshot',{p_map:map})).edges.length,1);
    const push=()=>h.rpc('bob','push_edges',{p_map:map,p_edges:[edge()]});
    if(role==='viewer') await assert.rejects(push); else assert.equal(await push(),1);
    for(const fn of ['set_member_role','kick_member','set_map_policy','delete_edge']) {
      const body={p_map:map,p_user:h.users.carol,p_role:'member',p_confirm:0,p_a:'No-zone-A',p_b:'No-zone-B'};
      if(role==='admin') await h.rpc('bob',fn,body); else await assert.rejects(()=>h.rpc('bob',fn,body),{code:'42501'});
      if(fn==='kick_member' && role==='admin') await h.rpc('carol','join_test_fixture',{p_map:map});
    }
    await assert.rejects(()=>h.rpc('bob','set_member_role',{p_map:map,p_user:h.users.bob,p_role:'admin'}),{code:'42501'});
    await assert.rejects(()=>h.rpc('bob','set_member_role',{p_map:map,p_user:h.users.alice,p_role:'viewer'}),{code:'42501'});
    await assert.rejects(()=>h.rpc('bob','kick_member',{p_map:map,p_user:h.users.alice}),{code:'42501'});
  }
  await h.rpc('alice','set_member_role',{p_map:map,p_user:h.users.carol,p_role:'admin'});
  await assert.rejects(()=>h.rpc('bob','set_member_role',{p_map:map,p_user:h.users.carol,p_role:'member'}),{code:'42501'});
  await assert.rejects(()=>h.rpc('bob','kick_member',{p_map:map,p_user:h.users.carol}),{code:'42501'});
  await h.rpc('alice','kick_member',{p_map:map,p_user:h.users.bob});
  assert.equal((await h.rpc('bob','pull_map_snapshot',{p_map:map})).denied,true);
  assert.deepEqual(await h.rpc('outsider','map_members_list',{p_map:map}),[]);
  await assert.rejects(()=>h.rpc('outsider','push_edges',{p_map:map,p_edges:[edge()]}),{code:'42501'});
  await assert.rejects(()=>h.rpc('guest','join_test_fixture',{p_map:map}));
});

test('release: arbitrary callers cannot read tables or call billing/internal bypass functions',async t=>{
  const h=await createDatabase();t.after(()=>h.close());
  const tables=(await h.db.query("select tablename from pg_tables where schemaname='public'")).rows;
  for(const user of ['anon','bob']) for(const {tablename} of tables) {
    assert.match(tablename,/^[a-z_]+$/);
    await assert.rejects(()=>sqlAs(h,user,'select * from public.'+tablename+' limit 1'),{code:'42501'},user+' '+tablename);
  }
  const forbidden = [
    "select public.billing_grant($1,'group',now()+interval '30 days','forged-payment',null)",
    "select public.billing_revoke('forged-payment')",
    "select public.create_map_unmetered('bypass')",
    "select public.pull_map_snapshot_unmetered($1,null)",
    "select * from public.pull_edges_unmetered($1,null)",
    "select public.push_edges_unmetered($1,'[]'::jsonb)"
  ];
  for(const user of ['anon','bob']) for(const sql of forbidden) {
    await assert.rejects(()=>sqlAs(h,user,sql,sql.includes('$1')?[h.users.alice]:[]),{code:'42501'},user+' '+sql);
  }
});

test('release: confirmations keep original author and do not reveal the latest scanner',async t=>{
  const h=await createDatabase();t.after(()=>h.close());
  const map=await h.rpc('alice','create_map',{p_title:'Author privacy'});
  await h.rpc('bob','join_test_fixture',{p_map:map});
  await h.rpc('alice','set_member_role',{p_map:map,p_user:h.users.bob,p_role:'member'});
  await h.rpc('alice','push_edges',{p_map:map,p_edges:[edge()]});
  await h.db.query("update public.edges set first_seen_at=now()-interval '16 minutes' where map_id=$1",[map]);
  await h.rpc('bob','push_edges',{p_map:map,p_edges:[edge()]});
  const result=await h.rpc('alice','pull_map_snapshot',{p_map:map});
  assert.equal(result.edges[0].by_nick,'alice');
  assert.deepEqual(result.edges[0].reporters,[]);
  const other=await h.rpc('bob','pull_map_snapshot',{p_map:map});
  assert.equal(other.edges[0].by_nick,null);
  await h.db.query("update public.edges set expires_at=now()-interval '1 second' where map_id=$1",[map]);
  await h.rpc('bob','push_edges',{p_map:map,p_edges:[edge()]});
  const renewed=await h.rpc('alice','pull_map_snapshot',{p_map:map});
  assert.equal(renewed.edges[0].by_nick,null,'a new portal generation restarts the author delay');
});

for(const action of ['createGroup','joinGroup','members']) test('release: '+action+' discards a response after account changes',async()=>{
  let complete,arrived;
  const requested=new Promise(resolve=>arrived=resolve);
  const delayed=new Promise(resolve=>complete=resolve);
  const sync=createSync({getToken:async()=> 'test-session',fetch:async()=>{
    arrived(); await delayed;
    return {ok:true,status:200,text:async()=>JSON.stringify(action==='createGroup'?'20000000-0000-4000-8000-000000000001':[])};
  }});
  const configure=id=>sync.configure({syncUrl:'https://project.invalid',syncKey:'public',syncAccountId:id,accountPolicy:{personalMap:id},rooms:[]});
  configure('10000000-0000-4000-8000-000000000001');
  const pending=sync[action](action==='joinGroup'?'AVI-'+'A'.repeat(32):'20000000-0000-4000-8000-000000000001');
  const rejected=assert.rejects(pending,/account_changed|changed|измен/i);
  await requested;
  configure('10000000-0000-4000-8000-000000000002');
  complete();
  await rejected;
  sync.stop();
});
