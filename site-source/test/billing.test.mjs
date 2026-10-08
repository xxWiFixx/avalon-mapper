import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBillingActions} from '../src/cloud/billing-actions.js';
const user='10000000-0000-4000-8000-000000000001',group='20000000-0000-4000-8000-000000000001';
test('billing sends a code and chosen map only; server determines duration and identity',async()=>{
 const calls=[];const a=createBillingActions({getAccountId:()=>user,rpc:async(name,body)=>{calls.push({name,body});return {ok:true,status:{userId:user},expiresAt:'2030-01-01T00:00:00Z'};}});
 const result=await a.redeem('  TEST-CODE  ',group);
 assert.deepEqual(calls,[{name:'billing_redeem_code',body:{p_code:'TEST-CODE',p_map:group}}]);assert.equal(result.ok,true);
});
test('billing denies unsigned users, invalid input and server refusal without granting access',async()=>{
 let called=0;const a=createBillingActions({getAccountId:()=>user,rpc:async()=>{called++;return {ok:false,code:'group_permanent'};}});
 await assert.rejects(()=>a.redeem(''),/invalid_code/);await assert.rejects(()=>a.redeem('x','malformed'),/invalid_map/);assert.equal(called,0);
 await assert.rejects(()=>a.redeem('x',group),/group_permanent/);
 const guest=createBillingActions({getAccountId:()=>null,rpc:async()=>{throw Error('must not call');}});
 await assert.rejects(()=>guest.status(),/discord_required/);
});
for(const operation of ['status','redeem'])test('billing discards '+operation+' after logout or account switch',async()=>{
 let id=user,complete;const pending=new Promise(resolve=>complete=resolve);
 const a=createBillingActions({getAccountId:()=>id,rpc:()=>pending});
 const task=operation==='status'?a.status():a.redeem('x',group);
 id='other-account';complete(operation==='status'?{userId:user}:{ok:true,status:{userId:user}});
 await assert.rejects(task,/account_changed/);
});
test('billing ignores overlapping submit while allowing an idempotent retry after the response',async()=>{
 let complete,calls=0;const a=createBillingActions({getAccountId:()=>user,rpc:async()=>{calls++;return new Promise(resolve=>complete=resolve);}});
 const first=a.redeem('x',group);await assert.rejects(()=>a.redeem('x',group),/request_in_progress/);
 complete({ok:true,status:{userId:user}});await first;assert.equal(calls,1);
 const retry=a.redeem('x',group);complete({ok:true,alreadyRedeemed:true,status:{userId:user}});
 assert.equal((await retry).alreadyRedeemed,true);assert.equal(calls,2);
});
