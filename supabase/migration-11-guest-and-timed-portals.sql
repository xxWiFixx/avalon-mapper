-- Guest accounts may keep personal cloud maps, but cannot create or join rooms.
-- Portals without a closing time are never stored in any map.
begin;

create or replace function public.account_is_guest()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((auth.jwt()->>'is_anonymous')::boolean, false);
$$;

create or replace function public.guard_guest_group_map()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.kind = 'group' and public.account_is_guest() then
    raise exception 'для карт друзей нужен вход через Discord' using errcode = '42501';
  end if;
  return NEW;
end;
$$;
drop trigger if exists guest_group_map_guard on public.maps;
create trigger guest_group_map_guard before insert on public.maps
for each row execute function public.guard_guest_group_map();

create or replace function public.guard_guest_group_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.account_is_guest() then
    raise exception 'для карт друзей нужен вход через Discord' using errcode = '42501';
  end if;
  return NEW;
end;
$$;
drop trigger if exists guest_group_member_guard on public.map_members;
create trigger guest_group_member_guard before insert on public.map_members
for each row execute function public.guard_guest_group_membership();

create or replace function public.skip_untimed_edge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.expires_at is null then return null; end if;
  return NEW;
end;
$$;
drop trigger if exists timed_edge_guard on public.edges;
create trigger timed_edge_guard before insert or update of expires_at on public.edges
for each row execute function public.skip_untimed_edge();

-- Remove historical untimed rows and their orphaned confirmations as well.
delete from public.edges where expires_at is null;
delete from public.edge_reports r where not exists (
  select 1 from public.edges e where e.map_id = r.map_id and e.a = r.a and e.b = r.b
);

revoke all on function public.account_is_guest() from public, anon, authenticated;
revoke all on function public.guard_guest_group_map() from public, anon, authenticated;
revoke all on function public.guard_guest_group_membership() from public, anon, authenticated;
revoke all on function public.skip_untimed_edge() from public, anon, authenticated;
commit;
