-- Stable coordinates per private/group map; apply after migration 16.
begin;
create table if not exists public.map_layouts (
  map_id uuid primary key references public.maps(id) on delete cascade,
  revision integer not null default 0,
  positions jsonb not null default '{}'::jsonb
);
alter table public.map_layouts enable row level security;
revoke all on public.map_layouts from public, anon, authenticated;

create or replace function public.map_layout(p_map uuid, p_positions jsonb default null,
  p_revision integer default null, p_replace boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.map_layouts%rowtype;
  v_owner uuid; v_role text; v_kind text; v_key text; v_pos jsonb; v_next jsonb;
begin
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  select owner, kind into v_owner, v_kind from public.maps where id = p_map;
  v_role := public.my_role(p_map);
  if v_role = 'none' or v_owner is null then raise exception 'map_access_denied' using errcode = '42501'; end if;
  if v_kind = 'group' and public.billing_enabled() and not public.group_subscription_active(p_map) then
    raise exception 'group_subscription_expired' using errcode = '42501';
  end if;
  if p_replace and v_owner <> auth.uid() then raise exception 'owner_required' using errcode = '42501'; end if;
  -- Serialize initial creation and concurrent proposals, then compare the revision.
  perform pg_advisory_xact_lock(hashtextextended('map-layout:' || p_map::text, 0));
  insert into public.map_layouts(map_id) values (p_map) on conflict do nothing;
  select * into v_row from public.map_layouts where map_id = p_map;
  if p_positions is null then return jsonb_build_object('revision', v_row.revision, 'positions', v_row.positions); end if;
  if p_revision is distinct from v_row.revision then
    return jsonb_build_object('revision', v_row.revision, 'positions', v_row.positions, 'conflict', true);
  end if;
  if jsonb_typeof(p_positions) <> 'object' or octet_length(p_positions::text) > 600000 then
    raise exception 'invalid_positions';
  end if;
  v_next := case when p_replace then '{}'::jsonb else v_row.positions end;
  for v_key, v_pos in select key, value from jsonb_each(p_positions) loop
    if length(v_key) < 2 or length(v_key) > 100 or jsonb_typeof(v_pos) <> 'object'
      or jsonb_typeof(v_pos->'x') is distinct from 'number' or jsonb_typeof(v_pos->'y') is distinct from 'number' then
      raise exception 'invalid_position';
    end if;
    if abs((v_pos->>'x')::numeric) > 1000000 or abs((v_pos->>'y')::numeric) > 1000000 then raise exception 'invalid_position'; end if;
    -- A viewer may seed unseen positions, but cannot move existing nodes. Only actual
    -- zones of this map are accepted (no coordinate data from another private map).
    if (p_replace or not (v_next ? v_key)) and exists (
      select 1 from public.edges e where e.map_id = p_map and (e.a = v_key or e.b = v_key)
        and (e.expires_at is null or e.expires_at > now())
    ) then
      v_next := jsonb_set(v_next, array[v_key], jsonb_build_object('x', v_pos->'x', 'y', v_pos->'y'));
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(v_next)) > 5000 then raise exception 'layout_too_large'; end if;
  if v_next is distinct from v_row.positions then
    update public.map_layouts set positions = v_next, revision = revision + 1 where map_id = p_map returning * into v_row;
  end if;
  return jsonb_build_object('revision', v_row.revision, 'positions', v_row.positions);
end;
$$;
revoke all on function public.map_layout(uuid,jsonb,integer,boolean) from public, anon;
grant execute on function public.map_layout(uuid,jsonb,integer,boolean) to authenticated;
notify pgrst, 'reload schema';
commit;
