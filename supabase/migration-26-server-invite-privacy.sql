-- Recoverable reusable invitations are private: never grant direct table access.
begin;
alter table public.map_invites add column if not exists display_code text;
revoke all on public.map_invites from public,anon,authenticated;
create or replace function public.create_map_invite(p_map uuid,p_mode text default 'once',p_hours integer default 24)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code text; v_id uuid; v_expires timestamptz;
begin
 perform public.server_access_lock(p_map);
 if auth.uid() is null or public.my_role(p_map) not in ('admin','moderator')
   or not exists(select 1 from public.maps where id=p_map and kind='group') then
   raise exception 'invite_access_denied' using errcode='42501'; end if;
 if public.billing_enabled() and not public.group_subscription_active(p_map) then raise exception 'group_subscription_expired' using errcode='42501'; end if;
 if p_mode is null or p_mode not in ('once','timed','forever') or (p_mode='timed' and (p_hours is null or p_hours not between 1 and 720)) then raise exception 'invalid_invite_options'; end if;
 perform public.take_slot('invite:'||auth.uid()::text,interval '1 hour',60);
 v_code:='AVI-'||upper(replace(gen_random_uuid()::text,'-',''));
 v_expires:=case when p_mode='timed' then clock_timestamp()+make_interval(hours=>p_hours) end;
 insert into public.map_invites(map_id,code_hash,created_by,expires_at,max_uses,display_code)
 values(p_map,encode(sha256(convert_to(v_code,'UTF8')),'hex'),auth.uid(),v_expires,case when p_mode='once' then 1 end,case when p_mode<>'once' then v_code end) returning id into v_id;
 return jsonb_build_object('id',v_id,'code',v_code,'mode',p_mode,'expiresAt',v_expires);
end; $$;

create or replace function public.active_map_invites(p_map uuid)
returns table(id uuid,code text,created_at timestamptz,expires_at timestamptz,uses integer)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or public.my_role(p_map) not in ('admin','moderator') then
   raise exception 'invite_access_denied' using errcode='42501'; end if;
 return query select i.id,i.display_code,i.created_at,i.expires_at,i.uses
 from public.map_invites i
 join public.map_members issuer on issuer.map_id=i.map_id and issuer.user_id=i.created_by
 where i.map_id=p_map and i.max_uses is null and i.revoked_at is null
   and (i.expires_at is null or i.expires_at>now()) and issuer.role in ('admin','moderator')
 order by i.created_at desc;
end; $$;
revoke all on function public.active_map_invites(uuid) from public,anon,authenticated;
grant execute on function public.active_map_invites(uuid) to authenticated;
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
      where m.kind = 'group' and m.owner=auth.uid() and exists(select 1 from public.map_members mm where mm.map_id=m.id and mm.user_id=auth.uid())), '[]'::jsonb));
end;
$$;

notify pgrst, 'reload schema';
commit;
