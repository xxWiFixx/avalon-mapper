-- Five free days of personal recording. No payment or group server is granted.
-- Apply after migration-14. Existing enforcement/payment settings are preserved.
begin;

alter table public.billing_configuration add column if not exists trial_enabled boolean not null default true;
create table if not exists public.personal_trials (
  discord_id text primary key check (discord_id ~ '^[0-9]{15,22}$'),
  activated_by uuid references auth.users(id) on delete set null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '120 hours',
  check (expires_at = starts_at + interval '120 hours')
);
alter table public.personal_trials enable row level security;
revoke all on public.personal_trials from public, anon, authenticated;

-- Provider identities are verified by Supabase OAuth. Never trust editable
-- user metadata, the nickname or a Discord ID submitted by the desktop.
create or replace function public.billing_discord_id()
returns text language sql stable security definer set search_path = public as $$
  select i.provider_id from auth.identities i
  where i.user_id = auth.uid() and i.provider = 'discord'
    and i.provider_id ~ '^[0-9]{15,22}$'
  order by i.provider_id limit 1;
$$;

do $$ begin
  if to_regprocedure('public.billing_status_paid()') is null then
    alter function public.billing_status() rename to billing_status_paid;
  end if;
end $$;
revoke all on function public.billing_status_paid() from public, anon, authenticated;

create or replace function public.billing_status()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_status jsonb := public.billing_status_paid();
  v_discord text := public.billing_discord_id();
  v_trial public.personal_trials%rowtype;
  v_enabled boolean;
  v_until timestamptz;
  v_active boolean := false;
begin
  select trial_enabled into v_enabled from public.billing_configuration where singleton;
  select * into v_trial from public.personal_trials where discord_id = v_discord;
  v_active := v_trial.discord_id is not null and v_trial.starts_at <= now() and v_trial.expires_at > now();
  v_until := greatest((v_status->>'unlimitedUntil')::timestamptz,
    case when v_active then v_trial.expires_at end);
  return v_status || jsonb_build_object('unlimited', v_until is not null,
    'unlimitedUntil', v_until,
    'trial', jsonb_build_object('enabled', v_enabled, 'days', 5,
      'discordRequired', v_discord is null,
      'eligible', v_enabled and v_discord is not null and v_trial.discord_id is null
        and not (v_status->>'unlimited')::boolean,
      'used', v_trial.discord_id is not null, 'active', v_active,
      'startsAt', v_trial.starts_at, 'expiresAt', v_trial.expires_at));
end;
$$;

create or replace function public.billing_start_trial()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_discord text;
  v_status jsonb;
  v_existing public.personal_trials%rowtype;
begin
  if v_uid is null then raise exception 'account_required' using errcode = '28000'; end if;
  v_discord := public.billing_discord_id();
  if public.account_is_guest() or v_discord is null then
    return jsonb_build_object('ok', false, 'code', 'discord_required', 'status', public.billing_status());
  end if;
  -- Two computers and OAuth account recreation cannot restart the clock.
  perform pg_advisory_xact_lock(hashtextextended('personal-trial:' || v_discord, 0));
  v_status := public.billing_status();
  select * into v_existing from public.personal_trials where discord_id = v_discord;
  if found then
    return jsonb_build_object('ok', v_existing.starts_at <= now() and v_existing.expires_at > now(),
      'code', case when v_existing.expires_at <= now() then 'trial_used' end, 'status', v_status);
  end if;
  if not (v_status->'trial'->>'enabled')::boolean then
    return jsonb_build_object('ok', false, 'code', 'trial_unavailable', 'status', v_status);
  end if;
  if (v_status->>'unlimited')::boolean then
    return jsonb_build_object('ok', false, 'code', 'already_unlimited', 'status', v_status);
  end if;
  insert into public.personal_trials(discord_id, activated_by) values (v_discord, v_uid);
  return jsonb_build_object('ok', true, 'status', public.billing_status());
end;
$$;
revoke all on function public.billing_discord_id(), public.billing_status(), public.billing_start_trial()
  from public, anon, authenticated;
grant execute on function public.billing_status(), public.billing_start_trial() to authenticated;
notify pgrst, 'reload schema';
commit;
