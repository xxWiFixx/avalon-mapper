-- Read the layout only when its revision changed. Unlike map_layout(), this
-- read path never creates a row or takes the writer's advisory lock.
begin;
create or replace function public.map_layout_since(p_map uuid, p_revision integer default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid; v_kind text; v_role text; v_revision integer; v_positions jsonb;
begin
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  select owner, kind into v_owner, v_kind from public.maps where id = p_map;
  v_role := public.my_role(p_map);
  if v_role = 'none' or v_owner is null then raise exception 'map_access_denied' using errcode = '42501'; end if;
  if v_kind = 'group' and public.billing_enabled() and not public.group_subscription_active(p_map) then
    raise exception 'group_subscription_expired' using errcode = '42501';
  end if;

  select revision into v_revision from public.map_layouts where map_id = p_map;
  if p_revision is not null and p_revision = coalesce(v_revision, 0) then
    return jsonb_build_object('revision', coalesce(v_revision, 0), 'unchanged', true);
  end if;
  -- A concurrent write between these selects is harmless: the next check
  -- will see its revision. Return coordinates and revision from one row read.
  select revision, positions into v_revision, v_positions from public.map_layouts where map_id = p_map;
  return jsonb_build_object('revision', coalesce(v_revision, 0),
    'positions', coalesce(v_positions, '{}'::jsonb));
end;
$$;
revoke all on function public.map_layout_since(uuid,integer) from public, anon;
grant execute on function public.map_layout_since(uuid,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
