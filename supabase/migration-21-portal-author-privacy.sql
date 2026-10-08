-- Portal authors are visible only to map guardians, fifteen minutes after
-- the portal was first recorded. Run after migration 20.
begin;

alter table public.edges add column if not exists first_seen_at timestamptz;
-- Older rows have no reliable original insertion time. Their last update is
-- the conservative starting point for the privacy delay.
update public.edges set first_seen_at = least(updated_at, now()) where first_seen_at is null;
alter table public.edges alter column first_seen_at set default now();
alter table public.edges alter column first_seen_at set not null;

create or replace function public.pull_map_snapshot_unmetered(p_map uuid, p_version text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_map public.maps%rowtype;
  v_role text;
  v_version text;
  v_matured text;
  v_edges jsonb;
begin
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  select * into v_map from public.maps where id = p_map;
  v_role := public.my_role(p_map);
  if v_map.id is null or v_role = 'none' then return jsonb_build_object('denied', true); end if;

  -- A portal becoming 15 minutes old changes the snapshot even when nobody
  -- has written to the map. The suffix also changes when a role is promoted.
  if v_role = 'admin' then
    select md5(coalesce(string_agg(e.a || chr(31) || e.b || chr(31) || e.first_seen_at::text,
      chr(30) order by e.a, e.b), '')) into v_matured
    from public.edges e where e.map_id = p_map
      and e.first_seen_at <= now() - interval '15 minutes'
      and coalesce(e.expires_at, e.updated_at + interval '6 hours') > now();
  else
    v_matured := '';
  end if;
  v_version := v_map.sync_version::text || ':' || v_role || ':' || v_matured;
  if v_version = coalesce(p_version, '') then
    return jsonb_build_object('version', v_version, 'role', v_role,
      'confirmRequired', v_map.confirm_required, 'unchanged', true);
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.updated_at, x.a, x.b), '[]'::jsonb)
    into v_edges from (
    select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source,
      case when v_role = 'admin' and e.first_seen_at <= now() - interval '15 minutes'
        then e.by_nick else null::text end as by_nick,
      e.first_seen_at, e.updated_at, e.confirms,
      case when e.trusted then 0::smallint else v_map.confirm_required end as needed,
      -- A newly added confirmer could otherwise reveal their whereabouts at once.
      array[]::text[] as reporters
    from public.edges e where e.map_id = p_map
      and coalesce(e.expires_at, e.updated_at + interval '6 hours') > now()
      and (v_map.confirm_required = 0 or e.trusted or e.confirms >= v_map.confirm_required
        or exists (select 1 from public.edge_reports r where r.map_id = e.map_id
          and r.a = e.a and r.b = e.b and r.user_id = auth.uid()))
  ) x;
  return jsonb_build_object('version', v_version, 'role', v_role,
    'confirmRequired', v_map.confirm_required, 'unchanged', false, 'edges', v_edges);
end;
$$;

-- Legacy incremental clients must not bypass the same privacy rule.
create or replace function public.pull_edges_unmetered(p_map uuid, p_since timestamptz default null)
returns table (a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz,
  confirms numeric, needed smallint, reporters text[])
language plpgsql security definer set search_path = public as $$
declare v_role text; v_confirm smallint;
begin
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  v_role := public.my_role(p_map);
  if v_role = 'none' then return; end if;
  select m.confirm_required into v_confirm from public.maps m where m.id = p_map;
  return query select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source,
    case when v_role = 'admin' and e.first_seen_at <= now() - interval '15 minutes'
      then e.by_nick else null::text end,
    e.updated_at, e.confirms,
    case when e.trusted then 0::smallint else v_confirm end,
    array[]::text[]
  from public.edges e where e.map_id = p_map
    and e.updated_at > coalesce(p_since, '-infinity'::timestamptz)
    and coalesce(e.expires_at, e.updated_at + interval '6 hours') > now()
    and (v_confirm = 0 or e.trusted or e.confirms >= v_confirm
      or exists (select 1 from public.edge_reports r where r.map_id = e.map_id
        and r.a = e.a and r.b = e.b and r.user_id = auth.uid()))
  order by e.updated_at limit 2000;
end;
$$;

revoke all on function public.pull_map_snapshot_unmetered(uuid,text),
  public.pull_edges_unmetered(uuid,timestamptz) from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
