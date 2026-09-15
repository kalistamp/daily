-- Apply manually to the existing project only after a private database backup.
begin;
create schema if not exists daily;
revoke all on schema daily from public, anon;
grant usage on schema daily to authenticated, service_role;

create table if not exists daily.journal_owners (
  user_id uuid primary key references auth.users(id), created_at timestamptz not null default now()
);
alter table daily.journal_owners enable row level security;
alter table daily.journal_owners force row level security;
revoke all on daily.journal_owners from public, anon, authenticated;
grant select on daily.journal_owners to authenticated;
grant all on daily.journal_owners to service_role;
drop policy if exists owner_self on daily.journal_owners;
create policy owner_self on daily.journal_owners for select to authenticated using (user_id = (select auth.uid()));

create or replace function daily.journal_access() returns boolean
language sql stable security definer set search_path = '' as $$
 select auth.uid() is not null and coalesce(auth.jwt()->>'aal', '') = 'aal2'
 and exists(select 1 from daily.journal_owners where user_id = auth.uid());
$$;
revoke all on function daily.journal_access() from public, anon;
grant execute on function daily.journal_access() to authenticated, service_role;

create table if not exists daily.journal_imports (
 id uuid primary key, user_id uuid not null references auth.users(id), source_hash text not null,
 status text not null default 'staging' check(status in ('staging','active')),
 manifest jsonb not null default '{}', created_at timestamptz not null default now(),
 unique(user_id,id), unique(user_id,source_hash)
);
create table if not exists daily.journal_entries (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 entry_date date, archive_year integer not null check(archive_year between 1900 and 2200),
 title text not null default '', body_md text not null default '' check(length(body_md)<=1000000),
 source_key text, source_order integer not null default 0, source_hash text,
 import_batch uuid, review_note text not null default '', revision bigint not null default 1 check(revision>0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz,
 check(entry_date is null or extract(year from entry_date)=archive_year),
 foreign key(user_id,import_batch) references daily.journal_imports(user_id,id), unique(user_id,source_key,source_order)
);
create index if not exists journal_year_date on daily.journal_entries(user_id,archive_year,entry_date desc,id);
create table if not exists daily.journal_years (
 user_id uuid not null references auth.users(id), year integer not null check(year between 1900 and 2200),
 intro_md text not null default '', revision bigint not null default 1,
 updated_at timestamptz not null default now(), primary key(user_id,year)
);
create table if not exists daily.journal_documents (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 archive_year integer not null check(archive_year between 1900 and 2200), title text not null, body_md text not null,
 source_key text, source_hash text, import_batch uuid,
 revision bigint not null default 1, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), deleted_at timestamptz,
 foreign key(user_id,import_batch) references daily.journal_imports(user_id,id), unique(user_id,source_key)
);
create table if not exists daily.journal_assets (
 id uuid primary key, user_id uuid not null references auth.users(id), archive_year integer not null,
 source_key text not null, object_path text not null, mime_type text not null,
 sha256 text not null, size_bytes bigint not null check(size_bytes>=0), import_batch uuid not null,
 foreign key(user_id,import_batch) references daily.journal_imports(user_id,id), unique(user_id,source_key,import_batch)
);
create table if not exists daily.journal_revisions (
 id bigint generated always as identity primary key, user_id uuid not null references auth.users(id),
 entity text not null, entity_id text not null, revision bigint not null, snapshot jsonb not null,
 created_at timestamptz not null default now()
);

do $$ declare t text; begin
 foreach t in array array['journal_imports','journal_entries','journal_years','journal_documents','journal_assets','journal_revisions'] loop
  execute format('alter table daily.%I enable row level security',t);
  execute format('alter table daily.%I force row level security',t);
  execute format('revoke all on daily.%I from public,anon,authenticated',t);
  execute format('grant select on daily.%I to authenticated',t);
  execute format('grant all on daily.%I to service_role',t);
  execute format('drop policy if exists journal_owner on daily.%I',t);
  execute format('create policy journal_owner on daily.%I to authenticated using (user_id=(select auth.uid()) and (select daily.journal_access())) with check(user_id=(select auth.uid()) and (select daily.journal_access()))',t);
 end loop;
end $$;
grant insert,update on daily.journal_entries,daily.journal_documents,daily.journal_years,daily.journal_imports,daily.journal_assets to authenticated;
-- Deliberately no DELETE grants: the editor uses reversible deleted_at updates.

create or replace function daily.track_journal_edit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.user_id is distinct from old.user_id then raise exception 'OWNER_IMMUTABLE' using errcode='42501'; end if;
 if tg_table_name='journal_years' then
  if new.year is distinct from old.year then raise exception 'YEAR_IMMUTABLE'; end if;
 else
  if new.id is distinct from old.id then raise exception 'ID_IMMUTABLE'; end if;
 end if;
 insert into daily.journal_revisions(user_id,entity,entity_id,revision,snapshot)
 values(old.user_id,tg_table_name,coalesce(to_jsonb(old)->>'id',to_jsonb(old)->>'year'),old.revision,to_jsonb(old));
 new.revision:=old.revision+1; new.updated_at:=now(); return new;
end $$;
revoke all on function daily.track_journal_edit() from public,anon,authenticated;
do $$ declare t text; begin
 foreach t in array array['journal_entries','journal_documents','journal_years'] loop
  execute format('drop trigger if exists journal_revision on daily.%I',t);
  execute format('create trigger journal_revision before update on daily.%I for each row execute function daily.track_journal_edit()',t);
 end loop;
end $$;

-- Guard existing report RPCs without replacing their implementation or data.
do $$ declare item record; begin
 for item in select p.proname as name, pg_get_function_arguments(p.oid) as args,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  pg_get_function_result(p.oid) as result,
  coalesce((select string_agg(quote_ident(arg),', ' order by ordinal)
   from unnest(p.proargnames) with ordinality as a(arg,ordinal)),'') as callargs,
  case p.proname when 'apply_daily_changes' then 'expected_revision'
   when 'save_data' then 'expected_version' when 'read_daily_changes_since' then 'since_revision' else '' end as revision_arg
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='daily' and p.proname in ('apply_daily_changes','save_data','ensure_daily_state','read_daily_changes_since') loop
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='daily' and p.proname=item.name)
   and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='daily' and p.proname=item.name||'_internal') then
   execute format('alter function daily.%I(%s) rename to %I',item.name,item.identity_args,item.name||'_internal');
   execute format('revoke all on function daily.%I(%s) from public, anon, authenticated, service_role',item.name||'_internal',item.identity_args);
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='daily' and p.proname=item.name||'_internal') then
   execute format('create or replace function daily.%I(%s) returns %s language plpgsql security definer set search_path='''' as $body$ begin if not daily.journal_access() then raise exception ''JOURNAL_ACCESS_REQUIRED'' using errcode=''42501''; end if; %s return daily.%I(%s); end $body$',item.name,item.args,item.result,
    case when item.revision_arg<>'' then format('if %I is null or %I < 0 then raise exception ''INVALID_REVISION''; end if;',item.revision_arg,item.revision_arg) else '' end,item.name||'_internal',item.callargs);
   execute format('revoke all on function daily.%I(%s) from public,anon',item.name,item.identity_args);
   execute format('grant execute on function daily.%I(%s) to authenticated',item.name,item.identity_args);
  end if;
 end loop;
end $$;
do $$ declare t text; begin
 foreach t in array array['daily_items','daily_sync_state','monthly_data'] loop
  if to_regclass('daily.'||t) is not null then
   execute format('drop policy if exists journal_mfa_gate on daily.%I',t);
   execute format('create policy journal_mfa_gate on daily.%I as restrictive to authenticated using ((select daily.journal_access()))',t);
  end if;
 end loop;
 if exists(select 1 from pg_publication where pubname='supabase_realtime')
 and to_regclass('daily.daily_sync_state') is not null
 and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='daily' and tablename='daily_sync_state') then
  alter publication supabase_realtime add table daily.daily_sync_state;
 end if;
end $$;

insert into storage.buckets(id,name,public,file_size_limit) values('daily-journal','daily-journal',false,52428800)
on conflict(id) do update set public=false;
drop policy if exists daily_private_objects on storage.objects;
create policy daily_private_objects on storage.objects to authenticated
 using(bucket_id='daily-journal' and (storage.foldername(name))[1]=(select auth.uid())::text and (select daily.journal_access()))
 with check(bucket_id='daily-journal' and (storage.foldername(name))[1]=(select auth.uid())::text and (select daily.journal_access()));
-- Never grant anonymous Storage access or change other buckets' policies.
-- Shared-project permissive policies must not widen access to this bucket.
drop policy if exists daily_bucket_guard on storage.objects;
create policy daily_bucket_guard on storage.objects as restrictive to authenticated
 using(bucket_id<>'daily-journal' or ((storage.foldername(name))[1]=(select auth.uid())::text and (select daily.journal_access())))
 with check(bucket_id<>'daily-journal' or ((storage.foldername(name))[1]=(select auth.uid())::text and (select daily.journal_access())));
drop policy if exists daily_bucket_anon_guard on storage.objects;
create policy daily_bucket_anon_guard on storage.objects as restrictive to anon
 using(bucket_id<>'daily-journal') with check(bucket_id<>'daily-journal');

create table if not exists daily.agent_leaderboard_cache (
 key text primary key, payload jsonb, fetched_at timestamptz, expires_at timestamptz,
 retry_after timestamptz, lease_until timestamptz
);
insert into daily.agent_leaderboard_cache(key) values('overall') on conflict do nothing;
alter table daily.agent_leaderboard_cache enable row level security;
revoke all on daily.agent_leaderboard_cache from public,anon,authenticated;
grant all on daily.agent_leaderboard_cache to service_role;
create or replace function daily.claim_agent_refresh() returns boolean language plpgsql security definer set search_path='' as $$
begin
 update daily.agent_leaderboard_cache set lease_until=now()+interval '30 seconds'
 where key='overall' and (lease_until is null or lease_until<now()) and (retry_after is null or retry_after<now());
 return found;
end $$;
revoke all on function daily.claim_agent_refresh() from public,anon,authenticated;
grant execute on function daily.claim_agent_refresh() to service_role;
create table if not exists daily.ai_usage(user_id uuid primary key,window_start timestamptz not null,requests integer not null);
alter table daily.ai_usage enable row level security;
revoke all on daily.ai_usage from public,anon,authenticated;
grant all on daily.ai_usage to service_role;
create or replace function daily.claim_ai_request(owner_id uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare n integer; begin
 insert into daily.ai_usage values(owner_id,now(),1) on conflict(user_id) do update
 set window_start=case when daily.ai_usage.window_start<now()-interval '1 hour' then now() else daily.ai_usage.window_start end,
 requests=case when daily.ai_usage.window_start<now()-interval '1 hour' then 1 else daily.ai_usage.requests+1 end returning requests into n;
 return n<=30;
end $$;
revoke all on function daily.claim_ai_request(uuid) from public,anon,authenticated;
grant execute on function daily.claim_ai_request(uuid) to service_role;
commit;
