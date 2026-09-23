-- Apply after migration-07. Existing clients can continue using pull_edges.
-- A map version lets clients reconcile deletions and policy changes without polling full maps.
begin;

alter table public.maps add column if not exists sync_version bigint not null default 0;

create or replace function public.touch_shared_map()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'DELETE' then
    update public.maps set sync_version = sync_version + 1 where id = OLD.map_id;
    return OLD;
  end if;
  update public.maps set sync_version = sync_version + 1 where id = NEW.map_id;
  return NEW;
end;
$$;
drop trigger if exists edges_sync_version on public.edges;
create trigger edges_sync_version after insert or update or delete on public.edges
for each row execute function public.touch_shared_map();
drop trigger if exists members_sync_version on public.map_members;
create trigger members_sync_version after insert or update or delete on public.map_members
for each row execute function public.touch_shared_map();

create or replace function public.touch_shared_map_policy()
returns trigger language plpgsql set search_path = public as $$
begin
  if NEW.confirm_required is distinct from OLD.confirm_required then
    NEW.sync_version := OLD.sync_version + 1;
  end if;
  return NEW;
end;
$$;
drop trigger if exists policy_sync_version on public.maps;
create trigger policy_sync_version before update of confirm_required on public.maps
for each row execute function public.touch_shared_map_policy();

create or replace function public.touch_shared_map_reporter()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.maps set sync_version = sync_version + 1 where id in
    (select distinct map_id from public.edge_reports where user_id = NEW.id);
  return NEW;
end;
$$;
drop trigger if exists reporter_sync_version on public.profiles;
create trigger reporter_sync_version after update of nick on public.profiles
for each row when (OLD.nick is distinct from NEW.nick) execute function public.touch_shared_map_reporter();

create or replace function public.push_edges(p_map uuid, p_edges jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := auth.uid();
  v_kind text; v_role text; v_nick text; v_a text; v_b text; v_source text;
  v_exp timestamptz; v_old public.edges%rowtype; v_e jsonb;
  v_count integer := 0;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  -- Serializes writes to one map, including independent confirmations of the same portal.
  select kind into v_kind from public.maps where id = p_map for update;
  if v_kind is null then raise exception 'нет такой карты' using errcode = 'no_data_found'; end if;
  v_role := public.my_role(p_map);
  if v_role = 'none' then raise exception 'ты не в этой карте' using errcode = '42501'; end if;
  if v_role = 'viewer' then raise exception 'в этой карте доступен только просмотр' using errcode = '42501'; end if;
  if jsonb_typeof(p_edges) is distinct from 'array' or jsonb_array_length(p_edges) > 200 then
    raise exception 'ожидался массив не более 200 порталов' using errcode = 'P0001';
  end if;
  perform public.take_slot('push:' || p_map::text || ':' || v_id::text, interval '1 minute', 60);
  select nick into v_nick from public.profiles where id = v_id;

  for v_e in select value from jsonb_array_elements(p_edges) loop
    v_a := least(v_e->>'a', v_e->>'b');
    v_b := greatest(v_e->>'a', v_e->>'b');
    if v_a is null or v_b is null or v_a = v_b or length(v_a) not between 2 and 40
       or length(v_b) not between 2 and 40 then continue; end if;
    v_exp := nullif(v_e->>'expiresAt', '')::timestamptz;
    if v_exp is not null then
      if v_exp <= now() then continue; end if;
      v_exp := least(v_exp, now() + interval '48 hours');
    elsif v_kind = 'public' then continue;
    end if;
    v_source := case when v_e->>'source' = 'manual' then 'manual' else 'ocr' end;
    select * into v_old from public.edges where map_id = p_map and a = v_a and b = v_b;
    if found and coalesce(v_old.expires_at, v_old.updated_at + interval '6 hours') <= now() then
      delete from public.edge_reports where map_id = p_map and a = v_a and b = v_b;
      delete from public.edges where map_id = p_map and a = v_a and b = v_b;
    end if;

    -- Separate statements make the new report visible to the confirmation count below.
    insert into public.edge_reports as r (map_id, a, b, user_id, source)
      values (p_map, v_a, v_b, v_id, v_source)
    on conflict (map_id, a, b, user_id) do update
      set source = case when r.source = 'ocr' or excluded.source = 'ocr' then 'ocr' else 'manual' end;
    insert into public.edges as e
      (map_id, a, b, cap_max, cap_max_known, expires_at, source, by_nick, updated_at, confirms, trusted)
    values (p_map, v_a, v_b,
      case when coalesce((v_e->>'capMaxKnown')::boolean, false) then nullif(v_e->>'capMax', '')::smallint end,
      coalesce((v_e->>'capMaxKnown')::boolean, false), v_exp, v_source,
      case when v_kind = 'public' then null else v_nick end, clock_timestamp(),
      (select sum(case when r.source = 'manual' then 0.5 else 1 end) from public.edge_reports r
        where r.map_id = p_map and r.a = v_a and r.b = v_b), v_role in ('verified', 'admin'))
    on conflict (map_id, a, b) do update set
      cap_max = coalesce(excluded.cap_max, e.cap_max),
      cap_max_known = e.cap_max_known or excluded.cap_max_known,
      expires_at = coalesce(excluded.expires_at, e.expires_at),
      source = excluded.source, by_nick = coalesce(e.by_nick, excluded.by_nick),
      updated_at = excluded.updated_at, confirms = excluded.confirms,
      trusted = e.trusted or excluded.trusted;
    v_count := v_count + 1;
  end loop;
  delete from public.edges where map_id = p_map
    and coalesce(expires_at, updated_at + interval '6 hours') < now() - interval '10 minutes';
  delete from public.edge_reports r where r.map_id = p_map and not exists
    (select 1 from public.edges e where e.map_id = r.map_id and e.a = r.a and e.b = r.b);
  return v_count;
end;
$$;

create or replace function public.pull_map_snapshot(p_map uuid, p_version text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  -- Version and rows use one statement snapshot; a concurrent commit is picked up next time.
  select case when public.my_role(m.id) = 'none' then jsonb_build_object('denied', true)
    else jsonb_build_object('version', m.sync_version::text, 'role', public.my_role(m.id),
      'confirmRequired', m.confirm_required, 'unchanged', m.sync_version::text = coalesce(p_version, ''))
    || case when m.sync_version::text = coalesce(p_version, '') then '{}'::jsonb else
      jsonb_build_object('edges', coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at, x.a, x.b) from (
        select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source, e.by_nick, e.updated_at,
          e.confirms, m.confirm_required as needed,
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

-- Repair existing counters without changing portal timers or authors.
update public.edges e set confirms = coalesce((select sum(case when r.source = 'manual' then 0.5 else 1 end)
  from public.edge_reports r where r.map_id = e.map_id and r.a = e.a and r.b = e.b), 0);

revoke all on function public.touch_shared_map() from public, anon, authenticated;
revoke all on function public.touch_shared_map_policy() from public, anon, authenticated;
revoke all on function public.touch_shared_map_reporter() from public, anon, authenticated;
revoke all on function public.push_edges(uuid, jsonb) from public, anon;
revoke all on function public.pull_map_snapshot(uuid, text) from public, anon;
grant execute on function public.push_edges(uuid, jsonb) to authenticated;
grant execute on function public.pull_map_snapshot(uuid, text) to authenticated;

commit;
