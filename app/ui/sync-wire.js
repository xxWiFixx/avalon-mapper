/* Lossless transport decoding, shared by the desktop and website. */
(function(root){
 'use strict';
 const timestamp=value=>value==null?null:new Date(value).toISOString();
 function snapshot(value){
  if(!value||value.wire!==1)return value;
  if(!Array.isArray(value.rows))throw new Error('invalid_compact_snapshot');
  const edges=value.rows.map(row=>{
   if(!Array.isArray(row)||row.length!==12)throw new Error('invalid_compact_row');
   const [a,b,cap_max,cap_max_known,expires,source,by_nick,first,updated,confirms,needed,reporters]=row;
   return {a,b,cap_max,cap_max_known,expires_at:timestamp(expires),source,by_nick,first_seen_at:timestamp(first),updated_at:timestamp(updated),confirms,needed,reporters};
  });
  const {wire,rows,...rest}=value;return {...rest,edges};
 }
 function batch(value){
  if(value?.wire!==1||!value.snapshots||typeof value.snapshots!=='object'||Array.isArray(value.snapshots))throw new Error('invalid_compact_batch');
  return {...value,snapshots:Object.fromEntries(Object.entries(value.snapshots).map(([id,s])=>[id,snapshot(s)]))};
 }
 function unwrap(value){if(value?.error){const error=new Error(value.error.message||'sync_failed');error.code=value.error.code;error.status=error.code==='42501'?403:error.code==='28000'?401:400;throw error;}return value;}
 const api={snapshot,batch,unwrap};root.AvalonSyncWire=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
