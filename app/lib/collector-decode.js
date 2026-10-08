'use strict';
// Market wire format follows ao-data/albiondata-client, MIT, commit
// 12ff34e2964869ed616d284f4be82dd36c62a5f3. See assets/aodp-license.txt.
const ITEM = /^(?:T[1-8]_|UNIQUE_|QUESTITEM_)[A-Z0-9_@.]{1,180}$/;
const LOC = /^(?:\d{1,8}|BLACKBANK-[A-Za-z0-9_-]{1,100}|[A-Za-z0-9_@-]{1,100}-(?:HellDen|Auction2))$/;
const tradeTypes = new Set(['MARKETPLACE_BUYORDER_FINISHED','MARKETPLACE_SELLORDER_FINISHED','MARKETPLACE_BUYORDER_FINISHED_SUMMARY','MARKETPLACE_SELLORDER_FINISHED_SUMMARY']);
const decimal = v => {
  const s = typeof v === 'bigint' ? v.toString() : String(v ?? '');
  return /^(?:0|[1-9]\d{0,19})$/.test(s) && BigInt(s) <= 18446744073709551615n ? s : null;
};
const integer = v => { if(!['number','bigint','string'].includes(typeof v)||v==='')return null;const n = Number(v); return Number.isSafeInteger(n) ? n : null; };
function timestamp(v) {
  const s=decimal(v); if(!s)return null;
  const n=BigInt(s), ms=n>100000000000000n ? Number((n-621355968000000000n)/10000n) : Number(n<100000000000n?n*1000n:n);
  return ms >= 946684800000 && ms <= 4102444800000 ? new Date(ms).toISOString() : null;
}
function gameConnection(meta) {
  if(typeof meta?.incoming!=='boolean' || typeof meta.peer!=='string')return null;
  const pair=meta.peer.split('>'); if(pair.length!==2)return null;
  const server=pair[meta.incoming?0:1].split(':')[0];
  const realm=server.startsWith('193.169.238.')?'europe':server.startsWith('5.188.125.')?'west':server.startsWith('5.45.187.')?'east':null;
  if(!realm)return null;
  return {realm,key:pair.slice().sort().join('|')};
}
function tradeBody(value) {
  if(typeof value!=='string' || value.length>4096)return null;
  const a=value.split('|');
  if(a.length<4 || !ITEM.test(a[1]))return null;
  const quantity=integer(a[0]),total=decimal(a[2]),price=decimal(a[3]);
  if(!quantity || quantity<0 || quantity>1e9 || !total || !price || BigInt(total)<=0n || BigInt(price)<=0n
      || BigInt(total)>BigInt(Number.MAX_SAFE_INTEGER) || BigInt(price)>BigInt(Number.MAX_SAFE_INTEGER))return null;
  return {quantity,item:a[1],totalRaw:total,priceRaw:price};
}
function mailIndex(m) {
  if(m.kind!=='response' || m.code!==174 || m.returnCode!==0)return [];
  const p=m.params||{}, ids=p[3], loc=p[7]||p[6], types=p[11]||p[10], dates=p[12];
  if(!Array.isArray(ids) || !Array.isArray(types) || ids.length>4096)return [];
  return ids.flatMap((id,i)=>{
    const mailId=decimal(id),type=types[i],location=String(loc?.[i]||'');
    return mailId && tradeTypes.has(type) && /^[\p{L}\p{N}_@ .'-]{1,120}$/u.test(location) ? [{mailId,type,location:location.replace(/ (?:Portal|Market)$/i,''),receivedAt:timestamp(dates?.[i])}] : [];
  });
}
function transaction(body, info, observedAt) {
  if(!body || !info || !tradeTypes.has(info.type))return null;
  const direction=info.type.includes('BUYORDER')?'buy':'sell';
  const total=Number(body.totalRaw)/10000, limitPrice=Number(body.priceRaw)/10000;
  return {mailId:info.mailId,direction,city:info.location,item:body.item,quantity:body.quantity,
    unitPrice:direction==='buy'?total/body.quantity:limitPrice,total,
    receivedAt:info.receivedAt,observedAt:new Date(observedAt).toISOString()};
}
function cleanOrder(raw, location) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))return null;
  const id=integer(raw.Id),price=integer(raw.UnitPriceSilver),amount=integer(raw.Amount),quality=integer(raw.QualityLevel),ench=integer(raw.EnchantmentLevel);
  const loc=raw.LocationId || location;
  if(!id || id<0 || !price || price<0 || !amount || amount<0 || amount>1e9 || !ITEM.test(raw.ItemTypeId||'')
      || !LOC.test(loc||'') || quality<1 || quality>5 || !Number.isInteger(quality) || ench<0 || ench>4 || !Number.isInteger(ench)
      || !['offer','request'].includes(String(raw.AuctionType).toLowerCase()) || !timestamp(Date.parse(raw.Expires)))return null;
  return {Id:id,ItemTypeId:raw.ItemTypeId,LocationId:loc,QualityLevel:quality,EnchantmentLevel:ench,
    UnitPriceSilver:price,Amount:amount,AuctionType:String(raw.AuctionType).toLowerCase(),Expires:raw.Expires};
}
function createDecoder({now=Date.now,onMarket=()=>{},onMail=()=>{},onCharacter=()=>{}}={}) {
  const states=new Map();
  function feed(m,meta) {
    const c=gameConnection(meta); if(!c || !m?.params)return;
    let s=states.get(c.key);
    if(!s){if(states.size>=16)states.delete(states.keys().next().value);s={location:null,character:null,requests:new Map(),responses:new Map()};states.set(c.key,s);}
    const p=m.params,t=now();
    for(const list of [s.requests,s.responses])for(const [id,v]of list)if(t-v.at>30000)list.delete(id);
    if(m.kind==='response'&&m.returnCode===0&&m.code===2) {
      const char=typeof p[2]==='string'&&/^[\p{L}\p{N}_ -]{1,64}$/u.test(p[2])?p[2]:null;
      if(char!==s.character){s.requests.clear();s.responses.clear();s.character=char;onCharacter({realm:c.realm,character:char});}
      s.location=LOC.test(p[8]||'')?p[8]:null;
    }
    if(m.kind==='response'&&m.returnCode===0&&m.code===41)s.location=LOC.test(p[0]||'')?p[0]:null;
    if(m.kind==='request'&&m.code===17)s.location=LOC.test(p[0]||'')?p[0]:null;
    if(m.kind==='response'&&m.returnCode===0&&[81,82,458].includes(m.code)&&Array.isArray(p[0])) {
      const orders=[];
      for(const text of p[0].slice(0,4096)) {
        if(typeof text!=='string'||text.length>8192)continue;
        try {const o=cleanOrder(JSON.parse(text),s.location);if(o)orders.push(o);}catch{}
      }
      if(orders.length)onMarket({realm:c.realm,topic:'marketorders.ingest',body:{Orders:orders}});
    }
    if(m.kind==='request'&&m.code===95) {
      const id=decimal(p[255]),item=integer(p[1]),quality=integer(p[2]),scale=integer(p[3]);
      if(id && item!==null && item!==0 && quality!==null&&quality>=1&&quality<=5&&scale!==null&&scale>=0&&scale<=2 && s.location) {
        const itemId=item<0&&item>-129?item+256:item;
        if(itemId>0){if(s.requests.size>=256)s.requests.delete(s.requests.keys().next().value);s.requests.set(id,{at:t,item:itemId,quality,scale,location:s.location});}
      }
    }
    if(m.kind==='response'&&m.returnCode===0&&m.code===95) {
      const id=decimal(p[255]),arrays=[p[0],p[1],p[2]];
      if(id&&arrays.every(Array.isArray)&&arrays[0].length===arrays[1].length&&arrays[0].length===arrays[2].length&&arrays[0].length<=4096){if(s.responses.size>=16)s.responses.delete(s.responses.keys().next().value);s.responses.set(id,{at:t,params:{0:p[0],1:p[1],2:p[2]}});}
    }
    for(const [id,response]of s.responses) {
      const request=s.requests.get(id);if(!request)continue;
      s.responses.delete(id);s.requests.delete(id);
      const [amounts,silver,times]=[response.params[0],response.params[1],response.params[2]];
      if(![amounts,silver,times].every(Array.isArray)||amounts.length!==silver.length||amounts.length!==times.length||amounts.length>4096)continue;
      const rows=[];
      for(let i=0;i<amounts.length;i++) {
        let amount=integer(amounts[i]);if(amount!==null&&amount<0&&amount>=-124)amount+=256;
        const money=decimal(silver[i]),stamp=decimal(times[i]);
        if(amount===null||amount<=0||!money||!stamp||!timestamp(stamp))continue;
        rows.push({ItemAmount:amount,SilverAmount:money,Timestamp:stamp});
      }
      if(rows.length)onMarket({realm:c.realm,topic:'markethistories.ingest',body:{AlbionId:request.item,LocationId:request.location,QualityLevel:request.quality,Timescale:request.scale,MarketHistories:rows}});
    }
    if(m.kind==='response'&&m.returnCode===0&&s.character) {
      const scope={realm:c.realm,character:s.character};
      const infos=mailIndex(m);if(infos.length)onMail({scope,infos,at:t});
      if(m.code===176){const mailId=decimal(p[0]),body=tradeBody(p[1]);if(mailId&&body)onMail({scope,mailId,body,at:t});}
    }
  }
  return {feed,reset(){states.clear();}};
}
module.exports={decimal,timestamp,tradeBody,mailIndex,transaction,cleanOrder,gameConnection,createDecoder};
