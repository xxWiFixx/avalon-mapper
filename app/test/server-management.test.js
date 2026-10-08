'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const {createDatabase}=require('./helpers/shared-database');
const {makeBatch}=require('../../tools/generate-funpay-codes.cjs');
const {term}=require('../ui/server-term');
let d,batch,n=0;
const create=(user,title,code)=>d.rpc(user,'create_server_with_code',{p_title:title,p_code:code});
before(async()=>{d=await createDatabase();batch=makeBatch(12);await d.db.query('select public.billing_register_codes($1,$2::jsonb)',[batch.batchId,JSON.stringify(batch.hashes)]);await d.db.exec('update public.billing_configuration set enabled=true');});
after(async()=>{await d?.close();});
test('server term uses days, then hours/minutes, and never NaN',()=>{
 const now=Date.parse('2026-10-03T12:00:00Z'),at=ms=>new Date(now+ms).toISOString();
 assert.equal(term(at(3*86400000),now),'3 дня');
 assert.equal(term(at((23*60+32)*60000),now),'23 часа 32 минуты');
 assert.equal(term(at(21*60000),now),'21 минута');
 assert.equal(term(at(30000),now),'Меньше минуты');
 assert.equal(term(at(0),now),'Сервер приостановлен');
 assert.equal(term('bad',now),'Сервер приостановлен');
 assert.equal(term(at(3600000),now,'en'),'1 hour 0 minutes');
});
test('creation requires a code and consumes exactly that code, not an earlier unused license',async()=>{
 const unused=await d.rpc('alice','billing_redeem_code',{p_code:batch.codes[n++]});
 const code=batch.codes[n++],r=await create('alice','Canonical',code);assert.equal(r.ok,true);
 assert.equal(r.status.groups.find(g=>g.mapId===r.id).title,'Canonical');
 const old=(await d.db.query('select map_id from public.subscriptions where id=$1',[unused.licenseId])).rows[0];
 assert.equal(old.map_id,null);
 const retry=await create('alice','Different retry name',code);assert.equal(retry.id,r.id);assert.equal(retry.title,'Canonical');assert.equal(retry.alreadyCreated,true);
 assert.equal((await create('bob','Stolen',code)).code,'invalid_code');
 assert.equal((await create('alice','Missing','')).code,'invalid_code');
 await assert.rejects(create('','Anonymous',batch.codes[n++]));
 assert.equal((await create('guest','Guest',batch.codes[n++])).code,'discord_required');
 const joined=await d.rpc('bob','join_test_fixture',{p_map:r.id,p_title:'Local alias'});
 assert.equal(joined[0].title,'Canonical');
 assert.equal((await d.rpc('bob','my_maps')).find(g=>g.id===r.id).title,'Canonical');
 assert.equal((await d.rpc('bob','billing_status')).groups.some(g=>g.mapId===r.id),false,'members must not receive subscription details');
 const newCode=batch.codes[n++];assert.equal((await d.rpc('bob','billing_redeem_code',{p_code:newCode,p_map:r.id})).code,'map_owner_required');
 assert.equal((await create('bob','Own',newCode)).ok,true,'owner-only rejection must not consume a code');
});
test('invalid names and failed insertion do not consume a sales code',async()=>{
 const code=batch.codes[n++];assert.equal((await create('carol',' ',code)).code,'invalid_title');
 await d.db.exec("create function public.fail_test_creation() returns trigger language plpgsql as $$ begin if new.title='Forced failure' then raise exception 'test failure'; end if; return new; end $$; create trigger fail_test_creation before insert on public.maps for each row execute function public.fail_test_creation();");
 await assert.rejects(create('carol','Forced failure',code),/test failure/);
 const r=await create('carol','Recovered',code);assert.equal(r.ok,true);assert.equal(r.alreadyCreated,false);
 await d.db.exec('drop trigger fail_test_creation on public.maps; drop function public.fail_test_creation();');
});
test('billing list matches membership list and preserves hidden legacy map data',async()=>{
 const r=await create('carol','Legacy room',batch.codes[n++]);assert.equal(r.ok,true);
 await d.db.query('delete from public.map_members where map_id=$1 and user_id=$2',[r.id,d.users.carol]);
 assert.ok(!(await d.rpc('carol','my_maps')).some(g=>g.id===r.id));
 assert.ok(!(await d.rpc('carol','billing_status')).groups.some(g=>g.mapId===r.id));
 assert.equal((await d.db.query('select title from public.maps where id=$1',[r.id])).rows[0].title,'Legacy room');
});
test('permanent maps stay free and cannot consume a renewal code',async()=>{
 const r=await create('alice','Permanent',batch.codes[n++]);await d.db.query('select public.billing_set_permanent_group($1,true)',[r.id]);
 const code=batch.codes[n++];assert.equal((await d.rpc('alice','billing_redeem_code',{p_code:code,p_map:r.id})).code,'group_permanent');
 assert.equal((await create('alice','Other',code)).ok,true);
});

test('desktop creation rejects missing codes and ignores replies after account changes',async()=>{
 const fs=require('fs'),path=require('path'),vm=require('vm');
 const source=fs.readFileSync(path.join(__dirname,'../main.js'),'utf8');
 const start=source.indexOf("ipcMain.handle('room-create'"),end=source.indexOf("ipcMain.handle('room-join'",start);
 const state={signedIn:true,guest:false,userId:'alice'};
 let handler,finish,calls=0;
 vm.runInNewContext(source.slice(start,end),{
  ipcMain:{handle:(_,fn)=>handler=fn},auth:{status:()=>state},sync:{UUID_RE:require('../lib/sync').UUID_RE},i18nText:t=>t,
  net:{createGroup:()=>{calls++;return new Promise(resolve=>finish=resolve);}},
  upsertRoom:()=>assert.fail('stale response must not create a local server'),config:{rooms:[]}
 });
 assert.equal((await handler(null,'Title',undefined)).code,'invalid_code');assert.equal(calls,0);
 const pending=handler(null,'Title',batch.codes[0]);state.userId='bob';
 finish({ok:true,id:'10000000-0000-4000-8000-000000000001',title:'Title'});
 assert.equal((await pending).code,'account_changed');
});
