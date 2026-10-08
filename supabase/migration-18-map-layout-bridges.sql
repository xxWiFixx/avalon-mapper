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
  if p_replace and v_role not in ('admin','verified') then raise exception 'layout_role_required' using errcode = '42501'; end if;
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

-- Automatic moves are deliberately narrower than the privileged full reset:
-- one rigid translation of a leaf component of at most two zones, once per bridge.
alter table public.map_layouts add column if not exists moved_bridges jsonb not null default '{}'::jsonb;
create or replace function public.map_layout_merge(p_map uuid,p_bridge text[],p_positions jsonb,p_revision integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_result jsonb; v_row public.map_layouts%rowtype; v_edges jsonb; v_left text[]; v_right text[]; v_keys text[];
  v_small text[]; v_big text[]; v_moving text; v_anchor text; v_key text; v_n text; v_p jsonb;
  v_dx numeric; v_dy numeric; v_x numeric; v_y numeric; v_old numeric; v_new numeric;
begin
  v_result:=public.map_layout(p_map); -- membership, billing and transaction lock
  select * into v_row from public.map_layouts where map_id=p_map;
  if p_revision is distinct from v_row.revision then return v_result||'{"conflict":true}'::jsonb; end if;
  if cardinality(p_bridge) is distinct from 2 or p_bridge[1] is null or p_bridge[2] is null or p_bridge[1]=p_bridge[2]
    or jsonb_typeof(p_positions) is distinct from 'object' or octet_length(p_positions::text)>1000 then raise exception 'invalid_merge'; end if;
  v_key:=to_jsonb(array[least(p_bridge[1],p_bridge[2]),greatest(p_bridge[1],p_bridge[2])])::text;
  if v_row.moved_bridges ? v_key then return v_result||'{"skipped":true}'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_array(e.a,e.b)),'[]'::jsonb) into v_edges
    from public.edges e join public.maps m on m.id=e.map_id where e.map_id=p_map
    and coalesce(e.expires_at,e.updated_at+interval '6 hours')>now()
    and (m.confirm_required=0 or e.trusted or e.confirms>=m.confirm_required);
  if not exists(select 1 from jsonb_array_elements(v_edges) e where (e->>0=p_bridge[1] and e->>1=p_bridge[2]) or (e->>1=p_bridge[1] and e->>0=p_bridge[2])) then
    return v_result||'{"retry":true}'::jsonb;
  end if;
  with recursive links as (select e->>0 a,e->>1 b from jsonb_array_elements(v_edges) e
    where not ((e->>0=p_bridge[1] and e->>1=p_bridge[2]) or (e->>1=p_bridge[1] and e->>0=p_bridge[2]))),
    reach(n) as (select p_bridge[1] union select case when l.a=r.n then l.b else l.a end from reach r join links l on l.a=r.n or l.b=r.n)
    select array_agg(n order by n) into v_left from reach;
  with recursive links as (select e->>0 a,e->>1 b from jsonb_array_elements(v_edges) e
    where not ((e->>0=p_bridge[1] and e->>1=p_bridge[2]) or (e->>1=p_bridge[1] and e->>0=p_bridge[2]))),
    reach(n) as (select p_bridge[2] union select case when l.a=r.n then l.b else l.a end from reach r join links l on l.a=r.n or l.b=r.n)
    select array_agg(n order by n) into v_right from reach;
  if p_bridge[2]=any(v_left) or cardinality(v_left)=cardinality(v_right) then return v_result||'{"skipped":true}'::jsonb; end if;
  if cardinality(v_left)<cardinality(v_right) then v_small:=v_left;v_big:=v_right;v_moving:=p_bridge[1];v_anchor:=p_bridge[2];
  else v_small:=v_right;v_big:=v_left;v_moving:=p_bridge[2];v_anchor:=p_bridge[1];end if;
  if cardinality(v_small)>2 then return v_result||'{"skipped":true}'::jsonb;end if;
  select array_agg(key order by key) into v_keys from jsonb_each(p_positions);
  if v_keys is distinct from v_small or not(v_row.positions ? v_anchor) then raise exception 'invalid_merge';end if;
  foreach v_n in array v_small loop
    v_p:=p_positions->v_n;
    if not(v_row.positions ? v_n) or jsonb_typeof(v_p->'x') is distinct from 'number' or jsonb_typeof(v_p->'y') is distinct from 'number' then raise exception 'invalid_merge';end if;
    v_x:=(v_p->>'x')::numeric;v_y:=(v_p->>'y')::numeric;
    if abs(v_x)>1000000 or abs(v_y)>1000000 then raise exception 'invalid_merge';end if;
    if v_dx is null then v_dx:=v_x-(v_row.positions->v_n->>'x')::numeric;v_dy:=v_y-(v_row.positions->v_n->>'y')::numeric;
    elsif abs(v_x-(v_row.positions->v_n->>'x')::numeric-v_dx)>.001 or abs(v_y-(v_row.positions->v_n->>'y')::numeric-v_dy)>.001 then raise exception 'non_rigid_merge';end if;
    if exists(select 1 from jsonb_each(v_row.positions) f where not(f.key=any(v_small))
      and abs(v_x-(f.value->>'x')::numeric)<110 and abs(v_y-(f.value->>'y')::numeric)<80) then raise exception 'merge_overlap';end if;
  end loop;
  v_old:=sqrt(power((v_row.positions->v_moving->>'x')::numeric-(v_row.positions->v_anchor->>'x')::numeric,2)+power((v_row.positions->v_moving->>'y')::numeric-(v_row.positions->v_anchor->>'y')::numeric,2));
  v_new:=sqrt(power((p_positions->v_moving->>'x')::numeric-(v_row.positions->v_anchor->>'x')::numeric,2)+power((p_positions->v_moving->>'y')::numeric-(v_row.positions->v_anchor->>'y')::numeric,2));
  if v_old<260 or v_new>421 or v_new>=v_old then return v_result||'{"skipped":true}'::jsonb;end if;
  update public.map_layouts set positions=positions||p_positions,revision=revision+1,moved_bridges=jsonb_set(moved_bridges,array[v_key],'true'::jsonb)
    where map_id=p_map returning * into v_row;
  return jsonb_build_object('positions',v_row.positions,'revision',v_row.revision);
end;
$$;
revoke all on function public.map_layout_merge(uuid,text[],jsonb,integer) from public,anon;
grant execute on function public.map_layout_merge(uuid,text[],jsonb,integer) to authenticated;
notify pgrst,'reload schema';
commit;
