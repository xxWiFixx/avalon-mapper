-- Personal cloud maps belong to their account only.
begin;
create or replace function public.my_role(p_map uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then 'none'
    when (select m.kind from public.maps m where m.id = p_map) = 'personal'
      then case when (select m.owner from public.maps m where m.id = p_map) = auth.uid()
                then 'admin' else 'none' end
    when (select m.kind from public.maps m where m.id = p_map) = 'group'
      then case when (select m.owner from public.maps m where m.id = p_map) = auth.uid() then 'admin'
        else coalesce((select mm.role from public.map_members mm
          where mm.map_id = p_map and mm.user_id = auth.uid()), 'none') end
    else 'none'
  end;
$$;
drop function if exists public.admin_personal_maps();
commit;
