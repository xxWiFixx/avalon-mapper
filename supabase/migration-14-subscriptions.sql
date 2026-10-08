-- Provider-independent entitlements. Apply after migration-13.
-- Enforcement starts disabled; only the service role can grant subscriptions.
begin;

create table if not exists public.billing_configuration (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false
);
insert into public.billing_configuration(singleton) values (true) on conflict do nothing;
alter table public.billing_configuration add column if not exists payment_ready boolean not null default false;
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references auth.users(id),
  product text not null check (product in ('personal', 'group')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  payment_ref text not null unique,
  map_id uuid references public.maps(id),
  included_user_id uuid references auth.users(id),
  check (expires_at > starts_at),
  check (product = 'group' or (map_id is null and included_user_id is null))
);
create index if not exists subscriptions_account on public.subscriptions(account_id, expires_at);
create index if not exists subscriptions_map on public.subscriptions(map_id, expires_at);
create table if not exists public.capture_usage (
  user_id uuid not null references auth.users(id),
  day date not null,
  used integer not null default 0 check (used >= 0),
  primary key (user_id, day)
);
create table if not exists public.capture_receipts (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  a text not null, b text not null, expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (a < b)
);
create index if not exists capture_receipts_pair on public.capture_receipts(user_id, a, b, expires_at);
alter table public.billing_configuration enable row level security;
alter table public.subscriptions enable row level security;
alter table public.capture_usage enable row level security;
alter table public.capture_receipts enable row level security;
revoke all on public.billing_configuration, public.subscriptions, public.capture_usage, public.capture_receipts
  from public, anon, authenticated;

create or replace function public.billing_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select enabled from public.billing_configuration where singleton;
$$;
create or replace function public.group_subscription_active(p_map uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.subscriptions where product = 'group' and map_id = p_map
    and revoked_at is null and starts_at <= now() and expires_at > now());
$$;
create or replace function public.billing_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_day date := (now() at time zone 'UTC')::date;
  v_until timestamptz; v_personal timestamptz; v_seat timestamptz; v_used integer;
begin
  if v_uid is null then raise exception 'account_required' using errcode = '28000'; end if;
  select max(expires_at) into v_personal from public.subscriptions where account_id = v_uid
    and product = 'personal' and revoked_at is null and starts_at <= now() and expires_at > now();
  select max(s.expires_at) into v_seat from public.subscriptions s join public.maps m on m.id = s.map_id
    where s.product = 'group' and s.included_user_id = v_uid and s.revoked_at is null
    and s.starts_at <= now() and s.expires_at > now() and public.my_role(m.id) <> 'none';
  v_until := greatest(v_personal, v_seat);
  select used into v_used from public.capture_usage where user_id = v_uid and day = v_day;
  return jsonb_build_object('userId', v_uid, 'enabled', public.billing_enabled(),
    'paymentReady', (select payment_ready from public.billing_configuration where singleton),
    'serverTime', now(), 'unlimited', v_until is not null, 'unlimitedUntil', v_until,
    'personalUntil', v_personal, 'includedUntil', v_seat,
    'quota', jsonb_build_object('used', coalesce(v_used, 0), 'limit', 10,
      'remaining', greatest(0, 10 - coalesce(v_used, 0)),
      'resetsAt', (v_day + 1)::timestamp at time zone 'UTC'),
    'licenses', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'mapId', s.map_id,
      'title', m.title, 'expiresAt', s.expires_at, 'revoked', s.revoked_at is not null,
      'active', s.revoked_at is null and s.starts_at <= now() and s.expires_at > now(),
      'includedUserId', s.included_user_id)) from public.subscriptions s left join public.maps m on m.id = s.map_id
      where s.account_id = v_uid and s.product = 'group'), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('mapId', m.id, 'title', m.title,
      'active', public.group_subscription_active(m.id))) from public.maps m
      where m.kind = 'group' and public.my_role(m.id) <> 'none'), '[]'::jsonb));
end;
$$;

-- Lock the account/day before checking a receipt: two PCs share one allowance.
-- Only complete, live portals are accepted. Rechecking a live pair is free.
drop function if exists public.authorize_capture(uuid, text, text, timestamptz);
create or replace function public.authorize_capture(p_id uuid, p_a text, p_b text, p_expires timestamptz,
  p_cap_max smallint default null, p_cap_known boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_day date := (now() at time zone 'UTC')::date;
  v_a text := least(p_a, p_b); v_b text := greatest(p_a, p_b);
  v_used integer; v_status jsonb; v_old public.capture_receipts%rowtype; v_repeat boolean;
begin
  if v_uid is null then raise exception 'account_required' using errcode = '28000'; end if;
  if p_id is null or p_a is null or p_b is null or v_a = v_b
    or length(v_a) not between 2 and 40 or length(v_b) not between 2 and 40
    or p_expires is null or p_expires <= now() or p_expires > now() + interval '48 hours' then
    return jsonb_build_object('ok', false, 'code', 'invalid_portal');
  end if;
  insert into public.capture_usage(user_id, day) values (v_uid, v_day) on conflict do nothing;
  select used into v_used from public.capture_usage where user_id = v_uid and day = v_day for update;
  select * into v_old from public.capture_receipts where id = p_id;
  if found then
    if v_old.user_id <> v_uid or v_old.a <> v_a or v_old.b <> v_b or v_old.expires_at < p_expires then
      return jsonb_build_object('ok', false, 'code', 'invalid_receipt');
    end if;
    return jsonb_build_object('ok', true, 'receipt', p_id, 'status', public.billing_status());
  end if;
  v_repeat := exists(select 1 from public.capture_receipts where user_id = v_uid and a = v_a and b = v_b and expires_at > now())
    or exists(select 1 from public.edges where map_id = v_uid and a = v_a and b = v_b and expires_at > now());
  v_status := public.billing_status();
  if public.billing_enabled() and not (v_status->>'unlimited')::boolean and not v_repeat and v_used >= 10 then
    return jsonb_build_object('ok', false, 'code', 'daily_limit', 'status', v_status);
  end if;
  -- Saving the private cloud copy and charging the quota are one transaction.
  -- A timeout/local disk failure cannot charge a recording which does not exist.
  perform public.account_policy();
  perform public.push_edges_unmetered(v_uid, jsonb_build_array(jsonb_build_object('a', v_a, 'b', v_b,
    'expiresAt', p_expires, 'source', 'ocr', 'capMax', p_cap_max, 'capMaxKnown', coalesce(p_cap_known, false))));
  insert into public.capture_receipts(id, user_id, a, b, expires_at) values (p_id, v_uid, v_a, v_b, p_expires);
  if not v_repeat and not (v_status->>'unlimited')::boolean then
    update public.capture_usage set used = used + 1 where user_id = v_uid and day = v_day;
  end if;
  return jsonb_build_object('ok', true, 'receipt', p_id, 'status', public.billing_status());
end;
$$;

-- Webhooks call this with the service-role key, never the public application key.
-- A repeated payment event cannot grant a second group server.
create or replace function public.billing_grant(p_account uuid, p_product text, p_expires timestamptz,
  p_payment_ref text, p_map uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_old public.subscriptions%rowtype;
begin
  if p_product not in ('personal', 'group') or p_expires is null or p_expires <= now()
    or p_payment_ref is null or length(p_payment_ref) not between 1 and 200 then
    raise exception 'invalid_subscription' using errcode = '22023';
  end if;
  if p_map is not null and (p_product <> 'group' or not exists
      (select 1 from public.maps where id = p_map and kind = 'group' and owner = p_account)) then
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
  insert into public.subscriptions(account_id, product, expires_at, payment_ref, map_id, included_user_id)
    values (p_account, p_product, p_expires, p_payment_ref, p_map, case when p_product = 'group' then p_account end)
    returning id into v_id;
  return v_id;
end;
$$;
create or replace function public.billing_revoke(p_payment_ref text)
returns void language sql security definer set search_path = public as $$
  update public.subscriptions set revoked_at = coalesce(revoked_at, now()) where payment_ref = p_payment_ref;
$$;
revoke all on function public.billing_enabled(), public.group_subscription_active(uuid), public.billing_status(),
  public.authorize_capture(uuid, text, text, timestamptz, smallint, boolean), public.billing_grant(uuid, text, timestamptz, text, uuid),
  public.billing_revoke(text) from public, anon, authenticated;
grant execute on function public.billing_status(), public.authorize_capture(uuid, text, text, timestamptz, smallint, boolean) to authenticated;
grant execute on function public.billing_grant(uuid, text, timestamptz, text, uuid), public.billing_revoke(text) to service_role;

-- Keep the established confirmation/role logic in private implementations.
do $$ begin
  if to_regprocedure('public.push_edges_unmetered(uuid,jsonb)') is null then
    alter function public.push_edges(uuid,jsonb) rename to push_edges_unmetered;
    alter function public.create_map(text) rename to create_map_unmetered;
    alter function public.pull_map_snapshot(uuid,text) rename to pull_map_snapshot_unmetered;
    alter function public.pull_edges(uuid,timestamptz) rename to pull_edges_unmetered;
  end if;
end $$;
revoke all on function public.push_edges_unmetered(uuid,jsonb), public.create_map_unmetered(text),
  public.pull_map_snapshot_unmetered(uuid,text), public.pull_edges_unmetered(uuid,timestamptz) from public, anon, authenticated;

create or replace function public.push_edges(p_map uuid, p_edges jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_e jsonb; v_a text; v_b text; v_receipt uuid;
begin
  if public.billing_enabled() then
    if exists(select 1 from public.maps where id = p_map and kind = 'group') and not public.group_subscription_active(p_map) then
      raise exception 'group_subscription_expired' using errcode = 'P0001';
    end if;
    if jsonb_typeof(p_edges) <> 'array' then raise exception 'invalid_portals' using errcode = '22023'; end if;
    for v_e in select value from jsonb_array_elements(p_edges) loop
      if v_e->>'source' = 'manual' then continue; end if;
      v_a := least(v_e->>'a', v_e->>'b'); v_b := greatest(v_e->>'a', v_e->>'b');
      v_receipt := nullif(v_e->>'captureReceipt', '')::uuid;
      if not exists(select 1 from public.capture_receipts where id = v_receipt and user_id = auth.uid()
          and a = v_a and b = v_b and expires_at >= (v_e->>'expiresAt')::timestamptz) then
        -- Previously stored personal portals may be backed up/rechecked without a new charge.
        if not exists(select 1 from public.edges where map_id = auth.uid() and a = v_a and b = v_b
            and expires_at >= (v_e->>'expiresAt')::timestamptz and expires_at > now()) then
          raise exception 'capture_authorization_required' using errcode = 'P0001';
        end if;
      end if;
    end loop;
  end if;
  return public.push_edges_unmetered(p_map, p_edges);
end;
$$;
create or replace function public.create_map(p_title text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_map uuid; v_license uuid;
begin
  if not public.billing_enabled() then return public.create_map_unmetered(p_title); end if;
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  if public.account_is_guest() then raise exception 'discord_required' using errcode = '42501'; end if;
  select id into v_license from public.subscriptions where account_id = auth.uid() and product = 'group'
    and map_id is null and revoked_at is null and starts_at <= now() and expires_at > now()
    order by expires_at for update skip locked limit 1;
  if v_license is null then raise exception 'group_subscription_required' using errcode = 'P0001'; end if;
  perform public.take_slot('create:' || auth.uid()::text, interval '1 hour', 60);
  insert into public.maps(kind, title, owner) values ('group', nullif(left(trim(p_title),80),''), auth.uid()) returning id into v_map;
  update public.subscriptions set map_id = v_map where id = v_license;
  insert into public.map_members(map_id, user_id, title) values (v_map, auth.uid(), nullif(left(trim(p_title),80),''));
  return v_map;
end;
$$;
create or replace function public.subscription_member_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.billing_enabled() and not public.group_subscription_active(NEW.map_id) then
    raise exception 'group_subscription_expired' using errcode = 'P0001';
  end if;
  return NEW;
end;
$$;
drop trigger if exists subscription_member_guard on public.map_members;
create trigger subscription_member_guard before insert on public.map_members for each row execute function public.subscription_member_guard();
revoke all on function public.subscription_member_guard() from public, anon, authenticated;

-- Expiry pauses synchronization. It does not revoke membership or erase a map.
create or replace function public.pull_map_snapshot(p_map uuid, p_version text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if public.billing_enabled() and public.my_role(p_map) <> 'none'
    and exists(select 1 from public.maps where id = p_map and kind = 'group') and not public.group_subscription_active(p_map) then
    return jsonb_build_object('paused', true, 'role', public.my_role(p_map));
  end if;
  return public.pull_map_snapshot_unmetered(p_map, p_version);
end;
$$;
-- Same row type as the pre-billing compatibility endpoint.
create or replace function public.pull_edges(p_map uuid, p_since timestamptz default null)
returns table(a text, b text, cap_max smallint, cap_max_known boolean, expires_at timestamptz,
  source text, by_nick text, updated_at timestamptz, confirms numeric, needed smallint, reporters text[])
language plpgsql security definer set search_path = public as $$
begin
  if public.billing_enabled() and exists(select 1 from public.maps where id = p_map and kind = 'group')
    and not public.group_subscription_active(p_map) then return; end if;
  return query select * from public.pull_edges_unmetered(p_map, p_since);
end;
$$;
revoke all on function public.push_edges(uuid,jsonb), public.create_map(text), public.pull_map_snapshot(uuid,text),
  public.pull_edges(uuid,timestamptz) from public, anon;
grant execute on function public.push_edges(uuid,jsonb), public.create_map(text), public.pull_map_snapshot(uuid,text),
  public.pull_edges(uuid,timestamptz) to authenticated;
commit;
