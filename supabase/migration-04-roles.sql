-- Роли в картах, вес подтверждений и запрет порталов без времени в общей карте.
-- Запускать в SQL Editor Supabase ПОСЛЕ migration-03. Скрипт идемпотентен.
--
-- ЧТО МЕНЯЕТСЯ И ПОЧЕМУ
--
-- 1. Роли. Раньше вход по коду давал сразу всё: вошёл — пиши. Для двоих друзей это
--    нормально, для гильдии на сто человек — нет: код расходится, и любой, кому его
--    переслали, правит общее знание. Теперь у каждого участника карты есть роль, а по
--    умолчанию — самая тихая: смотреть. Право писать выдаёт владелец.
--
-- 2. Вес подтверждения. Портал, прочитанный с экрана, и портал, вписанный руками, — это
--    разные по надёжности сведения. Первый видела программа, второй — только человек,
--    и ошибиться в нём проще всего. Считаем прочитанный за единицу, вписанный за половину:
--    порог 3 берётся тремя снимками или шестью ручными записями.
--
-- 3. Порталы без времени закрытия в общую карту не принимаются вовсе. Время — половина
--    смысла портала: без него маршрутизатор не знает, успеет ли игрок, и ребро живёт
--    двенадцать часов «на всякий случай». В своей карте это терпимо, в общей — нет.

-- ---------- роли ----------
-- viewer   Наблюдатель        только смотрит
-- member   Разведчик          смотрит и добавляет; его порталы копят подтверждения
-- verified Проверенный        добавляет без подтверждений
-- admin    Хранитель карты    всё выше, плюс удаление и раздача ролей
alter table public.map_members add column if not exists role text not null default 'viewer';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'map_members_role_ck') then
    alter table public.map_members add constraint map_members_role_ck
      check (role in ('viewer', 'member', 'verified', 'admin'));
  end if;
end $$;

-- Перенос уже существующих. Все, кто вошёл до появления ролей, писали в карту — значит
-- они разведчики, а не наблюдатели: иначе обновление молча отняло бы у них право.
update public.map_members set role = 'member' where role = 'viewer';
update public.map_members mm set role = 'admin'
  from public.maps m where m.id = mm.map_id and m.owner = mm.user_id and mm.role <> 'admin';

-- ---------- вес подтверждений ----------
-- Откуда пришло каждое подтверждение. Без этого столбца вес считать не из чего:
-- в edge_reports лежал только факт «этот аккаунт видел».
alter table public.edge_reports add column if not exists source text not null default 'ocr';

-- confirms становится дробным: половинки не влезают в smallint. Сначала сносим всё,
-- что этот столбец возвращает, — «create or replace» не меняет тип возврата (42P13).
drop function if exists public.pull_edges(uuid, timestamptz);
drop function if exists public.my_maps();
alter table public.edges alter column confirms type numeric(4,1) using confirms::numeric(4,1);

-- ---------- кто я в этой карте ----------
-- Вспомогательная: роль текущего аккаунта. Владелец всегда хранитель, даже если строка
-- членства почему-то отстала; в общей карте роль заменяет глобальный признак доверия.
create or replace function public.my_role(p_map uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select case
    when auth.uid() is null then 'none'
    when (select m.owner from public.maps m where m.id = p_map) = auth.uid() then 'admin'
    when (select m.kind from public.maps m where m.id = p_map) = 'public'
      then case when coalesce((select p.trusted from public.profiles p where p.id = auth.uid()), false)
                then 'admin' else 'member' end
    else coalesce((select mm.role from public.map_members mm
                    where mm.map_id = p_map and mm.user_id = auth.uid()), 'none')
  end;
$$;

-- ---------- список участников ----------
-- Видят его все члены карты: знать, кто рядом, — часть доверия к общему знанию.
-- Менять роли может только хранитель, и это проверяется отдельно, в set_member_role.
create or replace function public.map_members_list(p_map uuid)
returns table (user_id uuid, nick text, role text, is_owner boolean, joined_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select mm.user_id, coalesce(p.nick, 'игрок'), mm.role, (m.owner = mm.user_id), mm.joined_at
    from public.map_members mm
    join public.maps m on m.id = mm.map_id
    left join public.profiles p on p.id = mm.user_id
   where mm.map_id = p_map
     and public.my_role(p_map) <> 'none'
   order by (m.owner = mm.user_id) desc,
            case mm.role when 'admin' then 0 when 'verified' then 1 when 'member' then 2 else 3 end,
            mm.joined_at;
$$;

-- ---------- смена роли ----------
-- Правило старшинства простое и намеренно жёсткое: хранителей назначает только владелец.
-- Иначе первый же назначенный хранитель мог бы назначить второго, тот третьего, и карта
-- уходила бы из рук владельца без единого злого умысла.
create or replace function public.set_member_role(p_map uuid, p_user uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := auth.uid();
  v_owner uuid;
  v_me text;
  v_cur text;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  if p_role not in ('viewer', 'member', 'verified', 'admin') then
    raise exception 'неизвестная роль' using errcode = 'P0001';
  end if;
  select m.owner into v_owner from public.maps m where m.id = p_map;
  if v_owner is null then raise exception 'нет такой карты' using errcode = 'no_data_found'; end if;
  if p_user = v_owner then raise exception 'роль владельца карты не меняется' using errcode = '42501'; end if;

  v_me := public.my_role(p_map);
  if v_me <> 'admin' then raise exception 'роли раздаёт хранитель карты' using errcode = '42501'; end if;

  select mm.role into v_cur from public.map_members mm where mm.map_id = p_map and mm.user_id = p_user;
  if v_cur is null then raise exception 'этого игрока нет в карте' using errcode = 'no_data_found'; end if;
  if (p_role = 'admin' or v_cur = 'admin') and v_id <> v_owner then
    raise exception 'назначать и снимать хранителей может только владелец карты' using errcode = '42501';
  end if;

  update public.map_members set role = p_role where map_id = p_map and user_id = p_user;
end;
$$;

-- ---------- выгнать участника ----------
create or replace function public.kick_member(p_map uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid := auth.uid(); v_owner uuid; v_cur text;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  select m.owner into v_owner from public.maps m where m.id = p_map;
  if v_owner is null then raise exception 'нет такой карты' using errcode = 'no_data_found'; end if;
  if p_user = v_owner then raise exception 'владельца карты выгнать нельзя' using errcode = '42501'; end if;
  if public.my_role(p_map) <> 'admin' then
    raise exception 'выгонять может хранитель карты' using errcode = '42501';
  end if;
  select mm.role into v_cur from public.map_members mm where mm.map_id = p_map and mm.user_id = p_user;
  if v_cur = 'admin' and v_id <> v_owner then
    raise exception 'хранителя выгоняет только владелец карты' using errcode = '42501';
  end if;
  delete from public.map_members where map_id = p_map and user_id = p_user;
end;
$$;

-- ---------- порог подтверждений карты ----------
-- 0 — порога нет, все разведчики пишут напрямую. Больше нуля — порталы разведчиков ждут
-- столько подтверждений; проверенные и хранители не ждут никогда.
create or replace function public.set_map_policy(p_map uuid, p_confirm smallint)
returns smallint
language plpgsql
security definer
set search_path = public
as $$
declare v_n smallint := greatest(0, least(coalesce(p_confirm, 0), 10));
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  if (select m.kind from public.maps m where m.id = p_map) = 'public' then
    raise exception 'порог общей карты не меняется' using errcode = '42501';
  end if;
  if public.my_role(p_map) <> 'admin' then
    raise exception 'порог задаёт хранитель карты' using errcode = '42501';
  end if;
  update public.maps set confirm_required = v_n where id = p_map;
  return v_n;
end;
$$;

-- ---------- вход в карту ----------
-- Новичок входит НАБЛЮДАТЕЛЕМ. Код карты расходится по чатам, и «вошёл — значит пиши»
-- означало бы, что общее знание правит любой, кому переслали ссылку. Право писать
-- выдаёт хранитель, одним движением в окне ролей.
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
  insert into public.map_members (map_id, user_id, title, role)
  values (p_map, v_id, nullif(left(trim(p_title), 80), ''), 'viewer')
  on conflict (map_id, user_id) do update set title = coalesce(excluded.title, public.map_members.title);
  return query
    select m.id, coalesce(mm.title, m.title), m.kind
      from public.maps m join public.map_members mm on mm.map_id = m.id and mm.user_id = v_id
     where m.id = p_map;
end;
$$;

-- Создатель карты — сразу хранитель: иначе он не смог бы выдать роль даже себе.
create or replace function public.create_map(p_title text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid := auth.uid(); v_map uuid;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  perform public.take_slot('create:' || v_id::text, interval '1 hour', 60);
  insert into public.maps (kind, title, owner)
  values ('group', nullif(left(trim(p_title), 80), ''), v_id)
  returning id into v_map;
  insert into public.map_members (map_id, user_id, title, role)
  values (v_map, v_id, nullif(trim(p_title), ''), 'admin');
  return v_map;
end;
$$;

-- ---------- список своих карт ----------
-- Прибавились роль и порог: по ним окно решает, показывать ли пункт «Настройки ролей»
-- и можно ли вообще писать в эту карту.
create or replace function public.my_maps()
returns table (id uuid, title text, kind text, confirm_required smallint, is_owner boolean, role text)
language sql
security definer
set search_path = public
as $$
  select m.id, coalesce(mm.title, m.title), m.kind, m.confirm_required,
         (m.owner = auth.uid()), mm.role
    from public.maps m
    join public.map_members mm on mm.map_id = m.id
   where mm.user_id = auth.uid()
   order by mm.joined_at;
$$;

-- ---------- удаление ребра ----------
-- Право у хранителя карты. В общей карте хранителем считается доверенный аккаунт —
-- это то же правило, только выраженное через роль (см. my_role).
create or replace function public.delete_edge(p_map uuid, p_a text, p_b text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  if public.my_role(p_map) <> 'admin' then
    raise exception 'удалять из этой карты может хранитель' using errcode = '42501';
  end if;
  with gone as (
    delete from public.edges
     where map_id = p_map and a = least(p_a, p_b) and b = greatest(p_a, p_b)
     returning 1
  ) select count(*)::integer into v_n from gone;
  delete from public.edge_reports
   where map_id = p_map and a = least(p_a, p_b) and b = greatest(p_a, p_b);
  return v_n;
end;
$$;

-- ---------- выгрузка ----------
create or replace function public.push_edges(p_map uuid, p_edges jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid := auth.uid();
  v_kind text;
  v_role text;
  v_trusted boolean;
  v_count integer;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  select kind into v_kind from public.maps where id = p_map;
  if v_kind is null then raise exception 'нет такой карты' using errcode = 'no_data_found'; end if;
  if jsonb_typeof(p_edges) <> 'array' then raise exception 'ожидался массив рёбер' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_edges) > 200 then
    raise exception 'слишком много рёбер за раз: % (предел 200)', jsonb_array_length(p_edges) using errcode = 'P0001';
  end if;

  v_role := public.my_role(p_map);
  if v_role = 'none' then raise exception 'ты не в этой карте' using errcode = '42501'; end if;
  if v_role = 'viewer' then
    raise exception 'в этой карте у тебя только просмотр — попроси хранителя выдать право писать' using errcode = '42501';
  end if;
  -- Проверенный и хранитель обходят порог: за них уже поручились.
  v_trusted := v_role in ('verified', 'admin');

  perform public.take_slot('push:' || p_map::text, interval '1 minute', 120);

  with incoming as (
    select
      p_map as map_id,
      least(e->>'a', e->>'b')    as a,
      greatest(e->>'a', e->>'b') as b,
      nullif(e->>'capMax', '')::smallint as cap_max,
      coalesce((e->>'capMaxKnown')::boolean, false) as cap_max_known,
      least(nullif(e->>'expiresAt', '')::timestamptz, now() + interval '48 hours') as expires_at,
      case when coalesce(e->>'source', 'ocr') in ('ocr', 'manual') then coalesce(e->>'source', 'ocr') else 'ocr' end as source,
      case when v_kind = 'public' then null else left(nullif(e->>'by', ''), 24) end as by_nick,
      now() as updated_at
    from jsonb_array_elements(p_edges) as e
    where coalesce(e->>'a', '') <> '' and coalesce(e->>'b', '') <> ''
      and e->>'a' <> e->>'b'
      and length(e->>'a') <= 64 and length(e->>'b') <= 64
      -- В ОБЩУЮ КАРТУ ТОЛЬКО СО ВРЕМЕНЕМ. Портал без времени закрытия висел бы в ней
      -- двенадцать часов как живой, и маршрут вёл бы к закрытому проходу.
      and (v_kind <> 'public' or nullif(e->>'expiresAt', '') is not null)
  ), rep as (
    insert into public.edge_reports as r (map_id, a, b, user_id, source)
    select map_id, a, b, v_id, source from incoming
    on conflict (map_id, a, b, user_id) do update
      set reported_at = now(),
          -- прочитанное с экрана сильнее вписанного руками и назад не понижается:
          -- человек однажды видел этот портал своими глазами через программу
          source = case when r.source = 'ocr' or excluded.source = 'ocr' then 'ocr' else excluded.source end
    returning map_id, a, b
  ), ins as (
    insert into public.edges as t (map_id, a, b, cap_max, cap_max_known, expires_at, source, by_nick, updated_at, confirms, trusted)
    select i.map_id, i.a, i.b, i.cap_max, i.cap_max_known, i.expires_at, i.source, i.by_nick, i.updated_at,
           case when i.source = 'manual' then 0.5 else 1 end, v_trusted
      from incoming i
    on conflict (map_id, a, b) do update set
      cap_max       = coalesce(case when excluded.cap_max_known then excluded.cap_max end, t.cap_max),
      cap_max_known = t.cap_max_known or excluded.cap_max_known,
      expires_at    = coalesce(excluded.expires_at, t.expires_at),
      source        = excluded.source,
      by_nick       = coalesce(excluded.by_nick, t.by_nick),
      updated_at    = excluded.updated_at,
      trusted       = t.trusted or v_trusted,
      -- Вес, а не счёт: снимок экрана — единица, ручная запись — половина. Порог 3
      -- берётся тремя снимками или шестью ручными записями от разных людей.
      confirms      = (select coalesce(sum(case when r2.source = 'manual' then 0.5 else 1 end), 0)
                         from public.edge_reports r2
                        where r2.map_id = t.map_id and r2.a = t.a and r2.b = t.b)
    returning 1
  )
  select count(*)::integer into v_count from ins;

  delete from public.edges where expires_at is not null and expires_at < now() - interval '10 minutes';
  delete from public.edges where expires_at is null and updated_at < now() - interval '12 hours';
  return v_count;
end;
$$;

-- ---------- выдача ----------
-- confirms стал дробным — тип возврата изменился, функция пересоздана выше по файлу.
create or replace function public.pull_edges(p_map uuid, p_since timestamptz default null)
returns table (
  a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz,
  confirms numeric, needed smallint
)
language sql
security definer
set search_path = public
as $$
  select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source, e.by_nick, e.updated_at,
         e.confirms, m.confirm_required
    from public.edges e
    join public.maps m on m.id = e.map_id
   where e.map_id = p_map
     and public.my_role(p_map) <> 'none'
     and e.updated_at > coalesce(p_since, '-infinity'::timestamptz)
     and (e.expires_at is null or e.expires_at > now())
     and (
       m.confirm_required = 0
       or e.trusted
       or e.confirms >= m.confirm_required
       or exists (select 1 from public.edge_reports r
                   where r.map_id = e.map_id and r.a = e.a and r.b = e.b and r.user_id = auth.uid())
     )
   order by e.updated_at
   limit 2000;
$$;

-- ---------- права ----------
-- Роли anon не выдаётся ничего: всё общее требует входа через Discord. Отзываем и у
-- public (Postgres выдаёт EXECUTE новым функциям сам), и у anon (оставалось от старых
-- скриптов, где входа ещё не было).
revoke all on function public.my_role(uuid)                         from public, anon;
revoke all on function public.map_members_list(uuid)                from public, anon;
revoke all on function public.set_member_role(uuid, uuid, text)     from public, anon;
revoke all on function public.kick_member(uuid, uuid)               from public, anon;
revoke all on function public.set_map_policy(uuid, smallint)        from public, anon;
revoke all on function public.push_edges(uuid, jsonb)               from public, anon;
revoke all on function public.pull_edges(uuid, timestamptz)         from public, anon;
revoke all on function public.create_map(text)                      from public, anon;
revoke all on function public.join_map(uuid, text)                  from public, anon;
revoke all on function public.my_maps()                             from public, anon;
revoke all on function public.delete_edge(uuid, text, text)         from public, anon;

grant execute on function public.my_role(uuid)                      to authenticated;
grant execute on function public.map_members_list(uuid)             to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text)  to authenticated;
grant execute on function public.kick_member(uuid, uuid)            to authenticated;
grant execute on function public.set_map_policy(uuid, smallint)     to authenticated;
grant execute on function public.push_edges(uuid, jsonb)            to authenticated;
grant execute on function public.pull_edges(uuid, timestamptz)      to authenticated;
grant execute on function public.create_map(text)                   to authenticated;
grant execute on function public.join_map(uuid, text)               to authenticated;
grant execute on function public.my_maps()                          to authenticated;
grant execute on function public.delete_edge(uuid, text, text)      to authenticated;
