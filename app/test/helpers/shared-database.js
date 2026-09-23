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
  owner: '63cba067-4c94-48e5-8d0e-6f56dba2a65e',
};
const PARAMS = {
  ensure_profile: ['p_nick'], create_map: ['p_title'], join_map: ['p_map', 'p_title'],
  leave_map: ['p_map'], my_maps: [], map_members_list: ['p_map'],
  set_member_role: ['p_map', 'p_user', 'p_role'], kick_member: ['p_map', 'p_user'],
  set_map_policy: ['p_map', 'p_confirm'], push_edges: ['p_map', 'p_edges'],
  pull_edges: ['p_map', 'p_since'], delete_edge: ['p_map', 'p_a', 'p_b'],
  pull_map_snapshot: ['p_map', 'p_version'],
  account_policy: [], account_set_sharing: ['p_share'], admin_personal_maps: [],
};
const SCALARS = new Set(['create_map', 'push_edges', 'delete_edge', 'set_map_policy', 'pull_map_snapshot',
  'account_policy', 'account_set_sharing']);

async function createDatabase({ through = Infinity } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
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
  for (const id of Object.values(USERS)) await db.query('insert into auth.users(id) values ($1)', [id]);
  const calls = [];
  let down = false;
  async function rpc(user, fn, body = {}) {
    if (!Object.hasOwn(PARAMS, fn)) throw new Error('Unknown test RPC: ' + fn);
    const args = PARAMS[fn].map(k => body[k] ?? null);
    return db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [USERS[user] || '']);
      await tx.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ is_anonymous: user === 'guest' })]);
      await tx.exec('set local role ' + (USERS[user] ? 'authenticated' : 'anon'));
      const placeholders = args.map((_, i) => '$' + (i + 1)).join(',');
      const result = await tx.query(`select * from public.${fn}(${placeholders})`,
        args.map(v => Array.isArray(v) ? JSON.stringify(v) : v));
      return SCALARS.has(fn) ? result.rows[0]?.[fn] : result.rows;
    });
  }
  for (const user of Object.keys(USERS)) await rpc(user, 'ensure_profile', { p_nick: user });
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
  return { db, rpc, fetch, calls, users: USERS, setOffline(value) { down = value; }, close: () => db.close() };
}

module.exports = { createDatabase, USERS };
