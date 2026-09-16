# Production Cutover

Status: deployment steps are manual. The owner reports applying the initial SQL
migration and allowlist and pushing the site. Function deployment, private import,
and live verification must be checked separately.
Do not interpret a successful Pages push as a completed private-data migration.

## 1. Preserve recovery

Keep the already verified source/app backup outside git. Take a restorable private
Supabase logical backup and private Storage backup before applying SQL. Include
existing report data, versions, legacy monthly_data and the relevant auth user
identities. Verify a restore in an isolated project; never reset the shared project.
The Free Plan inspected during review had no scheduled backups.

Export unsynced legacy browser data using Settings before clearing it. These
exports contain sensitive content and may contain old credentials. Do not commit
them. The user controls retirement/rotation of the old GitHub and provider keys.

## 2. Apply the scoped database migrations

Review supabase/migrations/202609120001_journal.sql and run it in the existing
project's SQL editor as its administrator. It is transactional and re-runnable.
It creates daily journal tables and private Storage policies, guards existing
report RPCs with owner-access and non-null revision checks, and preserves existing
report tables/data/history. It does not reset other application schemas.

Add the intended existing Auth user UUID to the allowlist using the SQL editor:

```sql
insert into daily.journal_owners(user_id)
values ('REPLACE_WITH_EXISTING_AUTH_USER_UUID'::uuid)
on conflict do nothing;
```

Do not use email or user-editable metadata as authorization. Keep public signup
and anonymous Auth disabled. Confirm the daily schema is available through the
Data API with only the migration's grants; do not expose unrelated schemas or
grant anonymous table access. The prior PGRST002/503 error must be resolved before
meaningful live tests. No CPU remediation is prescribed or performed here.

The report-RPC wrappers preserve actual catalog signatures. They rename originals
to *_internal, revoke client execution, and enforce journal_access before calling
them. The migration enables the existing revision signal's Realtime publication
when available. The new client uses explicit refresh/resume with optimistic
concurrency, so it does not depend on Realtime delivery for correctness.

For both new and existing installations, run
supabase/migrations/202609140001_email_password_only.sql after the initial
202609120001_journal.sql migration. It keeps the owner
allowlist and RLS protections but removes the TOTP/AAL2 requirement. This
follow-up is required for the email/password-only deployment. If the initial
migration is already applied, run only the follow-up. Re-running the initial
migration later would restore its old MFA requirement until the follow-up runs.

## 3. Auth and recovery

Set the Auth site URL/allowed redirect to https://kalistamp.github.io/daily/.
For cloud-backed local testing, explicitly allow the chosen loopback development
URL as an additional redirect. Do not use broad wildcard production redirects.
Sign in with the allowlisted existing account using email and password. This
deployment does not require TOTP/MFA enrollment. Test password recovery and
account-session expiry before relying on the journal.

## 4. Function secrets and deployment

Install the Supabase CLI and authenticate as the project administrator. Deploy
the two functions individually; **do not run db reset, db push, or push the shared
project configuration blindly**. SUPABASE_URL, SUPABASE_ANON_KEY and
SUPABASE_SERVICE_ROLE_KEY are supplied by the hosted function environment.

```powershell
supabase functions deploy agent-leaderboard --project-ref baiojghilzxhkebfblzv
supabase functions deploy journal-ai --project-ref baiojghilzxhkebfblzv
```

config.toml disables gateway JWT verification because the handlers explicitly
validate the user with Auth and journal_access(). This is not an unauthenticated
endpoint. Both checks must remain in place. CORS accepts the exact production
origin https://kalistamp.github.io, not a URL path. DAILY_DEV_ORIGINS can contain
comma-separated exact loopback origins for deliberate development use.

Configure only the AI providers you use via function secrets:
OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY (Gemini), GROQ_API_KEY,
CEREBRAS_API_KEY, COHERE_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY,
HUGGINGFACE_API_KEY. Never put them in HTML, JavaScript, GitHub variables or logs.
DAILY_ALLOWED_MODELS is a JSON object mapping provider IDs to arrays of permitted
model IDs, for example {"openai":["YOUR_APPROVED_MODEL_ID"]}. Unlisted models are
rejected. Obtain model IDs from the provider's current documentation/account.

The function has a 30-request/hour per-owner limit, bounded payloads, fixed
provider endpoints, a 90-second upstream timeout, and no content logging. The
user must confirm each report/follow-up disclosure. Provider processing is not
private Supabase-only storage. Review provider retention/privacy before use.

Monthly generation and regeneration include saved earlier answers/reflections
only when the context checkbox is selected. Open interrogation sends the saved
reflection and conversation, with journal entries opt-in. The confirmation states
the selected entry/context counts. No provider call is needed to write or save an
open reflection. These use the existing report entity store with kind=reflection;
there is no additional schema migration for the restored reflection workspace.

### Arena feed dependency


No supported public API was established for the requested Agent leaderboard;
its [terms](https://help.arena.ai/articles/5629909088-terms-of-use) restrict automated
extraction. Supply an official/licensed feed or obtain permission. No scraper,
unofficial proxy or fabricated ranking is included.

Set ARENA_AUTHORIZED_FEED_URL to the fixed HTTPS authorized adapter endpoint and
optional ARENA_FEED_TOKEN in function secrets. The normalized contract is:

```json
{
  "category": "overall",
  "source_date": "2026-09-12",
  "agents": [
    {"rank": 1, "id": "stable-variant-id", "name": "Actual ranked variant", "score": 100}
  ]
}
```

The array must contain at least ten rows in source-rank order, unique stable IDs,
and ranks 1 through 10. Scores are numbers or null. Do not conflate effort variants.
The example is a contract illustration, not live leaderboard data.

Each authenticated page load checks the function. A 15-minute shared cache and
30-second lease collapse concurrent refreshes. Refresh has a ten-second timeout;
rate-limit errors respect Retry-After with bounded backoff. Failures retain the
last good result with a cached timestamp; absent data shows unavailable with the
source link. The browser never fetches Arena directly. Without an authorized
feed, the requested automatic top ten is **not operational**.

## 5. Import and reconcile privately

Source preparation defaults to the sibling Daily_ng-main folder; output defaults
to sibling private-migration. No source text is bundled into the site.

```powershell
npm run prepare-import
npm run verify:local
```

Review private-migration/RECONCILIATION.md and package.json. The frozen policy
retains written cross-year dates and explicitly flags malformed dates. Correct
these only with a recorded decision. Duplicate dates are separate UUIDs.

Sign into the configured app with email and password, then Settings > Export
temporary session.
Move that private token file to a protected location outside git. In the local
PowerShell session, set these variables without printing their values:

```powershell
$env:SUPABASE_URL = 'https://baiojghilzxhkebfblzv.supabase.co'
$env:SUPABASE_PUBLISHABLE_KEY = 'PUBLIC_KEY_FROM_SRC_BACKEND'
$env:JOURNAL_ACCESS_TOKEN = (Get-Content -Raw -LiteralPath 'PRIVATE_TOKEN_FILE_PATH').Trim()
npm run import
npm run verify-import
Remove-Item Env:JOURNAL_ACCESS_TOKEN
```

Do not use a service-role key for the importer. It verifies the owner's live
session and allowlist gate. It uploads original assets, stages deterministic
records, checks all fields/IDs/counts and downloaded asset SHA-256 values, then
activates the batch. Retrying the same frozen package skips existing primary
keys and cannot silently overwrite edits. A mismatch fails activation. If a
token expires, sign in/export a new token and retry the same package.

At migration freeze, rerun the import twice before editing and verify no duplicate
records. DATABASE_VERIFICATION.json must show PASS for every year. The separate
LOCAL_VERIFICATION.json is explicitly not that live acceptance result. Verify
the original-file/source-group totals as well as year totals and preserve the
private report with the source package. Verify year introductions, documents and
assets independently. Local review-state.json is a sandbox, not the upload input.

## 6. Live security and preservation acceptance

Run with a functioning API, not while responses are 503. Save results privately:

1. Signed-out REST, Storage and report/journal RPC calls cannot read or modify
   journal data. Sign-out removes content from the interface.
2. An unrelated authenticated account cannot access
   entries, documents, history, imports, reports or private objects.
3. The allowlisted owner with an email/password session can read/create/edit each year; date moves,
   duplicates, unresolved dates, stale edits, trash/restore and downloads work.
4. Direct owner-transfer attempts, non-owner inserts, null/stale report revision
   calls and direct *_internal RPC execution are denied.
5. Password reset, expired session and account-switch behavior pass.
6. Existing report/claim/prompt/legacy/version counts match the pre-migration
   backup baseline. Open existing reports; edit a reflection/follow-up and confirm
   it survives reload. New reports and source-verified claims work for a configured
   provider/model. Never send real entries during vendor tests without consent.
7. The leaderboard handles fresh cache, concurrent loads, timeout, 429, malformed
   payloads and stale fallback. Test against an authorized feed/test adapter.

## 7. Build and push yourself

```powershell
npm ci
npm run check
npm run check:release
git status --short
git diff --stat
```

Review the exact diff and tracked/untracked files before staging. Keep index.html,
style.css and built assets/app.js together. Existing Pages main/root hosting is
retained. Hash routes support reload beneath /daily/ without server rewrites.
The Actions workflow checks code and bundle consistency; it does not ingest data,
deploy database changes or hold journal/provider secrets. A branch-based Pages
deployment may publish before a failing code-check job finishes: run local checks
first or use a protected review branch until cutover is authorized.

After your push, test https://kalistamp.github.io/daily/ signed out and signed in
on desktop/mobile, including a deep link such as #/2024/entries. Check the deployed
artifact for content leaks and other same-origin service workers. Only after all
gates pass should Supabase become the sole ongoing primary journal store.

## Rollback and retention

Keep the old source and encrypted backups. To hide an incomplete import, an
administrator may mark its journal_imports row staging; do not delete it. Export
post-import edits, documents, revisions and objects before any rollback. Restoring
only the old UI will not undo guarded RPC changes; prefer a forward fix. Any
database restore requires its reviewed backup/restore procedure and preservation
of unrelated shared-project data. Never drop existing reports or rewrite history
as an implicit rollback.

Stop primary edits to the old Markdown files only after verification. The separate
source repo's countdown/market Actions can then be disabled manually. A private
repo or history cleanup can limit exposure but cannot recall prior public copies.
