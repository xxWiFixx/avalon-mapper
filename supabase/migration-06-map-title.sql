-- Имя карты — одно на всех, и задаёт его владелец.
-- Запускать в SQL Editor Supabase ПОСЛЕ migration-05. Скрипт идемпотентен.
--
-- КАК БЫЛО И ПОЧЕМУ ЭТО ПЛОХО. У членства (map_members.title) есть своё название карты,
-- и my_maps отдавала `coalesce(mm.title, m.title)` — то есть личное имя перебивало общее.
-- Задумка была «назови у себя как удобно», а на деле вышло, что у каждого участника
-- карта называется по-своему: владелец говорит «выложи в GENIUS», а у собеседника этот
-- же канал подписан «Комната». Разговаривать о картах становится нельзя.
--
-- Теперь имя одно — то, что дал владелец при создании. Личное поле остаётся в таблице
-- (сносить столбец ради этого незачем), но на выдачу больше не влияет.

-- Тип возврата не меняется, но функция переписывается целиком — так виден весь текст.
create or replace function public.my_maps()
returns table (id uuid, title text, kind text, confirm_required smallint, is_owner boolean, role text)
language sql
security definer
set search_path = public
as $$
  select m.id, m.title, m.kind, m.confirm_required,
         (m.owner = auth.uid()), mm.role
    from public.maps m
    join public.map_members mm on mm.map_id = m.id
   where mm.user_id = auth.uid()
   order by mm.joined_at;
$$;

-- При входе по коду личное имя больше не записываем: карта называется так, как назвал
-- её владелец. Аргумент p_title оставлен, чтобы не ломать старые сборки, — он просто
-- игнорируется.
create or replace function public.join_map(p_map uuid, p_title text default null)
returns table (id uuid, title text, kind text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_id uuid := auth.uid(); v_kind text;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  select m.kind into v_kind from public.maps m where m.id = p_map;
  if v_kind is null then raise exception 'нет такой карты' using errcode = 'no_data_found'; end if;
  if v_kind <> 'group' then raise exception 'в общую карту входить не нужно' using errcode = 'P0001'; end if;
  insert into public.map_members (map_id, user_id, role)
  values (p_map, v_id, 'viewer')
  on conflict (map_id, user_id) do nothing;
  return query
    select m.id, m.title, m.kind
      from public.maps m join public.map_members mm on mm.map_id = m.id and mm.user_id = v_id
     where m.id = p_map;
end;
$$;

-- Переименовать карту может хранитель. Без этого имя, данное сгоряча при создании,
-- осталось бы навсегда у всех участников сразу.
create or replace function public.rename_map(p_map uuid, p_title text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_title text := nullif(left(trim(coalesce(p_title, '')), 80), '');
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  if v_title is null then raise exception 'пустое имя' using errcode = 'P0001'; end if;
  if (select m.kind from public.maps m where m.id = p_map) = 'public' then
    raise exception 'общую карту переименовывать нельзя' using errcode = '42501';
  end if;
  if public.my_role(p_map) <> 'admin' then
    raise exception 'имя карты меняет хранитель' using errcode = '42501';
  end if;
  update public.maps set title = v_title where id = p_map;
  return v_title;
end;
$$;

-- Уже вошедшим личное имя обнуляем: иначе старые записи продолжали бы жить своей жизнью
-- у тех, кто входил до этой миграции.
update public.map_members set title = null where title is not null;

revoke all on function public.my_maps()              from public, anon;
revoke all on function public.join_map(uuid, text)   from public, anon;
revoke all on function public.rename_map(uuid, text) from public, anon;

grant execute on function public.my_maps()              to authenticated;
grant execute on function public.join_map(uuid, text)   to authenticated;
grant execute on function public.rename_map(uuid, text) to authenticated;
