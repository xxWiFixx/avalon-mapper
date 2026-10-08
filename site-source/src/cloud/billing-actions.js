export function createBillingActions({rpc, getAccountId}) {
  let redeemFlight = null;
  function account() { const id=getAccountId(); if(!id) throw new Error('discord_required'); return id; }
  function verify(id) { if(getAccountId()!==id) throw new Error('account_changed'); }
  async function status() {
    const id=account(), value=await rpc('billing_status',{});
    verify(id);
    if(value?.userId!==id) throw new Error('account_changed');
    return value;
  }
  async function redeem(code,mapId=null) {
    if(redeemFlight) throw new Error('request_in_progress');
    const id=account(), cleaned=String(code||'').trim();
    if(!cleaned || cleaned.length>128) throw new Error('invalid_code');
    if(mapId!==null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mapId)) throw new Error('invalid_map');
    const flight=(async()=>{
      const result=await rpc('billing_redeem_code',{p_code:cleaned,p_map:mapId});
      verify(id);
      if(!result?.ok) throw new Error(result?.code || 'code_unavailable');
      if(result.status?.userId!==id) throw new Error('account_changed');
      return result;
    })();
    redeemFlight=flight;
    try{return await flight;}finally{if(redeemFlight===flight)redeemFlight=null;}
  }
  return {status,redeem};
}
