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
| Your GitHub token / Gist ID / provider API keys | **Only in your browser's localStorage** — never committed anywhere |

Because the repo and Gist are both private, nobody can read your data without
**your** GitHub token + Gist ID entered on **your** device.

## Enable GitHub Pages (you do this once, manually)

1. Repo **Settings → Pages**.
2. Source: **Deploy from a branch** → Branch **`main`** → Folder **`/docs`** → Save.
3. Open the published URL (e.g. `https://<user>.github.io/Daily_ng/`).

## First-time setup (in the app)

Open **Settings (⚙)** and fill in:

- **GitHub token** — a fine-grained PAT with:
  - **Contents: Read-only** on this repo (to fetch the journal). The app never
    writes to the repo, so no write access is needed or wanted.
  - **Gists: Read and write** (to store reports in the private Gist).
- **Gist ID** — pre-filled with `ead6fb9238714dfc51d0b3fea495e899`.
- **Provider** — choose which model writes the report: **OpenAI** (the default),
  **Anthropic (Claude)**, or **Gemini**.
- **API key** — enter a separate key for each provider you want to use:
  - **OpenAI** — <https://platform.openai.com/api-keys>
  - **Anthropic** — <https://console.anthropic.com/settings/keys>
  - **Gemini** — free from <https://aistudio.google.com/apikey>
  Only the selected provider's key is used to generate a report; keys stay in
  this browser and are never committed.
- **Model** — the dropdown lists models for the selected provider (default
  `gpt-4o` for OpenAI). Hit **Refresh** to pull the live list with that
  provider's key. Gemini additionally auto-falls back to an available model if
  the chosen one is unavailable.

Under **Source (advanced)** the repo (`kalistamp/Daily_ng`), notes path
(`2026/2026daily_pt1.md`), and branch (`main`) are pre-filled — change the notes
path each year as your journal file changes.

Hit **Test connections** to verify all four before generating.

## How it works

1. **Generate Monthly Report** fetches only the previous calendar month's entries
   (plus a 7–14 day look-back) from the private journal via the GitHub API.
   Entries are delimited by `### YYYY-MM-DD` headers.
2. A light **local** pass detects dominant themes and open loops.
3. A precise system prompt + the month's slice is sent to your selected
   provider's model (OpenAI, Anthropic, or Gemini), which returns one Markdown
   report:
   - executive overview
   - theme-weighted question bank (8–12)
   - contradiction / open-loop detector (4–6)
   - adversarial self-audit (4–6)
   - future-self letter (4–6)
   - cross-domain synthesis (4–6)
4. The report + timestamp + provider/model + theme summary + the exact date
   range read (first → last entry) is saved to the private Gist. Each report
   shows the target month alongside that start/end span.
5. Answer the questions in the **reflection** box — auto-saved to the Gist.

## The repo is strictly read-only

The app **never writes to the repository.** It only reads `2026/2026daily_pt1.md`
via `GET`; that file is never written, modified, or deleted. Guaranteed two ways:

- **No write code exists.** The former "Commit to repo" feature was removed, so
  there is no `PUT`/`PATCH`/`DELETE` against any repo path anywhere in
  `script.js`. The only GitHub write the app makes is a `PATCH` to the private
  **Gist** (`gistPushNow`). You can confirm with a one-line audit:
  `grep -nE "method: *'(PUT|PATCH|DELETE)'" script.js` → the only match is the
  Gist `PATCH`.
- **The token can't write anyway.** Use a fine-grained PAT scoped to
  **Contents: Read-only** (+ **Gists: Read and write**). GitHub itself then
  rejects any repo write — the journal can't be touched even by a bug or a
  compromised page. This is the recommended setup and needs no repo write access.

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
