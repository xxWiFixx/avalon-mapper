'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const access=require('../lib/collector-access'),decode=require('../lib/collector-decode'),database=require('../lib/collector-store'),protocol=require('../lib/combat-protocol'),upload=require('../lib/collector-upload');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const keys=crypto.generateKeyPairSync('ed25519');
const grant=(id=A,features=['market','mail'])=>{const payload=Buffer.from(JSON.stringify({v:1,userId:id,features}));return {payload:payload.toString('base64url'),signature:crypto.sign(null,payload,keys.privateKey).toString('base64url')};};
const incoming={incoming:true,peer:'193.169.238.5:5056>192.168.1.1:54321'},outgoing={incoming:false,peer:'192.168.1.1:54321>193.169.238.5:5056'};
const join={kind:'response',returnCode:0,code:2,params:{2:'TestCharacter',8:'3005'}};
const scope={realm:'europe',character:'TestCharacter'};
const rawOrder={Id:123,ItemTypeId:'T4_BAG',LocationId:'',QualityLevel:1,EnchantmentLevel:0,UnitPriceSilver:15000000,Amount:3,AuctionType:'offer',Expires:'2026-11-08T10:00:00Z',Seller:'private-name',Private:'secret'};
function temp(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'mapper-collectors-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function vint(n){const a=[];do{let b=Number(n&127n);n>>=7n;if(n)b|=128;a.push(b);}while(n);return Buffer.from(a);}
function value(v){if(typeof v==='string'){const b=Buffer.from(v);return Buffer.concat([Buffer.from([7]),vint(BigInt(b.length)),b]);}if(Array.isArray(v))return Buffer.concat([Buffer.from([23]),vint(BigInt(v.length)),...v.map(value)]);const n=BigInt(v);return Buffer.concat([Buffer.from([typeof v==='bigint'?10:9]),vint(n>=0?n*2n:-n*2n-1n)]);}
function body(m){const p={...m.params,253:m.code},table=Buffer.concat([vint(BigInt(Object.keys(p).length)),...Object.entries(p).map(([k,v])=>Buffer.concat([Buffer.from([+k]),value(v)]))]);return Buffer.concat([Buffer.from(m.kind==='request'?[243,2,1]:[243,3,1,0,0,8]),table]);}
function packet(b,seq=1){const h=Buffer.alloc(24);h[3]=1;h[12]=6;h.writeUInt32BE(b.length+12,16);h.writeUInt32BE(seq,20);return Buffer.concat([h,b]);}

test('signed account capability cannot be claimed by nickname, another account, malformed or tampered license',()=>{
  assert.deepEqual(access.verify(grant(),keys.publicKey,A),{market:true,mail:true});
  for(const id of [B,'DemoOwner','demo07',null])assert.equal(access.verify(grant(),keys.publicKey,id),null);
  const changed=grant();changed.payload=Buffer.from(JSON.stringify({v:1,userId:B,features:['market','mail']})).toString('base64url');assert.equal(access.verify(changed,keys.publicKey,B),null);
  assert.equal(access.verify({...grant(),signature:'bad'},keys.publicKey,A),null);
  assert.equal(access.verify(grant(A,['unknown']),keys.publicKey,A),null);
  assert.deepEqual(access.verify(grant(A,['mail']),keys.publicKey,A),{market:false,mail:true});
});
test('optional wire requests preserve default combat parsing, uint64 values and UDP deduplication',()=>{
  const m={kind:'request',code:95,params:{1:123,2:1,3:0,255:77}},b=body(m);
  assert.equal(protocol.parse(b),null);assert.equal(protocol.parse(b,{requests:true}).kind,'request');
  const stream=protocol.createStream({requests:true});assert.equal(stream.feed(packet(b),outgoing.peer)[0].code,95);assert.deepEqual(stream.feed(packet(b),outgoing.peer),[]);
  const response=protocol.parse(body({kind:'response',code:95,params:{2:[639007200000000001n],255:77}}));assert.equal(response.params[2][0],639007200000000001n);
  assert.equal(protocol.parse(Buffer.from([0xf3,3,1,0,0,8,2,4,66,10,0x55,0x03,253,13,174,0])).code,174);
});
test('market orders are sanitized, use current location and never contain character or seller identifiers',()=>{
  const events=[],d=decode.createDecoder({onMarket:e=>events.push(e)});d.feed(join,incoming);
  const message={kind:'response',returnCode:0,code:81,params:{0:[JSON.stringify(rawOrder),'broken','{}']}};d.feed(message,incoming);
  assert.equal(events.length,1);assert.equal(events[0].body.Orders[0].LocationId,'3005');assert.equal(events[0].body.Orders[0].UnitPriceSilver,15000000);
  assert.ok(!JSON.stringify(events).includes('private-name'));assert.ok(!JSON.stringify(events).includes('TestCharacter'));
  for(const patch of [{UnitPriceSilver:NaN},{QualityLevel:null},{EnchantmentLevel:null},{Amount:-1},{ItemTypeId:'<script>'},{Expires:'bad'}])assert.equal(decode.cleanOrder({...rawOrder,...patch},'3005'),null);
  d.feed({...message,returnCode:1},incoming);assert.equal(events.length,1);
});
test('market histories correlate bidirectionally, preserve ticks and ignore unmatched connections and stale IDs',()=>{
  let clock=1800000000000;const events=[],d=decode.createDecoder({now:()=>clock,onMarket:e=>events.push(e)});d.feed(join,incoming);
  const req={kind:'request',code:95,params:{1:123,2:3,3:2,255:77}};
  const resp={kind:'response',returnCode:0,code:95,params:{0:[5,-1],1:[15000000n,18446744073709551615n],2:[639007200000000001n,639007200000000002n],255:77}};
  d.feed(resp,incoming);assert.equal(events.length,0);d.feed(req,outgoing);assert.equal(events.length,1);assert.equal(events[0].body.MarketHistories[1].ItemAmount,255);
  assert.equal(events[0].body.MarketHistories[0].Timestamp,'639007200000000001');
  const serialized=upload.bodyJSON(events[0].body);assert.ok(serialized.includes('"Timestamp":639007200000000001'));assert.ok(serialized.includes('"SilverAmount":18446744073709551615'));
  d.feed(req,outgoing);d.feed(resp,{...incoming,peer:'193.169.238.6:5056>192.168.1.1:54321'});assert.equal(events.length,1);
  clock+=31000;d.feed(resp,incoming);assert.equal(events.length,1);
  d.feed({...req,params:{...req.params,3:null}},outgoing);assert.equal(events.length,1);
});
test('mail decoder excludes personal messages, accepts all market items and normalizes city names',()=>{
  const events=[],d=decode.createDecoder({onMail:e=>events.push(e)});
  d.feed({kind:'response',returnCode:0,code:176,params:{0:7,1:'2|T4_BAG|30000000|15000000'}},incoming);assert.equal(events.length,0);
  d.feed(join,incoming);d.feed({kind:'response',returnCode:0,code:174,params:{3:[7,8],7:['Bridgewatch Portal','Bridgewatch Portal'],11:['MARKETPLACE_SELLORDER_FINISHED_SUMMARY','PLAYER_MESSAGE'],12:[1800000000,1800000000]}},incoming);
  assert.equal(events[0].infos.length,1);assert.equal(events[0].infos[0].location,'Bridgewatch');
  d.feed({kind:'response',returnCode:0,code:176,params:{0:8,1:'private correspondence'}},incoming);assert.equal(events.length,1);
  d.feed({kind:'response',returnCode:0,code:176,params:{0:7,1:'2|T4_BAG|30000000|15000000'}},incoming);assert.equal(events.length,2);
  assert.equal(decode.tradeBody('NaN|T4_BAG|30000000|15000000'),null);
});
test('SQLite mail body before index survives restart, deduplicates and keeps realms/characters separate',t=>{
  const file=path.join(temp(t),'db.sqlite');let store=database.create(file);
  const event={scope,mailId:'7',body:decode.tradeBody('2|T4_BAG|30000000|15000000'),at:1800000000000};store.mail(event);assert.equal(store.summary().mails,0);store.close();
  store=database.create(file);
  const info={mailId:'7',type:'MARKETPLACE_SELLORDER_FINISHED_SUMMARY',location:'Bridgewatch',receivedAt:'2027-01-15T08:00:00Z'};
  store.mail({scope,infos:[info],at:event.at});store.mail(event);assert.equal(store.summary().mails,1);
  store.mail({...event,scope:{...scope,character:'OtherCharacter'}});assert.equal(store.summary().mails,1);
  store.mail({scope:{...scope,character:'OtherCharacter'},infos:[info],at:event.at});assert.equal(store.summary().mails,2);
  const row=store.list()[0];assert.equal(row.quantity,2);assert.equal(row.total,3000);assert.equal(row.unitPrice,1500);assert.equal(row.item,'T4_BAG');assert.equal(row.realm,'europe');
  assert.throws(()=>store.list({limit:101}));assert.throws(()=>store.list({offset:-1}));
  store.close();
});
test('persistent market outbox deduplicates pending data and backs off instead of dropping offline uploads',t=>{
  let clock=1800000000000;const file=path.join(temp(t),'db.sqlite'),store=database.create(file,{now:()=>clock});
  const e={realm:'europe',topic:'marketorders.ingest',body:{Orders:[decode.cleanOrder(rawOrder,'3005')]}};
  store.market(e,['private']);store.market(e,['private']);assert.equal(store.summary().observations,1);assert.equal(store.summary().queued,1);
  const row=store.next('private');store.retry(row.id,row.attempts);assert.equal(store.next('private'),undefined);clock+=5001;store.done(store.next('private').id);assert.equal(store.summary().uploaded,1);assert.equal(store.summary().queued,0);
  store.market(e,[]);assert.equal(store.summary().queued,0);
  store.close();
});
test('private upload accepts only HTTPS ingest, does not redirect secrets and never sends personal data',async()=>{
  for(const url of ['http://example.test/ingest/token','https://u:p@example.test/ingest/token','https://example.test/ingest/token?key=x','https://example.test/wrong/token'])assert.throws(()=>upload.privateURL(url,'marketorders.ingest'));
  const calls=[],row={realm:'europe',topic:'marketorders.ingest',data:JSON.stringify({Orders:[decode.cleanOrder(rawOrder,'3005')]})};
  await upload.upload(row,'private',{privateEndpoint:'https://example.test/ingest/test-secret',fetchImpl:async(...args)=>{calls.push(args);return new Response('{}',{status:200});}});
  assert.equal(calls.length,1);assert.equal(calls[0][1].redirect,'error');assert.ok(!calls[0][1].body.includes('private-name'));
  await assert.rejects(upload.upload({...row,realm:'west'},'private',{privateEndpoint:'https://example.test/ingest/test-secret',fetchImpl:()=>assert.fail('No wrong region upload')}),/private_region_mismatch/);
});
test('public AODP proof and form follow the official API and only configured upload invokes it',async()=>{
  const wanted=upload.bits(crypto.createHash('sha256').update('anything').digest()).slice(0,3),pow={key:'test-key',wanted};const solution=await upload.solvePow(pow);assert.ok(upload.bits(crypto.createHash('sha256').update('aod^'+solution+'^'+pow.key).digest()).startsWith(wanted));
  const calls=[];await upload.upload({realm:'europe',topic:'marketorders.ingest',data:'{"Orders":[]}'},'public',{fetchImpl:async(url,opts)=>{calls.push([url,opts]);return new Response(url.endsWith('/pow')?JSON.stringify(pow):'{}',{status:200});}});
  assert.equal(calls.length,2);assert.equal(calls[1][1].body.get('serverid'),'3');assert.equal(calls[1][1].body.get('natsmsg'),'{"Orders":[]}');
  await assert.rejects(upload.solvePow({key:'bad',wanted:'x'}),/invalid_pow/);
  await assert.rejects(upload.upload({realm:'europe',topic:'personalmail',data:'{}'},'public'),/invalid_market_payload/);
});
function control(t){const root=temp(t);fs.writeFileSync(path.join(root,'collector-access.json'),JSON.stringify(grant()));let user={signedIn:true,guest:false,userId:A,nick:'Anyone'},clock=1000;const workers=[];
  const c=require('../lib/collectors').create({root,user:()=>user,now:()=>clock,verificationKey:keys.publicKey,secret:{encrypt:s=>Buffer.from(s).toString('base64'),decrypt:s=>Buffer.from(s,'base64').toString()},workerFactory:()=>{const worker=new EventEmitter();worker.sent=[];worker.postMessage=m=>worker.sent.push(m);worker.terminate=async()=>0;workers.push(worker);return worker;}});t.after(()=>c.close());
  return {c,workers,root,user:u=>user=u,at:n=>clock=n};
}
test('controller requires fresh server-confirmed identity and saved flags never authorize another account',async t=>{
  const r=control(t);assert.equal(r.c.snapshot(),null);assert.equal((await r.c.configure('mail',true,async()=>null)).ok,false);assert.equal(r.workers.length,0);
  r.c.acceptProfile({id:A});assert.ok(r.c.snapshot().allowed);assert.equal((await r.c.configure('mail',true,async()=>({id:A}))).ok,true);assert.ok(r.c.needsTraffic());
  r.user({signedIn:true,guest:false,userId:B,nick:'DemoOwner'});assert.equal(r.c.snapshot(),null);assert.equal(r.c.needsTraffic(),false);assert.equal((await r.c.list()).error,'access_denied');r.c.acceptProfile({id:B});assert.equal(r.c.snapshot(),null);
  r.user({signedIn:true,guest:true,userId:A});r.c.acceptProfile({id:A});assert.equal(r.c.snapshot(),null);
});
test('controller clears in-flight mail replies on account change and rejects expired proof',async t=>{
  const r=control(t);r.c.acceptProfile({id:A});const pending=r.c.list();const worker=r.workers[0],request=worker.sent.find(m=>m.type==='list');r.c.reset();worker.emit('message',{type:'list',id:request.id,rows:[{private:'secret'}],total:1});assert.equal((await pending).error,'account_changed');
  r.c.acceptProfile({id:A});r.at(3601001);assert.equal(r.c.snapshot(),null);r.c.refreshAccess();assert.equal(r.c.needsTraffic(),false);
});
test('controller batches packets, bounds memory, and stopping traffic disables both collectors',async t=>{
  const r=control(t);r.c.acceptProfile({id:A});await r.c.configure('market',true,async()=>({id:A}));const payload=Buffer.alloc(65535);
  for(let i=0;i<500;i++)r.c.feed(payload,incoming);assert.ok(r.c.snapshot().dropped>0);await new Promise(resolve=>setImmediate(resolve));assert.ok(r.workers[0].sent.filter(m=>m.type==='packets').length<=4);
  r.c.disable();assert.equal(r.c.needsTraffic(),false);assert.equal(r.c.snapshot().mail,false);assert.equal(r.c.snapshot().market,false);
});
test('mail IPC rejects other windows and subframes even when the authorized account is signed in',async()=>{
  const vm=require('node:vm'),source=fs.readFileSync(path.resolve(__dirname,'../main.js'),'utf8'),handlers={},mainFrame={},contents={mainFrame};let read=0,changed=0;
  const ctx=vm.createContext({ipcMain:{handle:(n,fn)=>handlers[n]=fn},win:{webContents:contents},metricsSnapshot:()=>({}),confirmCollectorIdentity:async()=>({id:A}),collectors:{list:async()=>{read++;return {rows:[],total:0};},configure:async()=>{changed++;return {ok:true};}}});
  vm.runInContext(source.slice(source.indexOf("ipcMain.handle('collector-action'"),source.indexOf("ipcMain.handle('metrics-action'")),ctx);
  for(const event of [{sender:{},senderFrame:mainFrame},{sender:contents,senderFrame:{}},{sender:contents}]){
    assert.equal((await handlers['collector-mails'](event,{})).error,'access_denied');assert.equal((await handlers['collector-action'](event,'mail',true)).error,'access_denied');
  }
  assert.equal(read,0);assert.equal(changed,0);await handlers['collector-mails']({sender:contents,senderFrame:mainFrame},{});assert.equal(read,1);
});
module.exports={body,packet,incoming,outgoing};
