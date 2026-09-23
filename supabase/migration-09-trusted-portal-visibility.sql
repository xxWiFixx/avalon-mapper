-- A portal contributed by a verified member or administrator is visible to
-- every map member immediately. Return its effective confirmation threshold
-- as zero so existing clients do not falsely label it "awaiting confirmation".
-- The map's policy remains unchanged for ordinary contributors.

create or replace function public.pull_map_snapshot(p_map uuid, p_version text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  select case when public.my_role(m.id) = 'none' then jsonb_build_object('denied', true)
    else jsonb_build_object('version', m.sync_version::text, 'role', public.my_role(m.id),
      'confirmRequired', m.confirm_required, 'unchanged', m.sync_version::text = coalesce(p_version, ''))
    || case when m.sync_version::text = coalesce(p_version, '') then '{}'::jsonb else
      jsonb_build_object('edges', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at, x.a, x.b) from (
        select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source, e.by_nick, e.updated_at,
          e.confirms, case when e.trusted then 0::smallint else m.confirm_required end as needed,
          case when m.kind = 'public' then null else (select array_agg(p.nick order by r.reported_at, p.nick)
            from public.edge_reports r join public.profiles p on p.id = r.user_id
            where r.map_id = e.map_id and r.a = e.a and r.b = e.b) end as reporters
        from public.edges e where e.map_id = m.id
          and coalesce(e.expires_at, e.updated_at + interval '6 hours') > now()
          and (m.confirm_required = 0 or e.trusted or e.confirms >= m.confirm_required
            or exists (select 1 from public.edge_reports r where r.map_id = e.map_id
              and r.a = e.a and r.b = e.b and r.user_id = auth.uid()))
      ) x), '[]'::jsonb)) end end
    into v_result from public.maps m where m.id = p_map;
  return coalesce(v_result, jsonb_build_object('denied', true));
end;
$$;

create or replace function public.pull_edges(p_map uuid, p_since timestamptz default null)
returns table (
  a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz,
  confirms numeric, needed smallint, reporters text[]
)
language sql security definer set search_path = public as $$
  select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source, e.by_nick, e.updated_at,
    e.confirms, case when e.trusted then 0::smallint else m.confirm_required end,
    case when m.kind = 'public' then null else (
      select array_agg(p.nick order by r.reported_at, p.nick)
      from public.edge_reports r join public.profiles p on p.id = r.user_id
      where r.map_id = e.map_id and r.a = e.a and r.b = e.b
    ) end
  from public.edges e join public.maps m on m.id = e.map_id
  where e.map_id = p_map and public.my_role(p_map) <> 'none'
    and e.updated_at > coalesce(p_since, '-infinity'::timestamptz)
    and (e.expires_at is null or e.expires_at > now())
    and (m.confirm_required = 0 or e.trusted or e.confirms >= m.confirm_required
      or exists (select 1 from public.edge_reports r where r.map_id = e.map_id
        and r.a = e.a and r.b = e.b and r.user_id = auth.uid()))
  order by e.updated_at limit 2000;
$$;

revoke all on function public.pull_map_snapshot(uuid, text) from public, anon;
revoke all on function public.pull_edges(uuid, timestamptz) from public, anon;
grant execute on function public.pull_map_snapshot(uuid, text) to authenticated;
grant execute on function public.pull_edges(uuid, timestamptz) to authenticated;

-- Previously downloaded snapshots need a new version to refresh their labels.
update public.maps m set sync_version = sync_version + 1
where m.confirm_required > 0 and exists (
  select 1 from public.edges e where e.map_id = m.id and e.trusted
);
