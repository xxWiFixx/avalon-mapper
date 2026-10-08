'use strict';
const fs=require('node:fs'),path=require('node:path');
const TYPES=['ore','fiber','hide','wood','rock','blue','green','gold','any-resource','any-chest'];
let cached;
function catalog(){return cached||(cached=JSON.parse(fs.readFileSync(path.join(__dirname,'../data-static/zone-data.json'),'utf8')));}
function goals(value){
  if(!Array.isArray(value)||!value.length||value.length>4)throw new Error('Выбери от одной до четырёх целей.');
  return value.map(g=>{
    if(!g||!TYPES.includes(g.type)||![0,4,5,6,7,8].includes(Number(g.tier||0)))throw new Error('Некорректная цель поиска.');
    return {type:g.type,tier:Number(g.tier||0)};
  });
}
function amount(z,g){
  if(g.tier&&Number(z.tier)!==g.tier)return 0;
  const n=k=>Math.max(0,Number(z.res?.[k]?.n)||0),c=k=>Math.max(0,Number(z.chests?.[k])||0);
  if(['ore','fiber','hide','wood','rock'].includes(g.type))return n(g.type);
  if(g.type==='any-resource')return ['ore','fiber','hide','wood','rock'].reduce((s,k)=>s+n(k),0);
  const blue=c('blueSmall')+c('blueBig'),gold=c('goldSmall')+c('goldBig'),green=c('green');
  return g.type==='blue'?blue:g.type==='gold'?gold:g.type==='green'?green:blue+gold+green;
}
function scoped(snapshot,scope,now=Date.now()){
  return {...snapshot,edges:Object.values(snapshot.edges||{}).filter(e=>Number.isFinite(e.expiresAt)&&e.expiresAt>now&&
    (!scope||(e.maps?.length?e.maps:[e.scope||'local']).includes(scope))&&
    (!scope||!e.conf?.[scope]||e.conf[scope].confirms>=e.conf[scope].needed))};
}
function search(snapshot,request={},rows=catalog()){
  const selected=goals(request.goals),s=scoped(snapshot,request.scope,request.now),open=new Set(s.edges.flatMap(e=>[e.a,e.b]));
  const matches=rows.map(z=>({name:z.name,tier:z.tier,counts:selected.map(g=>amount(z,g)),open:open.has(z.name)}))
    .filter(z=>(request.includeClosed||z.open)&&(request.match==='all'?z.counts.every(n=>n>0):z.counts.some(n=>n>0)));
  const sort=request.sort||'amount';matches.sort((a,b)=>
    (sort==='tier'?b.tier-a.tier:sort==='name'?0:b.counts.reduce((s,n)=>s+n,0)-a.counts.reduce((s,n)=>s+n,0))||a.name.localeCompare(b.name,'en'));
  return {goals:selected,matches};
}
function goalSets(snapshot,request,rows=catalog()){
  const selected=goals(request.goals),s=scoped(snapshot,request.scope,request.now),open=new Set(s.edges.flatMap(e=>[e.a,e.b]));
  if(request.match==='all')return [rows.filter(z=>open.has(z.name)&&selected.every(g=>amount(z,g)>0)).map(z=>z.name)];
  return selected.map(g=>rows.filter(z=>open.has(z.name)&&amount(z,g)>0).map(z=>z.name));
}
module.exports={catalog,goals,amount,scoped,search,goalSets,TYPES};
