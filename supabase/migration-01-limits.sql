-- Ограничения против злоупотребления. Выполнить в SQL Editor поверх schema.sql.
-- Скрипт можно запускать повторно.
--
-- ЗАЧЕМ. Адрес проекта и публичный ключ лежат внутри приложения — так и задумано,
-- иначе клиент не смог бы работать. Но это значит, что вызывать наши функции может
-- КТО УГОДНО, а не только наш клиент: достаточно достать ключ из сборки и открыть
-- консоль браузера. Любая проверка на стороне приложения такого человека не касается.
-- Поэтому всё, что защищает проект, обязано жить здесь.
--
-- Что закрываем (каждое проверено на живом проекте до правки):
--   1. expires_at принимался любым — портал «до 2999 года» не удалялся уборкой никогда
--      и навсегда оставался в общей карте и в картах всех, кто её читает;
--   2. create_map выдана анониму без ограничений — цикл создаёт карты пока не кончится
--      бесплатный тариф;
--   3. размер порции не ограничен — один запрос с массивом на сто тысяч рёбер;
--   4. длина имён не ограничена — мегабайтное «имя зоны» ложится в базу и растекается
--      по картам всех участников;
--   5. частота не ограничена вовсе.

-- ---------- счётчик обращений ----------
-- Опознать человека без авторизации мы не можем, поэтому считаем обращения по вёдрам:
-- глобально для создания карт и по каждой карте отдельно для выгрузки. Мера грубая —
-- один злоупотребляющий притормозит остальных в том же ведре, — но она защищает проект,
-- а это сейчас важнее удобства. Появятся аккаунты — счётчик переедет на них.
create table if not exists public.limits (
  bucket text not null,
  slot   timestamptz not null,
  n      integer not null default 0,
  primary key (bucket, slot)
);
alter table public.limits enable row level security;   -- политик нет: таблица только для функций

-- Взять одно обращение из ведра. Проверяем ДО увеличения: если поднять исключение после,
-- откатится и само увеличение — счётчик никогда не дорастёт до предела, и защита
-- превратится в украшение.
create or replace function public.take_slot(p_bucket text, p_window interval, p_cap integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot timestamptz;
  v_n integer;
begin
  v_slot := date_bin(p_window, now(), timestamptz 'epoch');
  select n into v_n from public.limits where bucket = p_bucket and slot = v_slot;
  if coalesce(v_n, 0) >= p_cap then
    raise exception 'слишком часто: % — не больше % за %', p_bucket, p_cap, p_window
      using errcode = 'P0001';
  end if;
  insert into public.limits (bucket, slot, n) values (p_bucket, v_slot, 1)
    on conflict (bucket, slot) do update set n = public.limits.n + 1;
  -- старые вёдра не копим
  delete from public.limits where slot < now() - interval '3 hours';
end;
$$;

-- ---------- ограничения на сами данные ----------
-- Имя зоны в игре — не длиннее сорока символов (самое длинное в справочнике — 21).
-- Ник ограничен теми же 24 символами, что и в приложении. Источник — три известных слова.
alter table public.edges drop constraint if exists edges_a_len;
alter table public.edges drop constraint if exists edges_b_len;
alter table public.edges drop constraint if exists edges_nick_len;
alter table public.edges drop constraint if exists edges_source_known;
alter table public.edges add constraint edges_a_len      check (char_length(a) between 2 and 40);
alter table public.edges add constraint edges_b_len      check (char_length(b) between 2 and 40);
alter table public.edges add constraint edges_nick_len   check (by_nick is null or char_length(by_nick) <= 24);
alter table public.edges add constraint edges_source_known check (source in ('ocr', 'manual', 'passive'));

alter table public.maps drop constraint if exists maps_title_len;
alter table public.maps add constraint maps_title_len check (title is null or char_length(title) <= 60);

-- ---------- создание карт ----------
-- 60 карт в час на весь проект. Живая компания создаёт одну-две в неделю, а цикл
-- в консоли упирается в предел через минуту.
create or replace function public.create_map(p_title text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  perform public.take_slot('create_map', interval '1 hour', 60);
  insert into public.maps (kind, title)
  values ('group', nullif(left(trim(coalesce(p_title, '')), 60), ''))
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------- выгрузка порталов ----------
create or replace function public.push_edges(p_map uuid, p_edges jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_count integer;
  v_rows integer;
begin
  select kind into v_kind from public.maps where id = p_map;
  if v_kind is null then
    raise exception 'нет такой карты' using errcode = 'no_data_found';
  end if;

  if p_edges is null or jsonb_typeof(p_edges) <> 'array' then
    raise exception 'ожидался массив рёбер' using errcode = 'P0001';
  end if;
  -- Приложение шлёт порциями по 100. Двести — потолок с запасом; всё, что больше,
  -- прислано не нашим клиентом.
  if jsonb_array_length(p_edges) > 200 then
    raise exception 'слишком много рёбер за раз: % (предел 200)', jsonb_array_length(p_edges)
      using errcode = 'P0001';
  end if;

  -- 120 обращений в минуту на карту: обычный игрок делает единицы.
  perform public.take_slot('push:' || p_map::text, interval '1 minute', 120);

  with incoming as (
    select
      p_map as map_id,
      least(e->>'a', e->>'b')    as a,
      greatest(e->>'a', e->>'b') as b,
      nullif(e->>'capMax', '')::smallint as cap_max,
      coalesce((e->>'capMaxKnown')::boolean, false) as cap_max_known,
      -- Портал живёт максимум около суток. Всё, что дальше 48 часов, — либо ошибка,
      -- либо попытка оставить запись навсегда: уборка удаляет только просроченное.
      -- Проверка на null обязательна: least() в Postgres пропускает null и вернул бы
      -- потолок, то есть ребро «прошёл насквозь» без таймера получило бы срок 48 часов
      -- и выпало бы из уборки по 12-часовому правилу.
      case when nullif(e->>'expiresAt', '') is null then null
           else least((e->>'expiresAt')::timestamptz, now() + interval '48 hours') end as expires_at,
      case when coalesce(e->>'source', 'ocr') in ('ocr', 'manual', 'passive')
           then coalesce(e->>'source', 'ocr') else 'ocr' end as source,
      -- в общую карту ник не пишем: связка «кто где был» из неё выводиться не должна
      case when v_kind = 'public' then null else left(nullif(e->>'by', ''), 24) end as by_nick,
      now() as updated_at
    from jsonb_array_elements(p_edges) as e
    where coalesce(e->>'a', '') <> '' and coalesce(e->>'b', '') <> ''
      and e->>'a' <> e->>'b'
      and char_length(e->>'a') between 2 and 40
      and char_length(e->>'b') between 2 and 40
  ), ins as (
    insert into public.edges as t (map_id, a, b, cap_max, cap_max_known, expires_at, source, by_nick, updated_at)
    select map_id, a, b, cap_max, cap_max_known, expires_at, source, by_nick, updated_at from incoming
    on conflict (map_id, a, b) do update set
      -- размер портала липкий: он не меняется, и «не прочитал» не должен стирать прочитанное
      cap_max       = coalesce(case when excluded.cap_max_known then excluded.cap_max end, t.cap_max),
      cap_max_known = t.cap_max_known or excluded.cap_max_known,
      expires_at    = coalesce(excluded.expires_at, t.expires_at),
      source        = case when excluded.source = 'passive' and t.source <> 'passive' then t.source else excluded.source end,
      by_nick       = coalesce(excluded.by_nick, t.by_nick),
      updated_at    = excluded.updated_at
    returning 1
  )
  select count(*)::integer into v_count from ins;

  -- Потолок на карту: в игре порталов заведомо меньше тысячи. Лишнее срезаем по
  -- давности — так карта не растёт бесконечно, даже если в неё пишут мусор.
  select count(*) into v_rows from public.edges where map_id = p_map;
  if v_rows > 3000 then
    delete from public.edges e
     where e.map_id = p_map
       and e.ctid not in (
         select ctid from public.edges where map_id = p_map order by updated_at desc limit 3000
       );
  end if;

  -- уборка заодно: портал живёт часами, держать протухшие незачем
  delete from public.edges
   where expires_at is not null and expires_at < now() - interval '10 minutes';
  delete from public.edges
   where expires_at is null and updated_at < now() - interval '12 hours';

  return v_count;
end;
$$;

-- take_slot наружу не отдаём: она вызывается только изнутри других функций.
-- Отзывать надо именно у PUBLIC: право EXECUTE на функции выдано ему по умолчанию,
-- и отзыв у anon/authenticated сам по себе ничего бы не закрыл.
revoke all on function public.take_slot(text, interval, integer) from public;
grant execute on function public.create_map(text)        to anon, authenticated;
grant execute on function public.push_edges(uuid, jsonb) to anon, authenticated;
revoke all on public.limits from public, anon, authenticated;
