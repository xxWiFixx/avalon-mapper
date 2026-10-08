-- Server invitations, bans and moderator hierarchy. Existing memberships are preserved.
begin;
alter table public.map_members drop constraint if exists map_members_role_ck;
alter table public.map_members add constraint map_members_role_ck check(role in ('viewer','member','verified','moderator','admin'));
create table if not exists public.map_invites (
  id uuid primary key default gen_random_uuid(), map_id uuid not null references public.maps(id) on delete cascade,
  code_hash text not null unique, created_by uuid not null references auth.users(id),
  created_at timestamptz not null default clock_timestamp(), expires_at timestamptz,
  max_uses integer check(max_uses is null or max_uses=1), uses integer not null default 0,
  revoked_at timestamptz
);
create index if not exists map_invites_map on public.map_invites(map_id);
create table if not exists public.map_exclusions (
  map_id uuid not null references public.maps(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  invalid_before timestamptz not null default clock_timestamp(), banned boolean not null default false,
  acted_by uuid references auth.users(id), primary key(map_id,user_id)
);
alter table public.map_invites enable row level security;
alter table public.map_exclusions enable row level security;
revoke all on public.map_invites,public.map_exclusions from public,anon,authenticated;

create or replace function public.server_role_rank(p_role text) returns integer
language sql immutable set search_path='' as $$
 select case p_role when 'viewer' then 0 when 'member' then 1 when 'verified' then 2 when 'moderator' then 3 when 'admin' then 4 else -1 end;
$$;
create or replace function public.server_access_lock(p_map uuid) returns void
language sql set search_path='' as $$ select pg_advisory_xact_lock(hashtextextended('server-access:'||p_map::text,0)); $$;
revoke all on function public.server_access_lock(uuid) from public,anon,authenticated;

create or replace function public.set_member_role(p_map uuid,p_user uuid,p_role text) returns void
language plpgsql security definer set search_path='' as $$
declare v_owner uuid; v_me text; v_target text;
begin
 perform public.server_access_lock(p_map);
 if auth.uid() is null then raise exception 'account_required' using errcode='28000'; end if;
 select owner into v_owner from public.maps where id=p_map and kind='group';
 v_me:=public.my_role(p_map);
 select role into v_target from public.map_members where map_id=p_map and user_id=p_user;
 if p_user=auth.uid() or p_user=v_owner or v_target is null or p_role is null or public.server_role_rank(p_role)<0
   or v_me not in ('admin','moderator') then raise exception 'role_change_denied' using errcode='42501'; end if;
 -- Only the owner may appoint/remove other keepers. Moderators cannot create peers.
 if auth.uid()<>v_owner and (public.server_role_rank(v_target)>=public.server_role_rank(v_me)
   or public.server_role_rank(p_role)>=public.server_role_rank(v_me)) then
   raise exception 'role_change_denied' using errcode='42501'; end if;
 update public.map_members set role=p_role where map_id=p_map and user_id=p_user;
end; $$;

create or replace function public.server_remove_member(p_map uuid,p_user uuid,p_ban boolean) returns void
language plpgsql security definer set search_path='' as $$
declare v_owner uuid; v_target text;
begin
 perform public.server_access_lock(p_map);
 select owner into v_owner from public.maps where id=p_map and kind='group';
 select role into v_target from public.map_members where map_id=p_map and user_id=p_user;
 if auth.uid() is null or public.my_role(p_map)<>'admin' or p_user=auth.uid() or p_user=v_owner
   or v_target is null or (v_target='admin' and auth.uid()<>v_owner) then
   raise exception 'member_remove_denied' using errcode='42501'; end if;
 insert into public.map_exclusions(map_id,user_id,banned,acted_by) values(p_map,p_user,p_ban,auth.uid())
 on conflict(map_id,user_id) do update set invalid_before=clock_timestamp(), banned=excluded.banned,acted_by=excluded.acted_by;
 delete from public.map_members where map_id=p_map and user_id=p_user;
end; $$;
revoke all on function public.server_remove_member(uuid,uuid,boolean) from public,anon,authenticated;
create or replace function public.kick_member(p_map uuid,p_user uuid) returns void
language sql security definer set search_path='' as $$ select public.server_remove_member(p_map,p_user,false); $$;
create or replace function public.ban_member(p_map uuid,p_user uuid) returns void
language sql security definer set search_path='' as $$ select public.server_remove_member(p_map,p_user,true); $$;
create or replace function public.unban_member(p_map uuid,p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.server_access_lock(p_map);
 if auth.uid() is null or public.my_role(p_map)<>'admin' then raise exception 'ban_access_denied' using errcode='42501'; end if;
 update public.map_exclusions set banned=false,invalid_before=clock_timestamp(),acted_by=auth.uid() where map_id=p_map and user_id=p_user;
end; $$;
create or replace function public.map_bans_list(p_map uuid)
returns table(user_id uuid,nick text,banned_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or public.my_role(p_map)<>'admin' then raise exception 'ban_access_denied' using errcode='42501'; end if;
 return query select x.user_id,coalesce(p.nick,'игрок'),x.invalid_before from public.map_exclusions x
 left join public.profiles p on p.id=x.user_id where x.map_id=p_map and x.banned order by x.invalid_before desc;
end; $$;

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
 insert into public.map_invites(map_id,code_hash,created_by,expires_at,max_uses)
 values(p_map,encode(sha256(convert_to(v_code,'UTF8')),'hex'),auth.uid(),v_expires,case when p_mode='once' then 1 end) returning id into v_id;
 return jsonb_build_object('id',v_id,'code',v_code,'mode',p_mode,'expiresAt',v_expires);
end; $$;
create or replace function public.map_invites_list(p_map uuid)
returns table(id uuid,created_at timestamptz,expires_at timestamptz,max_uses integer,uses integer,revoked_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or public.my_role(p_map) not in ('admin','moderator') then raise exception 'invite_access_denied' using errcode='42501'; end if;
 return query select i.id,i.created_at,i.expires_at,i.max_uses,i.uses,i.revoked_at from public.map_invites i where i.map_id=p_map order by i.created_at desc limit 50;
end; $$;
create or replace function public.revoke_map_invite(p_map uuid,p_invite uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.server_access_lock(p_map);
 if auth.uid() is null or public.my_role(p_map) not in ('admin','moderator') then raise exception 'invite_access_denied' using errcode='42501'; end if;
 update public.map_invites set revoked_at=clock_timestamp() where map_id=p_map and id=p_invite;
end; $$;

create or replace function public.join_server_with_invite(p_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_inv public.map_invites%rowtype; v_map public.maps%rowtype; v_block public.map_exclusions%rowtype; v_code text:=upper(trim(coalesce(p_code,''))); v_creator_role text;
begin
 if auth.uid() is null then raise exception 'account_required' using errcode='28000'; end if;
 if not exists(select 1 from auth.identities where user_id=auth.uid() and provider='discord') then raise exception 'Discord_required' using errcode='42501'; end if;
 perform public.take_slot('join-invite:'||auth.uid()::text,interval '1 hour',60);
 if v_code !~ '^AVI-[0-9A-F]{32}$' then return jsonb_build_object('ok',false,'code','invalid_invite'); end if;
 select * into v_inv from public.map_invites where code_hash=encode(sha256(convert_to(v_code,'UTF8')),'hex');
 if not found then return jsonb_build_object('ok',false,'code','invalid_invite'); end if;
 perform public.server_access_lock(v_inv.map_id);
 select * into v_inv from public.map_invites where id=v_inv.id for update;
 select * into v_map from public.maps where id=v_inv.map_id;
 select * into v_block from public.map_exclusions where map_id=v_inv.map_id and user_id=auth.uid();
 -- Do not disclose whether a code belongs to a server that banned this account.
 if v_block.banned or v_inv.created_at<=v_block.invalid_before then return jsonb_build_object('ok',false,'code','invalid_invite'); end if;
 if public.billing_enabled() and not public.group_subscription_active(v_inv.map_id) then return jsonb_build_object('ok',false,'code','server_paused'); end if;
 -- A successful retry must not consume a one-time invitation a second time.
 if exists(select 1 from public.map_members where map_id=v_inv.map_id and user_id=auth.uid()) then
   return jsonb_build_object('ok',true,'id',v_map.id,'title',v_map.title,'kind','group'); end if;
 select case when v_map.owner=v_inv.created_by then 'admin' else mm.role end into v_creator_role
 from public.map_members mm where mm.map_id=v_inv.map_id and mm.user_id=v_inv.created_by;
 if v_inv.revoked_at is not null or v_inv.expires_at<=clock_timestamp() or v_inv.uses>=v_inv.max_uses
   or coalesce(v_creator_role,'none') not in ('admin','moderator') then return jsonb_build_object('ok',false,'code','invalid_invite'); end if;
 insert into public.map_members(map_id,user_id,role) values(v_inv.map_id,auth.uid(),'viewer');
 update public.map_invites set uses=uses+1 where id=v_inv.id;
 return jsonb_build_object('ok',true,'id',v_map.id,'title',v_map.title,'kind','group');
end; $$;
-- UUIDs identify servers; they are no longer bearer invitations, including for old clients.
create or replace function public.join_map(p_map uuid,p_title text default null)
returns table(id uuid,title text,kind text) language plpgsql security definer set search_path='' as $$
begin raise exception 'invite_code_required' using errcode='42501'; end; $$;

-- Keep the owner in the server, even when calling an old client or the API directly.
create or replace function public.guard_server_owner() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null and exists(select 1 from public.maps where id=old.map_id and kind='group' and owner=old.user_id)
   and (tg_op='DELETE' or new.role<>'admin' or new.user_id<>old.user_id) then
   raise exception 'owner_protected' using errcode='42501'; end if;
 if tg_op='DELETE' then return old; end if; return new;
end; $$;
drop trigger if exists server_owner_guard on public.map_members;
create trigger server_owner_guard before update or delete on public.map_members for each row execute function public.guard_server_owner();
revoke all on function public.guard_server_owner() from public,anon,authenticated;

-- Moderators inherit verified portal/layout rights, never keeper deletion/audit rights.
do $$ declare f record; definition text; patched text;
begin
 for f in select oid from pg_proc where pronamespace='public'::regnamespace and prokind='f'
   and proname in ('push_edges','push_edges_unmetered','map_layout','map_layout_merge','guard_map_layout_write') loop
   definition:=pg_get_functiondef(f.oid);
   patched:=replace(replace(replace(definition,'''verified'', ''admin''','''verified'', ''moderator'', ''admin'''),'''verified'',''admin''','''verified'',''moderator'',''admin'''),'''admin'',''verified''','''admin'',''moderator'',''verified''');
   if patched<>definition then execute patched; end if;
 end loop;
end; $$;
revoke all on function public.create_map_invite(uuid,text,integer),public.map_invites_list(uuid),public.revoke_map_invite(uuid,uuid),public.join_server_with_invite(text),public.ban_member(uuid,uuid),public.unban_member(uuid,uuid),public.map_bans_list(uuid) from public,anon,authenticated;
grant execute on function public.create_map_invite(uuid,text,integer),public.map_invites_list(uuid),public.revoke_map_invite(uuid,uuid),public.join_server_with_invite(text),public.ban_member(uuid,uuid),public.unban_member(uuid,uuid),public.map_bans_list(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
