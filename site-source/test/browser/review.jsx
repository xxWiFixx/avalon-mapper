// Isolated local UI review. This entry is never included in the website build.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/localization.jsx';
import { AuthContext } from '../../src/cloud/AuthProvider.jsx';
import MapWorkspace from '../../src/cloud/MapWorkspace.jsx';
import '../../src/styles.css';
import '../../src/cloud/account.css';

const account = '10000000-0000-4000-8000-000000000001';
const group = '20000000-0000-4000-8000-000000000001';
const createdGroup = '30000000-0000-4000-8000-000000000001';
const scenario = new URL(location.href).searchParams.get('case');
let created = false, confirmRequired = 0, createdTitle = '', paidUntil = Date.now() + (23 * 60 + 32) * 60000;
const leftGroups = new Set();
let members = [{ user_id: account, nick: 'Local review', role: 'admin', is_owner: true },
  { user_id: '40000000-0000-4000-8000-000000000001', nick: 'Scout test', role: 'member', is_owner: false },
  { user_id: '50000000-0000-4000-8000-000000000001', nick: 'Viewer test', role: 'viewer', is_owner: false }];
const clock = Date.now();
const portal = (a, b, hours = 4, size = 7) => ({ a, b, cap_max: size, cap_max_known: true,
  expires_at: new Date(clock + hours * 3600000).toISOString(), updated_at: new Date(clock).toISOString(),
  source: 'ocr', confirms: 1, needed: 0 });
const own = [portal('Qiient-Qi-Odesas', 'Coues-Exakrom', 5.6), portal('Qiient-Qi-Odesas', 'Xiros-Aiairom', 2.3),
  portal('Coues-Exakrom', 'Brons Hill', 9.9), portal('Coues-Exakrom', 'Cairn Camain', .4),
  portal('Cairn Camain', 'Murky Fen', 2.9), portal('Xiros-Aiairom', 'Pen Gent', 3.1), portal('Pen Gent', 'Sleetwater Basin', 7.3),
  portal('Whitebank Stream', 'Roastcorpse Steppe', 4.2)];
const shared = [portal('Coues-Exakrom', 'Qiient-Qi-Odesas', 5.5, 20), portal('Qiient-Qi-Odesas', 'Cynos-Avixnum', 6.1),
  portal('Cynos-Avixnum', 'Eldon Hill', 8), portal('Eldon Hill', 'Martlock', 2.8)];
own[0].first_seen_at = new Date(clock - 20 * 60000).toISOString();
own[0].by_nick = 'Local review';
own[1].first_seen_at = new Date(clock).toISOString();
own[1].by_nick = 'Local review';
const layouts = new Map();
let invitations=[],banned=[];
let redeemed=false;
const billingStatus=()=>({userId:account,enabled:true,codeRedemptionReady:true,serverTime:new Date().toISOString(),licenses:redeemed?[{id:'60000000-0000-4000-8000-000000000001',mapId:null,expiresAt:new Date(Date.now()+30*864e5).toISOString(),active:true}]:[],groups:[{mapId:group,title:'Avalon explorers',isOwner:scenario==='admin'||scenario==='permanent',permanent:scenario==='permanent',active:true,expiresAt:new Date(paidUntil).toISOString()}]});
async function rpc(name, body) {
  if(name==='pull_maps_compact')throw Object.assign(new Error('Legacy test server'),{status:404,code:'PGRST202'});
  if(name==='create_map_invite'){const id=crypto.randomUUID(),code='AVI-'+id.replaceAll('-','').toUpperCase();invitations.unshift({id,code,created_at:new Date().toISOString(),expires_at:body.p_mode==='timed'?new Date(Date.now()+body.p_hours*3600000).toISOString():null,max_uses:body.p_mode==='once'?1:null,uses:0});return {id,code};}
  if(name==='active_map_invites')return structuredClone(invitations.filter(i=>!i.revoked_at&&i.max_uses!==1&&(!i.expires_at||Date.parse(i.expires_at)>Date.now())));
  if(name==='map_invites_list')return structuredClone(invitations);
  if(name==='revoke_map_invite'){invitations.find(i=>i.id===body.p_invite).revoked_at=new Date().toISOString();return null;}
  if(name==='map_bans_list')return structuredClone(banned);
  if(name==='ban_member'){banned.push(members.find(m=>m.user_id===body.p_user));members=members.filter(m=>m.user_id!==body.p_user);return null;}
  if(name==='unban_member'){banned=banned.filter(m=>m.user_id!==body.p_user);return null;}
  if(name==='billing_status')return billingStatus();
  if(name==='create_server_with_code'){if(body.p_code!=='AM30-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA')return {ok:false,code:'invalid_code'};created=true;createdTitle=body.p_title;return {ok:true,id:createdGroup,title:createdTitle};}
  if(name==='billing_redeem_code'){
    if(body.p_code!=='DEMO-CODE-NOT-FOR-SALE')return {ok:false,code:'invalid_code'};
    const alreadyRedeemed=redeemed;redeemed=true;if(!alreadyRedeemed)paidUntil+=30*864e5;
    return {ok:true,alreadyRedeemed,status:billingStatus()};
  }
  if (scenario === 'offline') throw new Error('test-offline');
  if (name === 'account_policy') return { personalMap: account, plan: 'free' };
  if (name === 'my_maps') return [{ id: group, kind: 'group', title: 'Avalon explorers', role: scenario === 'admin' ? 'admin' : 'viewer', is_owner: scenario === 'admin', confirm_required: confirmRequired },
    ...(created ? [{ id: createdGroup, kind: 'group', title: createdTitle || 'New review group', role: 'admin', is_owner: true, confirm_required: 0 }] : [])].filter(map => !leftGroups.has(map.id));
  if (name === 'create_map') { created = true; return createdGroup; }
  if (name === 'leave_map') { leftGroups.add(body.p_map); return null; }
  if (name === 'map_members_list') return structuredClone(members);
  if (name === 'set_member_role') { members = members.map(member => member.user_id === body.p_user ? { ...member, role: body.p_role } : member); return null; }
  if (name === 'kick_member') { members = members.filter(member => member.user_id !== body.p_user); return null; }
  if (name === 'set_map_policy') { confirmRequired = body.p_confirm; return confirmRequired; }
  if (name === 'join_map') throw new Error('Test-only map codes cannot join a real group');
  if (name === 'map_layout_since') {
    const current = layouts.get(body.p_map) || { revision: 0, positions: {} };
    return body.p_revision === current.revision ? { revision: current.revision, unchanged: true } : structuredClone(current);
  }
  if (name === 'map_layout') {
    const current = layouts.get(body.p_map) || { revision: 0, positions: {} };
    if (!body.p_positions) return structuredClone(current);
    if (body.p_map === group && scenario !== 'admin') throw Object.assign(new Error('read only'), { status: 403 });
    if (body.p_revision !== current.revision) return { ...structuredClone(current), conflict: true };
    const next = { revision: current.revision + 1, positions: body.p_replace ? body.p_positions : { ...current.positions, ...body.p_positions } };
    layouts.set(body.p_map, next); return structuredClone(next);
  }
  if (name === 'map_layout_merge') throw Object.assign(new Error('read only'), { status: 403 });
  if (name === 'pull_map_snapshot') {
    if (scenario === 'paused' && body.p_map === group) return { paused: true };
    return { role: body.p_map === account || body.p_map === createdGroup || scenario === 'admin' ? 'admin' : 'viewer', version: '1', unchanged: body.p_version === '1',
      edges: scenario === 'empty' || body.p_map === createdGroup ? [] : body.p_map === account ? own : shared };
  }
  throw new Error(`Unexpected test RPC ${name}`);
}
const auth = { user: { id: account, name: 'Local review · test data', avatar: null }, loading: false, error: null,
  signIn: async () => {}, signOut: async () => {}, retry: async () => {} };
createRoot(document.getElementById('root')).render(<LanguageProvider><AuthContext.Provider value={auth}><MapWorkspace rpc={rpc}/></AuthContext.Provider></LanguageProvider>);
