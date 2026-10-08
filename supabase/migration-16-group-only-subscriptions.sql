-- Group channels are the only paid product. Recording is free for everyone.
-- Apply after migration 15. Preserve maps, memberships, payment/trial history,
-- billing activation flags and all existing group licenses.
begin;

create or replace function public.billing_status()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  return public.billing_status_paid() || jsonb_build_object(
    'recordingFree', true, 'unlimited', true,
    'unlimitedUntil', null, 'personalUntil', null, 'includedUntil', null,
    'quota', jsonb_build_object('used', 0, 'limit', null, 'remaining', null, 'resetsAt', null),
    'trial', jsonb_build_object('enabled', false, 'eligible', false, 'active', false));
end;
$$;

-- Old clients may still call this endpoint. Do not grant or consume a trial.
create or replace function public.billing_start_trial()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  return jsonb_build_object('ok', false, 'code', 'personal_plan_removed', 'status', public.billing_status());
end;
$$;

-- Keep legacy capture requests working, without a quota or an included seat.
create or replace function public.authorize_capture(p_id uuid, p_a text, p_b text, p_expires timestamptz,
  p_cap_max smallint default null, p_cap_known boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_a text := least(p_a, p_b); v_b text := greatest(p_a, p_b);
  v_old public.capture_receipts%rowtype;
begin
  if v_uid is null then raise exception 'account_required' using errcode = '28000'; end if;
  if p_id is null or p_a is null or p_b is null or v_a = v_b
    or length(v_a) not between 2 and 40 or length(v_b) not between 2 and 40
    or p_expires is null or p_expires <= now() or p_expires > now() + interval '48 hours' then
    return jsonb_build_object('ok', false, 'code', 'invalid_portal');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('capture:' || p_id::text, 0));
  select * into v_old from public.capture_receipts where id = p_id;
  if found then
    if v_old.user_id <> v_uid or v_old.a <> v_a or v_old.b <> v_b or v_old.expires_at < p_expires then
      return jsonb_build_object('ok', false, 'code', 'invalid_receipt');
    end if;
    return jsonb_build_object('ok', true, 'receipt', p_id, 'status', public.billing_status());
  end if;
  perform public.account_policy();
  perform public.push_edges_unmetered(v_uid, jsonb_build_array(jsonb_build_object('a', v_a, 'b', v_b,
    'expiresAt', p_expires, 'source', 'ocr', 'capMax', p_cap_max, 'capMaxKnown', coalesce(p_cap_known, false))));
  insert into public.capture_receipts(id, user_id, a, b, expires_at) values (p_id, v_uid, v_a, v_b, p_expires);
  return jsonb_build_object('ok', true, 'receipt', p_id, 'status', public.billing_status());
end;
$$;

-- New clients synchronize recordings made locally, including offline captures.
-- Existing role, confirmation and account checks stay in the private function.
create or replace function public.push_edges(p_map uuid, p_edges jsonb)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if public.billing_enabled()
    and exists(select 1 from public.maps where id = p_map and kind = 'group')
    and not public.group_subscription_active(p_map) then
    raise exception 'group_subscription_expired' using errcode = 'P0001';
  end if;
  return public.push_edges_unmetered(p_map, p_edges);
end;
$$;

create or replace function public.billing_grant(p_account uuid, p_product text, p_expires timestamptz,
  p_payment_ref text, p_map uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_old public.subscriptions%rowtype;
begin
  if p_product is distinct from 'group' or p_expires is null or p_expires <= now()
    or p_payment_ref is null or length(p_payment_ref) not between 1 and 200 then
    raise exception 'invalid_subscription' using errcode = '22023';
  end if;
  if p_map is not null and not exists
      (select 1 from public.maps where id = p_map and kind = 'group' and owner = p_account) then
    raise exception 'invalid_subscription_map' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('payment:' || p_payment_ref, 0));
  select * into v_old from public.subscriptions where payment_ref = p_payment_ref;
  if found then
    if v_old.account_id <> p_account or v_old.product <> p_product or v_old.expires_at <> p_expires
      or (p_map is not null and v_old.map_id is distinct from p_map) then
      raise exception 'payment_event_conflict' using errcode = '22023';
    end if;
    return v_old.id;
  end if;
  insert into public.subscriptions(account_id, product, expires_at, payment_ref, map_id)
    values (p_account, 'group', p_expires, p_payment_ref, p_map) returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.billing_status(), public.billing_start_trial(),
  public.authorize_capture(uuid, text, text, timestamptz, smallint, boolean), public.push_edges(uuid,jsonb),
  public.billing_grant(uuid, text, timestamptz, text, uuid) from public, anon, authenticated;
grant execute on function public.billing_status(), public.billing_start_trial(),
  public.authorize_capture(uuid, text, text, timestamptz, smallint, boolean), public.push_edges(uuid,jsonb) to authenticated;
grant execute on function public.billing_grant(uuid, text, timestamptz, text, uuid) to service_role;
notify pgrst, 'reload schema';
commit;
