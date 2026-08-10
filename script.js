/* ============================================================================
   Monthly Self-Interrogation Agent — application logic (vanilla JS, no deps)
   ----------------------------------------------------------------------------
   PRIVACY MODEL (confirmed):
     • Pure client-side. No backend server. Runs entirely in the browser.
     • The parent repository holding the private daily-journal markdown stays
       100% PRIVATE. Only the static files in this `docs/` folder are public.
     • All persistent data (reports + metadata) lives as JSON in a SEPARATE
       PRIVATE REPO. GitHub enforces that: an unauthenticated read returns 404,
       not 403 — it will not even confirm the repo exists. This replaced a
       secret Gist, which had NO access control at all: a gist ID is a bearer
       credential, and this one had been published in the public site repo, so
       anyone could read every report with one unauthenticated request.
     • TWO tokens, deliberately. The journal token is Contents:READ-ONLY on the
       journal repo, so no code path here — bug, typo, or otherwise — can write
       2026daily_pt1.md; GitHub itself rejects it. The data token is
       Contents:read+write on the data repo ONLY. A fine-grained PAT applies one
       permission set to every repo it selects, so a single token cannot express
       "read here, write there". Hence two. Do not merge them.
     • Secrets (both tokens, per-provider API keys, selected provider + model)
       are kept EXCLUSIVELY in this browser's localStorage. They are
       NEVER written into any file in this public `docs/` folder — only sent
       directly over HTTPS to api.github.com and, for the selected provider,
       one of api.openai.com / api.anthropic.com / generativelanguage.googleapis.com.
   ========================================================================== */

'use strict';

/* -------------------------------------------------------------- constants */
// One localStorage key per provider per field, so switching the active provider
// never loses the other providers' keys. API keys are DEVICE-LOCAL ONLY and are
// never written into state.data / the data repo (see dataPushNow).
const LS = {
  githubToken:    'msi.githubToken',   // journal repo, READ-ONLY
  dataToken:      'msi.dataToken',     // data repo, read + write
  dataRepo:       'msi.dataRepo',
  dataPath:       'msi.dataPath',
  dataBranch:     'msi.dataBranch',
  activeProvider: 'msi.activeProvider',
  openaiKey:      'msi.openaiKey',
  openaiModel:    'msi.openaiModel',
  anthropicKey:   'msi.anthropicKey',
  anthropicModel: 'msi.anthropicModel',
  geminiKey:      'msi.geminiKey',
  geminiModel:    'msi.geminiModel',
  repo:           'msi.repo',
  notesPath:      'msi.notesPath',
  branch:         'msi.branch',
  theme:          'msi.theme',
  passHash:       'msi.passHash',
  // key string kept as-is: renaming it would orphan every device's cache
  cache:          'msi.gistCache',
  lastId:         'msi.lastId',
  dirty:          'msi.dirty',
};
// Repo NAMES are safe to hardcode — they are useless without a token, and both
// repos 404 for anyone who lacks one. The old gistId default is deliberately
// gone: it was a bearer credential sitting in a public repo.
// NOTE on the *Model defaults: blank means "Auto" — resolved against the live
// discovery list at request time, never frozen into storage. Writing a
// hardcoded "latest model" here would go stale the moment a vendor ships
// something new, and would silently pin the user forever.
const DEFAULTS = {
  githubToken:    '',
  dataToken:      '',
  dataRepo:       'kalistamp/daily-data',
  dataPath:       'monthly-reports.json',
  dataBranch:     'main',
  activeProvider: 'openai',   // default summarization provider (was gemini)
  openaiKey:      '',
  openaiModel:    '',         // blank = Auto
  anthropicKey:   '',
  anthropicModel: '',         // blank = Auto
  geminiKey:      '',
  geminiModel:    '',         // blank = Auto
  repo:           'kalistamp/Daily_ng',
  notesPath:      '2026/2026daily_pt1.md',
  branch:         'main',
};

/* ------------------------------------------------- model filter + ranking */
// DENY-list, not an allow-list: an allow-list keyed to today's naming
// conventions (/^gpt-|^o\d/) silently hides any model released under an
// unfamiliar name, which defeats the point of live discovery. Tokens are
// matched as whole segments — a bare substring test would hide "adaptive"
// because of "ada", or "editorial" because of "edit".
const NON_CHAT_TOKENS = [
  'embed', 'embedding', 'embeddings', 'gecko',
  'tts', 'stt', 'whisper', 'audio', 'speech', 'voice', 'transcribe', 'translate',
  'image', 'images', 'vision', 'dall', 'dalle', 'imagen', 'veo',
  'moderation', 'moderations', 'guard', 'safety',
  'realtime', 'search', 'rerank', 'similarity',
  'edit', 'edits', 'instruct', 'codex',
  'ada', 'babbage', 'curie', 'davinci',
  'aqa', 'gemma', 'learnlm',
];
const NON_CHAT_RE = new RegExp(`(^|[-_./])(${NON_CHAT_TOKENS.join('|')})([-_./]|$)`, 'i');
const isChatModel = (id) => !!id && !NON_CHAT_RE.test(id);

// Discovery results are cached per API KEY (not per session) so reopening
// Settings doesn't re-hit the network; the Refresh button forces a re-fetch.
const DISCOVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Non-reversible fingerprint, used only to scope the cache entry to one key.
function keyFingerprint(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (((h << 5) + h) + key.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const discoveryCacheKey = (provider, key) => `msi.models.${provider}.${keyFingerprint(key)}`;

/* -------------------------------------------------------- error helper */
function apiError(message, status, detail) {
  const e = new Error(detail ? `${message} ${detail}` : message);
  e.status = status;
  e.detail = detail || '';
  return e;
}

// Light local theme buckets. Substring counting — intentionally rough; the
// selected Gemini model does the real analysis. Keeps everything client-side.
const THEMES = [
  { key: 'ai',      label: 'AI/agents',           kw: ['ai/', 'agent', 'agentic', 'gemini', ' llm', 'gpt', 'model', 'prompt', 'rag', 'automation', 'dispatch', 'openai', 'anthropic', 'claude', 'neural', 'inference'] },
  { key: 'cyber',   label: 'OSINT/cyber',         kw: ['osint', 'cyber', 'malware', 'rat', 'c2', 'exploit', 'payload', 'recon', 'hashcat', 'pentest', 'security', 'crypter', 'bypass', 'stealer', 'phishing', 'vuln', 'cve', 'obfuscat', 'shellcode'] },
  { key: 'health',  label: 'health/bio',          kw: ['health', 'gym', 'fitness', 'meal', 'sleep', 'vitamin', 'zyn', 'caffeine', 'alcohol', 'sugar', 'marathon', 'cardio', 'weight', 'testosterone', 'stim', 'protein', 'diet', 'fasting'] },
  { key: 'career',  label: 'career/HVAC/income',  kw: ['hvac', 'job', 'income', 'ftid', 'money', 'paycheck', 'card', 'debt', 'epa', 'cert', 'interview', 'resume', 'client', 'salary', 'invoice', 'rebate', 'refund', 'apprentice'] },
  { key: 'privacy', label: 'privacy/tools',       kw: ['privacy', 'vpn', 'tor ', 'encrypt', 'localstorage', 'token', 'gist', 'self-host', 'anonym', 'opsec', 'burner', 'proxy'] },
  { key: 'life',    label: 'life-admin',          kw: ['appointment', 'dentist', 'jury', 'bill', 'rent', 'lease', 'move', 'house', 'book', 'chore', 'task', 'schedule', 'porter', 'walk', 'apartment'] },
];

/* --------------------------------------------------------------- app state */
const state = {
  cfg: {},
  data: emptyData(),
  currentId: null,
  pushTimer: null,
  reflectionTimer: null,
  followupTimer: null,
  pushInFlight: null,
  models: null,
  dirty: false,   // local edits not yet in the data repo
  rev: 0,         // bumped on every local edit; guards the dirty-flag clear
  dataSha: null,  // blob sha of the last data file we read; required to update it
};

function emptyData() {
  return { app: 'monthly-self-interrogation', version: 1, updatedAt: null, reports: [], claims: [], deleted: [], prompts: {} };
}
// Stores written before a collection existed come back without it. Normalize on
// every load path so nothing downstream has to null-check the arrays.
function normalizeData(d) {
  const out = d && typeof d === 'object' ? d : emptyData();
  if (!Array.isArray(out.reports)) out.reports = [];
  if (!Array.isArray(out.claims)) out.claims = [];
  if (!Array.isArray(out.deleted)) out.deleted = [];
  if (!out.prompts || typeof out.prompts !== 'object') out.prompts = {};
  // Reports predating the follow-up feature have no questions array.
  for (const r of out.reports) if (!Array.isArray(r.followups)) r.followups = [];
  return out;
}

/* ------------------------------------------------------------ local saves */
// Every local mutation goes through here. The dirty flag is persisted, not just
// held in memory: a device that generates a report and is closed before the
// push lands must still know, on next open, that it owes the Gist a write.
function saveLocal() {
  state.rev++;
  state.dirty = true;
  localStorage.setItem(LS.dirty, '1');
  localStorage.setItem(LS.cache, JSON.stringify(state.data));
}
function clearDirty(atRev) {
  if (atRev !== undefined && atRev !== state.rev) return;  // edited mid-push
  state.dirty = false;
  localStorage.removeItem(LS.dirty);
}

/* ------------------------------------------------------------------ merge */
/* ---------------------------------------------------------------------------
   WHY THIS EXISTS
   ---------------------------------------------------------------------------
The store is one JSON blob written whole. So a plain "upload my local copy" is
   a last-writer-wins overwrite: a phone writes 5 reports, the laptop opens with
   a day-old cache, pushes it, and those 5 reports are gone. That is exactly what
   happened on the old Gist backend. Every push now merges against a fresh pull
   instead of replacing, and the contents API sha makes the write conditional.

   Merge is a union keyed by id, so neither device can delete the other's work
   by simply not knowing about it. Deletion therefore has to be explicit — an id
   in `deleted` — otherwise a union would resurrect every deleted report from
   whichever device still had it cached.
--------------------------------------------------------------------------- */
const newer = (a, b) => ((a || '') > (b || '') ? a : b);
// Last-touched stamp for a record: whichever side edited it most recently wins.
// Answering a follow-up counts as touching the report, or a phone that only
// answered questions would lose to a laptop that merely opened the thing.
const reportStamp = (r) =>
  [r.reflectionUpdatedAt, r.generatedAt, ...(r.followups || []).map((f) => f.answeredAt)]
    .filter(Boolean).sort().pop() || '';
// Follow-ups: an ANSWERED question always beats an unanswered copy of itself,
// then newer wins. Same shape of problem as claims — both devices hold the same
// question with the same id, and only one of them has the answer in it.
const followupStamp = (f) => `${f.a && f.a.trim() ? 1 : 0}|${f.answeredAt || ''}`;
// Claims compare on judgement state FIRST, then time. Two devices that both
// extracted a claim carry the same extractedAt, so a pure timestamp compare
// ties — and a tie must not throw away the side where the user actually ruled
// on it. Rank is one leading digit, so plain string ordering does both.
const claimRank  = (c) => (isSettled(c) || c.status === 'void' ? 2 : c.status === 'proposed' ? 1 : 0);
const claimStamp = (c) => `${claimRank(c)}|${c.resolvedAt || c.extractedAt || ''}`;

function mergeById(a, b, stampOf, dedupeKey) {
  const byId = new Map();
  for (const rec of [...a, ...b]) {
    if (!rec || !rec.id) continue;
    const prev = byId.get(rec.id);
    if (!prev || stampOf(rec) > stampOf(prev)) byId.set(rec.id, rec);
  }
  if (!dedupeKey) return [...byId.values()];
  // Two devices extracting the same claim independently mint different ids, so
  // an id-keyed union alone would double every claim. Collapse on the natural
  // key too, keeping the one that carries a verdict (or the newer one).
  const byKey = new Map();
  for (const rec of byId.values()) {
    const k = dedupeKey(rec);
    const prev = byKey.get(k);
    if (!prev || stampOf(rec) > stampOf(prev)) byKey.set(k, rec);
  }
  return [...byKey.values()];
}

// Every record id in one dataset — used to tell "the merge added something the
// remote does not have" from "the remote already had it all".
function idSet(d) {
  const n = normalizeData(d);
  return new Set([...n.reports, ...n.claims, ...n.deleted].map((x) => x.id));
}

// Picking one whole report and discarding the other loses answers: two devices
// can answer DIFFERENT follow-ups on the same report, and a wholesale winner
// throws away every answer the loser held. So the report wrapper is chosen by
// recency, but its answer-bearing fields are merged field by field.
function mergeReportPair(a, b) {
  const base = reportStamp(a) >= reportStamp(b) ? a : b;
  const other = base === a ? b : a;
  const out = { ...base };
  if ((other.reflectionUpdatedAt || '') > (base.reflectionUpdatedAt || '')) {
    out.reflection = other.reflection;
    out.reflectionUpdatedAt = other.reflectionUpdatedAt;
  }
  out.followups = mergeById(base.followups || [], other.followups || [], followupStamp);
  return out;
}

function mergeReports(a, b) {
  const byId = new Map();
  for (const r of [...a, ...b]) {
    if (!r || !r.id) continue;
    const prev = byId.get(r.id);
    byId.set(r.id, prev ? mergeReportPair(prev, r) : r);
  }
  return [...byId.values()];
}

// Prompt overrides are plain last-write-wins on their own stamp: unlike reports
// there is nothing to union, and the user editing on one device means to
// replace what the other had.
function mergePrompts(a = {}, b = {}) {
  return (a.adviceUpdatedAt || '') >= (b.adviceUpdatedAt || '') ? { ...b, ...a } : { ...a, ...b };
}

function mergeData(local, remote) {
  const l = normalizeData(local), r = normalizeData(remote);
  const deleted = mergeById(l.deleted, r.deleted, (d) => d.at || '');
  const gone = new Set(deleted.map((d) => d.id));
  return {
    app: l.app || r.app,
    version: l.version || r.version,
    updatedAt: newer(l.updatedAt, r.updatedAt),
    reports: mergeReports(l.reports, r.reports)
      .filter((x) => !gone.has(x.id))
      .sort((x, y) => (y.generatedAt || '').localeCompare(x.generatedAt || '')),
    claims: mergeById(l.claims, r.claims, claimStamp, claimKey)
      .filter((x) => !gone.has(x.id)),
    deleted,
    prompts: mergePrompts(l.prompts, r.prompts),
  };
}

/* -------------------------------------------------------------- DOM helper */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ============================================================== config I/O */
function loadCfg() {
  const c = {};
  for (const k of Object.keys(DEFAULTS)) {
    c[k] = localStorage.getItem(LS[k]) ?? DEFAULTS[k];
  }
  state.cfg = c;
  return c;
}
function setCfg(key, value) {
  state.cfg[key] = value;
  if (value === '' || value == null) localStorage.removeItem(LS[key]);
  else localStorage.setItem(LS[key], value);
}
function cfg() { return state.cfg; }

/* ----------------------------------------------------------- providers */
function activeProvider() {
  const p = cfg().activeProvider;
  return PROVIDERS[p] ? p : 'openai';
}
function providerLabel(p) { return (PROVIDERS[p] && PROVIDERS[p].label) || p; }
function providerKey(p = activeProvider()) { return (cfg()[PROVIDERS[p].keyCfg] || '').trim(); }
// The user's stored choice. Blank = Auto — deliberately NOT substituted with a
// default here; Auto is resolved live in resolveModel().
function pinnedModel(p = activeProvider()) { return (cfg()[PROVIDERS[p].modelCfg] || '').trim(); }

function missingSecrets() {
  const c = cfg();
  const miss = [];
  if (!c.githubToken) miss.push('token');
  if (!c.dataToken)   miss.push('datatoken');
  if (!providerKey()) miss.push('apikey');   // the ACTIVE provider's key
  return miss;
}
// True once both GitHub tokens are present — sync can run.
const canSync = () => !missingSecrets().some((m) => m === 'token' || m === 'datatoken');

/* ================================================================= GitHub */
// The token is an explicit argument on purpose. Two tokens are in play with
// deliberately different powers, and a default would make it easy to reach for
// the wrong one — the write-capable data token against the journal repo is
// precisely the mistake this whole design exists to prevent.
function ghHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
const journalHeaders = (accept) => ghHeaders(cfg().githubToken, accept);
const dataHeaders    = (accept) => ghHeaders(cfg().dataToken, accept);
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/* ---------------------------------------------------------------------------
   THE JOURNAL REPO IS READ-ONLY  ·  enforced by GitHub, not by this file
   ---------------------------------------------------------------------------
   Nothing here writes the journal repo. It is only READ (githubFetchNotes), and
   only ever with `githubToken`, which is scoped Contents:Read-only — so even a
   bug that tried to write it would get a 403 from GitHub.

   Writes go exclusively to the DATA repo, with `dataToken`, which has no access
   to the journal repo at all. The two tokens are never interchanged; that is
   the whole point of having two.
--------------------------------------------------------------------------- */

// READ-ONLY: issues only GET requests against the journal. Never writes it.
async function githubFetchNotes() {
  const { repo, notesPath, branch } = cfg();
  // NOTE: we use the default JSON contents API and decode base64 ourselves,
  // NOT the `application/vnd.github.raw` media type. The raw media type works in
  // curl/Node but is unreliable cross-origin in browsers (CORS), which silently
  // yielded the JSON envelope instead of file text and made every month look
  // empty. The JSON endpoint is the CORS-safe, browser-supported path.
  const url = `https://api.github.com/repos/${repo}/contents/${encPath(notesPath)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: journalHeaders() });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Notes file not found: ${repo}/${notesPath}@${branch}. Check the path in Settings.`);
    if (res.status === 401 || res.status === 403) throw new Error(`GitHub auth failed (${res.status}). Token needs Contents:read on ${repo}.`);
    throw new Error(`GitHub notes fetch failed (${res.status}).`);
  }
  const j = await res.json();
  if (j && j.content && j.encoding === 'base64') return b64DecodeUnicode(j.content);
  // Files > 1 MB: the contents API omits content. Fall back to the Git Blobs
  // API (also JSON + base64, so still CORS-safe).
  if (j && j.sha) {
    const b = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${j.sha}`, { headers: journalHeaders() });
    if (b.ok) {
      const bj = await b.json();
      if (bj && bj.content && bj.encoding === 'base64') return b64DecodeUnicode(bj.content);
    }
  }
  throw new Error('Could not read notes content from GitHub (unexpected response shape).');
}

const dataUrl = () => {
  const { dataRepo, dataPath } = cfg();
  return `https://api.github.com/repos/${dataRepo}/contents/${encPath(dataPath)}`;
};

// Reads the data file and remembers its blob sha, which the next write must
// quote. A 404 means the file has not been created yet — that is the normal
// first-run state, NOT an error, so it yields empty data and a null sha.
async function dataPull() {
  const { dataRepo, dataBranch } = cfg();
  const res = await fetch(`${dataUrl()}?ref=${encodeURIComponent(dataBranch)}`, { headers: dataHeaders() });
  if (res.status === 404) {
    // Distinguish "no file yet" from "no access": without the repo itself being
    // visible, GitHub 404s too, and silently treating that as "empty" would let
    // a bad token look like a fresh install and wipe the store on first push.
    const probe = await fetch(`https://api.github.com/repos/${dataRepo}`, { headers: dataHeaders() });
    if (!probe.ok) throw new Error(`Cannot reach ${dataRepo} (${probe.status}). Check the data token's repo access.`);
    state.dataSha = null;
    return emptyData();
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`Data repo auth failed (${res.status}). The data token needs Contents:read+write on ${dataRepo}.`);
    throw new Error(`Data read failed (${res.status}).`);
  }
  const j = await res.json();
  state.dataSha = j.sha || null;
  let content = '';
  if (j.content && j.encoding === 'base64') content = b64DecodeUnicode(j.content);
  else if (j.sha) {
    // Files > 1 MB come back without inline content; the blobs API still has it.
    const b = await fetch(`https://api.github.com/repos/${dataRepo}/git/blobs/${j.sha}`, { headers: dataHeaders() });
    if (b.ok) {
      const bj = await b.json();
      if (bj.content && bj.encoding === 'base64') content = b64DecodeUnicode(bj.content);
    }
  }
  try {
    return normalizeData(JSON.parse(content));
  } catch {
    // File exists but isn't our JSON yet — start fresh (won't clobber until push).
    return emptyData();
  }
}

// READ-MERGE-WRITE. Never PUTs the local copy straight over the remote: the
// contents API replaces the whole file, so a blind write silently deletes
// anything another device added since this one last pulled. Pull first, merge,
// then write the union. A failed pull aborts the write — better unsynced than
// overwritten.
//
// The sha gives us real optimistic concurrency, which the Gist never had: if
// another device wrote between our pull and our PUT, GitHub rejects it with 409
// instead of quietly taking our version. We re-pull, re-merge and retry, so a
// genuine race costs a round trip rather than someone's reports.
async function dataPushNow(attempt = 0) {
  const atRev = state.rev;
  state.data = mergeData(state.data, await dataPull());
  state.data.updatedAt = new Date().toISOString();

  const body = {
    message: `reports: ${state.data.reports.length} report(s), ${state.data.claims.length} claim(s)`,
    content: b64EncodeUnicode(JSON.stringify(state.data, null, 2)),
    branch: cfg().dataBranch,
  };
  if (state.dataSha) body.sha = state.dataSha;   // omitted on create

  const res = await fetch(dataUrl(), { method: 'PUT', headers: dataHeaders(), body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) {
    if (attempt >= 3) throw new Error('Data repo kept changing under us — try syncing again.');
    state.dataSha = null;
    return dataPushNow(attempt + 1);
  }
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error(`Write refused (403). The data token needs Contents:write on ${cfg().dataRepo}.`);
    throw new Error(e.message || `Data write failed (${res.status}).`);
  }
  const j = await res.json().catch(() => ({}));
  state.dataSha = j.content?.sha || null;
  localStorage.setItem(LS.cache, JSON.stringify(state.data));
  clearDirty(atRev);
}

/* ============================================================== providers */
/* ----------------------------------------------------------------------------
   PROVIDER REGISTRY
   ----------------------------------------------------------------------------
   One shared summarization path; a thin per-vendor adapter that only knows that
   vendor's wire format. Each entry implements the same interface:

     id, label, base, defaultModel, fallbacks, keyUrl
     buildBody(model, systemText, userText[, mode])  -> request JSON
     parse(json[, mode])                             -> { text }
     send(model, systemText, userText, key, onModel) -> { text, model, fellBack }
     discover(key)                                   -> [{ id, created }]
     rankKey(m)                                      -> sort key, higher = newer

   The conversation members from the reference design (newConvo / pushUser /
   pushAssistant / pushToolResults) and the tool-schema converter are omitted on
   purpose: this app makes a single-shot summarization call and declares no
   tools, so there is no multi-turn tool loop to carry state for.
--------------------------------------------------------------------------- */

const PROVIDERS = {
  /* --------------------------------------------------------------- OpenAI */
  openai: {
    id: 'openai',
    label: 'OpenAI',
    base: 'https://api.openai.com/v1',
    defaultModel: '',                       // blank = Auto
    fallbacks: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    keyUrl: 'https://platform.openai.com/api-keys',
    keyCfg: 'openaiKey', modelCfg: 'openaiModel', keyInput: 'set-openai-key',

    // Which endpoint a given model needs is not knowable from its id, so it is
    // learned once by probing and then cached per model.
    modeCache() { try { return JSON.parse(localStorage.getItem('msi.openaiMode') || '{}'); } catch { return {}; } },
    setMode(model, mode) {
      const c = this.modeCache();
      if (c[model] === mode) return;
      c[model] = mode;
      try { localStorage.setItem('msi.openaiMode', JSON.stringify(c)); } catch { /* quota */ }
    },

    buildBody(model, systemText, userText, mode) {
      if (mode === 'responses') {
        // /v1/responses uses `instructions` + `input` (not a messages array).
        // store:false keeps the conversation off OpenAI's servers, matching the
        // rest of this app's privacy model.
        return { model, instructions: systemText, input: userText, store: false };
      }
      // /v1/chat/completions. Deliberately NO temperature and NO max_tokens:
      // newer models reject a non-default temperature, and max_tokens was
      // renamed max_completion_tokens — omitting both works everywhere.
      return {
        model,
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userText },
        ],
      };
    },

    parse(json, mode) {
      if (mode === 'responses') {
        if (typeof json?.output_text === 'string' && json.output_text.trim()) {
          return { text: json.output_text.trim() };
        }
        // output[] interleaves reasoning items with the message; keep the text.
        const text = (json?.output || [])
          .filter((o) => o && o.type === 'message')
          .flatMap((o) => o.content || [])
          .filter((c) => c && c.type === 'output_text')
          .map((c) => c.text || '')
          .join('')
          .trim();
        return { text };
      }
      return { text: (json?.choices?.[0]?.message?.content || '').trim() };
    },

    // chat -> responses when the model won't take the chat shape (reasoning
    // models); responses -> chat when the model isn't served there. Auth and
    // quota failures are not mode problems, so they stop immediately.
    nextMode(mode, status, detail) {
      const d = (detail || '').toLowerCase();
      if (mode === 'chat') {
        const needsResponses = status === 404
          || (status === 400 && /reasoning|\/v1\/responses|responses api|not supported|unsupported/.test(d));
        return needsResponses ? 'responses' : null;
      }
      if (mode === 'responses' && (status === 404 || status === 400)) return 'chat';
      return null;
    },

    async send(model, systemText, userText, key) {
      let mode = this.modeCache()[model] || 'chat';
      const tried = new Set();
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (tried.has(mode)) break;
        tried.add(mode);
        const url = `${this.base}${mode === 'responses' ? '/responses' : '/chat/completions'}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(this.buildBody(model, systemText, userText, mode)),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          this.setMode(model, mode);
          const { text } = this.parse(data, mode);
          if (!text) {
            throw new Error(`OpenAI returned no text (${data?.choices?.[0]?.finish_reason || data?.status || 'empty response'}).`);
          }
          return { text, model, fellBack: false };
        }
        const detail = [data?.error?.message, data?.error?.param, data?.error?.code].filter(Boolean).join(' ');
        lastErr = apiError(`OpenAI request failed (${res.status}).`, res.status, data?.error?.message);
        const next = this.nextMode(mode, res.status, detail);
        if (!next) throw lastErr;
        mode = next;
      }
      throw lastErr || new Error('OpenAI request failed.');
    },

    async discover(key) {
      const res = await fetch(`${this.base}/models`, { headers: { Authorization: `Bearer ${key}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(`OpenAI model list failed (${res.status}).`, res.status, data?.error?.message);
      // `created` is seconds since epoch.
      return (data.data || []).map((m) => ({ id: m.id, created: (m.created || 0) * 1000 }));
    },
    rankKey(m) { return m.created || 0; },
  },

  /* ------------------------------------------------------------ Anthropic */
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    base: 'https://api.anthropic.com/v1',
    defaultModel: '',
    fallbacks: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyCfg: 'anthropicKey', modelCfg: 'anthropicModel', keyInput: 'set-anthropic-key',

    headers(key) {
      return {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // Required for browser calls — without it the request is blocked by
        // CORS before it ever leaves the tab.
        'anthropic-dangerous-direct-browser-access': 'true',
      };
    },

    buildBody(model, systemText, userText) {
      // max_tokens is required by /v1/messages, and `system` is a top-level
      // string rather than a message.
      return {
        model,
        max_tokens: 8192,
        system: systemText,
        messages: [{ role: 'user', content: userText }],
      };
    },

    parse(json) {
      const text = (json?.content || [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('')
        .trim();
      return { text };
    },

    async send(model, systemText, userText, key) {
      const res = await fetch(`${this.base}/messages`, {
        method: 'POST',
        headers: this.headers(key),
        body: JSON.stringify(this.buildBody(model, systemText, userText)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(`Anthropic request failed (${res.status}).`, res.status, data?.error?.message);
      if (data?.stop_reason === 'refusal') throw new Error('Anthropic declined this request (refusal).');
      const { text } = this.parse(data);
      if (!text) throw new Error(`Anthropic returned no text (${data?.stop_reason || 'empty response'}).`);
      return { text, model, fellBack: false };
    },

    async discover(key) {
      const res = await fetch(`${this.base}/models?limit=100`, { headers: this.headers(key) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(`Anthropic model list failed (${res.status}).`, res.status, data?.error?.message);
      return (data.data || []).map((m) => ({ id: m.id, created: Date.parse(m.created_at) || 0 }));
    },
    rankKey(m) { return m.created || 0; },
  },

  /* --------------------------------------------------------------- Gemini */
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    base: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: '',
    fallbacks: [
      'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash',
      'gemini-pro-latest', 'gemini-2.5-pro', 'gemini-flash-lite-latest',
    ],
    keyUrl: 'https://aistudio.google.com/apikey',
    keyCfg: 'geminiKey', modelCfg: 'geminiModel', keyInput: 'set-gemini-key',

    buildBody(model, systemText, userText) {
      return {
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: 8192 },
      };
    },

    parse(json) {
      const cand = json?.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
      return { text, finishReason: cand?.finishReason || json?.promptFeedback?.blockReason };
    },

    // Single attempt against one model.
    async once(model, systemText, userText, key) {
      // Gemini authenticates with the key as a query param.
      const url = `${this.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildBody(model, systemText, userText)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = apiError(`Gemini request failed (${res.status}).`, res.status, data?.error?.message);
        err.gstatus = data?.error?.status;
        throw err;
      }
      const { text, finishReason } = this.parse(data);
      if (!text) throw new Error(`Gemini returned no text (${finishReason || 'empty response'}).`);
      return text;
    },

    // Ordered fallback: Gemini's model names churn, so if the preferred model
    // is gone, discover what this key can actually use and try those in turn.
    async send(preferred, systemText, userText, key, onModel) {
      const tried = new Set();
      let queue = [preferred, ...this.fallbacks].filter(Boolean);
      let liveLoaded = false;
      let lastErr = null;

      for (let i = 0; i < queue.length; i++) {
        const model = queue[i];
        if (!model || tried.has(model)) continue;
        tried.add(model);
        if (onModel) onModel(model, tried.size > 1);
        try {
          const text = await this.once(model, systemText, userText, key);
          return { text, model, fellBack: model !== preferred };
        } catch (e) {
          lastErr = e;
          // Only walk the chain for "this model isn't available" errors.
          // Auth / quota / safety / network errors stop immediately.
          if (!isModelAvailabilityError(e)) throw e;
          if (!liveLoaded) {
            liveLoaded = true;
            let live = [];
            try {
              live = (await this.discover(key))
                .filter((m) => isChatModel(m.id))
                .sort((a, b) => this.rankKey(b) - this.rankKey(a))
                .map((m) => m.id);
            } catch (_) { /* keep the static queue */ }
            if (live.length) queue = queue.slice(0, i + 1).concat(live.filter((m) => !tried.has(m)));
          }
        }
      }
      throw new Error(`No available Gemini model worked (tried ${tried.size}). Last error: ${lastErr ? lastErr.message : 'unknown'}`);
    },

    async discover(key) {
      const res = await fetch(`${this.base}/models?key=${encodeURIComponent(key)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(`Gemini model list failed (${res.status}).`, res.status, data?.error?.message);
      return (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({ id: (m.name || '').replace(/^models\//, ''), created: 0 }));
    },
    // Gemini's list endpoint exposes no created/timestamp field, so this is the
    // one provider where ranking has to fall back to a name heuristic.
    rankKey(m) { return geminiNameRank(m.id); },
  },
};

function isModelAvailabilityError(e) {
  if (e && e.status === 404) return true;
  const m = ((e && e.message) || '').toLowerCase();
  return /no longer available|not found|does not exist|is not supported|not supported for|unavailable|deprecated|call listmodels|unknown name|invalid model|not a valid/.test(m);
}

// Higher = preferred. Newer version > flash > pro > lite; penalise variants
// that aren't general-purpose chat.
function geminiNameRank(name) {
  const n = (name || '').toLowerCase();
  let score = 0;
  const v = n.match(/(\d+)\.(\d+)/);
  if (v) score += (parseInt(v[1], 10) * 10 + parseInt(v[2], 10)) * 100;
  if (n.includes('flash') && !n.includes('lite')) score += 50;
  else if (n.includes('pro')) score += 45;
  else if (n.includes('lite')) score += 30;
  if (n.includes('latest')) score += 25;
  if (/exp|preview|thinking/.test(n)) score -= 300;
  return score;
}

/* ------------------------------------------------- discovery + Auto mode */
// Returns chat-capable models for a provider, newest first. Cached per key.
async function discoverModels(provider, key, { force = false } = {}) {
  const p = PROVIDERS[provider];
  if (!key) throw new Error(`Add your ${p.label} API key first.`);
  const cacheKey = discoveryCacheKey(provider, key);
  if (!force) {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const hit = JSON.parse(raw);
        if (hit && Array.isArray(hit.models) && (Date.now() - (hit.at || 0)) < DISCOVERY_TTL_MS) {
          return hit.models;
        }
      }
    } catch { /* ignore a corrupt cache entry */ }
  }
  const models = (await p.discover(key))
    .filter((m) => isChatModel(m.id))
    .sort((a, b) => p.rankKey(b) - p.rankKey(a));
  try { localStorage.setItem(cacheKey, JSON.stringify({ at: Date.now(), models })); } catch { /* quota */ }
  return models;
}

// Resolve the model to actually call. A pinned choice always wins; Auto is
// resolved against the live list at request time so it never goes stale.
async function resolveModel(provider, onProgress) {
  const p = PROVIDERS[provider];
  const pinned = pinnedModel(provider);
  if (pinned) return { model: pinned, auto: false };
  try {
    if (onProgress) onProgress('Selecting newest model…');
    const models = await discoverModels(provider, providerKey(provider));
    if (models.length) return { model: models[0].id, auto: true };
  } catch (_) { /* fall through to the static chain */ }
  return { model: p.fallbacks[0], auto: true, usedFallbackList: true };
}

/* ------------------------------------------------------ shared entry points */
// Returns { text, model, fellBack }.
function providerGenerate(provider, model, systemText, userText, onModel) {
  const p = PROVIDERS[provider];
  return p.send(model, systemText, userText, providerKey(provider), onModel);
}

/* ==================================================== notes parse + slice */
function parseEntries(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const re = /^#{1,6}\s+(\d{4}-\d{2}-\d{2})\b(.*)$/;
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(re);
    if (m) { cur = { date: m[1], title: (m[2] || '').trim(), lines: [] }; entries.push(cur); }
    else if (cur) cur.lines.push(line);
  }
  return entries.map((e) => ({ date: e.date, title: e.title, body: e.lines.join('\n').trim() }));
}

function sliceForRange(entries, startStr, endStr) {
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  return entries
    .filter((e) => {
      const d = new Date(e.date + 'T00:00:00Z');
      return !isNaN(d) && d >= start && d <= end;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function analyzeThemes(text) {
  const low = text.toLowerCase();
  const scored = THEMES.map((t) => {
    let score = 0;
    for (const kw of t.kw) {
      let idx = 0;
      while ((idx = low.indexOf(kw, idx)) !== -1) { score++; idx += kw.length; }
    }
    return { key: t.key, label: t.label, score };
  }).filter((t) => t.score > 0).sort((a, b) => b.score - a.score);
  return scored;
}

function findOpenLoops(entries) {
  const loops = [];
  for (const e of entries) {
    for (const raw of e.body.split('\n')) {
      const line = raw.trim();
      if (/\[\s\]/.test(line) || /\bFAILED\b/.test(line) || /\b(todo|next step|unfinished|follow up|follow-up)\b/i.test(line)) {
        loops.push(`${e.date}: ${line.replace(/^[*\-]\s*/, '').slice(0, 160)}`);
      }
    }
  }
  return loops.slice(0, 25);
}

/* ====================================================== advice directive */
/* ---------------------------------------------------------------------------
   USER-OWNED PROMPT
   ---------------------------------------------------------------------------
   This block is edited by the user in Settings and injected verbatim into the
   report system prompt. It lives in the synced data file, not localStorage, so
   the phone and the laptop cannot drift into generating differently-shaped
   advice from the same journal.

   It is deliberately the ONLY user-editable prompt. The report's section list
   and the strict JSON contracts elsewhere are parsed by code — letting those be
   edited would break parsing rather than change the writing.
--------------------------------------------------------------------------- */
const DEFAULT_ADVICE_PROMPT = [
  'Advice stance: a specific, well-read friend who has read every entry and is invested in the outcome.',
  'Not a life coach, not a therapist, not a motivational writer. Never inspirational, never generic.',
  '',
  'Every piece of advice must:',
  '- attach to something concrete in the entries — a date, a project, a number, a decision, an abandoned thread.',
  '- be actionable this week by someone with a job and limited evenings.',
  '- name the tradeoff honestly. what does this cost, and what gets dropped to make room?',
  '- say the uncomfortable thing when the entries support it. avoiding it is not kindness.',
  '',
  'Never:',
  '- recommend anything the entries give no evidence for.',
  '- offer generic wellness advice (sleep more, drink water, take breaks) unless the entries specifically show it breaking down.',
  '- pad with encouragement, affirmation, or "you\'ve got this".',
  '- suggest a system, app, or tool as a substitute for a decision they are avoiding.',
  '',
  'Bias toward: finishing over starting, deciding over researching, one thing well over five things partially.',
  'When the entries show a long-running avoidance, name it directly and say what it is costing.',
].join('\n');

// The user's edit if there is one, else the default. Kept as a function so a
// mid-session change to the synced data takes effect on the next report.
function advicePrompt() {
  const p = (state.data.prompts && state.data.prompts.advice) || '';
  return p.trim() ? p : DEFAULT_ADVICE_PROMPT;
}
function adviceIsCustom() {
  const p = (state.data.prompts && state.data.prompts.advice) || '';
  return !!p.trim() && p.trim() !== DEFAULT_ADVICE_PROMPT.trim();
}
function setAdvicePrompt(text) {
  const t = (text || '').trim();
  state.data.prompts = state.data.prompts || {};
  // Storing '' means "use the default", so resetting is a real state, not a
  // copy of today's default text frozen into the file forever.
  state.data.prompts.advice = t === DEFAULT_ADVICE_PROMPT.trim() ? '' : t;
  state.data.prompts.adviceUpdatedAt = new Date().toISOString();
  saveLocal();
  schedulePush();
}

/* =========================================================== prompt build */
function buildSystemPrompt() {
  return [
    'You are a sharp, unsentimental monthly self-interrogation coach for a technical, self-directed person.',
    'You are given one month of their raw private journal entries. Read closely, then produce a Markdown report that forces genuine reflection.',
    'Some runs also include an ESTABLISHED CONTEXT block — their own written answers to earlier reports. Treat it as fact, use it to decode terse entries, and never ask anything it already answers.',
    '',
    'Voice & style:',
    '- concise, slightly informal, lowercase starts where natural.',
    '- NOT beginner-level. assume high context. no fluff, no therapy-speak, no praise padding.',
    '- questions must be genuinely probing — the kind that are uncomfortable to answer honestly.',
    '- reference concrete specifics from the entries (projects, decisions, numbers, names) instead of generic prompts.',
    '',
    'Output EXACTLY these Markdown sections, in this order, using `##` headings:',
    '## executive overview',
    '  - 3–5 tight sentences: the month\'s dominant thread, what genuinely progressed, what quietly stalled, and the gap between stated intent and actual behavior.',
    '  - close with one blunt verdict sentence — what this month bought them, or what it cost.',
    '  - cite specifics (projects, dates, numbers, decisions). if the entries are thin, say that plainly instead of inflating them.',
    '## theme-weighted question bank',
    '  - 8–12 questions, allocated by the theme weights supplied below — the heaviest theme gets the most questions, not an even split.',
    '  - prefix each with its theme in brackets, e.g. `[ai]`. add a theme the local keyword scan missed if the entries support it.',
    '  - include at least one question about a theme that is conspicuously thin or absent this month — what dropped off, and whether that was a choice.',
    '  - no two questions may probe the same thing from a different angle.',
    '## contradiction / open-loop detector',
    '  - 4–6 questions aimed at contradictions, abandoned threads, and commitments made and never closed.',
    '  - work from the detected open-loop list below AND anything it missed — it is a keyword scan, not a judgment.',
    '  - each question must name the thing it comes from: the dated commitment, the abandoned thread, or the two entries that contradict each other.',
    '## adversarial self-audit',
    '  - 4–6 questions in the voice of someone who has read every entry, remembers what was promised, and is not impressed.',
    '  - attack the reasoning, the priorities, and the excuses — quote the actual justification from the entries before puncturing it.',
    '  - no invented flaws. if the entries do not support the critique, do not make it.',
    '## future-self letter',
    '  - 4–6 questions written by them 3–6 months out, looking back at this month — "why did you…", "did you ever…".',
    '  - write from two versions of them: the one who followed through on what is live in these entries, and the one who let it slide. label which is which.',
    '  - each question must hang on a real decision, bet, or thread from the entries. no generic regrets, no gentleness.',
    '## cross-domain synthesis',
    '  - 4–6 questions that force connections between domains the entries keep separate (e.g. a sleep pattern against a career decision).',
    '  - name the evidence on both sides of the link before drawing it. two vague trends are not a connection.',
    '  - ask whether the link is real, not whether it sounds clever. do not manufacture correlation the entries cannot support.',
    '## context gaps',
    '  - 4–8 direct factual questions about what the entries reference but never explain: shorthand, names, projects, decisions that appear with no stated reason.',
    '  - name the specific dates with no entries and ask what happened in them.',
    '  - these are for filling in the record, not for reflection. a one line answer should be enough for each.',
    '  - close with a `### write this down next month` list: 2–3 things that, logged even one line a day, would have made this report materially sharper.',
    '  - never ask anything the entries or the established context already answer.',
    '## self-improvement operating plan',
    '  - turn the month\'s most important observations into a realistic 30-day plan. this section is advice, not questions.',
    '  - pick 3–4 priorities, no more. favor unfinished commitments, recurring friction, and choices with real downstream impact.',
    '  - one `###` heading per priority, then these bullets with the labels bolded exactly as written:',
    '    - **why now:** the evidence from the entries, with a date.',
    '    - **7-day move:** one action they can finish this week.',
    '    - **30-day target:** the outcome to hit before the next report.',
    '    - **weekly rhythm:** the minimum recurring habit, review, or time block.',
    '    - **measurement:** how they will know progress is real and not just felt.',
    '    - **if/then:** the likely obstacle and the pre-decided response.',
    '    - **what this costs:** what gets less attention because this got more. every priority displaces something.',
    '  - close with a `### stop doing` block: one tempting, lower-value activity to cut, defer, or cap — and what it frees up.',
    '  - practical only. no pep talk, no advice the entries do not support.',
    '## life advice',
    '  - the longest and most substantial section of the report. write it as prose with `###` subheadings, not as a bullet dump.',
    '  - this is the section they actually came for. spend real words here — several paragraphs per subheading, not one-liners.',
    '  - use these five `###` subheadings, written EXACTLY as shown (they address the reader as "you", like the rest of the report):',
    '    - `### the pattern you cannot see` — the thing recurring across months that is invisible from inside it. name it, show the dated evidence, say where it leads if nothing changes.',
    '    - `### the decision being avoided` — the choice the entries keep circling without making. state it plainly, lay out the real options with their actual costs, and say which one you would take and why.',
    '    - `### leverage` — where a small change compounds. be specific about the mechanism, not just the suggestion.',
    '    - `### the honest risk` — what is most likely to go wrong in the next 6–12 months given these entries. not catastrophizing; the realistic failure mode, and the cheapest hedge against it.',
    '    - `### what is actually working` — the thing they are underrating and should do more of. evidence-based, not consolation.',
    '  - if a subheading has nothing real behind it, keep the heading and say in one line that the entries do not support it. do not invent material to fill it.',
    '  - where the entries are about work, money, health, or relationships, engage with the substance. do not retreat to process advice.',
    '  - argue for your recommendations. show the reasoning so they can disagree with it on the merits.',
    '',
    'ADVICE DIRECTIVE — governs `## self-improvement operating plan` and `## life advice`.',
    'This is written by the user and overrides the tone guidance above for those two sections where they conflict:',
    '<<<ADVICE_DIRECTIVE>>>',
    '',
    'Rules: output only the report as Markdown. no preamble, no closing note. exactly the nine `##` sections above, in that order. every question goes on its own line as a list item.',
  ].join('\n').replace('<<<ADVICE_DIRECTIVE>>>', advicePrompt());
}

/* --------------------------------------------------- accumulated context */
/* ---------------------------------------------------------------------------
   Everything the user has already told the app, in the form the model needs.

   This is the fix for "it keeps asking me things I already answered". Answers
   used to reach the prompt only as three blobs of free text from the reflection
   box, so nothing tied a given answer to the question that produced it and the
   model had no way to tell what ground was already covered. Answered follow-ups
   are Q&A PAIRS, which is both denser context and a checkable do-not-repeat
   list — and unlike the old window they are not capped at three reports.
--------------------------------------------------------------------------- */
const answeredFollowups = () =>
  state.data.reports.flatMap((r) =>
    (r.followups || [])
      .filter((f) => f.a && f.a.trim())
      .map((f) => ({ month: r.month, q: f.q, a: f.a.trim(), answeredAt: f.answeredAt || r.generatedAt }))
  ).sort((a, b) => (b.answeredAt || '').localeCompare(a.answeredAt || ''));

// Cap by characters, not by count: a handful of long answers can blow the
// context budget as easily as many short ones, and truncating mid-answer is
// worse than dropping the oldest whole ones.
function answeredContextBlock(limitChars = 14000) {
  const qa = answeredFollowups();
  const out = [];
  let used = 0;
  for (const x of qa) {
    const line = `Q [${x.month}] ${x.q}\nA: ${x.a}`;
    if (used + line.length > limitChars) break;
    out.push(line);
    used += line.length;
  }
  return { block: out.join('\n\n'), shown: out.length, total: qa.length };
}

// The free-text reflection box is separate from the Q&A pairs and still worth
// carrying; it is where they write things nothing asked about.
const reflectionContext = () =>
  state.data.reports
    .filter((r) => r.reflection && r.reflection.trim())
    .slice(0, 3)
    .map((r) => `[${r.month}] ${r.reflection.trim()}`);

function buildUserPrompt(monthStr, slice, themes, loops) {
  const themeLine = themes.length
    ? themes.map((t) => `${t.label} (${t.score})`).join(', ')
    : 'none detected locally';
  const loopBlock = loops.length ? loops.map((l) => `- ${l}`).join('\n') : '- (none auto-detected)';
  const body = slice.map((e) => `### ${e.date}${e.title ? ' ' + e.title : ''}\n${e.body}`).join('\n\n');
  const answered = answeredContextBlock();
  const reflections = reflectionContext();
  return [
    `TARGET MONTH: ${monthStr} (entries below cover the selected date range; may extend outside the month).`,
    `LOCALLY DETECTED THEMES (weight): ${themeLine}`,
    `LOCALLY DETECTED OPEN LOOPS / UNFINISHED:`,
    loopBlock,
    '',
    // Their own answers to earlier reports — the entries alone are terse, so
    // this is where accumulated context lives. Do not re-ask what it answers.
    '=== ALREADY ANSWERED (their own answers to earlier questions) ===',
    'Treat every answer below as established fact. Use it to decode terse entries.',
    'Do NOT ask any question this section already answers, in any rephrasing.',
    answered.block || '(none yet)',
    '=== END ALREADY ANSWERED ===',
    '',
    '=== FREE-FORM REFLECTIONS (most recent) ===',
    reflections.join('\n\n') || '(none yet)',
    '=== END REFLECTIONS ===',
    '',
    '=== JOURNAL ENTRIES ===',
    body || '(no entries found)',
    '=== END ENTRIES ===',
  ].join('\n');
}

/* ================================================= follow-up question set */
/* ---------------------------------------------------------------------------
   A SECOND pass, not part of the report.

   The report's questions are prose inside Markdown — good to read, impossible
   to answer in place and impossible to track. These are the same intent in a
   structured form: emitted as JSON, rendered as individual answer boxes, and
   fed back verbatim as Q&A pairs on the next run. That loop is the only way the
   model ever learns what it already knows.
--------------------------------------------------------------------------- */
function buildFollowupSystemPrompt() {
  return [
    'You write follow-up questions for a monthly journal self-interrogation tool.',
    'You are given a report that was just generated, the journal entries behind it, and every question the user has ALREADY answered.',
    'Output ONE JSON object and nothing else — no prose, no code fence, no explanation.',
    '',
    'Shape: {"questions":[{"q":"","theme":"","why":""}]}',
    '',
    'Produce 6-10 questions. Each one:',
    '- must be answerable in 1-4 sentences from memory. these get answered in a text box, not researched.',
    '- must close a REAL gap: something the entries reference without explaining, a decision with no stated reason, a thread that stops mid-air, a stretch of days with no entries.',
    '- must name the specific thing it is about — the project, the date, the person, the number. a question that could be asked of any journal is worthless here.',
    '- "theme": one short lowercase tag (ai, cyber, health, career, privacy, life).',
    '- "why": one short clause stating what answering it would let a future report do better. this is shown to the user.',
    '',
    'HARD RULE — the ALREADY ANSWERED block is the point of this whole exercise.',
    'Do not ask anything it answers. Do not ask a rephrasing, a narrowing, or a follow-on that the answer already covers.',
    'If an answer there is partial, you may go DEEPER, but the question must acknowledge what is already known and ask only for the missing piece.',
    '',
    'Order the questions so the highest-value gap is first — the one whose answer would most change how the next report reads.',
    'Prefer factual gap-filling over reflection. The report already handles reflection; this is for context the model does not have.',
  ].join('\n');
}

function buildFollowupUserPrompt(reportMd, slice, monthStr) {
  const answered = answeredContextBlock(10000);
  const body = slice.map((e) => `### ${e.date}\n${e.body}`).join('\n\n');
  return [
    `TARGET MONTH: ${monthStr}`,
    '',
    '=== ALREADY ANSWERED — never ask these again ===',
    answered.block || '(nothing answered yet — this is the first pass)',
    `=== END ALREADY ANSWERED (${answered.shown} of ${answered.total} shown) ===`,
    '',
    '=== THE REPORT JUST GENERATED ===',
    reportMd,
    '=== END REPORT ===',
    '',
    '=== JOURNAL ENTRIES FOR THIS PERIOD ===',
    body || '(no entries found)',
    '=== END ENTRIES ===',
  ].join('\n');
}

// Returns [] rather than throwing: a report that generated fine must not be
// lost because the question pass failed.
async function generateFollowups(provider, model, reportMd, slice, monthStr, onProgress) {
  try {
    const gen = await providerGenerate(
      provider, model, buildFollowupSystemPrompt(),
      buildFollowupUserPrompt(reportMd, slice, monthStr), onProgress
    );
    const out = parseJsonLoose(gen.text);
    const seen = new Set(answeredFollowups().map((x) => normQuote(x.q)));
    const list = [];
    for (const raw of Array.isArray(out.questions) ? out.questions : []) {
      const q = String(raw && raw.q || '').trim();
      if (!q) continue;
      // Belt and braces: the prompt forbids repeats, but a model that ignores
      // it should not put the same question in front of the user twice.
      const key = normQuote(q);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        id: 'f-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        q: q.slice(0, 400),
        theme: String(raw.theme || '').trim().toLowerCase().slice(0, 16),
        why: String(raw.why || '').trim().slice(0, 200),
        a: '',
        answeredAt: null,
      });
    }
    return list;
  } catch (e) {
    console.warn('follow-up generation failed:', e.message);
    return [];
  }
}

/* ============================================================ base64 utf8 */
// GitHub returns base64 with embedded newlines; strip whitespace, then decode
// as UTF-8 (atob alone mangles multi-byte chars like em dashes / arrows).
function b64DecodeUnicode(b64) {
  const bin = atob((b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}
// Mirror image, for writing the data file. btoa() takes a "binary string" — one
// char per byte — so the text must be UTF-8 encoded FIRST. Passing a JS string
// straight to btoa throws on any character above U+00FF, and the reports are
// full of em dashes and arrows.
function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  // Chunked: String.fromCharCode(...bytes) blows the argument limit on a large
  // report set, which would surface as a mystery RangeError mid-sync.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/* ======================================================= markdown → HTML */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function mdInline(t) {
  t = escapeHtml(t);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
function mdToHtml(md) {
  const lines = (md || '').replace(/\r\n/g, '\n').split('\n');
  let html = '', i = 0;
  const isBlockStart = (l) => /^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|(\*{3,}|-{3,}|_{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^```/.test(line)) {
      let code = ''; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + '\n'; i++; }
      i++; html += `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`; continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const lv = h[1].length; html += `<h${lv}>${mdInline(h[2].trim())}</h${lv}>`; i++; continue; }
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += `<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`; continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(mdInline(lines[i].replace(/^\s*[-*+]\s+/, ''))); i++; }
      html += `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`; continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(mdInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))); i++; }
      html += `<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`; continue;
    }
    const para = [line]; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) { para.push(lines[i]); i++; }
    html += `<p>${mdInline(para.join(' '))}</p>`;
  }
  return html;
}

/* =============================================================== sync core */
function setSync(kind, label) {
  const el = $('#sync-status');
  el.className = 'sync-status' + (kind ? ' is-' + kind : '');
  $('.sync-label', el).textContent = label;
}
function schedulePush() {
  setSync('dirty', 'unsynced');
  clearTimeout(state.pushTimer);
  state.pushTimer = setTimeout(flushPush, 1200);
}
async function flushPush() {
  clearTimeout(state.pushTimer);
  if (!state.dirty) { setSync('synced', 'synced'); return; }
  if (state.pushInFlight) return state.pushInFlight;
  setSync('busy', 'syncing…');
  state.pushInFlight = (async () => {
    try { await dataPushNow(); setSync('synced', 'synced'); }
    catch (e) { setSync('error', 'sync failed'); toast(e.message, 'err'); }
    finally { state.pushInFlight = null; }
  })();
  return state.pushInFlight;
}

async function cloudSync() {
  if (!canSync()) {
    toast('Add both GitHub tokens in Settings first.', 'err');
    openSettings();
    return;
  }
  setSync('busy', 'syncing…');
  try {
    await flushPush();                  // push pending local edits (merging)
    setSync('busy', 'syncing…');
    // Then reconcile with the remote. NOT an assignment: `state.data = pull()`
    // discards anything this device holds that the Gist has not seen yet, which
    // on a failed/absent push is silent local data loss. Merge keeps both sides.
    const remote = await dataPull();
    state.data = mergeData(state.data, remote);
    localStorage.setItem(LS.cache, JSON.stringify(state.data));
    // If this device turned out to be holding records the Gist lacks — a push
    // that failed earlier, a cleared dirty flag — the merge just recovered them
    // locally. Send them up, or they stay stranded on this device forever.
    if (idSet(state.data).size > idSet(remote).size) {
      saveLocal();
      await flushPush();
    }
    renderHistory();
    if (state.currentId && !state.data.reports.find((r) => r.id === state.currentId)) {
      state.currentId = null; showEmpty();
    } else if (state.currentId) {
      renderReport(state.data.reports.find((r) => r.id === state.currentId));
    }
    setSync('synced', 'synced');
    toast('Synced with private data repo.', 'ok');
  } catch (e) {
    setSync('error', 'sync failed');
    toast(e.message, 'err');
  }
}

/* ============================================================ report flow */
async function generateReport() {
  const miss = missingSecrets();
  if (miss.length) {
    toast('Missing keys: ' + miss.join(', ') + '. Opening Settings.', 'err');
    openSettings();
    return;
  }
  const month = $('#target-month').value || prevMonthStr();
  const reqStart = $('#range-start').value || monthFirstDay(month);
  const reqEnd = $('#range-end').value || monthLastDay(month);
  const provider = activeProvider();
  const btn = $('#btn-generate');
  btn.disabled = true;
  showProgress(true, 'Fetching journal…');
  try {
    const md = await githubFetchNotes();
    const entries = parseEntries(md);
    const slice = sliceForRange(entries, reqStart, reqEnd);
    if (!slice.length) {
      throw new Error(`No entries found for ${reqStart} → ${reqEnd} in ${cfg().notesPath}.`);
    }
    showProgress(true, 'Analyzing themes…');
    const joined = slice.map((e) => e.body).join('\n');
    const themes = analyzeThemes(joined);
    const loops = findOpenLoops(slice);

    // slice is sorted ascending, so first/last entries bound what was read.
    const rangeStart = slice[0].date;
    const rangeEnd = slice[slice.length - 1].date;

    // Auto (blank) resolves against the live model list here, per request —
    // never frozen into storage.
    const picked = await resolveModel(provider, (t) => showProgress(true, t));
    const model = picked.model;

    showProgress(true, `Interrogating ${model}…`);
    const gen = await providerGenerate(
      provider, model, buildSystemPrompt(), buildUserPrompt(month, slice, themes, loops),
      (m, isFallback) => showProgress(true, `${isFallback ? 'Falling back to' : 'Interrogating'} ${m}…`)
    );
    const reportMd = gen.text;
    if (gen.fellBack) toast(`"${model}" unavailable — used "${gen.model}" instead.`, 'ok');

    // Second pass, before the report is stored, so the questions land with it.
    showProgress(true, 'Drafting follow-up questions…');
    const followups = await generateFollowups(
      provider, gen.model, reportMd, slice, month,
      (m, fb) => showProgress(true, `${fb ? 'Falling back to' : 'Drafting questions with'} ${m}…`)
    );

    const report = {
      id: `${month}-${Date.now().toString(36)}`,
      month,
      generatedAt: new Date().toISOString(),
      provider,                 // NB: provider + model only — never the API key
      model: gen.model,
      modelAuto: !!picked.auto,
      entryCount: slice.length,
      requestedStart: reqStart, // date range the user asked for
      requestedEnd: reqEnd,
      rangeStart,               // first entry date actually included
      rangeEnd,                 // last entry date actually included
      themeSummary: themes.length ? themes.slice(0, 4).map((t) => t.label).join(', ') : 'none detected',
      themes,
      report: reportMd,
      followups,
      reflection: '',
      reflectionUpdatedAt: null,
    };

    state.data.reports.unshift(report);
    saveLocal();
    showProgress(true, 'Saving to private data repo…');
    await flushPushImmediate();

    selectReport(report.id);
    renderHistory();
    toast(
      `Report for ${month} generated — ${fmtDayRange(rangeStart, rangeEnd)} (${slice.length} entries)` +
      (followups.length ? ` · ${followups.length} follow-up questions` : ''),
      'ok'
    );

    // The claims ledger used to depend on the user finding a button inside a
    // modal they had no reason to open, which is why it stayed empty through
    // every report ever generated. It runs here instead, off the journal we
    // already fetched. Non-fatal: the report is already saved and pushed.
    showProgress(true, 'Updating claim ledger…');
    await extractClaims({ entries, byDate: byDateOf(entries), silent: true });
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    showProgress(false);
  }
}

const byDateOf = (entries) => {
  const m = {};
  for (const e of entries) m[e.date] = e;
  return m;
};

// Immediate (awaited) push used right after generation.
async function flushPushImmediate() {
  setSync('busy', 'syncing…');
  try { await dataPushNow(); setSync('synced', 'synced'); }
  catch (e) { setSync('error', 'sync failed'); toast('Saved locally, sync failed: ' + e.message, 'err'); }
}

/* ================================================================ actions */
function selectReport(id) {
  state.currentId = id;
  localStorage.setItem(LS.lastId, id);
  const r = state.data.reports.find((x) => x.id === id);
  if (r) renderReport(r);
  renderHistory();
}

async function deleteCurrentReport() {
  const r = currentReport();
  if (!r) return;
  const ok = await confirmDialog('Delete report', `Delete the ${r.month} report from your data repo? This can't be undone.`);
  if (!ok) return;
  state.data.reports = state.data.reports.filter((x) => x.id !== r.id);
  // Tombstone, not just a local removal: sync is a union now, so a report that
  // merely vanished from this device would come straight back from any other
  // device that still had it cached.
  state.data.deleted.push({ id: r.id, at: new Date().toISOString() });
  saveLocal();
  state.currentId = null;
  showEmpty();
  renderHistory();
  await flushPushImmediate();
  toast('Report deleted.', 'ok');
}

// Exported markdown carries the coverage header, so a copied/downloaded report
// still states which month and exactly which days it was built from.
function reportMarkdown(r) {
  if (!r.rangeStart || !r.rangeEnd) return r.report;
  const header = [
    `<!-- ${r.month} · entries ${r.rangeStart} → ${r.rangeEnd} -->`,
    `**Month:** ${r.month}  `,
    `**Entries read:** ${r.rangeStart} → ${r.rangeEnd} (${r.entryCount || 0} entries)`,
    '',
    '---',
    '',
  ].join('\n');
  return header + r.report;
}
function copyCurrentReport() {
  const r = currentReport();
  if (!r) return;
  navigator.clipboard.writeText(reportMarkdown(r))
    .then(() => toast('Markdown copied.', 'ok'))
    .catch(() => toast('Copy failed.', 'err'));
}
function downloadCurrentReport() {
  const r = currentReport();
  if (!r) return;
  const blob = new Blob([reportMarkdown(r)], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (r.rangeStart && r.rangeEnd)
    ? `${r.month}_${r.rangeStart}_to_${r.rangeEnd}.md`
    : `${r.month}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}
function onReflectionInput() {
  const r = currentReport();
  if (!r) return;
  r.reflection = $('#reflection-input').value;
  r.reflectionUpdatedAt = new Date().toISOString();
  saveLocal();
  $('#reflection-status').textContent = 'saving…';
  clearTimeout(state.reflectionTimer);
  state.reflectionTimer = setTimeout(async () => {
    await flushPush();
    $('#reflection-status').textContent = 'saved';
  }, 1000);
}
function currentReport() { return state.data.reports.find((x) => x.id === state.currentId) || null; }

/* ================================================================ render */
function renderHistory() {
  const list = $('#history-list');
  const reports = state.data.reports;
  $('#history-count').textContent = reports.length;
  if (!reports.length) {
    list.innerHTML = '<li class="history-empty muted">No reports yet.</li>';
    return;
  }
  list.innerHTML = '';
  for (const r of reports) {
    const li = document.createElement('li');
    li.className = 'history-item' + (r.id === state.currentId ? ' active' : '');
    const modelLabel = r.provider ? `${providerLabel(r.provider)} · ${r.model}` : r.model;
    const range = (r.rangeStart && r.rangeEnd) ? fmtDayRange(r.rangeStart, r.rangeEnd) : '';
    li.innerHTML =
      `<span class="hi-month">${r.month}</span>` +
      `<span class="hi-sub">` +
      (range ? `<span>${range}</span>` : '') +
      `<span>${modelLabel}</span><span>${fmtDate(r.generatedAt)}</span>` +
      // Follow-ups are the main way answers get in now, so the list has to show
      // which reports still have questions waiting.
      (() => {
        const fu = r.followups || [];
        if (!fu.length) return '';
        const done = fu.filter((f) => f.a && f.a.trim()).length;
        return `<span>· ${done}/${fu.length} answered</span>`;
      })() +
      (r.reflection ? '<span>· reflected</span>' : '') + `</span>`;
    li.addEventListener('click', () => selectReport(r.id));
    list.appendChild(li);
  }
}

function renderReport(r) {
  if (!r) return showEmpty();
  $('#empty-state').classList.add('hidden');
  $('#report-view').classList.remove('hidden');
  // Month AND the exact span of days that went into the summary — the title
  // carries both so the covered dates are visible at a glance.
  const hasRange = !!(r.rangeStart && r.rangeEnd);
  $('#report-title').textContent = hasRange
    ? `${r.month} · ${fmtDayRange(r.rangeStart, r.rangeEnd)}`
    : `${r.month} · self-interrogation`;
  $('#meta-month').textContent = `month ${r.month}`;
  const rangeEl = $('#meta-range');
  if (hasRange) {
    rangeEl.textContent =
      `read ${r.rangeStart} → ${r.rangeEnd}${r.entryCount ? ` · ${r.entryCount} entries` : ''}`;
    rangeEl.classList.remove('hidden');
  } else if (r.entryCount) {
    rangeEl.textContent = `${r.entryCount} entries`;
    rangeEl.classList.remove('hidden');
  } else {
    rangeEl.textContent = '';
    rangeEl.classList.add('hidden');
  }
  const modelText = r.provider ? `${providerLabel(r.provider)} · ${r.model}` : r.model;
  $('#meta-model').textContent = modelText + (r.modelAuto ? ' (auto)' : '');
  $('#meta-date').textContent = fmtDate(r.generatedAt);
  const tags = $('#theme-tags');
  tags.innerHTML = '';
  (r.themes || []).slice(0, 6).forEach((t) => {
    const s = document.createElement('span');
    s.className = 'theme-tag';
    s.textContent = `${t.label} · ${t.score}`;
    tags.appendChild(s);
  });
  $('#report-body').innerHTML = mdToHtml(r.report);
  renderFollowups(r);
  $('#reflection-input').value = r.reflection || '';
  $('#reflection-status').textContent = r.reflectionUpdatedAt ? 'saved ' + fmtDate(r.reflectionUpdatedAt) : 'auto-saves';
}

/* ------------------------------------------------------- follow-up panel */
// Rebuilt wholesale on report switch. The textareas carry their id in a data
// attribute and are read by delegated handlers, so no per-question listeners
// have to be torn down when the list is replaced.
function renderFollowups(r) {
  const wrap = $('#followups');
  const list = $('#followup-list');
  const status = $('#followup-status');
  if (!wrap || !list) return;
  const fu = r.followups || [];
  const answered = fu.filter((f) => f.a && f.a.trim()).length;

  status.textContent = fu.length ? `${answered} of ${fu.length} answered` : '';
  if (!fu.length) {
    list.innerHTML =
      `<p class="muted followup-empty">No follow-up questions on this report. ` +
      `Use <strong>Ask follow-ups</strong> to generate a set — answers feed into every future report so the same ground is never re-covered.</p>`;
    return;
  }
  list.innerHTML = fu.map((f, i) => `
    <li class="followup${f.a && f.a.trim() ? ' is-answered' : ''}">
      <div class="fu-q">
        <span class="fu-n">${i + 1}</span>
        <div class="fu-qtext">
          ${f.theme ? `<span class="fu-theme">${escapeHtml(f.theme)}</span>` : ''}
          <span>${escapeHtml(f.q)}</span>
          ${f.why ? `<span class="fu-why muted">${escapeHtml(f.why)}</span>` : ''}
        </div>
      </div>
      <textarea class="fu-input" data-fu="${f.id}" rows="2"
        placeholder="short answer — a sentence or two is plenty">${escapeHtml(f.a || '')}</textarea>
    </li>`).join('');
}

function onFollowupInput(e) {
  const ta = e.target.closest('.fu-input');
  if (!ta) return;
  const r = currentReport();
  if (!r) return;
  const f = (r.followups || []).find((x) => x.id === ta.dataset.fu);
  if (!f) return;
  f.a = ta.value;
  f.answeredAt = f.a.trim() ? new Date().toISOString() : null;
  ta.closest('.followup').classList.toggle('is-answered', !!f.a.trim());
  const fu = r.followups || [];
  $('#followup-status').textContent =
    `${fu.filter((x) => x.a && x.a.trim()).length} of ${fu.length} answered · saving…`;
  saveLocal();
  clearTimeout(state.followupTimer);
  state.followupTimer = setTimeout(async () => {
    await flushPush();
    const n = (currentReport()?.followups || []);
    $('#followup-status').textContent = `${n.filter((x) => x.a && x.a.trim()).length} of ${n.length} answered · saved`;
  }, 1000);
}

// Generates an ADDITIONAL set for the current report. Existing questions and
// their answers are kept — this appends, so nothing already answered is lost.
async function askMoreFollowups() {
  const r = currentReport();
  if (!r) return;
  if (missingSecrets().includes('apikey')) {
    toast('Add the active provider\'s API key in Settings first.', 'err');
    openSettings();
    return;
  }
  const btn = $('#btn-followups');
  btn.disabled = true;
  showProgress(true, 'Fetching journal…');
  try {
    const entries = parseEntries(await githubFetchNotes());
    const slice = sliceForRange(entries, r.requestedStart || r.rangeStart, r.requestedEnd || r.rangeEnd);
    const provider = r.provider && PROVIDERS[r.provider] ? r.provider : activeProvider();
    const picked = await resolveModel(provider, (t) => showProgress(true, t));
    showProgress(true, 'Drafting follow-up questions…');
    // Existing questions join the do-not-repeat set even when unanswered, so a
    // second press produces genuinely new ground rather than a reshuffle.
    const existing = new Set((r.followups || []).map((f) => normQuote(f.q)));
    const fresh = (await generateFollowups(
      provider, picked.model, r.report, slice.length ? slice : entries, r.month,
      (m, fb) => showProgress(true, `${fb ? 'Falling back to' : 'Drafting questions with'} ${m}…`)
    )).filter((f) => !existing.has(normQuote(f.q)));

    if (!fresh.length) {
      toast('No new questions — the model had nothing left that your answers do not already cover.', '');
      return;
    }
    r.followups = [...(r.followups || []), ...fresh];
    saveLocal();
    renderFollowups(r);
    await flushPushImmediate();
    toast(`${fresh.length} new follow-up question${fresh.length === 1 ? '' : 's'}.`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    showProgress(false);
  }
}

function showEmpty() {
  $('#report-view').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
  updateChecklist();
}
function updateChecklist() {
  const miss = missingSecrets();
  $$('#setup-checklist li').forEach((li) => {
    li.classList.toggle('done', !miss.includes(li.dataset.check));
  });
}
function showProgress(on, text) {
  const p = $('#progress');
  p.classList.toggle('hidden', !on);
  if (text) $('#progress-text').textContent = text;
}

/* ================================================================= dates */
function prevMonthStr() {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthFirstDay(monthStr) {
  return `${monthStr}-01`;
}
function monthLastDay(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthStr}-${String(last).padStart(2, '0')}`;
}
// Reset the date range to span the whole selected month.
function syncRangeToMonth() {
  const month = $('#target-month').value || prevMonthStr();
  $('#range-start').value = monthFirstDay(month);
  $('#range-end').value = monthLastDay(month);
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
// Format a 'YYYY-MM-DD' entry date without constructing a Date (avoids UTC/local
// off-by-one). fmtDayRange renders the exact span of days included in a report.
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return dateStr || '';
  return `${MONTHS_ABBR[Number(m[2]) - 1]} ${Number(m[3])}`;
}
function fmtDayRange(a, b) {
  if (!a && !b) return '';
  if (!a) a = b;
  if (!b) b = a;
  const ya = a.slice(0, 4), yb = b.slice(0, 4);
  if (a === b) return `${fmtDay(a)}, ${ya}`;
  if (ya === yb) return `${fmtDay(a)} – ${fmtDay(b)}, ${yb}`;
  return `${fmtDay(a)}, ${ya} – ${fmtDay(b)}, ${yb}`;
}
function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/* ================================================================ theme */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(LS.theme, t);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ========================================================== claims ledger */
/* ----------------------------------------------------------------------------
   CLAIMS LEDGER
   ----------------------------------------------------------------------------
   Two kinds of falsifiable statement get mined out of the journal:
     forecast   — a claim about the world     ("nobody's going to use that")
     commitment — a claim about their own act ("going to ship the adapter")
   Forecasts score calibration; commitments score follow-through. Commitments
   are far denser in this journal and settle in days rather than quarters,
   which is what makes the ledger useful long before a calibration curve has
   enough points to mean anything.

   THREE RULES ENFORCED HERE IN CODE, NOT LEFT TO THE PROMPT:
     1. Every claim and every resolution must carry a quote that actually
        occurs in the entry it names; quoteIsReal() drops the rest. A model
        asked "did this come true?" against a journal with 20-day gaps will
        confabulate — a quote that has to survive a substring check cannot.
     2. A model verdict lands as `proposed` and scores nothing until the user
        confirms it. Silence in the journal is not evidence of anything.
     3. All arithmetic happens here. The model never computes a number.
--------------------------------------------------------------------------- */

const CLAIM_VERDICTS = ['right', 'wrong', 'partial'];
const isSettled = (c) => CLAIM_VERDICTS.includes(c.status);
// Resolved forecasts needed before the panel will talk about calibration. Below
// this it reports counts only: a Brier score off four predictions is noise
// wearing a decimal point.
const CALIBRATION_MIN = 10;

const todayStr = () => new Date().toISOString().slice(0, 10);
const normQuote = (q) => (q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const claimKey = (c) => `${c.sourceDate}|${normQuote(c.quote)}`;
function claimList() { return (state.data.claims = state.data.claims || []); }

/* --------------------------------------------------------------- prompts */
function buildLedgerSystemPrompt() {
  return [
    'You extract falsifiable claims from a private journal, and judge earlier claims against later entries.',
    'Output ONE JSON object and nothing else — no prose, no code fence, no explanation.',
    '',
    'Shape:',
    '{"claims":[{"type":"forecast|commitment","text":"","quote":"","sourceDate":"YYYY-MM-DD","dueDate":"YYYY-MM-DD or null","confidence":0.7,"domain":"","resolved":null}],',
    ' "resolutions":[{"id":"","verdict":"right|wrong|partial","evidence":"","evidenceDate":"YYYY-MM-DD"}]}',
    '',
    'CLAIMS — only statements that can later be judged true or false.',
    '- type "forecast": a claim about the world or about other people — "nobody will use that", "this breaks by Q3".',
    '- type "commitment": a claim about their own future action — "going to ship the adapter", "plan to cut caffeine".',
    '- quote MUST be copied verbatim from an entry, character for character. if you cannot quote it, do not emit it.',
    '- sourceDate is the date heading of the entry the quote came from.',
    '- dueDate: when it becomes judgeable. use their stated deadline; if none, estimate a conservative one. null only if genuinely open-ended.',
    '- confidence: how sure THEY sounded, not how sure you are. "no way" 0.05, "doubt it" 0.2, "might" 0.4, "probably" 0.7, "definitely" 0.95, flat unhedged statement 0.8.',
    '- domain: one short lowercase tag — ai, cyber, health, career, privacy, life.',
    '- skip pure logging ("went to the gym"), questions, and vague wishes with no testable outcome.',
    '- "resolved": if a LATER entry already settles a claim you are extracting right now, attach {"verdict":"","evidence":"","evidenceDate":""} here. otherwise null. the same evidence rules below apply.',
    '',
    'RESOLUTIONS — judge the OPEN CLAIMS listed in the user message against the entries.',
    '- resolve only when a later entry gives real evidence. evidence MUST be a verbatim quote, evidenceDate its entry date.',
    '- "right" it happened as claimed. "wrong" it did not. "partial" it happened late, partially, or in altered form.',
    '- silence is NOT evidence. if nothing in the entries speaks to a claim, leave it out. omitting is always the correct move when unsure.',
    '- never resolve a claim using the entry the claim came from.',
    '- reuse the id exactly as given.',
  ].join('\n');
}

function buildLedgerUserPrompt(entries, openClaims, today) {
  const body = entries.map((e) => `### ${e.date}\n${e.body}`).join('\n\n');
  const open = openClaims.length
    ? openClaims.map((c) => `- id=${c.id} [${c.type}] from ${c.sourceDate}, due ${c.dueDate || 'open-ended'} — ${c.text}`).join('\n')
    : '- (none yet)';
  return [
    `TODAY: ${today}`,
    '',
    '=== OPEN CLAIMS (judge these; omit any without real evidence) ===',
    open,
    '=== END OPEN CLAIMS ===',
    '',
    '=== JOURNAL ENTRIES ===',
    body || '(no entries found)',
    '=== END ENTRIES ===',
  ].join('\n');
}

/* ------------------------------------------------------------- ingestion */
function parseJsonLoose(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('The model returned prose instead of JSON. Try again, or pick a different model in Settings.');
  return JSON.parse(t.slice(s, e + 1));
}

// A quote the journal does not contain is a fabrication however plausible it
// reads. Compared on normalized text so punctuation drift doesn't false-reject;
// the length floor stops a two-word "quote" from matching half the file.
function quoteIsReal(byDate, dateStr, quote) {
  const e = byDate[dateStr];
  const q = normQuote(quote);
  return !!e && q.length >= 12 && normQuote(e.body).includes(q);
}

function clampConf(v) {
  // A MISSING confidence must land on 0.5, not 0. Number(null) is 0, which
  // would silently record "they were 1% sure" and poison the Brier score.
  if (v === null || v === undefined || v === '') return 0.5;
  const n = Number(v);
  if (!isFinite(n)) return 0.5;
  return Math.max(0.01, Math.min(0.99, n > 1 ? n / 100 : n));
}

// A claim can arrive already settled. On a backfill pass every claim is new,
// so nothing would be resolvable via the id-keyed `resolutions` list — the
// first run would return an empty scoreboard and demand a second click.
function attachInlineResolution(c, raw, byDate) {
  const r = raw && raw.resolved;
  if (!r || !CLAIM_VERDICTS.includes(r.verdict)) return false;
  const evidence = String(r.evidence || '').trim();
  const evidenceDate = String(r.evidenceDate || '').trim();
  if (!evidence || evidenceDate === c.sourceDate) return false;
  if (!quoteIsReal(byDate, evidenceDate, evidence)) return false;
  Object.assign(c, { status: 'proposed', proposedVerdict: r.verdict, evidence: evidence.slice(0, 400), evidenceDate });
  return true;
}

function mergeClaims(incoming, byDate) {
  const list = claimList();
  const seen = new Set(list.map(claimKey));
  let added = 0, dropped = 0, proposed = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const type = raw && raw.type;
    if (type !== 'forecast' && type !== 'commitment') { dropped++; continue; }
    const c = {
      id: 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      type,
      text: String(raw.text || '').trim().slice(0, 300),
      quote: String(raw.quote || '').trim().slice(0, 400),
      sourceDate: String(raw.sourceDate || '').trim(),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate || '') ? raw.dueDate : null,
      confidence: clampConf(raw.confidence),
      domain: String(raw.domain || '').trim().toLowerCase().slice(0, 16),
      status: 'open',
      evidence: '', evidenceDate: null, proposedVerdict: null,
      resolvedAt: null, extractedAt: new Date().toISOString(),
    };
    if (!c.text || !c.quote || !c.sourceDate) { dropped++; continue; }
    if (!quoteIsReal(byDate, c.sourceDate, c.quote)) { dropped++; continue; }
    if (seen.has(claimKey(c))) continue;          // already in the ledger
    if (attachInlineResolution(c, raw, byDate)) proposed++;
    seen.add(claimKey(c));
    list.push(c);
    added++;
  }
  return { added, dropped, proposed };
}

function applyProposals(incoming, byDate) {
  const byId = new Map(claimList().map((c) => [c.id, c]));
  let proposed = 0, dropped = 0;
  for (const r of Array.isArray(incoming) ? incoming : []) {
    const c = byId.get(String((r && r.id) || '').trim());
    if (!c || c.status !== 'open') continue;
    const verdict = CLAIM_VERDICTS.includes(r.verdict) ? r.verdict : null;
    const evidence = String(r.evidence || '').trim();
    const evidenceDate = String(r.evidenceDate || '').trim();
    if (!verdict || !evidence) { dropped++; continue; }
    // A claim cannot be its own evidence, and the evidence has to exist.
    if (evidenceDate === c.sourceDate) { dropped++; continue; }
    if (!quoteIsReal(byDate, evidenceDate, evidence)) { dropped++; continue; }
    c.status = 'proposed';
    c.proposedVerdict = verdict;
    c.evidence = evidence.slice(0, 400);
    c.evidenceDate = evidenceDate;
    proposed++;
  }
  return { proposed, dropped };
}

/* ------------------------------------------------------------ statistics */
// Deterministic. Partial credit counts as half, for both scoreboards.
function claimScore(c) { return c.status === 'right' ? 1 : c.status === 'partial' ? 0.5 : 0; }
// True median: on an even count, average the middle pair rather than taking
// the upper one (which reads as worse slip than actually happened).
function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function ledgerStats(list) {
  const settled = list.filter(isSettled);
  const f = settled.filter((c) => c.type === 'forecast');
  const m = settled.filter((c) => c.type === 'commitment');
  const mean = (a, fn) => (a.length ? a.reduce((s, x) => s + fn(x), 0) / a.length : null);

  const buckets = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]]
    .map(([lo, hi]) => {
      const inB = f.filter((c) => c.confidence >= lo && c.confidence < hi);
      return { lo, hi, n: inB.length, stated: mean(inB, (c) => c.confidence), actual: mean(inB, claimScore) };
    })
    .filter((b) => b.n);

  // Slip is only meaningful where both a deadline and a dated outcome exist.
  const slips = m
    .filter((c) => c.dueDate && c.evidenceDate)
    .map((c) => Math.round((new Date(c.evidenceDate + 'T00:00:00Z') - new Date(c.dueDate + 'T00:00:00Z')) / 864e5))
    .sort((a, b) => a - b);

  return {
    open: list.filter((c) => c.status === 'open').length,
    proposed: list.filter((c) => c.status === 'proposed').length,
    voided: list.filter((c) => c.status === 'void').length,
    forecastN: f.length,
    commitN: m.length,
    hit: mean(f, claimScore),
    brier: mean(f, (c) => Math.pow(c.confidence - claimScore(c), 2)),
    follow: mean(m, claimScore),
    buckets,
    medianSlip: slips.length ? median(slips) : null,
    calibrated: f.length >= CALIBRATION_MIN,
  };
}

/* ---------------------------------------------------------------- actions */
function setLedgerStatus(text) {
  const el = $('#ledger-status');
  if (el) el.textContent = text || '';
}
function persistLedger() {
  saveLocal();
  schedulePush();
}

/* ---------------------------------------------------------------------------
   Runs from the ledger button AND automatically after every report.

   `opts.entries` lets the report flow hand over the journal it already fetched
   rather than pulling it a second time. `opts.silent` keeps the automatic run
   from stealing the report's completion toast unless it actually found
   something — a "0 new" popup after every report is noise.
--------------------------------------------------------------------------- */
async function extractClaims(opts = {}) {
  const miss = missingSecrets();
  if (miss.length) {
    if (!opts.silent) { toast('Missing keys: ' + miss.join(', ') + '. Opening Settings.', 'err'); openSettings(); }
    return;
  }
  const btn = $('#btn-extract');
  if (btn) btn.disabled = true;
  try {
    let entries = opts.entries;
    let byDate = opts.byDate;
    if (!entries) {
      setLedgerStatus('Fetching journal…');
      entries = parseEntries(await githubFetchNotes());
      byDate = byDateOf(entries);
    }
    if (!entries.length) throw new Error(`No dated entries found in ${cfg().notesPath}.`);

    // The whole journal, not a month: January's claims are settled by July's
    // entries, so a month-scoped pass would leave nearly everything open.
    const open = claimList().filter((c) => c.status === 'open');
    const provider = activeProvider();
    const picked = await resolveModel(provider, setLedgerStatus);
    setLedgerStatus(`Reading ${entries.length} entries with ${picked.model}…`);
    const gen = await providerGenerate(
      provider, picked.model, buildLedgerSystemPrompt(),
      buildLedgerUserPrompt(entries, open, todayStr()),
      (m, fb) => setLedgerStatus(`${fb ? 'Falling back to' : 'Reading with'} ${m}…`)
    );

    const out = parseJsonLoose(gen.text);
    const merged = mergeClaims(out.claims, byDate);
    const applied = applyProposals(out.resolutions, byDate);
    const found = merged.added + merged.proposed + applied.proposed;
    if (found) { persistLedger(); renderLedger(); }
    else renderLedger();

    const dropped = merged.dropped + applied.dropped;
    const toJudge = merged.proposed + applied.proposed;
    // Silence only the boring case. A silent run that DID find claims still
    // says so, otherwise the ledger quietly grows and nothing points at it.
    if (!opts.silent || found) {
      toast(
        `Ledger: ${merged.added} new · ${toJudge} to judge` +
        (dropped ? ` · ${dropped} rejected (no matching quote)` : ''),
        'ok'
      );
    }
    // A model that returns nothing at all is the single most confusing outcome,
    // because it is indistinguishable from the feature being broken. Say which
    // it is, and point at the likeliest cause.
    if (!found && !merged.dropped && !applied.dropped && !opts.silent) {
      const total = claimList().length;
      toast(
        total
          ? 'No NEW claims found — everything quotable is already in the ledger.'
          : `${picked.model} found no forecasts or commitments to track. Weaker models often return none here; try a stronger model in Settings.`,
        ''
      );
    }
    setLedgerStatus('');
  } catch (e) {
    setLedgerStatus('');
    if (!opts.silent) toast(e.message, 'err');
    else console.warn('automatic claim extraction failed:', e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function setVerdict(id, verdict) {
  const c = claimList().find((x) => x.id === id);
  if (!c) return;
  if (verdict === 'open') {
    Object.assign(c, { status: 'open', proposedVerdict: null, evidence: '', evidenceDate: null, resolvedAt: null });
  } else if (verdict === 'void') {
    Object.assign(c, { status: 'void', resolvedAt: new Date().toISOString() });
  } else if (CLAIM_VERDICTS.includes(verdict)) {
    Object.assign(c, { status: verdict, resolvedAt: new Date().toISOString() });
  }
  persistLedger();
  renderLedger();
}

/* ----------------------------------------------------------------- render */
const pct = (v) => (v === null ? '—' : Math.round(v * 100) + '%');

function claimRow(c) {
  const conf = Math.round(c.confidence * 100) + '%';
  const due = c.dueDate ? ` · due ${fmtDay(c.dueDate)}` : '';
  const overdue = c.status === 'open' && c.dueDate && c.dueDate < todayStr();
  const ev = c.evidence
    ? `<div class="claim-ev"><span class="ev-date">${fmtDay(c.evidenceDate)}</span>${escapeHtml(c.evidence)}</div>`
    : '';
  const actions = c.status === 'proposed'
    ? `<div class="claim-actions">
         <span class="muted">model says <strong>${c.proposedVerdict}</strong> —</span>
         <button class="btn btn-mini ok" data-claim="${c.id}" data-verdict="${c.proposedVerdict}">accept</button>
         <button class="btn btn-mini" data-claim="${c.id}" data-verdict="${c.proposedVerdict === 'right' ? 'wrong' : 'right'}">no, ${c.proposedVerdict === 'right' ? 'wrong' : 'right'}</button>
         <button class="btn btn-mini" data-claim="${c.id}" data-verdict="partial">partial</button>
         <button class="btn btn-mini" data-claim="${c.id}" data-verdict="open">reject</button>
       </div>`
    : c.status === 'open'
      ? `<div class="claim-actions">
           <button class="btn btn-mini ok" data-claim="${c.id}" data-verdict="right">right</button>
           <button class="btn btn-mini" data-claim="${c.id}" data-verdict="wrong">wrong</button>
           <button class="btn btn-mini" data-claim="${c.id}" data-verdict="partial">partial</button>
           <button class="btn btn-mini" data-claim="${c.id}" data-verdict="void">not a claim</button>
         </div>`
      : `<div class="claim-actions">
           <span class="verdict v-${c.status}">${c.status}</span>
           <button class="btn btn-mini" data-claim="${c.id}" data-verdict="open">reopen</button>
         </div>`;
  return `<li class="claim s-${c.status}${overdue ? ' overdue' : ''}">
    <div class="claim-top">
      <span class="claim-type t-${c.type}">${c.type}</span>
      <span class="claim-conf" title="how sure they sounded">${conf}</span>
      ${c.domain ? `<span class="claim-domain">${escapeHtml(c.domain)}</span>` : ''}
      <span class="claim-when">${fmtDay(c.sourceDate)}${due}${overdue ? ' · overdue' : ''}</span>
    </div>
    <p class="claim-text">${escapeHtml(c.text)}</p>
    <blockquote class="claim-quote">${escapeHtml(c.quote)}</blockquote>
    ${ev}
    ${actions}
  </li>`;
}

function statsBlock(s) {
  const cal = s.calibrated
    ? `<div class="stat"><span class="stat-n">${s.brier.toFixed(2)}</span><span class="stat-l">Brier score</span></div>` +
      s.buckets.map((b) => {
        const gap = b.stated - b.actual;
        const verdict = Math.abs(gap) < 0.1 ? 'calibrated' : gap > 0 ? 'overconfident' : 'underconfident';
        return `<div class="bucket"><span>${Math.round(b.lo * 100)}–${Math.round(Math.min(b.hi, 1) * 100)}%</span>
          <span class="muted">said ${pct(b.stated)}, hit ${pct(b.actual)} (n=${b.n})</span>
          <span class="bucket-v v-${verdict}">${verdict}</span></div>`;
      }).join('')
    : `<p class="muted cal-gate">Calibration needs ${CALIBRATION_MIN} settled forecasts to say anything honest — ${s.forecastN} so far. Counts only until then.</p>`;

  return `<div class="ledger-stats">
    <div class="stat-row">
      <div class="stat"><span class="stat-n">${pct(s.follow)}</span><span class="stat-l">follow-through<br><em>${s.commitN} commitments</em></span></div>
      <div class="stat"><span class="stat-n">${pct(s.hit)}</span><span class="stat-l">forecast hit rate<br><em>${s.forecastN} settled</em></span></div>
      <div class="stat"><span class="stat-n">${s.medianSlip === null ? '—' : (s.medianSlip > 0 ? '+' : '') + s.medianSlip + 'd'}</span><span class="stat-l">median slip<br><em>vs own deadline</em></span></div>
      <div class="stat"><span class="stat-n">${s.open}</span><span class="stat-l">open<br><em>${s.proposed} to judge</em></span></div>
    </div>
    ${cal}
  </div>`;
}

function renderLedger() {
  const list = claimList();
  const s = ledgerStats(list);
  const body = $('#ledger-body');
  if (!body) return;

  if (!list.length) {
    body.innerHTML = statsBlock(s) +
      `<p class="ledger-empty muted">No claims yet. <strong>Extract from journal</strong> reads the whole file at once —
       claims made in January are often already settled by entries from July, so the first pass usually returns
       settled rows, not an empty table.</p>`;
    return;
  }

  const proposed = list.filter((c) => c.status === 'proposed');
  const open = list.filter((c) => c.status === 'open')
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const settled = list.filter((c) => isSettled(c) || c.status === 'void')
    .sort((a, b) => (b.resolvedAt || '').localeCompare(a.resolvedAt || ''));

  const group = (title, arr, cls = '') => arr.length
    ? `<h3 class="ledger-group ${cls}">${title} <span class="muted">${arr.length}</span></h3><ul class="claim-list">${arr.map(claimRow).join('')}</ul>`
    : '';

  body.innerHTML = statsBlock(s) +
    group('Needs your call', proposed, 'is-hot') +
    group('Open', open) +
    group('Settled', settled.slice(0, 30));
}

function openLedger() {
  $('#ledger-modal').classList.remove('hidden');
  renderLedger();
}
function closeLedger() { $('#ledger-modal').classList.add('hidden'); }

/* =============================================================== toasts */
function toast(msg, kind = '') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const ico = kind === 'ok' ? '✓' : kind === 'err' ? '✕' : 'ℹ';
  el.innerHTML = `<span class="toast-ico">${ico}</span><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, kind === 'err' ? 6000 : 3800);
}

/* =========================================================== confirm modal */
function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    modal.classList.remove('hidden');
    const cleanup = (val) => {
      modal.classList.add('hidden');
      $('#confirm-ok').removeEventListener('click', ok);
      $('#confirm-cancel').removeEventListener('click', cancel);
      resolve(val);
    };
    const ok = () => cleanup(true);
    const cancel = () => cleanup(false);
    $('#confirm-ok').addEventListener('click', ok);
    $('#confirm-cancel').addEventListener('click', cancel);
  });
}

/* ============================================================ settings UI */
// Refill the directive on open: it syncs, so another device may have changed it
// since this modal was last built.
function openSettings() {
  fillAdvicePrompt();
  $('#settings-modal').classList.remove('hidden');
}
function closeSettings() { $('#settings-modal').classList.add('hidden'); }

/* ------------------------------------------------------- advice directive */
function fillAdvicePrompt() {
  const ta = $('#set-advice-prompt');
  if (!ta) return;
  ta.value = advicePrompt();
  updateAdviceMeta();
}
function updateAdviceMeta() {
  const ta = $('#set-advice-prompt');
  const state$ = $('#advice-state');
  const count = $('#advice-count');
  if (!ta) return;
  if (state$) state$.textContent = adviceIsCustom() ? '· customized' : '· default';
  if (count) count.textContent = `${ta.value.length} chars`;
}
function onAdviceInput() {
  setAdvicePrompt($('#set-advice-prompt').value);
  updateAdviceMeta();
}
function resetAdvicePrompt() {
  setAdvicePrompt('');
  fillAdvicePrompt();
  toast('Advice directive reset to the default.', 'ok');
}

const CUSTOM_MODEL = '__custom__';

function fillSettings() {
  const c = cfg();
  $('#set-github-token').value = c.githubToken;
  $('#set-data-token').value = c.dataToken;
  $('#set-provider').value = activeProvider();
  $('#set-openai-key').value = c.openaiKey;
  $('#set-anthropic-key').value = c.anthropicKey;
  $('#set-gemini-key').value = c.geminiKey;
  $('#set-repo').value = c.repo;
  $('#set-notes-path').value = c.notesPath;
  $('#set-branch').value = c.branch;
  $('#set-data-repo').value = c.dataRepo;
  $('#set-data-path').value = c.dataPath;
  $('#set-data-branch').value = c.dataBranch;
  fillAdvicePrompt();
  syncProviderUI();
}

// Show ONLY the API key field belonging to the selected provider, then rebuild
// the model picker for it.
function syncProviderUI() {
  const provider = activeProvider();
  $$('[data-provider-key]').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.providerKey !== provider);
  });
  populateModelOptions(provider);
}

// Rebuild the model dropdown. Always offers Auto + Custom; real model ids come
// from the cached discovery list. With no key we show ONLY Auto/Custom plus a
// hint — rendering the static fallback chain here would present hardcoded
// constants as if they were live data from the vendor.
function populateModelOptions(provider = activeProvider()) {
  const sel = $('#set-model');
  if (!sel) return;
  const pinned = pinnedModel(provider);
  const key = providerKey(provider);
  let discovered = [];
  if (key) {
    try {
      const raw = localStorage.getItem(discoveryCacheKey(provider, key));
      const hit = raw ? JSON.parse(raw) : null;
      if (hit && Array.isArray(hit.models)) discovered = hit.models.map((m) => m.id);
    } catch { /* ignore a corrupt cache entry */ }
  }

  sel.innerHTML = '';
  const addOpt = (value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    sel.appendChild(o);
    return o;
  };
  addOpt('', 'Auto (newest available)');
  discovered.forEach((m) => addOpt(m, m));
  // A pinned model that isn't in the discovered list still needs an entry.
  if (pinned && !discovered.includes(pinned)) addOpt(pinned, pinned);
  addOpt(CUSTOM_MODEL, 'Custom…');
  sel.value = pinned || '';

  const custom = $('#set-model-custom');
  if (custom) { custom.value = ''; custom.classList.add('hidden'); }
  updateModelHint(provider, discovered.length);
}

function updateModelHint(provider = activeProvider(), count = null) {
  const el = $('#model-hint');
  if (!el) return;
  const p = PROVIDERS[provider];
  if (!providerKey(provider)) {
    el.textContent = `Add your ${p.label} API key to load the models it can access.`;
    return;
  }
  const pinned = pinnedModel(provider);
  if (pinned) { el.textContent = `Pinned to ${pinned}. Choose Auto to always use the newest.`; return; }
  el.textContent = count
    ? `Auto picks the newest of ${count} models your key can access. Refresh to re-check.`
    : 'Auto picks the newest model your key can access. Hit Refresh to load the list.';
}

function flashSaved() {
  const el = $('#settings-saved');
  el.textContent = 'saved ✓';
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => (el.textContent = 'changes auto-save'), 1200);
}

// Manual refresh: force a live re-discovery for the active provider.
async function refreshModels() {
  const provider = activeProvider();
  if (!providerKey(provider)) { toast(`Add your ${providerLabel(provider)} API key first.`, 'err'); return; }
  const btn = $('#btn-refresh-models');
  btn.disabled = true; const prev = btn.textContent; btn.textContent = '…';
  try {
    const models = await discoverModels(provider, providerKey(provider), { force: true });
    populateModelOptions(provider);   // reads the cache we just wrote
    toast(`Loaded ${models.length} ${providerLabel(provider)} models.`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally { btn.disabled = false; btn.textContent = prev; }
}

async function testConnections() {
  const box = $('#test-results');
  box.innerHTML = '';
  const line = (label) => {
    const el = document.createElement('div');
    el.className = 'test-line pending';
    el.innerHTML = `<span class="t-dot"></span><span>${label}: testing…</span>`;
    box.appendChild(el);
    return el;
  };
  const done = (el, ok, msg) => { el.className = 'test-line ' + (ok ? 'ok' : 'fail'); el.querySelector('span:last-child').textContent = msg; };

  const tGh = line('Journal token');
  try {
    const r = await fetch('https://api.github.com/user', { headers: journalHeaders() });
    if (!r.ok) throw new Error(r.status);
    const u = await r.json();
    done(tGh, true, `Journal token: ok (@${u.login})`);
  } catch (e) { done(tGh, false, `Journal token: failed (${e.message})`); }

  const tRepo = line('Notes file');
  try {
    const { repo, notesPath, branch } = cfg();
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${encPath(notesPath)}?ref=${encodeURIComponent(branch)}`, { headers: journalHeaders() });
    done(tRepo, r.ok, r.ok ? `Notes file: ok (${notesPath})` : `Notes file: failed (${r.status})`);
  } catch (e) { done(tRepo, false, 'Notes file: failed'); }

  const tData = line('Data token');
  try {
    const r = await fetch('https://api.github.com/user', { headers: dataHeaders() });
    if (!r.ok) throw new Error(r.status);
    const u = await r.json();
    done(tData, true, `Data token: ok (@${u.login})`);
  } catch (e) { done(tData, false, `Data token: failed (${e.message})`); }

  // Separate line from the token check: the token can be valid while simply not
  // having this repo selected, which is the likeliest setup mistake.
  const tDataRepo = line('Data repo');
  try {
    const { dataRepo, dataPath, dataBranch } = cfg();
    const r = await fetch(`https://api.github.com/repos/${dataRepo}`, { headers: dataHeaders() });
    if (!r.ok) throw new Error(`${dataRepo} not reachable (${r.status})`);
    const f = await fetch(`https://api.github.com/repos/${dataRepo}/contents/${encPath(dataPath)}?ref=${encodeURIComponent(dataBranch)}`, { headers: dataHeaders() });
    // 404 here is fine and expected before the first sync creates the file.
    done(tDataRepo, true, f.ok
      ? `Data repo: ok (${dataPath} found)`
      : `Data repo: ok (${dataPath} not created yet — first sync will make it)`);
  } catch (e) { done(tDataRepo, false, `Data repo: failed (${e.message})`); }

  // Only the ACTIVE provider is tested — that's the key a report will use.
  const provider = activeProvider();
  const tGen = line(`${providerLabel(provider)} key`);
  try {
    const models = await discoverModels(provider, providerKey(provider), { force: true });
    populateModelOptions(provider);
    const pick = pinnedModel(provider) || (models[0] && models[0].id) || PROVIDERS[provider].fallbacks[0];
    done(tGen, true, `${providerLabel(provider)} key: ok (${models.length} models · will use ${pick})`);
  } catch (e) { done(tGen, false, `${providerLabel(provider)} key: failed (${e.message})`); }
}

/* ============================================================ password gate */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function isLocked() { return !!localStorage.getItem(LS.passHash); }
function showLock() {
  $('#lock-screen').classList.remove('hidden');
  $('#app').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#lock-input').focus(), 50);
}
function hideLock() {
  $('#lock-screen').classList.add('hidden');
  $('#app').removeAttribute('aria-hidden');
  document.body.style.overflow = '';
}

/* ==================================================================== init */
function bindSettingsInputs() {
  const map = {
    'set-github-token': 'githubToken',
    'set-data-token': 'dataToken',
    'set-openai-key': 'openaiKey',
    'set-anthropic-key': 'anthropicKey',
    'set-gemini-key': 'geminiKey',
    'set-repo': 'repo',
    'set-notes-path': 'notesPath',
    'set-branch': 'branch',
    'set-data-repo': 'dataRepo',
    'set-data-path': 'dataPath',
    'set-data-branch': 'dataBranch',
  };
  for (const [id, key] of Object.entries(map)) {
    $('#' + id).addEventListener('input', (e) => {
      setCfg(key, e.target.value.trim());
      flashSaved();
      updateChecklist();
      // A newly-entered key changes what the model picker can offer.
      if (/^set-(openai|anthropic|gemini)-key$/.test(id)) populateModelOptions();
    });
  }

  // Provider switch: swap which key field is visible and rebuild the models.
  $('#set-provider').addEventListener('change', (e) => {
    setCfg('activeProvider', e.target.value);
    syncProviderUI();
    flashSaved();
    updateChecklist();
  });

  $('#set-model').addEventListener('change', (e) => {
    const custom = $('#set-model-custom');
    if (e.target.value === CUSTOM_MODEL) {
      custom.classList.remove('hidden');
      custom.focus();
      return;                       // nothing stored until they type an id
    }
    custom.classList.add('hidden');
    custom.value = '';
    // Blank stays blank in storage — that is what keeps Auto working.
    setCfg(PROVIDERS[activeProvider()].modelCfg, e.target.value);
    updateModelHint();
    flashSaved();
  });

  $('#set-model-custom').addEventListener('input', (e) => {
    setCfg(PROVIDERS[activeProvider()].modelCfg, e.target.value.trim());
    updateModelHint();
    flashSaved();
  });

  // Password: hash and store on blur/change if non-empty.
  $('#set-password').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (!v) return;
    const hash = await sha256Hex(v);
    localStorage.setItem(LS.passHash, hash);
    e.target.value = '';
    toast('Passphrase set for this device.', 'ok');
    flashSaved();
  });
  $('#btn-clear-password').addEventListener('click', () => {
    localStorage.removeItem(LS.passHash);
    toast('Passphrase removed.', 'ok');
  });
}

function bindReveal() {
  $$('.reveal-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById(btn.dataset.reveal);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
  });
}

function init() {
  loadCfg();

  // Theme (respect stored pref, else system).
  const storedTheme = localStorage.getItem(LS.theme);
  applyTheme(storedTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

  // Restore cached Gist data for instant offline view. The cache is a starting
  // point, never the truth — the sync on open merges it against the Gist.
  try {
    const cached = localStorage.getItem(LS.cache);
    if (cached) state.data = normalizeData(JSON.parse(cached));
  } catch { /* ignore */ }
  state.dirty = localStorage.getItem(LS.dirty) === '1';

  // Defaults for controls.
  $('#target-month').value = prevMonthStr();
  syncRangeToMonth();
  fillSettings();
  bindSettingsInputs();
  bindReveal();
  updateChecklist();
  renderHistory();

  // Restore last-viewed report if present.
  const lastId = localStorage.getItem(LS.lastId);
  if (lastId && state.data.reports.find((r) => r.id === lastId)) selectReport(lastId);

  // Top bar.
  $('#btn-sync').addEventListener('click', cloudSync);
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-settings').addEventListener('click', openSettings);
  $$('[data-close-settings]').forEach((el) => el.addEventListener('click', closeSettings));
  $$('[data-open-settings]').forEach((el) => el.addEventListener('click', openSettings));

  // Claims ledger. Verdict buttons are delegated — rows are re-rendered on
  // every change, so per-button listeners would be rebound constantly.
  $('#btn-ledger').addEventListener('click', openLedger);
  $$('[data-close-ledger]').forEach((el) => el.addEventListener('click', closeLedger));
  // Arrow-wrapped: a bare listener hands extractClaims the click Event as its
  // options object, which is harmless today but silently wrong the moment an
  // option name collides with an Event property.
  $('#btn-extract').addEventListener('click', () => extractClaims());
  $('#ledger-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-claim]');
    if (btn) setVerdict(btn.dataset.claim, btn.dataset.verdict);
  });

  // Generate + report actions.
  $('#target-month').addEventListener('change', syncRangeToMonth);
  $('#btn-generate').addEventListener('click', generateReport);
  $('#btn-copy').addEventListener('click', copyCurrentReport);
  $('#btn-download').addEventListener('click', downloadCurrentReport);
  $('#btn-delete').addEventListener('click', deleteCurrentReport);
  $('#reflection-input').addEventListener('input', onReflectionInput);

  // Follow-ups. Delegated — the list is rebuilt on every report switch.
  $('#btn-followups').addEventListener('click', askMoreFollowups);
  $('#followup-list').addEventListener('input', onFollowupInput);

  // Settings actions.
  $('#btn-refresh-models').addEventListener('click', refreshModels);
  $('#btn-test').addEventListener('click', testConnections);
  $('#set-advice-prompt').addEventListener('input', onAdviceInput);
  $('#btn-reset-advice').addEventListener('click', resetAdvicePrompt);

  // Esc closes whichever modal is open.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSettings(); closeLedger(); } });

  // Password gate.
  if (isLocked()) {
    showLock();
    $('#lock-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const hash = await sha256Hex($('#lock-input').value);
      if (hash === localStorage.getItem(LS.passHash)) {
        hideLock(); onUnlocked();
      } else {
        $('#lock-error').classList.remove('hidden');
        $('#lock-input').value = '';
      }
    });
  } else {
    onUnlocked();
  }

  setSync('', 'not synced');
}

// Runs once the app is visible (after unlock, or immediately if no lock).
function onUnlocked() {
  // Auto cloud-sync on open if secrets are present.
  if (canSync()) {
    cloudSync();
  }
}

document.addEventListener('DOMContentLoaded', init);
