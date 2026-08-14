# Monthly Self-Interrogation Agent

A privacy-first, **pure client-side** web app that turns a month of your private
daily journal into a probing self-interrogation report. No backend, no build
step — just static HTML/CSS/JS.

## What's public vs. private

| Thing | Visibility |
|---|---|
| These `docs/` static files | **Public** (served via GitHub Pages) |
| The journal repo (your markdown) | **Private** — stays private |
| The data repo (your reports, as JSON) | **Private** — stays private |
| Both tokens / provider API keys | **Only in your browser's localStorage** — never committed anywhere |

Because both repos are private, nobody can read your data without **your** own
tokens entered on **your** device. GitHub enforces this: an unauthenticated
request gets `404`, not `403` — it won't even confirm the repos exist.

> **Why not a Gist?** Reports used to live in a "secret" Gist. Secret means
> *unlisted*, not *access-controlled*: the gist ID is a bearer credential, and
> anyone holding it can read everything, forever, with no token. Because the ID
> was hardcoded in this public repo, it was effectively published. A private
> repo is real access control, so that's where the data lives now.

## Enable GitHub Pages (you do this once, manually)

1. Repo **Settings → Pages**.
2. Source: **Deploy from a branch** → Branch **`main`** → Folder **`/docs`** → Save.
3. Open the published URL (e.g. `https://<user>.github.io/Daily_ng/`).

## First-time setup (in the app)

Open **Settings (⚙)** and fill in:

- **Journal token** — a fine-grained PAT scoped to the **journal repo only**,
  with **Contents: Read-only**. The app never writes your journal, so write
  access is neither needed nor wanted — with a read-only token, GitHub itself
  rejects any write, whatever the code does.
- **Data token** — a *separate* fine-grained PAT scoped to the **data repo
  only**, with **Contents: Read and write**. Read as well as write: syncing has
  to read the current file to merge against it.

  > **Why two tokens?** A fine-grained PAT applies one permission set to every
  > repo it covers. A single token cannot be read-only on the journal and
  > writable on the data repo — it would have to be writable on both, which
  > throws away the guarantee that nothing here can touch your journal.
- **Provider** — choose which service writes the report: **OpenAI** (the
  default), **Anthropic (Claude)**, or **Gemini**. Only **one API-key field is
  shown at a time** — the one for the selected provider. Each provider keeps its
  own key, so switching never loses the others.
- **API key** — enter a key for the selected provider:
  - **OpenAI** — <https://platform.openai.com/api-keys>
  - **Anthropic** — <https://console.anthropic.com/settings/keys>
  - **Gemini** — free from <https://aistudio.google.com/apikey>
  Only the selected provider's key is used to generate a report; keys stay in
  this browser and are **never** committed or synced to the data repo.
- **Model** — defaults to **Auto**, which uses the newest chat model your key
  can access, resolved live each time you run a report (so it never goes stale).
  Hit **Refresh** to load the live list and pin a specific model, or pick
  **Custom…** to type an exact model id. The list is discovered from the
  provider — with no key entered you'll only see **Auto** and **Custom**.

Under **Journal source (advanced)** the repo (`kalistamp/Daily_ng`), notes path
(`2026/2026daily_pt1.md`), and branch (`main`) are pre-filled — change the notes
path each year as your journal file changes.

Under **Data store (advanced)** the data repo (`kalistamp/daily-data`), file
path (`monthly-reports.json`), and branch (`main`) are pre-filled. The file is
created automatically on first sync if it doesn't exist yet.

Hit **Test connections** to verify both tokens, the notes file, the data repo,
and the selected provider's key before generating.

## How it works

1. **Generate Monthly Report** fetches only the previous calendar month's entries
   (plus a 7–14 day look-back) from the private journal via the GitHub API.
   Entries are delimited by `### YYYY-MM-DD` headers.
2. A light **local** pass detects dominant themes and open loops.
3. A precise system prompt + the month's slice is sent to your selected
   provider's model (OpenAI, Anthropic, or Gemini), which returns one Markdown
   report — five sections, each under a hard word cap, ~1000 words total:
   - the month in five bullets (≤110) — the skim layer, closing on a verdict line
   - the five questions that matter (≤90) — exactly five, one per angle
   - self-improvement operating plan (≤240) — 3 priorities × why now / 7-day
     move / measurement / what this costs, closing on `stop doing`
   - **life advice** (≤470) — the substantial section: the pattern you cannot
     see, the decision being avoided, leverage, the honest risk, what is
     actually working
   - write this down next month (≤60)
4. A **second pass** turns the report into 6–10 structured **follow-up
   questions**, each with a theme and a one-line reason it is worth answering.
   The report deliberately asks only five questions of its own: interrogation
   lives in the follow-ups, where answers are trackable and feed forward.
5. The **claim ledger** extraction runs automatically off the same journal read.
6. Everything is saved to the private data repo. Each report shows the target
   month alongside the exact start/end span that was read.
7. Answer the follow-ups inline, and anything else in the **reflection** box.

## Follow-up questions

Each report comes with its own set of questions in an answer box under the
report. Answer as many as you like, a sentence or two each; they auto-save.

**This is the memory loop.** Every answered question is fed into every later
run as an established fact, paired with the question that produced it, under a
hard instruction not to ask anything it already covers. That is what stops the
model re-asking things you have already explained. Answers are carried by
character budget rather than a fixed number of reports, so the newest ones
always make it in and old ones age out only when the budget runs out.

**Ask follow-ups** generates another set for the current report. Existing
questions — answered or not — are excluded, so a second press produces new
ground instead of a reshuffle.

**Regenerate with answers** rewrites the current month's report with your
answers to it now counted as established fact, updating it in place rather than
stacking a second report for the same month. Answers are kept and new questions
are appended below them, so nothing you have written is lost — and everything
you have answered keeps feeding future reports either way.

## Reading a report

Each `##` section is collapsible. The summary and **life advice** open by
default; the rest fold, showing their word and question counts so skipping one
is a choice rather than a guess. Nothing is truncated — the full text is always
one click away, which is what lets the report stay substantial without costing
a twelve-minute read.

## Curating the advice

Settings → **Advice directive** is a prompt you own. It is injected verbatim
into the report prompt and governs the **self-improvement operating plan** and
**life advice** sections: the stance advice is written from, what to push on,
what to never say. Edit it, and the next report follows it.

It ships with a default; **Reset to default** restores it. The directive syncs
with your reports, so both devices produce the same shape of advice. It is
deliberately the only editable prompt — the report's section list and the JSON
contracts elsewhere are parsed by code, so editing those would break parsing
rather than change the writing.

## Claim ledger

The ledger tracks **forecasts** ("this breaks by Q3") and **commitments** ("going
to ship the adapter") pulled out of the journal, then scores them against later
entries. Every claim and every resolution has to carry a quote that actually
occurs in the entry it names, so a model cannot confabulate one.

It now runs **automatically after every report**, off the journal that was
already fetched. Previously it only ran from the **Extract from journal** button
inside the ledger modal, which is why it could sit empty through months of
reports — nothing populated it unless you found that button.

Two things worth knowing:

- **Model strength matters a lot here.** On the same journal, a strong model
  returned 22 valid claims and a small one returned zero. If the ledger comes
  back empty, that is the first thing to check.
- **An empty result is not always a failure.** The ledger deliberately skips
  pure logging — a day's worth of archived links contains no falsifiable claims.
  The status message now distinguishes "found nothing to track" from "found
  nothing new" from "rejected N for unmatched quotes".

## The journal is strictly read-only

The app **never writes your journal.** It only reads `2026/2026daily_pt1.md`
via `GET`; that file is never written, modified, or deleted. Guaranteed two ways:

- **The only write targets the data repo.** There is exactly one write in
  `script.js` — the `PUT` in `dataPushNow`, against the data repo. Audit it:
  `grep -nE "method: *'(PUT|PATCH|DELETE)'" script.js` → one match, and the URL
  it uses is built from `dataRepo`, never from `repo`.
- **The journal token can't write anyway.** It is scoped **Contents:
  Read-only**, so GitHub rejects any write to the journal — even from a bug or a
  compromised page. The write-capable data token has no access to the journal
  repo at all. The two are never interchanged; that is why there are two.

## Optional device lock

Settings → **Device lock** sets a passphrase gate for this browser. It is a
convenience gate only (SHA-256 compare in the browser) — **not** encryption, since
the secrets already live in localStorage. It just stops casual over-the-shoulder
access.

## Using more than one device

Phone and laptop can both generate reports. Sync **merges**; it does not
overwrite. Every push pulls the data file first and writes the union of both
sides, so a device opening with a stale cache can no longer wipe out reports
another device made in the meantime. Per report, the most recently edited copy
wins (that's what keeps reflections from going backwards), and deleting a report
records a tombstone so it stays deleted instead of returning from the other
device's cache.

Writes are also **conditional**: each one quotes the file's current `sha`. If
another device wrote in between, GitHub rejects it with `409` and the app
re-pulls, re-merges and retries — so a genuine race costs a round trip instead
of somebody's reports.

If a device is offline when you generate a report, it remembers it still owes
the data repo a write and pushes on the next open.

## Notes

- Everything is stored in your browser + your private data repo. Clearing
  browser data removes your keys (the reports remain safe in the data repo, and
  its git history keeps every previous version).
- No external libraries or CDNs — fully self-contained and offline-capable for
  viewing cached reports.
