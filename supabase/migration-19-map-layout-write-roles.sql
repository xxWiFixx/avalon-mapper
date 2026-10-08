-- A viewer may read a group layout, but must not place or move its zones.
-- Apply after migration 18. Existing coordinates and revisions are preserved.
begin;
create or replace function public.guard_map_layout_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.positions is distinct from old.positions
    and auth.uid() is not null
    and public.my_role(new.map_id) not in ('member', 'verified', 'admin') then
    raise exception 'layout_write_denied' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists map_layout_write_guard on public.map_layouts;
create trigger map_layout_write_guard before update of positions on public.map_layouts
for each row execute function public.guard_map_layout_write();
revoke all on function public.guard_map_layout_write() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
