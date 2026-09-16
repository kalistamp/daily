# Monthly Self-Interrogation

Private, authenticated journal at https://kalistamp.github.io/daily/.
Daily writing and self-interrogation share one authenticated workspace. The
reflection view retains the original five-section monthly report, saved answers,
regeneration with answers, and the editable advice directive. Open reflections
can be saved without a report; an optional consent-gated conversation can examine
them with or without journal context. Journal editing is an equal primary mode.
The repository contains code only. Journal text, original files, import packages,
database exports, credentials and screenshots must remain outside git.

## Release status

The local implementation is built and tested. **Pushing this repository does not
apply the database migration, import journals, configure secrets, or deploy Edge
Functions. Complete [DEPLOYMENT.md](DEPLOYMENT.md) before production cutover.**
The Arena integration has no invented data or unauthorized scraper: automatic
rankings require an authorized JSON feed. Without one it displays unavailable.

## Local use

Requires Node.js 22 or newer and npm. From this directory:

```powershell
npm ci
npm run build
npm run dev
```

Open the loopback URL printed by the server. This shows the production login
flow; it requires a configured Supabase backend. Opening index.html as a file
does not work because browsers restrict module loading on file URLs.

For private offline review, prepare the supplied source and start review mode:

```powershell
npm run prepare-import
npm run review
```

Use the **complete launch link including its random token** printed by the server.
The token establishes an HttpOnly, SameSite=Strict review cookie and is removed
from the address bar. Only 127.0.0.1 is bound; do not expose this server through a
tunnel or port forward. Review edits persist in the sibling private-migration
folder, not the public project. They do not change the original source package
or Supabase. Export review edits before discarding this local sandbox.

Production has no offline/demo login bypass. Local review APIs do not exist on
GitHub Pages. The preview disables cloud AI and the agent feed. Existing cloud
reports are preserved in Supabase but are not copied into local review.

## Checks

```powershell
npm run check
npm run check:release
npm run verify:local
npm run test:browser
```

verify:local uses the real private package with an in-memory test transport; it
does **not** prove live database import. test:browser needs installed Chrome and
saves screenshots outside git. Unit/Postgres tests use synthetic records only.
The Actions workflow runs code checks without journal content or database keys.

## Layout

| Path | Responsibility |
| --- | --- |
| src/app.js | Email/password login, journal editor, documents, archive, reports |
| src/interrogation.js | Main reflection workspace, report history, open reflections and regeneration |
| supabase/functions/_shared/reflection.mjs | Original report structure and accumulated answer context |
| src/backend.js | Authenticated Supabase reads and revision-checked writes |
| src/markdown.js | Sanitized Markdown, blocked remote images, private file links |
| src/domain.js | Calendar dates, sorting, validation, relative source references |
| assets/app.js | Built, committed static bundle for main/root Pages hosting |
| tools/import.mjs | Private source preparation, staged upload and full verification |
| tools/serve.mjs | Loopback-only preview with guarded optional private review |
| supabase/migrations | Non-data-bearing schema/RLS migration |
| supabase/functions | Authenticated AI proxy and cached leaderboard proxy |
| tests | Synthetic domain, parser, provider and Postgres/RLS checks |

## Security boundaries

Journal access requires an administrator-allowlisted authenticated user and
ownership. RLS is enforced in Postgres; Storage is private and owner prefixed.
This deployment intentionally uses email/password authentication without a
required MFA factor. The public Supabase URL/publishable key are intentionally
public.
Service credentials and provider keys belong only in Supabase function secrets.

Journal data remains in memory. User sessions use tab-scoped sessionStorage,
not persistent journal caches. Sign-out/account change clears the interface.
Legacy browser caches have explicit private export and cleanup controls.
Private downloads are unencrypted files: protect their filesystem location.

Supabase administrators remain trusted; this is not end-to-end encryption.
All kalistamp.github.io projects share an origin. A malicious sibling site or
service worker could undermine session isolation; review other hosted projects.
A separate custom origin would be stronger but changes the requested URL.

Anything ever committed publicly remains potentially exposed in git history,
forks, clones, caches and artifacts. A login screen or new storage does not erase
that exposure. Keep content repos private; rotate exposed secrets immediately.
History scrubbing or replacing public history is a separate destructive operation,
not performed here. See GitHub's [sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

## Operations

Use [DEPLOYMENT.md](DEPLOYMENT.md) for setup, verification and rollback. Keep
restorable encrypted private backups of Postgres and Storage. Original widget
Actions in the separate source repository are unrelated to journal ingestion;
retire them only after cutover. They are not modified by this local project.
