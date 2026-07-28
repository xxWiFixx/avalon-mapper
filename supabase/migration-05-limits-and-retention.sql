-- Ограничение выгрузки — на игрока, а не на карту; и уборка следов за удалёнными рёбрами.
-- Запускать в SQL Editor Supabase ПОСЛЕ migration-04. Скрипт идемпотентен.
--
-- НАХОДКА 1: ОДНО ВЕДРО НА ВСЮ ОБЩУЮ КАРТУ.
-- Ограничение стояло так: take_slot('push:' || p_map, 1 минута, 120). Ведро одно на карту,
-- а общая карта одна на всех — значит 120 выгрузок в минуту делили между собой ВСЕ игроки.
-- Один человек (или скрипт) мог выбрать их целиком, и остальные получали отказ 400.
-- А клиент после трёх отказов подряд выбрасывает порцию (BAD_TRIES_MAX в lib/sync.js) —
-- то есть чужая жадность стоила бы другим игрокам их порталов. Ведро должно быть личным:
-- тогда предел бьёт только по тому, кто в него упёрся.
--
-- НАХОДКА 2: ОТЧЁТЫ ПЕРЕЖИВАЮТ СВОИ РЁБРА.
-- В edge_reports лежит связка «аккаунт — портал — когда». Она нужна, пока ребро живо:
-- по ней считаются подтверждения. Но уборка в push_edges сносила только edges, а отчёты
-- оставались навсегда. Получалось хранилище следов: кто когда где ходил, за всё время.
-- Ребру конец — отчётам тоже.

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

  -- Ведро ЛИЧНОЕ: карта плюс аккаунт. 60 запросов в минуту — это 6000 рёбер, вручную
  -- столько не набрать и близко, а скрипт упрётся сам в себя, не задев остальных.
  perform public.take_slot('push:' || p_map::text || ':' || v_id::text, interval '1 minute', 60);

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
      -- В общую карту только со временем закрытия (см. migration-04).
      and (v_kind <> 'public' or nullif(e->>'expiresAt', '') is not null)
  ), rep as (
    insert into public.edge_reports as r (map_id, a, b, user_id, source)
    select map_id, a, b, v_id, source from incoming
    on conflict (map_id, a, b, user_id) do update
      set reported_at = now(),
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
      confirms      = (select coalesce(sum(case when r2.source = 'manual' then 0.5 else 1 end), 0)
                         from public.edge_reports r2
                        where r2.map_id = t.map_id and r2.a = t.a and r2.b = t.b)
    returning 1
  )
  select count(*)::integer into v_count from ins;

  delete from public.edges where expires_at is not null and expires_at < now() - interval '10 minutes';
  delete from public.edges where expires_at is null and updated_at < now() - interval '12 hours';
  -- Отчёты живут ровно столько, сколько их ребро. Раньше они оставались навсегда, и в базе
  -- копилась история «кто когда какой портал видел» — сведения, которые после смерти ребра
  -- уже ни на что не влияют, а хранятся.
  delete from public.edge_reports r
   where not exists (select 1 from public.edges e
                      where e.map_id = r.map_id and e.a = r.a and e.b = r.b);
  return v_count;
end;
$$;

-- Разовая уборка того, что накопилось до этой миграции.
delete from public.edge_reports r
 where not exists (select 1 from public.edges e
                    where e.map_id = r.map_id and e.a = r.a and e.b = r.b);

revoke all on function public.push_edges(uuid, jsonb) from public, anon;
grant execute on function public.push_edges(uuid, jsonb) to authenticated;
