/* ============================================================================
   Monthly Self-Interrogation Agent — application logic (vanilla JS, no deps)
   ----------------------------------------------------------------------------
   PRIVACY MODEL (confirmed):
     • Pure client-side. No backend server. Runs entirely in the browser.
     • The parent repository holding the private daily-journal markdown stays
       100% PRIVATE. Only the static files in this `docs/` folder are public.
     • All persistent data (reports + metadata) lives in a PRIVATE GitHub Gist
       as JSON. The Gist stays PRIVATE.
     • Secrets (GitHub token, Gist ID, per-provider API keys, selected provider
       + model) are kept EXCLUSIVELY in this browser's localStorage. They are
       NEVER written into any file in this public `docs/` folder — only sent
       directly over HTTPS to api.github.com and, for the selected provider,
       one of api.openai.com / api.anthropic.com / generativelanguage.googleapis.com.
   ========================================================================== */

'use strict';

/* -------------------------------------------------------------- constants */
const GIST_FILE = 'monthly-reports.json';
// One localStorage key per provider per field, so switching the active provider
// never loses the other providers' keys. API keys are DEVICE-LOCAL ONLY and are
// never written into state.data / the Gist (see gistPushNow).
const LS = {
  githubToken:    'msi.githubToken',
  gistId:         'msi.gistId',
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
  gistCache:      'msi.gistCache',
  lastId:         'msi.lastId',
};
// Gist ID pre-filled from the private gist provided by the user.
// NOTE on the *Model defaults: blank means "Auto" — resolved against the live
// discovery list at request time, never frozen into storage. Writing a
// hardcoded "latest model" here would go stale the moment a vendor ships
// something new, and would silently pin the user forever.
const DEFAULTS = {
  githubToken:    '',
  gistId:         'ead6fb9238714dfc51d0b3fea495e899',
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
  pushInFlight: null,
  models: null,
};

function emptyData() {
  return { app: 'monthly-self-interrogation', version: 1, updatedAt: null, reports: [] };
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
  if (!c.gistId)      miss.push('gist');
  if (!providerKey()) miss.push('apikey');   // the ACTIVE provider's key
  return miss;
}

/* ================================================================= GitHub */
function ghHeaders(accept = 'application/vnd.github+json') {
  return {
    Authorization: `Bearer ${cfg().githubToken}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

/* ---------------------------------------------------------------------------
   REPO ACCESS IS READ-ONLY  ·  the app performs NO repo writes at all
   ---------------------------------------------------------------------------
   This app never writes to the repository. It only READs the daily journal
   (2026/2026daily_pt1.md) via GET. The former "Commit to repo" feature was
   removed, so there is no PUT/PATCH/DELETE against any repo path anywhere in
   this file. The only GitHub writes performed are PATCHes to the private GIST
   (gistPushNow). Pair this with a token scoped to Contents:Read-only so GitHub
   itself rejects any repo write, journal included.
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
  const res = await fetch(url, { headers: ghHeaders() });
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
    const b = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${j.sha}`, { headers: ghHeaders() });
    if (b.ok) {
      const bj = await b.json();
      if (bj && bj.content && bj.encoding === 'base64') return b64DecodeUnicode(bj.content);
    }
  }
  throw new Error('Could not read notes content from GitHub (unexpected response shape).');
}

async function gistPull() {
  const { gistId } = cfg();
  const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, { headers: ghHeaders() });
  if (!res.ok) {
    if (res.status === 404) throw new Error('Gist not found. Check the Gist ID and that your token can read it.');
    throw new Error(`Gist read failed (${res.status}).`);
  }
  const j = await res.json();
  const file = j.files?.[GIST_FILE];
  if (!file) return emptyData();
  let content = file.content;
  if (file.truncated && file.raw_url) content = await (await fetch(file.raw_url)).text();
  try {
    const parsed = JSON.parse(content);
    if (!parsed.reports) parsed.reports = [];
    return parsed;
  } catch {
    // File exists but isn't our JSON yet — start fresh (won't clobber until push).
    return emptyData();
  }
}

async function gistPushNow() {
  const { gistId } = cfg();
  state.data.updatedAt = new Date().toISOString();
  const body = { files: { [GIST_FILE]: { content: JSON.stringify(state.data, null, 2) } } };
  const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, {
    method: 'PATCH', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `Gist write failed (${res.status}). Token needs Gists:write.`);
  }
  localStorage.setItem(LS.gistCache, JSON.stringify(state.data));
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
    '  - close with a `### stop doing` block: one tempting, lower-value activity to cut, defer, or cap — and what it frees up.',
    '  - practical only. no pep talk, no advice the entries do not support.',
    '',
    'Rules: output only the report as Markdown. no preamble, no closing note. exactly the eight `##` sections above, in that order. every question goes on its own line as a list item.',
  ].join('\n');
}

function buildUserPrompt(monthStr, slice, themes, loops, priorContext) {
  const themeLine = themes.length
    ? themes.map((t) => `${t.label} (${t.score})`).join(', ')
    : 'none detected locally';
  const loopBlock = loops.length ? loops.map((l) => `- ${l}`).join('\n') : '- (none auto-detected)';
  const body = slice.map((e) => `### ${e.date}${e.title ? ' ' + e.title : ''}\n${e.body}`).join('\n\n');
  return [
    `TARGET MONTH: ${monthStr} (entries below cover the selected date range; may extend outside the month).`,
    `LOCALLY DETECTED THEMES (weight): ${themeLine}`,
    `LOCALLY DETECTED OPEN LOOPS / UNFINISHED:`,
    loopBlock,
    '',
    // Their own answers to earlier reports — the entries alone are terse, so
    // this is where accumulated context lives. Do not re-ask what it answers.
    '=== ESTABLISHED CONTEXT (their own answers to earlier reports) ===',
    (priorContext || []).join('\n\n') || '(none yet)',
    '=== END ESTABLISHED CONTEXT ===',
    '',
    '=== JOURNAL ENTRIES ===',
    body || '(no entries found)',
    '=== END ENTRIES ===',
  ].join('\n');
}

/* ============================================================ base64 utf8 */
// GitHub returns base64 with embedded newlines; strip whitespace, then decode
// as UTF-8 (atob alone mangles multi-byte chars like em dashes / arrows).
// (Read-only: only a DECODER is needed — the app never encodes/writes repo files.)
function b64DecodeUnicode(b64) {
  const bin = atob((b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
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
function scheduleGistPush() {
  setSync('dirty', 'unsynced');
  clearTimeout(state.pushTimer);
  state.pushTimer = setTimeout(flushGistPush, 1200);
}
async function flushGistPush() {
  clearTimeout(state.pushTimer);
  if (state.pushInFlight) return state.pushInFlight;
  setSync('busy', 'syncing…');
  state.pushInFlight = (async () => {
    try { await gistPushNow(); setSync('synced', 'synced'); }
    catch (e) { setSync('error', 'sync failed'); toast(e.message, 'err'); }
    finally { state.pushInFlight = null; }
  })();
  return state.pushInFlight;
}

async function cloudSync() {
  if (missingSecrets().includes('token') || missingSecrets().includes('gist')) {
    toast('Add your GitHub token and Gist ID in Settings first.', 'err');
    openSettings();
    return;
  }
  setSync('busy', 'syncing…');
  try {
    await flushGistPush();                 // push any pending local edits first
    state.data = await gistPull();          // then pull remote truth
    localStorage.setItem(LS.gistCache, JSON.stringify(state.data));
    renderHistory();
    if (state.currentId && !state.data.reports.find((r) => r.id === state.currentId)) {
      state.currentId = null; showEmpty();
    } else if (state.currentId) {
      renderReport(state.data.reports.find((r) => r.id === state.currentId));
    }
    setSync('synced', 'synced');
    toast('Synced with private Gist.', 'ok');
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

    // Reflections written against earlier reports, newest first (reports are
    // unshifted, and this one isn't stored yet). Rolling window of 3 keeps the
    // token cost bounded; older answers age out.
    const priorContext = state.data.reports
      .filter((r) => r.reflection && r.reflection.trim())
      .slice(0, 3)
      .map((r) => `[${r.month}] ${r.reflection.trim()}`);

    // slice is sorted ascending, so first/last entries bound what was read.
    const rangeStart = slice[0].date;
    const rangeEnd = slice[slice.length - 1].date;

    // Auto (blank) resolves against the live model list here, per request —
    // never frozen into storage.
    const picked = await resolveModel(provider, (t) => showProgress(true, t));
    const model = picked.model;

    showProgress(true, `Interrogating ${model}…`);
    const gen = await providerGenerate(
      provider, model, buildSystemPrompt(), buildUserPrompt(month, slice, themes, loops, priorContext),
      (m, isFallback) => showProgress(true, `${isFallback ? 'Falling back to' : 'Interrogating'} ${m}…`)
    );
    const reportMd = gen.text;
    if (gen.fellBack) toast(`"${model}" unavailable — used "${gen.model}" instead.`, 'ok');

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
      reflection: '',
      reflectionUpdatedAt: null,
    };

    state.data.reports.unshift(report);
    localStorage.setItem(LS.gistCache, JSON.stringify(state.data));
    showProgress(true, 'Saving to private Gist…');
    await flushGistPushImmediate();

    selectReport(report.id);
    renderHistory();
    toast(`Report for ${month} generated — ${fmtDayRange(rangeStart, rangeEnd)} (${slice.length} entries).`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    showProgress(false);
  }
}

// Immediate (awaited) push used right after generation.
async function flushGistPushImmediate() {
  setSync('busy', 'syncing…');
  try { await gistPushNow(); setSync('synced', 'synced'); }
  catch (e) { setSync('error', 'sync failed'); toast('Saved locally, Gist push failed: ' + e.message, 'err'); }
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
  const ok = await confirmDialog('Delete report', `Delete the ${r.month} report from the Gist? This can't be undone.`);
  if (!ok) return;
  state.data.reports = state.data.reports.filter((x) => x.id !== r.id);
  localStorage.setItem(LS.gistCache, JSON.stringify(state.data));
  state.currentId = null;
  showEmpty();
  renderHistory();
  await flushGistPushImmediate();
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
  localStorage.setItem(LS.gistCache, JSON.stringify(state.data));
  $('#reflection-status').textContent = 'saving…';
  clearTimeout(state.reflectionTimer);
  state.reflectionTimer = setTimeout(async () => {
    await flushGistPush();
    $('#reflection-status').textContent = 'saved to Gist';
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
  $('#reflection-input').value = r.reflection || '';
  $('#reflection-status').textContent = r.reflectionUpdatedAt ? 'saved ' + fmtDate(r.reflectionUpdatedAt) : 'auto-saves to Gist';
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
function openSettings() { $('#settings-modal').classList.remove('hidden'); }
function closeSettings() { $('#settings-modal').classList.add('hidden'); }

const CUSTOM_MODEL = '__custom__';

function fillSettings() {
  const c = cfg();
  $('#set-github-token').value = c.githubToken;
  $('#set-gist-id').value = c.gistId;
  $('#set-provider').value = activeProvider();
  $('#set-openai-key').value = c.openaiKey;
  $('#set-anthropic-key').value = c.anthropicKey;
  $('#set-gemini-key').value = c.geminiKey;
  $('#set-repo').value = c.repo;
  $('#set-notes-path').value = c.notesPath;
  $('#set-branch').value = c.branch;
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

  const tGh = line('GitHub token');
  try {
    const r = await fetch('https://api.github.com/user', { headers: ghHeaders() });
    if (!r.ok) throw new Error(r.status);
    const u = await r.json();
    done(tGh, true, `GitHub token: ok (@${u.login})`);
  } catch (e) { done(tGh, false, `GitHub token: failed (${e.message})`); }

  const tGist = line('Gist access');
  try {
    const r = await fetch(`https://api.github.com/gists/${encodeURIComponent(cfg().gistId)}`, { headers: ghHeaders() });
    done(tGist, r.ok, r.ok ? 'Gist access: ok' : `Gist access: failed (${r.status})`);
  } catch (e) { done(tGist, false, `Gist access: failed`); }

  const tRepo = line('Notes file');
  try {
    const { repo, notesPath, branch } = cfg();
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/${encPath(notesPath)}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders() });
    done(tRepo, r.ok, r.ok ? `Notes file: ok (${notesPath})` : `Notes file: failed (${r.status})`);
  } catch (e) { done(tRepo, false, 'Notes file: failed'); }

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
    'set-gist-id': 'gistId',
    'set-openai-key': 'openaiKey',
    'set-anthropic-key': 'anthropicKey',
    'set-gemini-key': 'geminiKey',
    'set-repo': 'repo',
    'set-notes-path': 'notesPath',
    'set-branch': 'branch',
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

  // Restore cached Gist data for instant offline view.
  try {
    const cached = localStorage.getItem(LS.gistCache);
    if (cached) state.data = JSON.parse(cached);
  } catch { /* ignore */ }

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

  // Generate + report actions.
  $('#target-month').addEventListener('change', syncRangeToMonth);
  $('#btn-generate').addEventListener('click', generateReport);
  $('#btn-copy').addEventListener('click', copyCurrentReport);
  $('#btn-download').addEventListener('click', downloadCurrentReport);
  $('#btn-delete').addEventListener('click', deleteCurrentReport);
  $('#reflection-input').addEventListener('input', onReflectionInput);

  // Settings actions.
  $('#btn-refresh-models').addEventListener('click', refreshModels);
  $('#btn-test').addEventListener('click', testConnections);

  // Esc closes settings.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

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
  if (!missingSecrets().includes('token') && !missingSecrets().includes('gist')) {
    cloudSync();
  }
}

document.addEventListener('DOMContentLoaded', init);
