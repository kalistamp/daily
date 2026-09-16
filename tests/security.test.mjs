import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
const owner = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222";
test("migration and forced RLS enforce owner access, revisions, private storage and RPC guards", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); insert into auth.users values('${owner}'),('${other}');
 `);
    // Supabase auth helpers backed by synthetic JWT claims, never real users.
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 grant usage on schema auth to anon,authenticated,service_role;
 create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint); create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text); alter table storage.objects enable row level security; grant usage on schema storage to anon,authenticated; grant select,insert,update,delete on storage.objects to anon,authenticated;
 create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
 create policy unrelated_broad_policy on storage.objects to authenticated,anon using(true) with check(true);
 create schema daily;
 create table daily.daily_items(user_id uuid,entity_id text,entity_type text,data jsonb,revision bigint); alter table daily.daily_items enable row level security; alter table daily.daily_items force row level security; grant select on daily.daily_items to authenticated; create policy old_owner on daily.daily_items to authenticated using(user_id=auth.uid());
 create function daily.apply_daily_changes(expected_revision bigint,changes jsonb) returns bigint language sql security definer as $$select coalesce(expected_revision,0)+1$$;
 create function daily.ensure_daily_state() returns bigint language sql security definer as $$select 0::bigint$$;
 create function daily.save_data(expected_version bigint,new_data jsonb) returns bigint language sql security definer as $$select coalesce(expected_version,0)+1$$;
 create function daily.read_daily_changes_since(since_revision bigint default 0) returns jsonb language sql security definer as $$select '{}'::jsonb$$;
 `);
    const sql = await readFile(
      new URL(
        "../supabase/migrations/202609120001_journal.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const emailOnly = await readFile(
      new URL(
        "../supabase/migrations/202609140001_email_password_only.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.exec(sql);
    await db.exec(sql);
    await db.exec(emailOnly);
    await db.exec(emailOnly);
    await db.exec(
      `insert into daily.journal_owners(user_id) values('${owner}'); insert into daily.journal_entries(user_id,archive_year,entry_date,body_md) values('${owner}',2026,'2026-01-01','Synthetic private entry'); insert into storage.objects(bucket_id,name) values('daily-journal','${owner}/file'),('unrelated','public-file');`,
    );
    async function session(role, uid, aal) {
      await db.exec(
        `reset role; select set_config('request.jwt.claims','${JSON.stringify({ sub: uid, aal })}',false); set role ${role};`,
      );
    }
    await session("anon", null, "aal1");
    await assert.rejects(db.query("select * from daily.journal_entries"));
    assert.equal(
      (
        await db.query(
          `select * from storage.objects where bucket_id='daily-journal'`,
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          `select * from storage.objects where bucket_id='unrelated'`,
        )
      ).rows.length,
      1,
    );
    await session("authenticated", owner, "aal1");
    assert.equal(
      (await db.query("select * from daily.journal_entries")).rows.length,
      1,
    );
    assert.equal((await db.query(`select daily.ensure_daily_state() n`)).rows[0].n, 0);
    await session("authenticated", other, "aal2");
    await assert.rejects(db.query(`select daily.ensure_daily_state()`), /JOURNAL_ACCESS_REQUIRED/);
    assert.equal(
      (await db.query("select * from daily.journal_entries")).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          `select * from storage.objects where bucket_id='daily-journal'`,
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      db.query(
        `insert into daily.journal_entries(user_id,archive_year,body_md) values('${owner}',2026,'Denied')`,
      ),
    );
    await session("authenticated", owner, "aal1");
    const row = (await db.query("select * from daily.journal_entries")).rows[0];
    assert.ok(row);
    assert.equal(
      (
        await db.query(
          `select * from storage.objects where bucket_id='daily-journal'`,
        )
      ).rows.length,
      1,
    );
    await assert.rejects(
      db.query(
        `insert into daily.journal_entries(user_id,archive_year,body_md) values('${other}',2026,'Denied')`,
      ),
    );
    await db.query(
      `update daily.journal_entries set body_md='Changed' where id=$1 and revision=1`,
      [row.id],
    );
    assert.equal(
      (await db.query("select revision from daily.journal_entries")).rows[0]
        .revision,
      2,
    );
    assert.equal(
      (
        await db.query(
          `update daily.journal_entries set body_md='Stale' where id=$1 and revision=1 returning id`,
          [row.id],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (await db.query("select count(*)::int n from daily.journal_revisions"))
        .rows[0].n,
      1,
    );
    await assert.rejects(
      db.query(
        `update daily.journal_entries set user_id='${other}' where id=$1`,
        [row.id],
      ),
    );
    await assert.rejects(
      db.query(
        `insert into daily.journal_entries(user_id,archive_year,entry_date,body_md) values('${owner}',2026,'2025-01-01','Bad date')`,
      ),
    );
    await assert.rejects(db.query("delete from daily.journal_entries"));
    await assert.rejects(
      db.query(`select daily.apply_daily_changes(null,'[]')`),
      /INVALID_REVISION/,
    );
    await assert.rejects(
      db.query(`select daily.save_data(null,'{}')`),
      /INVALID_REVISION/,
    );
    await assert.rejects(
      db.query(`select daily.apply_daily_changes_internal(0,'[]')`),
      /permission denied/,
    );
    assert.equal(
      (await db.query(`select daily.apply_daily_changes(0,'[]') n`)).rows[0].n,
      1,
    );
    await db.exec(`reset role; delete from daily.journal_owners where user_id='${owner}';`);
    await session("authenticated", owner, "aal1");
    assert.equal((await db.query("select * from daily.journal_entries")).rows.length, 0);
    assert.equal((await db.query("select * from storage.objects where bucket_id='daily-journal'")).rows.length, 0);
    await assert.rejects(db.query(`select daily.apply_daily_changes(1,'[]')`), /JOURNAL_ACCESS_REQUIRED/);
  } finally {
    await db.close();
  }
});
