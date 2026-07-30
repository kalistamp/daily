# Monthly Self-Interrogation Agent

A privacy-first, **pure client-side** web app that turns a month of your private
daily journal into a probing self-interrogation report. No backend, no build
step — just static HTML/CSS/JS.

## What's public vs. private

| Thing | Visibility |
|---|---|
| These `docs/` static files | **Public** (served via GitHub Pages) |
| The parent repo (your journal markdown) | **Private** — stays private |
| The Gist that stores your reports | **Private** — stays private |
| Your GitHub token / Gist ID / Gemini key | **Only in your browser's localStorage** — never committed anywhere |

Because the repo and Gist are both private, nobody can read your data without
**your** GitHub token + Gist ID entered on **your** device.

## Enable GitHub Pages (you do this once, manually)

1. Repo **Settings → Pages**.
2. Source: **Deploy from a branch** → Branch **`main`** → Folder **`/docs`** → Save.
3. Open the published URL (e.g. `https://<user>.github.io/Daily_ng/`).

## First-time setup (in the app)

Open **Settings (⚙)** and fill in:

- **GitHub token** — a fine-grained PAT with:
  - **Contents: Read** on this repo (to fetch the journal), and **Read/Write**
    if you want the optional "Commit to repo" button to work.
  - **Gists: Read and write** (to store reports in the private Gist).
- **Gist ID** — pre-filled with `ead6fb9238714dfc51d0b3fea495e899`.
- **Gemini API key** — free from <https://aistudio.google.com/apikey>.
- **Gemini model** — hit **Refresh** to pull the live list, or keep the default
  `gemini-2.5-flash`.

Under **Source (advanced)** the repo (`kalistamp/Daily_ng`), notes path
(`2026/2026daily_pt1.md`), and branch (`main`) are pre-filled — change the notes
path each year as your journal file changes.

Hit **Test connections** to verify all four before generating.

## How it works

1. **Generate Monthly Report** fetches only the previous calendar month's entries
   (plus a 7–14 day look-back) from the private journal via the GitHub API.
   Entries are delimited by `### YYYY-MM-DD` headers.
2. A light **local** pass detects dominant themes and open loops.
3. A precise system prompt + the month's slice is sent to your selected Gemini
   model, which returns one Markdown report:
   - executive overview
   - theme-weighted question bank (8–12)
   - contradiction / open-loop detector (4–6)
   - adversarial self-audit (4–6)
   - future-self letter (4–6)
   - cross-domain synthesis (4–6)
4. The report + timestamp + model + theme summary is saved to the private Gist.
5. Optionally **Commit to repo** writes it to `monthly-reports/YYYY-MM.md`.
6. Answer the questions in the **reflection** box — auto-saved to the Gist.

## The daily journal is strictly read-only

The app **only ever reads** `2026/2026daily_pt1.md` (via `GET`). It is never
written, modified, or deleted. Enforced in `script.js`:

- Repo writes go through **one** function, `githubPutRepoFile()`, which calls
  `assertRepoWritable()` **before any network request**.
- That guard allows writes to exactly one path shape — `monthly-reports/YYYY-MM.md`
  — and refuses everything else, including the journal. It resolves `.`/`..`
  first, so path traversal can't reach the journal, and it also denylists the
  journal path explicitly.
- The only repo-write feature is the optional **Commit to repo** button
  (reports → `monthly-reports/`). There is no code path that writes the journal.

**Strongest guarantee (recommended):** if you don't need the *Commit to repo*
button, issue your token with **Contents: Read-only** (+ Gists: Read/Write).
Then GitHub itself rejects any write to *any* repo file — the journal can't be
touched even by a bug or a compromised page. If you *do* want that button,
Contents: Read/Write is required (fine-grained PATs can't scope to a subpath),
and the in-app guard above is what protects the journal.

## Optional device lock

Settings → **Device lock** sets a passphrase gate for this browser. It is a
convenience gate only (SHA-256 compare in the browser) — **not** encryption, since
the secrets already live in localStorage. It just stops casual over-the-shoulder
access.

## Notes

- Everything is stored in your browser + your private Gist. Clearing browser data
  removes your keys (the reports remain safe in the Gist).
- No external libraries or CDNs — fully self-contained and offline-capable for
  viewing cached reports.
