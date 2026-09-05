# PROGRESS

## Current Goal
Make the two left-hand sidebar cards ("Generate report" and "History") collapsible so both
are reachable on a desktop viewport instead of History running off the bottom of the column.

## Status
- [x] Header of each sidebar card is a toggle button (`.card-toggle`, `aria-expanded`,
      `aria-controls`), nested inside the existing `<h2 class="card-title">`
- [x] Card contents wrapped in `.card-body` (`#generate-body`, `#history-body`);
      `.card.is-collapsed > .card-body` hides it
- [x] Chevron (`#i-chevron`) rotates 90deg → 0deg on collapse; no rotation under
      `prefers-reduced-motion`
- [x] State persisted per panel in `localStorage['msi.panels']` as JSON; both default open;
      malformed JSON falls back to open
- [x] Sidebar is a bounded flex column on desktop (`max-height: 100vh - topbar - 44px`,
      `overflow-y: auto`). Generate is `flex: none`; History takes the slack
      (`flex: 1 1 auto`, `min-height: 140px`) and scrolls its list internally.
      The old fixed `.history-card { max-height: 52vh }` is gone.
- [x] Drawer mode (<=900px) unchanged in feel: `.sidebar { max-height: none }`,
      `.history-card { flex: none }`, list scrolls with the column, panels still collapse
- [x] `showProgress(true, …)` force-expands the Generate panel — the progress row lives
      inside it and would otherwise be swallowed while a run is in flight
- [x] `setPanel`/`togglePanel` bail out when the card or button is missing (boot guard)
- [x] Cache stamps bumped: `style.css?v=8`, `script.js?v=8` (this project has no BUILD
      constant / `data-build` / `--build`; the `?v=` query is its only stamp)

## Notes / Decisions
- Button inside heading, not heading inside button: `<h2>` is flow content and is invalid
  inside `<button>`. This is also the WAI accordion header shape.
- The sidebar's own `overflow-y: auto` is a backstop only. It engages when the viewport is
  too short to hold the expanded Generate form plus History's 140px floor (verified at 620px
  tall) so nothing is ever clipped.
- No new tables, endpoints, keys, or network calls. No change to auth, RLS, or the Supabase
  read path. No auto-refresh. The CSP inline-script hash is untouched (no inline script edits).

## Last Verified
Headless Chromium (playwright build 1148) against `python3 -m http.server`, app div revealed
and the auth screen hidden so the sidebar renders; History seeded with 14 rows.

- 1280x800, both open: sidebar 695px, bottom 781 < viewport 800; History 233px, list scrolls
  internally. No console/page errors.
- Collapse Generate: History grows 233px -> 531px, six rows visible without scrolling.
- Collapse both: column shrinks to 223px, privacy note at 298. `msi.panels` =
  `{"generate":false,"history":false}`.
- Reload: state restored from localStorage, `aria-expanded="false"` on both.
- Keyboard: History toggle takes focus, Enter re-expands it, focus ring visible in dark mode.
- 1280x620 (short desktop): sidebar scrolls as backstop, both headers on screen, nothing clipped.
- 420x800 drawer: opens, both panels collapse, column scrolls as one. No console errors.
- `node --check script.js` passes.
