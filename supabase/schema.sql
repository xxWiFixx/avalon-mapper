-- Общие карты Avalon Mapper. Один Postgres в Supabase, ничего больше.
-- Вставить целиком в SQL Editor проекта (можно повторно — скрипт идемпотентный).
--
-- ЧТО ЗДЕСЬ ВАЖНО ПОНИМАТЬ ПРО ДОСТУП.
-- Приложение ходит в базу с публичным ключом anon — он лежит у каждого игрока и
-- секретом не является. Поэтому таблицы закрыты полностью (RLS без единой политики),
-- а наружу торчат три функции с `security definer`: они и есть весь API.
-- Читать и писать карту можно, только зная её id — случайный uuid, который игрок
-- пересылает друзьям сам. Перебрать uuid нельзя, а «select * from edges» без
-- указания карты просто не существует как возможность.
--
-- Личная карта в базу НЕ попадает вовсе: она живёт файлом на диске игрока.

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------- карты ----------
-- kind: 'group' — карта для своих (id рассылается друзьями), 'public' — общая
create table if not exists public.maps (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('group', 'public')),
  title      text,
  created_at timestamptz not null default now()
);

-- Общая карта одна и с постоянным id: приложение знает его константой,
-- отдельно «создавать» её не нужно.
insert into public.maps (id, kind, title)
values ('00000000-0000-0000-0000-0000000000a0', 'public', 'Общая карта Авалона')
on conflict (id) do nothing;

-- ---------- рёбра-порталы ----------
-- Пара зон хранится ОТСОРТИРОВАННОЙ (a < b) — портал ненаправленный, и без этого
-- одно и то же ребро от двух игроков легло бы двумя строками.
-- Позиции игроков, следы и журнал сюда не попадают вообще: только порталы.
create table if not exists public.edges (
  map_id        uuid not null references public.maps(id) on delete cascade,
  a             text not null,
  b             text not null,
  cap_max       smallint check (cap_max in (7, 20)),
  cap_max_known boolean not null default false,
  expires_at    timestamptz,
  source        text not null default 'ocr',   -- ocr | manual | passive
  by_nick       text,                          -- кто прислал; в общую карту не пишется
  updated_at    timestamptz not null default now(),
  primary key (map_id, a, b),
  check (a < b)
);

create index if not exists edges_map_updated on public.edges (map_id, updated_at desc);
create index if not exists edges_expires on public.edges (expires_at);

alter table public.maps  enable row level security;
alter table public.edges enable row level security;
-- политик нет намеренно: напрямую таблицы не читает и не пишет никто, только функции ниже

-- ---------- API ----------

-- Создать карту для своих. Возвращает id — его игрок и пересылает друзьям.
create or replace function public.create_map(p_title text default null)
returns uuid
language sql
security definer
set search_path = public
as $$
  insert into public.maps (kind, title) values ('group', nullif(trim(p_title), ''))
  returning id;
$$;

-- Выгрузить порталы. p_edges — массив объектов вида
-- {"a":"...", "b":"...", "capMax":7, "capMaxKnown":true, "expiresAt":"2026-07-26T21:00:00Z",
--  "source":"ocr", "by":"nick"}
-- Более свежая запись побеждает по updated_at; своё же старое эхо чужую свежую не затрёт.
create or replace function public.push_edges(p_map uuid, p_edges jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_count integer;
begin
  select kind into v_kind from public.maps where id = p_map;
  if v_kind is null then
    raise exception 'нет такой карты' using errcode = 'no_data_found';
  end if;

  with incoming as (
    select
      p_map as map_id,
      least(e->>'a', e->>'b')    as a,
      greatest(e->>'a', e->>'b') as b,
      nullif(e->>'capMax', '')::smallint as cap_max,
      coalesce((e->>'capMaxKnown')::boolean, false) as cap_max_known,
      nullif(e->>'expiresAt', '')::timestamptz as expires_at,
      coalesce(nullif(e->>'source', ''), 'ocr') as source,
      -- в общую карту ник не пишем: связка «кто где был» из неё выводиться не должна
      case when v_kind = 'public' then null else nullif(e->>'by', '') end as by_nick,
      now() as updated_at
    from jsonb_array_elements(coalesce(p_edges, '[]'::jsonb)) as e
    where coalesce(e->>'a', '') <> '' and coalesce(e->>'b', '') <> ''
      and e->>'a' <> e->>'b'
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

  -- уборка заодно: портал живёт часами, держать протухшие незачем
  delete from public.edges
   where expires_at is not null and expires_at < now() - interval '10 minutes';
  delete from public.edges
   where expires_at is null and updated_at < now() - interval '12 hours';

  return v_count;
end;
$$;

-- Забрать чужие порталы, изменившиеся после p_since (null — всё живое).
create or replace function public.pull_edges(p_map uuid, p_since timestamptz default null)
returns table (
  a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source, e.by_nick, e.updated_at
    from public.edges e
   where e.map_id = p_map
     and e.updated_at > coalesce(p_since, '-infinity'::timestamptz)
     and (e.expires_at is null or e.expires_at > now())
   order by e.updated_at
   limit 2000;
$$;

revoke all on public.maps, public.edges from anon, authenticated;
grant execute on function public.create_map(text)            to anon, authenticated;
grant execute on function public.push_edges(uuid, jsonb)     to anon, authenticated;
grant execute on function public.pull_edges(uuid, timestamptz) to anon, authenticated;
