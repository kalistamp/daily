# Monthly Self-Interrogation

A static reflection app that reads a private Markdown journal, generates monthly
reports with the selected model provider, and synchronizes reports through the
isolated `daily` schema in a shared Supabase project.

## Privacy model

- Supabase Auth and Row Level Security protect reports, claims, reflections,
  follow-up answers, prompts, and deletion tombstones.
- Reports, claims, prompts, and tombstones are stored as separate rows. Saves
  send only changed entities, and Realtime publishes only a revision signal.
- The browser cache uses per-user IndexedDB rows; typing in a reflection or
  follow-up no longer serializes the complete report and claim history.
- The GitHub journal token remains device-local and read-only.
- OpenAI, Anthropic, and Gemini keys remain device-local.
- The Supabase URL and publishable key are public browser configuration, as
  intended. The service-role key is never used by the website.
- The journal has no write path in this application.

## Deployment

This repository is already a static GitHub Pages application. Keep the existing
**Deploy from a branch** Pages source; no second Pages workflow is required.
Because the public Supabase configuration is committed in `script.js`, either
Pages deployment mode serves a configured application and cannot publish
placeholder values.

## Local check

```bash
node --check script.js
git diff --check
```

Schema SQL, the private import, verification/cleanup SQL, and the migration
guide live outside this repository in:

`/home/ks/Documents/projects_audit/prelaunch_deployment/daily/`

Run `01_daily_delta_sync.sql` and then `02_verify_daily_security.sql` manually
in the Supabase SQL Editor before pushing this website. Do not use a Supabase
config push or a shared migration push for this project-specific package.
