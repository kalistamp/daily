# Monthly Self-Interrogation

A static reflection app that reads a private Markdown journal, generates monthly
reports with the selected model provider, and synchronizes reports through the
isolated `daily` schema in a shared Supabase project.

## Privacy model

- Supabase Auth and Row Level Security protect reports, claims, reflections,
  follow-up answers, prompts, and deletion tombstones.
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

`/home/ks/Documents/projects/daily_migration/`
