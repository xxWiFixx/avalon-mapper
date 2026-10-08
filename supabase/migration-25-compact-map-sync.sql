-- Aggregate authorized reads and remove repeated JSON field names on the wire.
-- The existing RPC still performs all access, expiry, rate and author-delay checks.
begin;
create or replace function public.pull_maps_compact(p_versions jsonb default '{}'::jsonb,p_context boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_policy jsonb; v_groups jsonb; v_ids uuid[]; v_id uuid; v_snapshot jsonb; v_rows jsonb;
 v_snapshots jsonb:='{}'::jsonb; v_result jsonb; v_code text; v_message text;
begin
 if auth.uid() is null then raise exception 'account_required' using errcode='28000'; end if;
 if jsonb_typeof(p_versions)<>'object' or p_versions is null or octet_length(p_versions::text)>65536
   or (select count(*) from jsonb_object_keys(p_versions))>128 then raise exception 'invalid_batch' using errcode='22023'; end if;
 if p_context then
  v_policy:=public.account_policy();
  select coalesce(jsonb_agg(to_jsonb(g)),'[]'::jsonb) into v_groups from public.my_maps() g;
  select array_agg(id) into v_ids from (select auth.uid() id union select (g->>'id')::uuid from jsonb_array_elements(v_groups) g) ids;
 else
  select array_agg(key::uuid) into v_ids from jsonb_object_keys(p_versions) key;
 end if;
 if coalesce(cardinality(v_ids),0)>128 then raise exception 'invalid_batch' using errcode='22023'; end if;
 foreach v_id in array coalesce(v_ids,array[]::uuid[]) loop
  begin
   v_snapshot:=public.pull_map_snapshot(v_id,p_versions->>v_id::text);
   if jsonb_typeof(v_snapshot->'edges')='array' then
    select coalesce(jsonb_agg(jsonb_build_array(e->'a',e->'b',e->'cap_max',e->'cap_max_known',
      floor(extract(epoch from (e->>'expires_at')::timestamptz)*1000),e->'source',e->'by_nick',
      floor(extract(epoch from (e->>'first_seen_at')::timestamptz)*1000),floor(extract(epoch from (e->>'updated_at')::timestamptz)*1000),
      e->'confirms',e->'needed',e->'reporters') order by ord),'[]'::jsonb) into v_rows
    from jsonb_array_elements(v_snapshot->'edges') with ordinality x(e,ord);
    v_snapshot:=(v_snapshot-'edges')||jsonb_build_object('wire',1,'rows',v_rows);
   end if;
  exception when others then
   get stacked diagnostics v_code=returned_sqlstate,v_message=message_text;
   v_snapshot:=jsonb_build_object('error',jsonb_build_object('code',v_code,'message',v_message));
  end;
  v_snapshots:=v_snapshots||jsonb_build_object(v_id::text,v_snapshot);
 end loop;
 v_result:=jsonb_build_object('wire',1,'snapshots',v_snapshots);
 if p_context then v_result:=v_result||jsonb_build_object('policy',v_policy,'groups',v_groups); end if;
 return v_result;
end; $$;
revoke all on function public.pull_maps_compact(jsonb,boolean) from public,anon,authenticated;
grant execute on function public.pull_maps_compact(jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
