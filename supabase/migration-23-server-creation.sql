-- Atomic code activation + server creation. Existing maps, roles and licenses stay intact.
-- Run after migration 22. Retrying a creation code returns its original server.
begin;
create or replace function public.create_server_with_code(p_title text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb; v_license public.subscriptions%rowtype; v_map uuid;
  v_title text := trim(coalesce(p_title, ''));
begin
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  if length(v_title) not between 1 and 60 then
    return jsonb_build_object('ok', false, 'code', 'invalid_title');
  end if;
  -- Redemption holds an account lock and a code row lock until this transaction ends.
  v_result := public.billing_redeem_code(p_code, null);
  if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
  select * into v_license from public.subscriptions
    where id = (v_result->>'licenseId')::uuid and account_id = auth.uid() for update;
  if not found then raise exception 'invalid_license'; end if;
  if v_license.map_id is not null then
    select id, title into v_map, v_title from public.maps
      where id = v_license.map_id and owner = auth.uid() and kind = 'group';
    if not found then return jsonb_build_object('ok', false, 'code', 'map_owner_required'); end if;
    return jsonb_build_object('ok', true, 'id', v_map, 'title', v_title,
      'alreadyCreated', true, 'status', public.billing_status());
  end if;
  if v_license.revoked_at is not null or v_license.expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'code', 'license_expired');
  end if;
  perform public.take_slot('create:' || auth.uid()::text, interval '1 hour', 60);
  insert into public.maps(kind, title, owner) values ('group', v_title, auth.uid()) returning id into v_map;
  update public.subscriptions set map_id = v_map where id = v_license.id;
  insert into public.map_members(map_id, user_id, role) values (v_map, auth.uid(), 'admin');
  return jsonb_build_object('ok', true, 'id', v_map, 'title', v_title,
    'alreadyCreated', false, 'status', public.billing_status());
end;
$$;
revoke all on function public.create_server_with_code(text,text) from public, anon, authenticated;
grant execute on function public.create_server_with_code(text,text) to authenticated;

-- Canonical title only. Legacy clients may still send p_title when joining; ignore it.
create or replace function public.my_maps()
returns table (id uuid, title text, kind text, confirm_required smallint, is_owner boolean, role text)
language sql security definer set search_path = public as $$
  select m.id, m.title, m.kind, m.confirm_required, m.owner = auth.uid(), mm.role
  from public.maps m join public.map_members mm on mm.map_id = m.id
  where mm.user_id = auth.uid() order by mm.joined_at;
$$;
create or replace function public.join_map(p_map uuid, p_title text default null)
returns table (id uuid, title text, kind text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_id uuid := auth.uid(); v_kind text;
begin
  if v_id is null then raise exception 'account_required' using errcode = '28000'; end if;
  select m.kind into v_kind from public.maps m where m.id = p_map;
  if v_kind is null then raise exception 'map_not_found' using errcode = 'no_data_found'; end if;
  if v_kind <> 'group' then raise exception 'group_map_required'; end if;
  insert into public.map_members(map_id,user_id,role) values(p_map,v_id,'viewer')
    on conflict(map_id,user_id) do nothing;
  return query select m.id,m.title,m.kind from public.maps m
    join public.map_members mm on mm.map_id=m.id and mm.user_id=v_id where m.id=p_map;
end;
$$;
revoke all on function public.my_maps(), public.join_map(uuid,text) from public, anon;
grant execute on function public.my_maps(), public.join_map(uuid,text) to authenticated;
create or replace function public.billing_status()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public.billing_status_paid() || jsonb_build_object(
    'recordingFree', true, 'unlimited', true, 'codeRedemptionReady', true,
    'unlimitedUntil', null, 'personalUntil', null, 'includedUntil', null,
    'quota', jsonb_build_object('used', 0, 'limit', null, 'remaining', null, 'resetsAt', null),
    'trial', jsonb_build_object('enabled', false, 'eligible', false, 'active', false),
    'groups', coalesce((select jsonb_agg(jsonb_build_object(
      'mapId', m.id, 'title', m.title, 'isOwner', m.owner = auth.uid(), 'active', public.group_subscription_active(m.id),
      'permanent', p.map_id is not null,
      'expiresAt', case when p.map_id is null then s.expires_at end,
      'retainedUntil', case when p.map_id is null then s.expires_at + interval '2880 hours' end))
      from public.maps m left join public.billing_permanent_groups p on p.map_id = m.id
      left join lateral (select max(expires_at) expires_at from public.subscriptions
        where map_id = m.id and product = 'group' and revoked_at is null and starts_at <= now()) s on true
      where m.kind = 'group' and exists(select 1 from public.map_members mm where mm.map_id=m.id and mm.user_id=auth.uid())), '[]'::jsonb));
end;
$$;

notify pgrst, 'reload schema';
commit;
