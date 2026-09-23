-- Personal cloud maps and the paid aggregate. Apply after migration-09.
-- The personal map uses the account UUID as its map UUID. Tables remain behind RLS;
-- authenticated clients use only the functions granted at the end of this file.
begin;

alter table public.maps drop constraint if exists maps_kind_check;
alter table public.maps add constraint maps_kind_check check (kind in ('group', 'public', 'personal'));
alter table public.profiles add column if not exists plan text not null default 'free';
alter table public.profiles add column if not exists share_public boolean not null default true;
alter table public.profiles drop constraint if exists profiles_plan_check;
alter table public.profiles add constraint profiles_plan_check check (plan in ('free', 'pro'));

-- Only a server-side grant can make an account Pro. The owner has permanent Pro access.
create or replace function public.account_is_pro(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user = '63cba067-4c94-48e5-8d0e-6f56dba2a65e'::uuid
    or coalesce((select p.plan = 'pro' from public.profiles p where p.id = p_user), false);
$$;

create or replace function public.my_role(p_map uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when auth.uid() is null then 'none'
    when (select m.kind from public.maps m where m.id = p_map) = 'public'
      then case when public.account_is_pro(auth.uid()) then 'viewer' else 'none' end
    when (select m.kind from public.maps m where m.id = p_map) = 'personal'
      then case when (select m.owner from public.maps m where m.id = p_map) = auth.uid()
                  or auth.uid() = '63cba067-4c94-48e5-8d0e-6f56dba2a65e'::uuid
                then 'admin' else 'none' end
    when (select m.owner from public.maps m where m.id = p_map) = auth.uid() then 'admin'
    else coalesce((select mm.role from public.map_members mm
      where mm.map_id = p_map and mm.user_id = auth.uid()), 'none')
  end;
$$;

-- Called on sign-in. Existing local data is uploaded by the client after this succeeds.
create or replace function public.account_policy()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := auth.uid(); v_share boolean;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  insert into public.profiles (id, nick) values (v_id, 'игрок') on conflict (id) do nothing;
  insert into public.maps (id, kind, title, owner, confirm_required)
    values (v_id, 'personal', 'Личная карта', v_id, 0) on conflict (id) do nothing;
  if not exists (select 1 from public.maps where id = v_id and kind = 'personal' and owner = v_id) then
    raise exception 'код личной карты занят' using errcode = '42501';
  end if;
  select p.share_public into v_share from public.profiles p where p.id = v_id;
  return jsonb_build_object('plan', case when public.account_is_pro(v_id) then 'pro' else 'free' end,
    'sharePublic', case when public.account_is_pro(v_id) then coalesce(v_share, true) else true end,
    'canViewAll', public.account_is_pro(v_id), 'personalMap', v_id);
end;
$$;

create or replace function public.account_set_sharing(p_share boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := auth.uid();
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  if p_share is false and not public.account_is_pro(v_id) then
    raise exception 'отключить публикацию может только подписчик' using errcode = '42501';
  end if;
  update public.profiles set share_public = coalesce(p_share, true) where id = v_id;
  return public.account_policy();
end;
$$;

-- The aggregate is derived from active personal maps. An opt-out removes every
-- contribution immediately; a re-enable includes existing active portals again.
create or replace function public.global_edges()
returns table (a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz,
  confirms numeric, needed smallint, reporters text[])
language sql stable security definer set search_path = public as $$
  select distinct on (e.a, e.b) e.a, e.b, e.cap_max, e.cap_max_known,
    e.expires_at, e.source, null::text, e.updated_at, 1::numeric, 0::smallint, null::text[]
  from public.edges e
  join public.maps m on m.id = e.map_id and m.kind = 'personal'
  join public.profiles p on p.id = m.owner
    and (p.share_public or not public.account_is_pro(p.id))
  where e.expires_at > now()
  order by e.a, e.b, e.updated_at desc, e.map_id;
$$;

create or replace function public.touch_global_from_personal_edge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.maps where id = coalesce(NEW.map_id, OLD.map_id) and kind = 'personal') then
    update public.maps set sync_version = sync_version + 1
      where id = '00000000-0000-0000-0000-0000000000a0'::uuid;
  end if;
  return coalesce(NEW, OLD);
end;
$$;
drop trigger if exists personal_edge_global_version on public.edges;
create trigger personal_edge_global_version after insert or update or delete on public.edges
for each row execute function public.touch_global_from_personal_edge();

create or replace function public.touch_global_from_sharing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.maps set sync_version = sync_version + 1
    where id = '00000000-0000-0000-0000-0000000000a0'::uuid;
  return NEW;
end;
$$;
drop trigger if exists sharing_global_version on public.profiles;
create trigger sharing_global_version after update of share_public, plan on public.profiles
for each row when (OLD.share_public is distinct from NEW.share_public or OLD.plan is distinct from NEW.plan)
execute function public.touch_global_from_sharing();

create or replace function public.pull_map_snapshot(p_map uuid, p_version text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  if p_map = '00000000-0000-0000-0000-0000000000a0'::uuid then
    if not public.account_is_pro(auth.uid()) then return jsonb_build_object('denied', true); end if;
    select jsonb_build_object('version', m.sync_version::text, 'role', 'viewer',
      'confirmRequired', 0, 'unchanged', m.sync_version::text = coalesce(p_version, ''))
      || case when m.sync_version::text = coalesce(p_version, '') then '{}'::jsonb
        else jsonb_build_object('edges', coalesce((select jsonb_agg(to_jsonb(g) order by g.updated_at, g.a, g.b)
          from public.global_edges() g), '[]'::jsonb)) end
      into v_result from public.maps m where m.id = p_map;
    return coalesce(v_result, jsonb_build_object('denied', true));
  end if;
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
  if p_map = '00000000-0000-0000-0000-0000000000a0'::uuid then
    if not public.account_is_pro(auth.uid()) then raise exception 'нужна подписка' using errcode = '42501'; end if;
    return query select g.* from public.global_edges() g
      where g.updated_at > coalesce(p_since, '-infinity'::timestamptz)
      order by g.updated_at limit 2000;
  else
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
  end if;
end;
$$;

-- The owner can inspect cloud personal maps, while a subscriber sees only the aggregate.
create or replace function public.admin_personal_maps()
returns table (map_id uuid, account_id uuid, nick text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is distinct from '63cba067-4c94-48e5-8d0e-6f56dba2a65e'::uuid then
    raise exception 'доступно владельцу' using errcode = '42501';
  end if;
  return query select m.id, m.owner, p.nick from public.maps m
    left join public.profiles p on p.id = m.owner where m.kind = 'personal';
end;
$$;

revoke all on function public.account_is_pro(uuid) from public, anon, authenticated;
revoke all on function public.global_edges() from public, anon, authenticated;
revoke all on function public.touch_global_from_personal_edge() from public, anon, authenticated;
revoke all on function public.touch_global_from_sharing() from public, anon, authenticated;
revoke all on function public.account_policy() from public, anon;
revoke all on function public.account_set_sharing(boolean) from public, anon;
revoke all on function public.admin_personal_maps() from public, anon;
grant execute on function public.account_policy() to authenticated;
grant execute on function public.account_set_sharing(boolean) to authenticated;
grant execute on function public.admin_personal_maps() to authenticated;
commit;
