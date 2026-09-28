-- Retire automatic publication while preserving every personal and group map.
begin;
create or replace function public.my_role(p_map uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then 'none'
    when (select m.kind from public.maps m where m.id = p_map) = 'personal'
      then case when (select m.owner from public.maps m where m.id = p_map) = auth.uid()
                then 'admin' else 'none' end
    when (select m.kind from public.maps m where m.id = p_map) = 'group'
      then case when (select m.owner from public.maps m where m.id = p_map) = auth.uid() then 'admin'
        else coalesce((select mm.role from public.map_members mm
          where mm.map_id = p_map and mm.user_id = auth.uid()), 'none') end
    else 'none'
  end;
$$;
create or replace function public.account_is_pro(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.plan = 'pro' from public.profiles p where p.id = p_user), false);
$$;
create or replace function public.account_policy()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := auth.uid();
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  insert into public.profiles (id, nick) values (v_id, 'игрок') on conflict (id) do nothing;
  insert into public.maps (id, kind, title, owner, confirm_required)
    values (v_id, 'personal', 'Личная карта', v_id, 0) on conflict (id) do nothing;
  if not exists (select 1 from public.maps where id = v_id and kind = 'personal' and owner = v_id) then
    raise exception 'код личной карты занят' using errcode = '42501';
  end if;
  return jsonb_build_object('plan', case when public.account_is_pro(v_id) then 'pro' else 'free' end,
    'personalMap', v_id);
end;
$$;
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
          case when m.kind = 'personal' then null else (select array_agg(p.nick order by r.reported_at, p.nick)
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
returns table (a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz,
  confirms numeric, needed smallint, reporters text[])
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
    return query select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source,
      e.by_nick, e.updated_at, e.confirms,
      case when e.trusted then 0::smallint else m.confirm_required end,
      case when m.kind = 'personal' then null::text[] else (
        select array_agg(p.nick order by r.reported_at, p.nick)
        from public.edge_reports r join public.profiles p on p.id = r.user_id
        where r.map_id = e.map_id and r.a = e.a and r.b = e.b) end
    from public.edges e join public.maps m on m.id = e.map_id
    where e.map_id = p_map and public.my_role(p_map) <> 'none'
      and e.updated_at > coalesce(p_since, '-infinity'::timestamptz)
      and (e.expires_at is null or e.expires_at > now())
      and (m.confirm_required = 0 or e.trusted or e.confirms >= m.confirm_required
        or exists (select 1 from public.edge_reports r where r.map_id = e.map_id
          and r.a = e.a and r.b = e.b and r.user_id = auth.uid()))
    order by e.updated_at limit 2000;
end;
$$;

drop trigger if exists personal_edge_global_version on public.edges;
drop trigger if exists sharing_global_version on public.profiles;
drop function if exists public.touch_global_from_personal_edge();
drop function if exists public.touch_global_from_sharing();
drop function if exists public.global_edges();
drop function if exists public.account_set_sharing(boolean);
drop function if exists public.admin_personal_maps();
-- Preserve the unused legacy preference for rollback; no function reads or changes it.
revoke all on function public.account_is_pro(uuid) from public, anon, authenticated;
revoke all on function public.account_policy() from public, anon;
revoke all on function public.my_role(uuid) from public, anon;
revoke all on function public.pull_map_snapshot(uuid, text) from public, anon;
revoke all on function public.pull_edges(uuid, timestamptz) from public, anon;
grant execute on function public.account_policy(), public.my_role(uuid),
  public.pull_map_snapshot(uuid, text), public.pull_edges(uuid, timestamptz) to authenticated;
commit;
