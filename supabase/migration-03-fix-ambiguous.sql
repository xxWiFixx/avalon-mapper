-- Починка: «column reference "id" is ambiguous». Выполнить в SQL Editor поверх migration-02.
-- Скрипт идемпотентный.
--
-- ЧТО СЛУЧИЛОСЬ. У функции с «returns table (id uuid, nick text, trusted boolean)»
-- эти три имени становятся ВЫХОДНЫМИ ПЕРЕМЕННЫМИ функции. Дальше в теле любое
-- неквалифицированное «id» — уже не столбец таблицы, а переменная, и Postgres отказывается
-- гадать: on conflict (id) падает с 42702. Поймано на живом входе: аккаунт завёлся,
-- а профиль — нет.
--
-- Лечится директивой #variable_conflict use_column: при совпадении имён выигрывает
-- СТОЛБЕЦ. Это ровно то поведение, которого мы и ждали, когда писали функцию.
-- Ставим её и во вторую функцию с такими же выходными именами — join_map, — там та же
-- мина ждала первого же входа в комнату.

-- ---------- профиль ----------
drop function if exists public.ensure_profile(text);
create function public.ensure_profile(p_nick text default null)
returns table (id uuid, nick text, trusted boolean)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare v_id uuid := auth.uid();
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  insert into public.profiles as pr (id, nick)
  values (v_id, coalesce(nullif(left(trim(p_nick), 24), ''), 'игрок-' || left(v_id::text, 4)))
  on conflict (id) do update
     set nick = coalesce(nullif(left(trim(p_nick), 24), ''), pr.nick);
  return query select p.id, p.nick, p.trusted from public.profiles p where p.id = v_id;
end;
$$;

-- ---------- вход в комнату ----------
drop function if exists public.join_map(uuid, text);
create function public.join_map(p_map uuid, p_title text default null)
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
  insert into public.map_members as mm (map_id, user_id, title)
  values (p_map, v_id, nullif(left(trim(p_title), 80), ''))
  on conflict (map_id, user_id) do update set title = coalesce(excluded.title, mm.title);
  return query
    select m.id, coalesce(mm2.title, m.title), m.kind
      from public.maps m
      join public.map_members mm2 on mm2.map_id = m.id and mm2.user_id = v_id
     where m.id = p_map;
end;
$$;

-- Права выдаём заново: drop снёс их вместе с функциями.
-- Отзыв нужен и у public (Postgres выдаёт EXECUTE новой функции сам), и у anon
-- (остатки прежних скриптов, когда входа ещё не существовало).
revoke all on function public.ensure_profile(text)  from public, anon;
revoke all on function public.join_map(uuid, text)  from public, anon;
grant execute on function public.ensure_profile(text) to authenticated;
grant execute on function public.join_map(uuid, text) to authenticated;
