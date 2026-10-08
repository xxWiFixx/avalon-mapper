'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {createDatabase}=require('./helpers/shared-database');
const ui=require('../ui/server-access-ui');
let d,map;
before(async()=>{d=await createDatabase();map=await d.rpc('alice','create_map',{p_title:'Access test'});});
after(async()=>{await d?.close();});
const invite=(user='alice',mode='forever')=>d.rpc(user,'create_map_invite',{p_map:map,p_mode:mode,p_hours:24});
const join=(user,code)=>d.rpc(user,'join_server_with_invite',{p_code:code});
const role=(user,target,value)=>d.rpc(user,'set_member_role',{p_map:map,p_user:d.users[target],p_role:value});
test('legacy server IDs cannot admit users; guests cannot list or issue codes',async()=>{
 await assert.rejects(d.rpc('bob','join_map',{p_map:map}),/invite_code_required/);
 await assert.rejects(invite('bob'),/invite_access_denied/);
 await assert.rejects(invite(''),/permission denied|invite_access_denied/);
 assert.equal((await join('bob','AVI-'+ '0'.repeat(32))).ok,false);
});
test('single-use invitation consumes once and retry is idempotent',async()=>{
 const i=await invite('alice','once');assert.match(i.code,/^AVI-[A-F0-9]{32}$/);
 assert.equal((await join('bob',i.code)).ok,true);assert.equal((await join('bob',i.code)).ok,true);
 assert.equal((await join('carol',i.code)).ok,false);
 assert.equal((await d.db.query('select uses from map_invites where id=$1',[i.id])).rows[0].uses,1);
 assert.equal((await d.rpc('bob','my_maps'))[0].role,'viewer');
});
test('moderator hierarchy, self/owner protections and keeper-only removal',async()=>{
 const i=await invite();await join('carol',i.code);await join('outsider',i.code);await join('owner',i.code);
 await role('alice','bob','moderator');await role('alice','carol','admin');
 await role('bob','outsider','verified');
 await assert.rejects(role('bob','outsider','moderator'),/role_change_denied/);
 await assert.rejects(role('bob','carol','viewer'),/role_change_denied/);
 await assert.rejects(role('bob','bob','viewer'),/role_change_denied/);
 await assert.rejects(role('alice','alice','viewer'),/role_change_denied/);
 await assert.rejects(role('outsider','owner','verified'),/role_change_denied/);
 await role('carol','owner','moderator');
 await assert.rejects(role('carol','bob','admin'),/role_change_denied/);
 await assert.rejects(d.rpc('bob','kick_member',{p_map:map,p_user:d.users.outsider}),/member_remove_denied/);
 await assert.rejects(d.rpc('carol','ban_member',{p_map:map,p_user:d.users.alice}),/member_remove_denied/);
 await assert.rejects(d.rpc('alice','leave_map',{p_map:map}),/owner_protected/);
 await assert.rejects(d.rpc('carol','kick_member',{p_map:map,p_user:d.users.carol}),/member_remove_denied/);
 assert.ok((await invite('bob')).code);
 await assert.rejects(invite('outsider'),/invite_access_denied/);
});
test('kicked members need a freshly issued invitation; bans reject even fresh ones',async()=>{
 const old=await invite();await d.rpc('carol','kick_member',{p_map:map,p_user:d.users.outsider});
 assert.equal((await join('outsider',old.code)).ok,false);
 const fresh=await invite();assert.equal((await join('outsider',fresh.code)).ok,true);
 await d.rpc('carol','ban_member',{p_map:map,p_user:d.users.outsider});
 const newer=await invite();assert.equal((await join('outsider',newer.code)).ok,false);
 assert.equal((await d.rpc('carol','map_bans_list',{p_map:map})).length,1);
 assert.equal((await d.rpc('outsider','pull_map_snapshot',{p_map:map})).denied,true);
 await assert.rejects(d.rpc('bob','map_bans_list',{p_map:map}),/ban_access_denied/);
 await assert.rejects(d.rpc('bob','unban_member',{p_map:map,p_user:d.users.outsider}),/ban_access_denied/);
 await d.rpc('carol','unban_member',{p_map:map,p_user:d.users.outsider});
 assert.equal((await join('outsider',newer.code)).ok,false);
 assert.equal((await join('outsider',(await invite()).code)).ok,true);
});
test('expired, revoked and demoted issuer invitations cannot admit new members',async()=>{
 await d.rpc('alice','kick_member',{p_map:map,p_user:d.users.outsider});
 const timed=await invite('alice','timed');await d.db.query("update map_invites set expires_at=now()-interval '1 second' where id=$1",[timed.id]);
 assert.equal((await join('outsider',timed.code)).ok,false);
 const revoked=await invite();await d.rpc('alice','revoke_map_invite',{p_map:map,p_invite:revoked.id});
 assert.equal((await join('outsider',revoked.code)).ok,false);
 const issuer=await invite('owner');await role('alice','owner','verified');
 assert.equal((await join('outsider',issuer.code)).ok,false);
});
test('moderator portals are trusted without confirmations; deletion remains keeper-only',async()=>{
 await d.rpc('alice','set_map_policy',{p_map:map,p_confirm:3});
 const expiry=new Date(Date.now()+3600000).toISOString();
 await d.rpc('bob','push_edges',{p_map:map,p_edges:[{a:'Alpha',b:'Beta',source:'ocr',expiresAt:expiry,capMax:7,capMaxKnown:true}]});
 const snap=await d.rpc('owner','pull_map_snapshot',{p_map:map});assert.ok(snap.edges.some(e=>e.a==='Alpha'&&e.b==='Beta'));
 await assert.rejects(d.rpc('bob','delete_edge',{p_map:map,p_a:'Alpha',p_b:'Beta'}));
 await d.rpc('bob','map_layout',{p_map:map,p_positions:{Alpha:{x:1,y:2},Beta:{x:3,y:4}},p_replace:true,p_revision:0});
});
test('UI permissions mirror hierarchy and never allow editing self',()=>{
 const mod={role:'moderator'},p={id:'other',role:'verified'};
 assert.ok(ui.canChange(mod,'me',p,'member'));assert.ok(!ui.canChange(mod,'me',p,'moderator'));
 assert.ok(!ui.canRemove(mod,'me',p));assert.ok(!ui.canChange({isOwner:true},'other',p,'admin'));
 assert.ok(!ui.canRemove({isOwner:true},'me',{...p,isOwner:true}));
});
test('private invitation and ban data and helper functions are not exposed directly',async()=>{
 for(const table of ['map_invites','map_exclusions'])for(const role of ['anon','authenticated']){
  const result=await d.db.query('select has_table_privilege($1,$2,\'select,insert,update,delete\') as allowed',[role,'public.'+table]);
  assert.equal(result.rows[0].allowed,false);
 }
 for(const role of ['anon','authenticated']){
  assert.equal((await d.db.query("select has_function_privilege($1,'public.server_remove_member(uuid,uuid,boolean)','execute') as allowed",[role])).rows[0].allowed,false);
 }
 await assert.rejects(join('guest',(await invite()).code),/Discord_required/);
});
test('access migration can be reapplied without changing memberships or server identity',async()=>{
 const before=(await d.db.query('select * from map_members order by map_id,user_id')).rows;
 const fs=require('node:fs'),path=require('node:path');
 await d.db.exec(fs.readFileSync(path.resolve(__dirname,'../../supabase/migration-24-server-access.sql'),'utf8'));
 assert.deepEqual((await d.db.query('select * from map_members order by map_id,user_id')).rows,before);
 assert.equal((await d.rpc('alice','my_maps')).find(m=>m.id===map).is_owner,true);
});
