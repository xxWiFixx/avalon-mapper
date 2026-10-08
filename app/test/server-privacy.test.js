'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {createDatabase}=require('./helpers/shared-database');
let d,map;
before(async()=>{d=await createDatabase();map=await d.rpc('alice','create_map',{p_title:'Private subscription'});});
after(async()=>{await d?.close();});
const invite=(mode='timed',user='alice')=>d.rpc(user,'create_map_invite',{p_map:map,p_mode:mode,p_hours:24});
const list=(user='alice')=>d.rpc(user,'active_map_invites',{p_map:map});
test('reusable invitations show their code only to managers and disappear after revocation/expiry',async()=>{
 const timed=await invite(),forever=await invite('forever'),once=await invite('once');
 const expired=await invite();await d.db.query("update map_invites set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
 let rows=await list();assert.deepEqual(new Set(rows.map(i=>i.id)),new Set([timed.id,forever.id]));
 assert.equal(rows.find(i=>i.id===timed.id).code,timed.code);
 assert.equal((await d.db.query('select display_code from map_invites where id=$1',[once.id])).rows[0].display_code,null);
 await assert.rejects(list('bob'),/invite_access_denied/);await assert.rejects(list(''),/permission denied/);
 await d.rpc('bob','join_server_with_invite',{p_code:forever.code});
 await assert.rejects(list('bob'),/invite_access_denied/);
 await d.rpc('alice','set_member_role',{p_map:map,p_user:d.users.bob,p_role:'moderator'});
 assert.equal((await list('bob')).find(i=>i.id===forever.id).code,forever.code);
 await d.rpc('alice','revoke_map_invite',{p_map:map,p_invite:timed.id});
 assert.ok(!(await list()).some(i=>i.id===timed.id));
 assert.equal((await d.rpc('carol','join_server_with_invite',{p_code:timed.code})).ok,false);
});
test('demoted issuers and single-use invitations never appear as active reusable invitations',async()=>{
 const i=await invite('timed','bob');
 await d.rpc('alice','set_member_role',{p_map:map,p_user:d.users.bob,p_role:'verified'});
 assert.ok(!(await list()).some(x=>x.id===i.id));
 for(const role of ['anon','authenticated'])assert.equal((await d.db.query("select has_column_privilege($1,'public.map_invites','display_code','select') as allowed",[role])).rows[0].allowed,false);
});
test('subscription details are owner-only, while members retain their map access',async()=>{
 assert.ok((await d.rpc('alice','billing_status')).groups.some(g=>g.mapId===map));
 for(const role of ['viewer','member','verified','moderator','admin']){
   await d.rpc('alice','set_member_role',{p_map:map,p_user:d.users.bob,p_role:role});
   assert.deepEqual((await d.rpc('bob','billing_status')).groups,[]);
   assert.ok((await d.rpc('bob','my_maps')).some(g=>g.id===map));
   assert.equal((await d.rpc('bob','pull_map_snapshot',{p_map:map})).denied,undefined);
 }
});
test('legacy codes remain valid and the migration is repeatable without data loss',async()=>{
 const i=await invite();await d.db.query('update map_invites set display_code=null where id=$1',[i.id]);
 assert.equal((await list()).find(x=>x.id===i.id).code,null);
 assert.equal((await d.rpc('carol','join_server_with_invite',{p_code:i.code})).ok,true);
 const before=(await d.db.query('select * from map_members order by map_id,user_id')).rows;
 await d.db.exec(require('fs').readFileSync(require('path').resolve(__dirname,'../../supabase/migration-26-server-invite-privacy.sql'),'utf8'));
 assert.deepEqual((await d.db.query('select * from map_members order by map_id,user_id')).rows,before);
});
