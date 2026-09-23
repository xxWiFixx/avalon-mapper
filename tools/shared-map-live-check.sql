-- Run after migration-08. Test records and all side effects are rolled back.
begin;
do $$
declare
  owner_id uuid := gen_random_uuid();
  member_id uuid := gen_random_uuid();
  outsider_id uuid := gen_random_uuid();
  map_id uuid;
  snapshot jsonb;
  previous_version text;
  denied boolean := false;
begin
  insert into auth.users(id) values (owner_id), (member_id), (outsider_id);
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform public.ensure_profile('check-' || left(owner_id::text, 8));
  map_id := public.create_map('Temporary sync check');
  perform public.push_edges(map_id, jsonb_build_array(jsonb_build_object(
    'a', 'Qiient-Si-Tertum', 'b', 'Touos-Ataglos', 'source', 'ocr',
    'capMax', 20, 'capMaxKnown', true, 'expiresAt', null)));

  perform set_config('request.jwt.claim.sub', member_id::text, true);
  perform public.ensure_profile('check-' || left(member_id::text, 8));
  perform public.join_map(map_id);
  snapshot := public.pull_map_snapshot(map_id);
  if snapshot->>'role' is distinct from 'viewer' or jsonb_array_length(snapshot->'edges') is distinct from 1
     or (snapshot->'edges'->0->'expires_at') is distinct from 'null'::jsonb then
    raise exception 'Viewer delivery or unknown timer failed';
  end if;
  previous_version := snapshot->>'version';
  snapshot := public.pull_map_snapshot(map_id, previous_version);
  if snapshot->>'unchanged' is distinct from 'true' or snapshot ? 'edges' then
    raise exception 'Unchanged snapshot failed';
  end if;
  begin
    perform public.push_edges(map_id, '[]'::jsonb);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then raise exception 'Viewer write restriction failed'; end if;

  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform public.set_member_role(map_id, member_id, 'member');
  perform set_config('request.jwt.claim.sub', member_id::text, true);
  perform public.push_edges(map_id, jsonb_build_array(jsonb_build_object(
    'a', 'Qiient-Si-Tertum', 'b', 'Touos-Ataglos', 'source', 'ocr',
    'capMax', 7, 'capMaxKnown', true, 'expiresAt', now() + interval '2 minutes')));
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  snapshot := public.pull_map_snapshot(map_id, previous_version);
  if snapshot->>'unchanged' is distinct from 'false' or (snapshot->'edges'->0->>'confirms')::numeric is distinct from 2
     or jsonb_array_length(snapshot->'edges'->0->'reporters') is distinct from 2
     or (snapshot->'edges'->0->>'expires_at')::timestamptz is distinct from now() + interval '2 minutes' then
    raise exception 'Confirmation or timer correction failed';
  end if;

  perform set_config('request.jwt.claim.sub', outsider_id::text, true);
  if public.pull_map_snapshot(map_id)->>'denied' is distinct from 'true' then
    raise exception 'Non-member read restriction failed';
  end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform public.delete_edge(map_id, 'Qiient-Si-Tertum', 'Touos-Ataglos');
  perform set_config('request.jwt.claim.sub', member_id::text, true);
  if jsonb_array_length(public.pull_map_snapshot(map_id)->'edges') is distinct from 0 then
    raise exception 'Deletion delivery failed';
  end if;
  perform set_config('request.jwt.claim.sub', owner_id::text, true);
  perform public.kick_member(map_id, member_id);
  perform set_config('request.jwt.claim.sub', member_id::text, true);
  if public.pull_map_snapshot(map_id)->>'denied' is distinct from 'true' then
    raise exception 'Membership revocation failed';
  end if;
  if has_function_privilege('anon', 'public.pull_map_snapshot(uuid,text)', 'execute') then
    raise exception 'Anonymous RPC restriction failed';
  end if;
end;
$$;
select 'passed: delivery, timers, confirmations, deletion, permissions; all test data rolled back' as result;
rollback;
