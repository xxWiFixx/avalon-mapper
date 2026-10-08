-- One-time FunPay codes: one new group license or 30-day renewal of an owned group.
-- Apply after migration 21. Never changes rollout flags or existing groups.
begin;

create table if not exists public.billing_code_batches (
  id uuid primary key,
  code_count integer not null check (code_count between 1 and 10000),
  created_at timestamptz not null default now()
);
create table if not exists public.billing_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  batch_id uuid not null references public.billing_code_batches(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users(id),
  requested_map_id uuid references public.maps(id),
  subscription_id uuid unique references public.subscriptions(id),
  check ((redeemed_at is null and redeemed_by is null and subscription_id is null and requested_map_id is null)
      or (redeemed_at is not null and redeemed_by is not null and subscription_id is not null))
);
create index if not exists billing_codes_batch on public.billing_codes(batch_id);
create table if not exists public.billing_code_attempts (
  account_id uuid not null references auth.users(id) on delete cascade,
  slot timestamptz not null,
  attempts integer not null check (attempts between 1 and 20),
  primary key (account_id, slot)
);
alter table public.billing_code_batches enable row level security;
alter table public.billing_codes enable row level security;
alter table public.billing_code_attempts enable row level security;
revoke all on public.billing_code_batches, public.billing_codes, public.billing_code_attempts
  from public, anon, authenticated;


-- Per-map exemptions, assigned only by the owner through the service role.
create table if not exists public.billing_permanent_groups (
  map_id uuid primary key references public.maps(id),
  created_at timestamptz not null default now()
);
alter table public.billing_permanent_groups enable row level security;
revoke all on public.billing_permanent_groups from public, anon, authenticated;
create or replace function public.billing_set_permanent_group(p_map uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_enabled is null or not exists(select 1 from public.maps where id = p_map and kind = 'group') then
    raise exception 'invalid_subscription_map' using errcode = '22023';
  end if;
  if p_enabled then
    insert into public.billing_permanent_groups(map_id) values(p_map) on conflict do nothing;
  else
    delete from public.billing_permanent_groups where map_id = p_map;
  end if;
  return p_enabled;
end;
$$;
create or replace function public.group_subscription_active(p_map uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.billing_permanent_groups where map_id = p_map)
    or exists(select 1 from public.subscriptions where product = 'group' and map_id = p_map
      and revoked_at is null and starts_at <= now() and expires_at > now());
$$;
-- Metadata describes the minimum retention guarantee. This migration never deletes maps.
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
      where m.kind = 'group' and public.my_role(m.id) <> 'none'), '[]'::jsonb));
end;
$$;
revoke all on function public.billing_set_permanent_group(uuid,boolean), public.group_subscription_active(uuid),
  public.billing_status() from public, anon, authenticated;
grant execute on function public.billing_set_permanent_group(uuid,boolean) to service_role;
grant execute on function public.billing_status() to authenticated;

-- Administrators register hashes only. Importing the same batch is idempotent;
-- changing its contents or reusing a hash from a different batch is rejected.
create or replace function public.billing_register_codes(p_batch uuid, p_hashes jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_count integer; v_previous integer;
begin
  if p_batch is null or jsonb_typeof(p_hashes) is distinct from 'array' then
    raise exception 'invalid_code_batch' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_hashes);
  if v_count not between 1 and 10000
    or exists(select 1 from jsonb_array_elements(p_hashes) e
      where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[0-9a-f]{64}$')
    or (select count(distinct value) from jsonb_array_elements_text(p_hashes)) <> v_count then
    raise exception 'invalid_code_batch' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('code-batch:' || p_batch::text, 0));
  select code_count into v_previous from public.billing_code_batches where id = p_batch;
  if found then
    if v_previous <> v_count or exists(select 1 from jsonb_array_elements_text(p_hashes) h
      where not exists(select 1 from public.billing_codes c where c.batch_id = p_batch and c.code_hash = h.value)) then
      raise exception 'code_batch_conflict' using errcode = '22023';
    end if;
  else
    insert into public.billing_code_batches(id, code_count) values (p_batch, v_count);
    insert into public.billing_codes(code_hash, batch_id)
      select value, p_batch from jsonb_array_elements_text(p_hashes);
  end if;
  return jsonb_build_object('ok', true, 'batchId', p_batch, 'registered', v_count,
    'available', (select count(*) from public.billing_codes
      where batch_id = p_batch and redeemed_at is null and revoked_at is null));
end;
$$;

-- Never raise an error for a bad code: failed attempts must commit the rate counter.
-- The code row and account locks serialize redemption and concurrent renewals.
create or replace function public.billing_redeem_code(p_code text, p_map uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_normalized text;
  v_hash text;
  v_code public.billing_codes%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_now timestamptz;
  v_until timestamptz;
  v_slot timestamptz;
  v_attempts integer;
  v_license uuid;
begin
  if v_uid is null then raise exception 'account_required' using errcode = '28000'; end if;
  if public.account_is_guest() or not exists(select 1 from auth.identities where user_id = v_uid and provider = 'discord') then
    return jsonb_build_object('ok', false, 'code', 'discord_required');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('code-account:' || v_uid::text, 0));
  v_now := clock_timestamp();
  v_slot := date_bin(interval '1 hour', v_now, timestamptz 'epoch');
  insert into public.billing_code_attempts(account_id, slot, attempts) values (v_uid, v_slot, 1)
    on conflict (account_id, slot) do update set attempts = public.billing_code_attempts.attempts + 1
      where public.billing_code_attempts.attempts < 20
    returning attempts into v_attempts;
  if v_attempts is null then return jsonb_build_object('ok', false, 'code', 'code_rate_limited'); end if;
  delete from public.billing_code_attempts where account_id = v_uid and slot < v_slot - interval '2 hours';
  -- Bound the input before normalization/hash work. Accept typed spaces/hyphens and letter case.
  if p_code is null or length(p_code) > 128 then
    return jsonb_build_object('ok', false, 'code', 'invalid_code');
  end if;
  v_normalized := upper(regexp_replace(p_code, '[-[:space:]]', '', 'g'));
  if v_normalized !~ '^AM30[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{30}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_code');
  end if;
  v_hash := encode(sha256(convert_to(v_normalized, 'UTF8')), 'hex');
  select * into v_code from public.billing_codes where code_hash = v_hash for update;
  if not found or v_code.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'invalid_code');
  end if;
  if v_code.redeemed_at is not null then
    if v_code.redeemed_by <> v_uid or v_code.requested_map_id is distinct from p_map then
      return jsonb_build_object('ok', false, 'code', 'invalid_code');
    end if;
    select * into v_subscription from public.subscriptions where id = v_code.subscription_id;
    return jsonb_build_object('ok', true, 'alreadyRedeemed', true, 'licenseId', v_subscription.id,
      'mapId', v_subscription.map_id, 'expiresAt', v_subscription.expires_at, 'status', public.billing_status());
  end if;
  if p_map is not null then
    perform 1 from public.maps where id = p_map and kind = 'group' and owner = v_uid for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'map_owner_required'); end if;
    if exists(select 1 from public.billing_permanent_groups where map_id = p_map) then
      return jsonb_build_object('ok', false, 'code', 'group_permanent');
    end if;
  end if;
  v_now := clock_timestamp();
  if p_map is not null then
    select max(expires_at) into v_until from public.subscriptions
      where map_id = p_map and account_id = v_uid and product = 'group'
        and revoked_at is null and starts_at <= v_now;
  end if;
  v_until := greatest(v_now, v_until) + interval '720 hours';
  insert into public.subscriptions(account_id, product, starts_at, expires_at, payment_ref, map_id)
    values (v_uid, 'group', now(), v_until, 'funpay-code:' || v_hash, p_map)
    returning id into v_license;
  update public.billing_codes set redeemed_at = v_now, redeemed_by = v_uid,
    requested_map_id = p_map, subscription_id = v_license where code_hash = v_hash;
  return jsonb_build_object('ok', true, 'alreadyRedeemed', false, 'licenseId', v_license,
    'mapId', p_map, 'expiresAt', v_until, 'status', public.billing_status());
end;
$$;

-- A purchased slot is always consumed, even during the free beta.
-- With enforcement disabled and no available license, keep existing beta behavior.
create or replace function public.create_map(p_title text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_map uuid; v_license uuid;
begin
  if auth.uid() is null then raise exception 'account_required' using errcode = '28000'; end if;
  if public.account_is_guest() then raise exception 'discord_required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('code-account:' || auth.uid()::text, 0));
  select id into v_license from public.subscriptions where account_id = auth.uid() and product = 'group'
    and map_id is null and revoked_at is null and starts_at <= now() and expires_at > now()
    order by expires_at, id for update skip locked limit 1;
  if v_license is null then
    if not public.billing_enabled() then return public.create_map_unmetered(p_title); end if;
    raise exception 'group_subscription_required' using errcode = 'P0001';
  end if;
  perform public.take_slot('create:' || auth.uid()::text, interval '1 hour', 60);
  insert into public.maps(kind, title, owner) values ('group', nullif(left(trim(p_title),80),''), auth.uid()) returning id into v_map;
  update public.subscriptions set map_id = v_map where id = v_license;
  insert into public.map_members(map_id, user_id, title, role) values (v_map, auth.uid(), nullif(left(trim(p_title),80),''), 'admin');
  return v_map;
end;
$$;

-- Service-only inventory contains identifiers and counters, never open codes.
create or replace function public.billing_code_batch_status(p_batch uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('batchId', b.id, 'registered', b.code_count,
    'available', count(*) filter (where c.redeemed_at is null and c.revoked_at is null),
    'redeemed', count(*) filter (where c.redeemed_at is not null),
    'revoked', count(*) filter (where c.revoked_at is not null))
  from public.billing_code_batches b join public.billing_codes c on c.batch_id = b.id
  where b.id = p_batch group by b.id, b.code_count;
$$;

-- Revoke unsold/lost codes or a sold code plus its exact grant. Does not touch other grants.
create or replace function public.billing_revoke_code(p_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_license uuid;
begin
  update public.billing_codes set revoked_at = coalesce(revoked_at, now()) where code_hash = p_hash
    returning subscription_id into v_license;
  if not found then return false; end if;
  if v_license is not null then
    update public.subscriptions set revoked_at = coalesce(revoked_at, now()) where id = v_license;
  end if;
  return true;
end;
$$;

revoke all on function public.billing_register_codes(uuid,jsonb), public.billing_redeem_code(text,uuid),
  public.billing_code_batch_status(uuid), public.billing_revoke_code(text), public.create_map(text)
  from public, anon, authenticated;
grant execute on function public.billing_redeem_code(text,uuid), public.create_map(text) to authenticated;
grant execute on function public.billing_register_codes(uuid,jsonb), public.billing_code_batch_status(uuid),
  public.billing_revoke_code(text) to service_role;
notify pgrst, 'reload schema';
commit;
