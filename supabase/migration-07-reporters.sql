-- Кто внёс портал и кто его подтвердил — ИМЕНАМИ, а не числом.
--
-- Зачем. Игрок просил: «не должно дублироваться, должно появляться, что внесён игроком 1,
-- подтверждён игроком 2 или 3». Само склеивание уже работает — портал хранится один раз
-- на пару зон, и повторная запись от другого человека не создаёт второго ребра. Но в
-- интерфейсе от этого видно только «подтверждений 2 из 3»: с кем именно ты сходишься
-- показаниями, сказать было нечем.
--
-- Данные для этого на сервере ЛЕЖАТ с самого начала: в edge_reports строка на каждую
-- связку «аккаунт — портал», с временем. Не хватало только их выдачи, и добавляется она
-- одной колонкой в pull_edges.
--
-- Скрипт можно запускать повторно.
--
-- ЧТО СЛУЧИТСЯ СО СТАРЫМИ СБОРКАМИ ДРУЗЕЙ: ничего. Клиент читает поля ответа по именам,
-- лишняя колонка ему не мешает, а новый клиент без этой миграции просто показывает
-- счётчик, как раньше. Порядок «сначала база, потом сборка» здесь не обязателен —
-- в отличие от migration-02, которая меняла правила доступа.

-- ---------- выдача ----------
-- Тип возврата меняется (прибавилась колонка), поэтому функцию нельзя заменить на месте:
-- create or replace падает с 42P13. Только drop + create, и drop обязан быть с точными
-- типами аргументов и «if exists» — скрипт должен переживать и повторный запуск, и
-- чистую базу.
drop function if exists public.pull_edges(uuid, timestamptz);

create function public.pull_edges(p_map uuid, p_since timestamptz default null)
returns table (
  a text, b text, cap_max smallint, cap_max_known boolean,
  expires_at timestamptz, source text, by_nick text, updated_at timestamptz,
  confirms numeric, needed smallint, reporters text[]
)
language sql
security definer
set search_path = public
as $$
  select e.a, e.b, e.cap_max, e.cap_max_known, e.expires_at, e.source, e.by_nick, e.updated_at,
         e.confirms, m.confirm_required,
         -- Ники всех, кто сообщил про этот портал, в порядке появления: первый — тот, кто
         -- внёс, остальные — подтвердившие. Ровно та же связка, по которой считается
         -- confirms, поэтому число и список не могут разойтись.
         --
         -- В ОБЩЕЙ КАРТЕ НИКОВ НЕТ. Это не оговорка и не забота о размере ответа: правило
         -- «из общей карты не выводится, кто где был» держится с самого начала — ник туда
         -- не кладёт ни клиент, ни push_edges, — и выдать его здесь окольным путём значило
         -- бы обойти собственное правило. В комнате друзей всё наоборот: там знают, кто
         -- пишет, и имя — это и есть смысл подтверждения.
         case when m.kind = 'public' then null else (
           select array_agg(p.nick order by r.reported_at, p.nick)
             from public.edge_reports r
             join public.profiles p on p.id = r.user_id
            where r.map_id = e.map_id and r.a = e.a and r.b = e.b
         ) end
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
-- Функция пересоздана, значит права выданы заново: Postgres сам выдаёт EXECUTE роли
-- PUBLIC любой новой функции, поэтому отзыв обязателен, иначе её вызовет кто угодно
-- с ключом из сборки. Отзываем и у public, и у anon — это два разных права.
revoke all on function public.pull_edges(uuid, timestamptz) from public, anon;
grant execute on function public.pull_edges(uuid, timestamptz) to authenticated;
