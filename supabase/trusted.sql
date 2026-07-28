-- Признак доверия для конкретных аккаунтов.
-- Это НЕ миграция: файл держат рядом как памятку, а строки правят под нужных людей.
--
-- Что даёт trusted (см. my_role и pull_edges в migration-04):
--   1. Порталы этого игрока появляются в общей карте СРАЗУ, не дожидаясь трёх
--      подтверждений от разных людей.
--   2. В общей карте он считается хранителем — то есть может УДАЛЯТЬ оттуда чужие
--      порталы. Это второе следствие важно понимать: доверие здесь не только про
--      «его записям верим», но и про «ему разрешено чистить общее».
-- На комнаты признак не влияет: там права даёт роль участника.

update public.profiles set trusted = true
 where id in (
   '63cba067-4c94-48e5-8d0e-6f56dba2a65e',   -- wifi07 (владелец проекта)
   '171f7400-7f30-4f53-975d-aec72c91d257',   -- darling.1488
   '86d2ea6d-0620-43e5-abc6-1e3a9a32f3da'    -- hallelujahop
 );

-- ПОДЧИСТКА ЗАДНИМ ЧИСЛОМ.
-- Признак доверия ставится на РЕБРО в момент выгрузки: push_edges смотрит роль
-- отправителя и пишет edges.trusted. Значит все порталы, отправленные ДО того, как
-- человека сделали доверенным, остались с trusted = false — и продолжают ждать трёх
-- подтверждений, то есть видны только своему автору. Отмечаем их задним числом:
-- про них сообщал тот, кому мы теперь верим, и ждать больше нечего.
update public.edges e set trusted = true
 where e.trusted = false
   and exists (
     select 1 from public.edge_reports r
       join public.profiles p on p.id = r.user_id
      where r.map_id = e.map_id and r.a = e.a and r.b = e.b and p.trusted
   );

-- Кто сейчас доверенный — проверить после запуска:
select nick, trusted, created_at from public.profiles order by trusted desc, created_at;

-- Снять доверие обратно:
-- update public.profiles set trusted = false where id = '…';
