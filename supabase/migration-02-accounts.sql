-- Аккаунты, комнаты и подтверждения. Вставить целиком в SQL Editor проекта.
-- Скрипт идемпотентный: можно прогонять повторно.
--
-- ЧТО МЕНЯЕТСЯ ПО СУТИ. До сих пор доступа не существовало вовсе: кто знал код карты —
-- тот в ней хозяин. Теперь всё общее требует входа через Discord, и от аккаунта зависят
-- три вещи:
--   • в какие комнаты игрок входит;
--   • попадает ли его портал в общую карту сразу или ждёт подтверждений;
--   • может ли он удалять чужое.
--
-- БЕЗ ВХОДА ПРИЛОЖЕНИЕ РАБОТАЕТ ЦЕЛИКОМ — с личной картой, а она лежит файлом на диске
-- и этой базы не касается. Ради карты порталов никого не заставляют регистрироваться.
--
-- Почему Discord, а не анонимные аккаунты: порог «три подтверждения» имеет смысл, только
-- если это три разных ЧЕЛОВЕКА. Анонимный аккаунт накручивается переустановкой,
-- аккаунт Discord — нет.
--
-- ПОРОГ ПОДТВЕРЖДЕНИЙ — свойство КАРТЫ, а не жёсткое правило. У общей стоит 3, у комнат 0.
-- Гильдии на три сотни человек включат его себе одной строкой, а компании из четверых
-- он не помешает: там подтверждений просто не набрать.

create extension if not exists pgcrypto;

-- ---------- профили ----------
-- Одна строка на аккаунт. nick нужен ровно для одного: отличать свои порталы от чужих,
-- иначе эхо съедало бы чужие рёбра. В общую карту ник по-прежнему не пишется.
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nick       text not null check (length(nick) between 1 and 24),
  trusted    boolean not null default false,   -- выдаётся вручную владельцем проекта
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;   -- политик нет: наружу только функции

-- ---------- карты ----------
alter table public.maps add column if not exists owner uuid references auth.users(id) on delete set null;
alter table public.maps add column if not exists confirm_required smallint not null default 0;
alter table public.maps add column if not exists created_by_nick text;

-- Общей карте — порог 3. Она одна на всех, и чужая ошибка в ней дороже всего.
update public.maps set confirm_required = 3
 where id = '00000000-0000-0000-0000-0000000000a0' and confirm_required <> 3;

-- ---------- членство в комнатах ----------
-- Комнат у человека может быть несколько: гильдия, друзья, разовая вылазка.
-- Вход по-прежнему по коду карты — членство лишь запоминает, что игрок туда заходил,
-- чтобы приложение показало ему список слева и он не хранил коды в блокноте.
create table if not exists public.map_members (
  map_id    uuid not null references public.maps(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  title     text,                              -- своё название комнаты, видно только владельцу строки
  joined_at timestamptz not null default now(),
  primary key (map_id, user_id)
);
create index if not exists map_members_user on public.map_members (user_id);
alter table public.map_members enable row level security;

-- ---------- кто сообщил про ребро ----------
-- Строка на «этот аккаунт видел этот портал». По числу РАЗНЫХ аккаунтов и считается
-- подтверждение. Ключ включает user_id, поэтому один игрок, нажавший хоткей десять раз,
-- остаётся одним подтверждением.
create table if not exists public.edge_reports (
  map_id      uuid not null references public.maps(id) on delete cascade,
  a           text not null,
  b           text not null,
  user_id     uuid not null references auth.users(id) on delete cascade,
  reported_at timestamptz not null default now(),
  primary key (map_id, a, b, user_id)
);
create index if not exists edge_reports_edge on public.edge_reports (map_id, a, b);
alter table public.edge_reports enable row level security;

-- Счётчики прямо на ребре: считать подтверждения запросом на каждый pull дорого,
-- а тут их всего два числа, и оба меняются в том же push_edges.
alter table public.edges add column if not exists confirms  smallint not null default 1;
alter table public.edges add column if not exists trusted   boolean  not null default false;

-- ---------- API ----------

-- Сначала сносим то, у чего МЕНЯЕТСЯ ТИП ВОЗВРАТА: «create or replace» такого не умеет
-- и падает с 42P13. У pull_edges прибавились две колонки — confirms и needed, — поэтому
-- заменить её на месте нельзя, только пересоздать.
-- «if exists» и точные типы аргументов: скрипт должен переживать повторный запуск
-- и на чистой базе, где этих функций ещё нет.
drop function if exists public.pull_edges(uuid, timestamptz);
drop function if exists public.ensure_profile(text);
drop function if exists public.join_map(uuid, text);
drop function if exists public.my_maps();

-- Профиль текущего аккаунта: создаётся при первом обращении.
-- Ник приходит из Discord (global_name), приложение лишь пересылает его; сервер
-- подрезает длину. Запасной вариант — кусок uuid: у аккаунта без имени ник всё равно
-- должен быть, по нему приложение отличает свои порталы от чужих.
create or replace function public.ensure_profile(p_nick text default null)
returns table (id uuid, nick text, trusted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid := auth.uid();
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  insert into public.profiles (id, nick)
  values (v_id, coalesce(nullif(left(trim(p_nick), 24), ''), 'игрок-' || left(v_id::text, 4)))
  on conflict (id) do update
     set nick = coalesce(nullif(left(trim(p_nick), 24), ''), public.profiles.nick);
  return query select p.id, p.nick, p.trusted from public.profiles p where p.id = v_id;
end;
$$;

-- Создать комнату. Возвращает её код — его игрок и пересылает друзьям.
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
  insert into public.map_members (map_id, user_id, title) values (v_map, v_id, nullif(trim(p_title), ''));
  return v_map;
end;
$$;

-- Войти в комнату по коду. Комнат может быть сколько угодно, общую карту не трогаем:
-- в неё входить не надо, она доступна всем и так.
create or replace function public.join_map(p_map uuid, p_title text default null)
returns table (id uuid, title text, kind text)
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid := auth.uid(); v_kind text;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  select m.kind into v_kind from public.maps m where m.id = p_map;
  if v_kind is null then raise exception 'нет такой карты' using errcode = 'no_data_found'; end if;
  if v_kind <> 'group' then raise exception 'в общую карту входить не нужно' using errcode = 'P0001'; end if;
  insert into public.map_members (map_id, user_id, title)
  values (p_map, v_id, nullif(left(trim(p_title), 80), ''))
  on conflict (map_id, user_id) do update set title = coalesce(excluded.title, public.map_members.title);
  return query
    select m.id, coalesce(mm.title, m.title), m.kind
      from public.maps m join public.map_members mm on mm.map_id = m.id and mm.user_id = v_id
     where m.id = p_map;
end;
$$;

create or replace function public.leave_map(p_map uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  delete from public.map_members where map_id = p_map and user_id = auth.uid();
end;
$$;

-- Список своих комнат — приложение рисует по нему панель каналов слева.
create or replace function public.my_maps()
returns table (id uuid, title text, kind text, confirm_required smallint, is_owner boolean)
language sql
security definer
set search_path = public
as $$
  select m.id, coalesce(mm.title, m.title), m.kind, m.confirm_required, (m.owner = auth.uid())
    from public.maps m
    join public.map_members mm on mm.map_id = m.id
   where mm.user_id = auth.uid()
   order by mm.joined_at;
$$;

-- Удалить ребро. Право есть у владельца карты и у доверенных аккаунтов — и больше ни у кого.
-- Именно этого не хватало общей карте: добавлять могли все, убирать — тоже все.
create or replace function public.delete_edge(p_map uuid, p_a text, p_b text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := auth.uid();
  v_ok boolean;
  v_n integer;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  select (m.owner = v_id) or coalesce(p.trusted, false) into v_ok
    from public.maps m left join public.profiles p on p.id = v_id
   where m.id = p_map;
  if not coalesce(v_ok, false) then
    raise exception 'удалять из этой карты может только владелец или доверенный' using errcode = '42501';
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
-- Отличий от прежней версии два: пишем, КТО сообщил про ребро, и держим счётчик разных
-- сообщивших. Порог применяется не здесь, а на выдаче: пусть ребро копит подтверждения,
-- даже пока его не видно.
create or replace function public.push_edges(p_map uuid, p_edges jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   uuid := auth.uid();
  v_kind text;
  v_trusted boolean := false;
  v_count integer;
begin
  if v_id is null then raise exception 'нужен аккаунт' using errcode = '28000'; end if;
  select kind into v_kind from public.maps where id = p_map;
  if v_kind is null then raise exception 'нет такой карты' using errcode = 'no_data_found'; end if;
  if jsonb_typeof(p_edges) <> 'array' then raise exception 'ожидался массив рёбер' using errcode = 'P0001'; end if;
  if jsonb_array_length(p_edges) > 200 then
    raise exception 'слишком много рёбер за раз: % (предел 200)', jsonb_array_length(p_edges) using errcode = 'P0001';
  end if;
  -- в чужую комнату не пишем: общая открыта всем, в остальные надо было войти
  if v_kind = 'group' and not exists (
    select 1 from public.map_members where map_id = p_map and user_id = v_id
  ) then
    raise exception 'ты не в этой комнате' using errcode = '42501';
  end if;
  perform public.take_slot('push:' || p_map::text, interval '1 minute', 120);
  select coalesce(p.trusted, false) into v_trusted from public.profiles p where p.id = v_id;

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
  ), rep as (
    insert into public.edge_reports (map_id, a, b, user_id)
    select map_id, a, b, v_id from incoming
    on conflict (map_id, a, b, user_id) do update set reported_at = now()
    returning map_id, a, b
  ), ins as (
    insert into public.edges as t (map_id, a, b, cap_max, cap_max_known, expires_at, source, by_nick, updated_at, confirms, trusted)
    select i.map_id, i.a, i.b, i.cap_max, i.cap_max_known, i.expires_at, i.source, i.by_nick, i.updated_at, 1, v_trusted
      from incoming i
    on conflict (map_id, a, b) do update set
      cap_max       = coalesce(case when excluded.cap_max_known then excluded.cap_max end, t.cap_max),
      cap_max_known = t.cap_max_known or excluded.cap_max_known,
      expires_at    = coalesce(excluded.expires_at, t.expires_at),
      source        = excluded.source,
      by_nick       = coalesce(excluded.by_nick, t.by_nick),
      updated_at    = excluded.updated_at,
      trusted       = t.trusted or v_trusted,
      -- пересчитываем по настоящему числу разных сообщивших, а не «+1» на каждый push
      confirms      = (select count(*)::smallint from public.edge_reports r
                        where r.map_id = t.map_id and r.a = t.a and r.b = t.b)
    returning 1
  )
  select count(*)::integer into v_count from ins;

  delete from public.edges where expires_at is not null and expires_at < now() - interval '10 minutes';
  delete from public.edges where expires_at is null and updated_at < now() - interval '12 hours';
  return v_count;
end;
$$;

-- ---------- выдача ----------
-- Порог применяется ЗДЕСЬ. Ребро видно, если карта порога не требует, либо про него
-- сообщило достаточно разных аккаунтов, либо среди сообщивших был доверенный.
-- Своё же ребро игрок видит всегда: иначе он решил бы, что выгрузка не работает.
create or replace function public.pull_edges(p_map uuid, p_since timestamptz default null)
returns table (
  a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz,
  confirms smallint, needed smallint
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
     and (m.kind = 'public' or exists (
           select 1 from public.map_members mm where mm.map_id = e.map_id and mm.user_id = auth.uid()))
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
-- Роли anon не выдаётся НИЧЕГО. Без входа через Discord приложение работает целиком —
-- но только с личной картой, а она живёт файлом на диске и сервера не касается вовсе.
-- Всё общее (комнаты и общая карта) требует входа, и это единственное правило доступа.
-- ОТЗЫВАТЬ НАДО У PUBLIC, И У КАЖДОЙ ФУНКЦИИ. Postgres выдаёт право EXECUTE роли PUBLIC
-- на любую новую функцию по умолчанию, поэтому «просто не выдать грант» не работает:
-- функция всё равно вызывается кем угодно с ключом из сборки. Проверено вживую — новые
-- функции отвечали «нужен аккаунт» из своего тела, а my_maps молча возвращала пустой
-- список. Утечки не было (auth.uid() пуст — и выборка пуста), но полагаться на тело
-- функции там, где должен стоять грант, нельзя: одна забытая проверка внутри — и дыра.
-- Отзываем И У PUBLIC, И У ANON — это два РАЗНЫХ права, и нужны оба отзыва.
-- public — то, что Postgres выдал сам при создании функции.
-- anon — то, что мы выдали руками в прежних скриптах (schema.sql и migration-01),
--   когда входа ещё не существовало и ключ из сборки был единственным пропуском.
-- Проверено вживую: после отзыва только у public функции create_map и push_edges
-- по-прежнему вызывались анонимом — их спасала лишь проверка внутри тела.
revoke all on public.profiles, public.map_members, public.edge_reports from public, anon, authenticated;
revoke all on function public.push_edges(uuid, jsonb)          from public, anon;
revoke all on function public.pull_edges(uuid, timestamptz)    from public, anon;
revoke all on function public.create_map(text)                 from public, anon;
revoke all on function public.ensure_profile(text)             from public, anon;
revoke all on function public.join_map(uuid, text)             from public, anon;
revoke all on function public.leave_map(uuid)                  from public, anon;
revoke all on function public.my_maps()                        from public, anon;
revoke all on function public.delete_edge(uuid, text, text)    from public, anon;

grant execute on function public.ensure_profile(text)              to authenticated;
grant execute on function public.create_map(text)                  to authenticated;
grant execute on function public.join_map(uuid, text)              to authenticated;
grant execute on function public.leave_map(uuid)                   to authenticated;
grant execute on function public.my_maps()                         to authenticated;
grant execute on function public.delete_edge(uuid, text, text)     to authenticated;
grant execute on function public.push_edges(uuid, jsonb)           to authenticated;
grant execute on function public.pull_edges(uuid, timestamptz)     to authenticated;

-- Доверенный аккаунт назначается вручную, из этого же редактора:
--   update public.profiles set trusted = true where id = '<uuid игрока>';
-- Свой uuid игрок видит в настройках приложения и присылает тебе.
