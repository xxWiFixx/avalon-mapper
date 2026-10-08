'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const USERS = {
  alice: '10000000-0000-4000-8000-000000000001',
  bob: '10000000-0000-4000-8000-000000000002',
  carol: '10000000-0000-4000-8000-000000000003',
  outsider: '10000000-0000-4000-8000-000000000004',
  guest: '10000000-0000-4000-8000-000000000005',
  owner: '10000000-0000-4000-8000-000000000099',
};
const PARAMS = {
  pull_maps_compact:['p_versions','p_context'],
  create_map_invite:['p_map','p_mode','p_hours'],map_invites_list:['p_map'],active_map_invites:['p_map'],revoke_map_invite:['p_map','p_invite'],join_server_with_invite:['p_code'],ban_member:['p_map','p_user'],unban_member:['p_map','p_user'],map_bans_list:['p_map'],
  create_server_with_code: ['p_title','p_code'], ensure_profile: ['p_nick'], create_map: ['p_title'], join_map: ['p_map', 'p_title'],
  leave_map: ['p_map'], my_maps: [], map_members_list: ['p_map'],
  set_member_role: ['p_map', 'p_user', 'p_role'], kick_member: ['p_map', 'p_user'],
  set_map_policy: ['p_map', 'p_confirm'], push_edges: ['p_map', 'p_edges'],
  pull_edges: ['p_map', 'p_since'], delete_edge: ['p_map', 'p_a', 'p_b'],
  pull_map_snapshot: ['p_map', 'p_version'],
  map_layout: ['p_map', 'p_positions', 'p_revision', 'p_replace'],
  map_layout_since: ['p_map', 'p_revision'],
  map_layout_merge: ['p_map','p_bridge','p_positions','p_revision'],
  account_policy: [], account_set_sharing: ['p_share'],
  billing_redeem_code: ['p_code', 'p_map'], billing_status: [], billing_start_trial: [], authorize_capture: ['p_id', 'p_a', 'p_b', 'p_expires', 'p_cap_max', 'p_cap_known'],
};
const SCALARS = new Set(['pull_maps_compact','create_map_invite','join_server_with_invite','create_server_with_code', 'create_map', 'push_edges', 'delete_edge', 'set_map_policy', 'pull_map_snapshot',
  'account_policy', 'account_set_sharing', 'billing_redeem_code', 'billing_status', 'billing_start_trial', 'authorize_capture', 'map_layout', 'map_layout_since', 'map_layout_merge']);

async function createDatabase({ through = Infinity, users = USERS, anonymousUsers = ['guest'], database = null } = {}) {
  const anonymous = new Set(anonymousUsers);
  const db = database || new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade,
      provider_id text not null, provider text not null, unique(provider, provider_id));
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
  `);
  const dir = path.resolve(__dirname, '../../../supabase');
  const files = ['schema.sql', ...fs.readdirSync(dir).filter(f => /^migration-\d+.*\.sql$/.test(f)
    && Number(f.match(/^migration-(\d+)/)[1]) <= through).sort()];
  for (const file of files) {
    // gen_random_uuid is built into this PostgreSQL; the optional pgcrypto package is absent in WASM.
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^create extension if not exists pgcrypto;.*$/m, '');
    await db.exec(sql);
  }
  for (const id of Object.values(users)) await db.query('insert into auth.users(id) values ($1)', [id]);
  const discordIds = {};
  for (const [index, [user, id]] of Object.entries(users).entries()) if (!anonymous.has(user)) {
    discordIds[user] = '90000000000000000' + index;
    await db.query("insert into auth.identities(user_id,provider,provider_id) values($1,'discord',$2)", [id, discordIds[user]]);
  }
  const calls = [];
  let down = false;
  async function rpc(user, fn, body = {}) {
    // Fixture setup uses the real invitation API after migration 24.
    // Tests of legacy API rejection call join_map explicitly.
    if(fn==='join_test_fixture'){
      if(through<24)return rpc(user,'join_map',body);
      const m=(await db.query('select owner from public.maps where id=$1',[body.p_map])).rows[0];
      const owner=Object.keys(users).find(key=>users[key]===m?.owner);
      const invitation=await rpc(owner,'create_map_invite',{p_map:body.p_map,p_mode:'once',p_hours:24});
      const result=await rpc(user,'join_server_with_invite',{p_code:invitation.code});
      if(!result?.ok)throw new Error(result?.code||'invalid_invite');
      return [{id:result.id,title:result.title,kind:result.kind}];
    }
    if (!Object.hasOwn(PARAMS, fn)) throw new Error('Unknown test RPC: ' + fn);
    const args = PARAMS[fn].map(k => body[k] ?? null);
    return db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [Object.hasOwn(users, user) ? users[user] : '']);
      await tx.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ is_anonymous: anonymous.has(user) })]);
      await tx.exec('set local role ' + (Object.hasOwn(users, user) ? 'authenticated' : 'anon'));
      const placeholders = args.map((_, i) => '$' + (i + 1)).join(',');
      const result = await tx.query(`select * from public.${fn}(${placeholders})`,
        args.map(v => Array.isArray(v) ? JSON.stringify(v) : v));
      return SCALARS.has(fn) ? result.rows[0]?.[fn] : result.rows;
    });
  }
  for (const user of Object.keys(users)) await rpc(user, 'ensure_profile', { p_nick: user });
  async function fetch(url, init) {
    const fn = String(url).split('/rpc/')[1];
    const body = JSON.parse(init.body);
    const user = init.headers.Authorization.slice('Bearer '.length);
    calls.push({ fn, body, user });
    if (down) throw new Error('offline');
    try {
      const result = await rpc(user, fn, body);
      return { ok: true, status: 200, text: async () => JSON.stringify(result ?? null) };
    } catch (e) {
      return { ok: false, status: e.code === '42501' ? 403 : e.code === '42883' ? 404 : 400,
        text: async () => JSON.stringify({ code: e.code, message: e.message }) };
    }
  }
  return { db, rpc, fetch, calls, users, discordIds, setOffline(value) { down = value; }, close: () => db.close() };
}

module.exports = { createDatabase, USERS };
