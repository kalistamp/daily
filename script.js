/* ============================================================================
   Monthly Self-Interrogation Agent — application logic
   ----------------------------------------------------------------------------
   PRIVACY MODEL (confirmed):
     • Pure client-side. No backend server. Runs entirely in the browser.
     • The parent repository holding the private daily-journal markdown stays
       100% PRIVATE. Only this static website repository is public.
     • Persistent reports, claims, prompts, and tombstones live in the isolated
       `daily` Supabase schema behind Auth and Row Level Security.
     • The journal token is Contents:READ-ONLY on the journal repo, so no code
       path here can write the journal; GitHub itself rejects it.
     • Secrets (the journal token and per-provider API keys)
       are kept EXCLUSIVELY in this browser's localStorage. They are
       NEVER written into the public website — only sent
       directly over HTTPS to api.github.com and, for the selected provider,
       that vendor's own endpoint (see the PROVIDER REGISTRY below for the
       full list; every one of them is pinned in the page's CSP connect-src).
   ========================================================================== */

'use strict';

/* Public browser values. Supabase publishable keys are intentionally public;
   the service-role key must never appear in this repository or browser. */
const SUPABASE_CONFIG = {
  url: 'https://baiojghilzxhkebfblzv.supabase.co',
  publishableKey: 'sb_publishable_nfLVr5Krdld9pxxr4f2CYQ_bsn0TNxx',
  schema: 'daily',
};
let supabaseClient = null;
let cloudUserId = null;
let cloudEmail = '';

function cloudClient() {
  if (supabaseClient) return supabaseClient;
  if (!window.supabase || !window.supabase.createClient) return null;
  supabaseClient = window.supabase.createClient(
    SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey,
    { db: { schema: SUPABASE_CONFIG.schema }, auth: { persistSession: true, autoRefreshToken: true } }
  );
  return supabaseClient;
}

function installCloudSession(session) {
  cloudUserId = session?.user?.id || null;
  cloudEmail = session?.user?.email || '';
  return session || null;
}

async function getCloudSession() {
  const client = cloudClient();
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw new Error(error.message);
  return installCloudSession(data?.session);
}

async function cloudSignIn(email, password) {
  const client = cloudClient();
  if (!client) return { ok: false, error: 'Supabase failed to load.' };
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, error: error.message };
  installCloudSession(data.session);
  return { ok: true };
}

async function cloudSignOut() {
  const client = cloudClient();
  if (client && state.realtimeChannel) await client.removeChannel(state.realtimeChannel);
  state.realtimeChannel = null;
  cloudUserId = null;
  cloudEmail = '';
  if (client) await client.auth.signOut();
}

/* -------------------------------------------------------------- constants */
// One localStorage key per provider per field, so switching the active provider
// never loses the other providers' keys. API keys are DEVICE-LOCAL ONLY and are
// never written into state.data / Supabase (see dataPushNow).
const LS = {
  githubToken:    'msi.githubToken',   // journal repo, READ-ONLY
  activeProvider: 'msi.activeProvider',
  openaiKey:      'msi.openaiKey',
  openaiModel:    'msi.openaiModel',
  anthropicKey:   'msi.anthropicKey',
  anthropicModel: 'msi.anthropicModel',
  geminiKey:      'msi.geminiKey',
  geminiModel:    'msi.geminiModel',
  groqKey:        'msi.groqKey',
  groqModel:      'msi.groqModel',
  cerebrasKey:    'msi.cerebrasKey',
  cerebrasModel:  'msi.cerebrasModel',
  openrouterKey:  'msi.openrouterKey',
  openrouterModel: 'msi.openrouterModel',
  mistralKey:     'msi.mistralKey',
  mistralModel:   'msi.mistralModel',
  cohereKey:      'msi.cohereKey',
  cohereModel:    'msi.cohereModel',
  huggingfaceKey: 'msi.huggingfaceKey',
  huggingfaceModel: 'msi.huggingfaceModel',
  repo:           'msi.repo',
  notesPath:      'msi.notesPath',
  branch:         'msi.branch',
  theme:          'msi.theme',
  sidebar:        'msi.sidebar',
  panels:         'msi.panels',       // collapsed/expanded sidebar cards
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
  activeProvider: 'openai',   // default summarization provider (was gemini)
  openaiKey:      '',
  openaiModel:    '',         // blank = Auto
  anthropicKey:   '',
  anthropicModel: '',         // blank = Auto
  geminiKey:      '',
  geminiModel:    '',         // blank = Auto
  groqKey:        '',
  groqModel:      '',         // blank = Auto
  cerebrasKey:    '',
  cerebrasModel:  '',         // blank = Auto
  openrouterKey:  '',
  openrouterModel: '',         // blank = Auto
  mistralKey:     '',
  mistralModel:   '',         // blank = Auto
  cohereKey:      '',
  cohereModel:    '',         // blank = Auto
  huggingfaceKey: '',
  huggingfaceModel: '',         // blank = Auto
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

// The gateway providers serve open-weight families, where several tokens above
// name an ordinary chat model rather than a different endpoint: "-instruct" IS
// the chat variant on Llama, Qwen and Mistral derivatives, and gemma, learnlm
// and vision models all answer chat requests. Applying the OpenAI-shaped list
// to those catalogues would hide almost everything in them, which is exactly
// the failure the deny-list exists to avoid — so they get this narrower one,
// holding only the tokens that name a genuinely different endpoint on every
// vendor. Providers opt in via `isChatModel` on their registry entry.
const GATEWAY_NON_CHAT_TOKENS = [
  'embed', 'embedding', 'embeddings', 'gecko',
  'tts', 'stt', 'whisper', 'audio', 'speech', 'voice', 'transcribe',
  'image', 'images', 'dall', 'dalle', 'imagen', 'veo', 'diffusion', 'flux', 'sdxl',
  'moderation', 'moderations', 'guard', 'safety',
  'rerank', 'reranker', 'similarity',
];
const GATEWAY_NON_CHAT_RE = new RegExp(`(^|[-_./])(${GATEWAY_NON_CHAT_TOKENS.join('|')})([-_./]|$)`, 'i');
const isGatewayChatModel = (id) => !!id && !GATEWAY_NON_CHAT_RE.test(id);

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

// Where the message lives differs by vendor. The original three all nest it
// under `error`, so that is checked first and their behaviour is unchanged;
// the rest only apply when that comes back empty — Cohere and the HuggingFace
// router put a bare string at the top level, and Cloudflare returns an
// `errors` array. Without this the gateway adapters would report a bare status
// code and a plain bad key would look like an unexplained failure.
function errorDetail(data) {
  if (!data || typeof data !== 'object') return '';
  const e = data.error;
  if (e && typeof e === 'object' && e.message) return String(e.message);
  if (typeof e === 'string' && e) return e;
  if (Array.isArray(data.errors) && data.errors[0] && data.errors[0].message) {
    return String(data.errors[0].message);
  }
  if (typeof data.message === 'string' && data.message) return data.message;
  if (typeof data.detail === 'string' && data.detail) return data.detail;
  return '';
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
  syncInFlight: null,
  queuedRevision: null,
  realtimeChannel: null,
  models: null,
  dirty: false,   // local edits not yet in Supabase
  rev: 0,         // bumped on every local edit; guards the dirty-flag clear
  remoteRevision: 0,
  cloudLoaded: false,
  knownItems: new Map(),
  pendingChanges: new Map(),
  cacheItems: new Map(),
  cacheDbPromise: null,
  cacheQueue: Promise.resolve(),
  cacheHydrated: false,
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
  // Reports written before the month was derived from their entries carry
  // whatever the target-month box held at the time, which nothing kept in step
  // with a hand-picked date range. rangeStart/rangeEnd came from the entries
  // themselves, so they are the authority: relabel from those.
  for (const r of out.reports) {
    if (!r.rangeStart || !r.rangeEnd) continue;
    const actual = monthForRange(r.rangeStart, r.rangeEnd);
    if (actual && r.month !== actual) r.month = actual;
  }
  return out;
}

/* ------------------------------------------------------------ local saves */
// Cloud and browser caches use the same row-shaped entities. A reflection edit
// now serializes one report, not the complete history/ledger/prompt document.
const ENTITY_COLLECTION = {
  report: 'reports', claim: 'claims', tombstone: 'deleted', prompt: 'prompts',
};
const COLLECTION_ENTITY = {
  reports: 'report', claims: 'claim', deleted: 'tombstone',
};
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const entityKey = (type, id) => `${type}\u0000${String(id)}`;
function splitEntityKey(key) {
  const at = key.indexOf('\u0000');
  return { type: key.slice(0, at), id: key.slice(at + 1) };
}
function entityId(type, data) {
  return type === 'prompt' ? 'settings' : String(data?.id || '');
}
function flattenData(data) {
  const value = normalizeData(data);
  const items = new Map();
  for (const [collection, type] of Object.entries(COLLECTION_ENTITY)) {
    for (const record of value[collection]) {
      const id = entityId(type, record);
      if (id) items.set(entityKey(type, id), cloneJson(record));
    }
  }
  items.set(entityKey('prompt', 'settings'), cloneJson(value.prompts));
  return items;
}
function unflattenData(items) {
  const value = emptyData();
  for (const [key, data] of items) {
    const { type } = splitEntityKey(key);
    if (type === 'prompt') value.prompts = cloneJson(data);
    else if (ENTITY_COLLECTION[type]) value[ENTITY_COLLECTION[type]].push(cloneJson(data));
  }
  value.reports.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
  return normalizeData(value);
}
function diffItems(base, desired) {
  const changes = new Map();
  for (const [key, data] of desired) {
    if (!base.has(key) || !sameJson(base.get(key), data)) {
      const { type, id } = splitEntityKey(key);
      changes.set(key, { entity_type: type, entity_id: id, action: 'upsert', data: cloneJson(data) });
    }
  }
  for (const key of base.keys()) {
    if (!desired.has(key)) {
      const { type, id } = splitEntityKey(key);
      changes.set(key, { entity_type: type, entity_id: id, action: 'delete' });
    }
  }
  return changes;
}

function markDirty() {
  state.rev++;
  state.dirty = true;
  localStorage.setItem(LS.dirty, '1');
}
function stageAllChanges() {
  state.pendingChanges = diffItems(state.knownItems, flattenData(state.data));
  if (!state.pendingChanges.size && !state.pushInFlight) clearDirty();
}
function stageItem(type, data) {
  const id = entityId(type, data);
  if (!id) return;
  const key = entityKey(type, id);
  if (state.knownItems.has(key) && sameJson(state.knownItems.get(key), data)) {
    state.pendingChanges.delete(key);
  } else {
    state.pendingChanges.set(key, {
      entity_type: type, entity_id: id, action: 'upsert', data: cloneJson(data),
    });
  }
}
function saveLocal() {
  markDirty();
  cacheData(state.data);
  stageAllChanges();
}
function saveLocalItem(type, data) {
  markDirty();
  cacheItem(type, data);
  stageItem(type, data);
}
function clearDirty(atRev) {
  if (atRev !== undefined && atRev !== state.rev) return;
  if (state.pendingChanges.size || state.pushInFlight) return;
  state.dirty = false;
  localStorage.removeItem(LS.dirty);
}

function openCache() {
  if (state.cacheDbPromise) return state.cacheDbPromise;
  if (!window.indexedDB || !cloudUserId) return Promise.resolve(null);
  state.cacheDbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(`daily-cache-v2-${cloudUserId}`, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('items')) {
        request.result.createObjectStore('items', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return state.cacheDbPromise;
}
function cacheTransaction(mode, run) {
  return openCache().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', mode);
      run(tx.objectStore('items'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
}
function enqueueCache(run) {
  state.cacheQueue = state.cacheQueue.then(run).catch(() => null);
  return state.cacheQueue;
}
function cacheItem(type, data) {
  const id = entityId(type, data);
  if (!id) return Promise.resolve();
  const key = entityKey(type, id);
  const value = cloneJson(data);
  state.cacheItems.set(key, value);
  return enqueueCache(() => cacheTransaction('readwrite', (store) => {
    store.put({ key, data: value });
  }));
}
function cacheData(data) {
  const desired = flattenData(data);
  const changes = diffItems(state.cacheItems, desired);
  state.cacheItems = desired;
  if (!changes.size) return Promise.resolve();
  return enqueueCache(() => cacheTransaction('readwrite', (store) => {
    for (const [key, change] of changes) {
      if (change.action === 'delete') store.delete(key);
      else store.put({ key, data: change.data });
    }
  }));
}
async function readCache() {
  await state.cacheQueue;
  let db = null;
  try { db = await openCache(); }
  catch (error) {
    state.cacheDbPromise = null;
    console.warn('IndexedDB cache unavailable:', error?.message || error);
  }
  let records = [];
  if (db) {
    records = await new Promise((resolve, reject) => {
      const request = db.transaction('items').objectStore('items').getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }
  if (!records.length) {
    try {
      const legacy = localStorage.getItem(LS.cache);
      if (legacy) {
        const data = normalizeData(JSON.parse(legacy));
        if (db) {
          const desired = flattenData(data);
          await cacheTransaction('readwrite', (store) => {
            for (const [key, value] of desired) store.put({ key, data: value });
          });
          state.cacheItems = desired;
          localStorage.removeItem(LS.cache);
        }
        return data;
      }
    } catch { /* ignore corrupt legacy cache */ }
  }
  state.cacheItems = new Map(records.map((record) => [record.key, record.data]));
  return unflattenData(state.cacheItems);
}
async function clearCache() {
  state.cacheItems = new Map();
  await enqueueCache(() => cacheTransaction('readwrite', (store) => store.clear()));
}

/* ------------------------------------------------------------------ merge */
/* ---------------------------------------------------------------------------
   WHY THIS EXISTS
   ---------------------------------------------------------------------------
The legacy store was one JSON blob written whole, so a plain "upload my local
   copy" was a last-writer-wins overwrite. V2 writes rows conditionally, but a
   device can still reconnect with stale cached rows. This merge preserves both
   devices' work before the client computes the row-level changes to send.

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

// The report text and everything describing how it was produced move together,
// and are chosen by GENERATION time — not by the wrapper's last-touched stamp.
// This only started to matter with in-place regeneration: report text used to
// be write-once, so whichever wrapper won carried the same text either way. Now
// a device that merely ANSWERED a question on a stale copy has the newer
// last-touched stamp, and without this it drags the old text back over a
// rewrite it has not pulled yet.
const GEN_FIELDS = [
  'report', 'generatedAt', 'regeneratedAt', 'regenCount', 'answersUsed',
  'provider', 'model', 'modelAuto', 'themes', 'themeSummary', 'entryCount',
  'requestedStart', 'requestedEnd', 'rangeStart', 'rangeEnd',
];

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
  // Only when the two winners disagree, so identical copies stay untouched.
  const gen = (a.generatedAt || '') >= (b.generatedAt || '') ? a : b;
  if (gen !== base) for (const k of GEN_FIELDS) out[k] = gen[k];
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
  if (!cloudUserId)   miss.push('account');
  if (!providerKey()) miss.push('apikey');   // the ACTIVE provider's key
  return miss;
}
const canSync = () => Boolean(cloudUserId && cloudClient());

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
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
let journalCache = { url: '', etag: '', text: '' };

/* ---------------------------------------------------------------------------
   THE JOURNAL REPO IS READ-ONLY  ·  enforced by GitHub, not by this file
   ---------------------------------------------------------------------------
   Nothing here writes the journal repo. It is only READ (githubFetchNotes), and
   only ever with `githubToken`, which is scoped Contents:Read-only — so even a
   bug that tried to write it would get a 403 from GitHub.

   Persistent report writes go only to Supabase. The journal token is used only
   by githubFetchNotes() and never by a write request.
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
  const headers = journalHeaders();
  if (journalCache.url === url && journalCache.etag && journalCache.text) {
    headers['If-None-Match'] = journalCache.etag;
  }
  const res = await fetch(url, { headers });
  if (res.status === 304 && journalCache.url === url && journalCache.text) {
    return journalCache.text;
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Notes file not found: ${repo}/${notesPath}@${branch}. Check the path in Settings.`);
    if (res.status === 401 || res.status === 403) throw new Error(`GitHub auth failed (${res.status}). Token needs Contents:read on ${repo}.`);
    throw new Error(`GitHub notes fetch failed (${res.status}).`);
  }
  const j = await res.json();
  if (j && j.content && j.encoding === 'base64') {
    const text = b64DecodeUnicode(j.content);
    journalCache = { url, etag: res.headers.get('etag') || '', text };
    return text;
  }
  // Files > 1 MB: the contents API omits content. Fall back to the Git Blobs
  // API (also JSON + base64, so still CORS-safe).
  if (j && j.sha) {
    const b = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${j.sha}`, { headers: journalHeaders() });
    if (b.ok) {
      const bj = await b.json();
      if (bj && bj.content && bj.encoding === 'base64') {
        const text = b64DecodeUnicode(bj.content);
        journalCache = { url, etag: res.headers.get('etag') || '', text };
        return text;
      }
    }
  }
  throw new Error('Could not read notes content from GitHub (unexpected response shape).');
}

// Read only the tiny revision row first. Normal operation then requests just
// entities changed since this device's revision; a full paginated read is used
// only for first load or conflict recovery.
async function readCloudRevision() {
  if (!cloudUserId) throw new Error('Sign in to Supabase first.');
  const { data, error } = await cloudClient().from('daily_sync_state')
    .select('revision').eq('user_id', cloudUserId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const created = await cloudClient().rpc('ensure_daily_state');
    if (created.error) throw new Error(created.error.message);
    return Number(created.data || 0);
  }
  return Number(data.revision || 0);
}
async function readAllCloudItems(revision) {
  const rows = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await cloudClient().from('daily_items')
      .select('entity_type,entity_id,data,revision')
      .eq('user_id', cloudUserId).range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  state.knownItems = new Map(rows.map((row) => [
    entityKey(row.entity_type, row.entity_id), cloneJson(row.data),
  ]));
  state.remoteRevision = Number(revision == null ? await readCloudRevision() : revision);
  state.cloudLoaded = true;
  return unflattenData(state.knownItems);
}
async function readCloudDelta(targetRevision) {
  const { data, error } = await cloudClient().rpc('read_daily_changes_since', {
    since_revision: state.remoteRevision,
  });
  if (error) throw new Error(error.message);
  const payload = data || {};
  for (const change of payload.changes || []) {
    const key = entityKey(change.entity_type, change.entity_id);
    if (change.deleted) state.knownItems.delete(key);
    else state.knownItems.set(key, cloneJson(change.data));
  }
  state.remoteRevision = Number(payload.revision == null ? targetRevision : payload.revision);
  return unflattenData(state.knownItems);
}
async function dataPull(announcedRevision) {
  const revision = announcedRevision == null
    ? await readCloudRevision() : Number(announcedRevision);
  if (state.cloudLoaded && revision === state.remoteRevision) return null;
  if (state.cloudLoaded && revision > state.remoteRevision) return readCloudDelta(revision);
  return readAllCloudItems(revision);
}
function applyKnownChanges(changes) {
  for (const change of changes) {
    const key = entityKey(change.entity_type, change.entity_id);
    if (change.action === 'delete') state.knownItems.delete(key);
    else state.knownItems.set(key, cloneJson(change.data));
  }
}

// A write carries only changed rows. Revision conflicts fetch once, merge at
// entity level, and retry rather than reading/re-writing the full document on
// every reflection keystroke.
async function dataPushNow() {
  if (!cloudUserId) throw new Error('Sign in to Supabase first.');
  if (!state.cloudLoaded) {
    const local = state.data;
    state.data = mergeData(local, await readAllCloudItems());
    await cacheData(state.data);
    stageAllChanges();
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const changes = [...state.pendingChanges.values()].slice(0, 200);
    if (!changes.length) { clearDirty(); return; }
    const atRev = state.rev;
    const { data, error } = await cloudClient().rpc('apply_daily_changes', {
      expected_revision: state.remoteRevision,
      changes,
    });
    if (!error) {
      state.remoteRevision = Number(data == null ? state.remoteRevision + 1 : data);
      applyKnownChanges(changes);
      stageAllChanges();
      clearDirty(atRev);
      if (state.pendingChanges.size) return dataPushNow();
      return;
    }
    if (!String(error.message || '').includes('DAILY_REVISION_CONFLICT')) {
      throw new Error(error.message);
    }
    const local = state.data;
    const remote = await readAllCloudItems();
    state.data = mergeData(local, remote);
    await cacheData(state.data);
    stageAllChanges();
  }
  throw new Error('Reports kept changing elsewhere — try syncing again.');
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

// Every provider added after the original three speaks OpenAI's
// /chat/completions shape verbatim, so one factory covers them and each entry
// shrinks to what actually differs: base URL, defaults, and how that vendor
// spells its model list. It deliberately does not reuse the `openai` entry —
// that one carries endpoint negotiation for /v1/responses, which no other
// vendor implements, so sharing it would give all of them a probe that can
// only ever fail.
//
// This app makes a single-shot summarization call and declares no tools, so
// there is no tool plumbing here and no filtering on tool support: a model
// that cannot call a function summarizes perfectly well.
function openAiCompatible(spec) {
  return Object.assign({
    defaultModel: '',                       // blank = Auto, as everywhere here
    isChatModel: isGatewayChatModel,

    keyHeader(key) { return { Authorization: `Bearer ${key}` }; },
    headers(key) { return Object.assign({ 'Content-Type': 'application/json' }, this.keyHeader(key)); },

    // max_tokens is set, unlike the OpenAI entry above: that one omits it
    // because the GPT-5 family renamed it max_completion_tokens, which is an
    // OpenAI-specific quirk. These gateways all accept max_tokens, and a
    // report truncated at some vendor's small default is a silent failure —
    // so this matches the 8192 the Anthropic and Gemini entries use. No
    // temperature, though: several of these serve reasoning models that
    // reject a non-default one.
    buildBody(model, systemText, userText) {
      return {
        model,
        max_tokens: 8192,
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userText },
        ],
      };
    },

    // `content` comes back as blocks from some gateways rather than a string.
    parse(json) {
      const c = json?.choices?.[0]?.message?.content;
      const text = typeof c === 'string'
        ? c
        : (Array.isArray(c) ? c.map((b) => (b && (b.text || b.output_text)) || '').join('') : '');
      return { text: text.trim() };
    },

    chatUrl() { return `${this.base}/chat/completions`; },

    async send(model, systemText, userText, key) {
      const res = await fetch(this.chatUrl(key), {
        method: 'POST',
        headers: this.headers(key),
        body: JSON.stringify(this.buildBody(model, systemText, userText)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw apiError(`${this.label} request failed (${res.status}).`, res.status, errorDetail(data));
      }
      const { text } = this.parse(data);
      if (!text) {
        throw new Error(`${this.label} returned no text (${data?.choices?.[0]?.finish_reason || 'empty response'}).`);
      }
      return { text, model, fellBack: false };
    },

    modelsUrl() { return `${this.base}/models`; },

    // OpenAI's { data: [{ id, created }] }, with `created` in seconds.
    readModels(data) {
      return (data.data || []).map((m) => ({ id: String(m.id), created: (Number(m.created) || 0) * 1000 }));
    },

    async discover(key) {
      const res = await fetch(this.modelsUrl(key), { headers: this.headers(key) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw apiError(`${this.label} model list failed (${res.status}).`, res.status, errorDetail(data));
      }
      return this.readModels(data);
    },

    // Higher = preferred, matching the other entries. Several of these
    // catalogues report no usable date, in which case every entry ties and the
    // vendor's own listing order is preserved by the sort.
    rankKey(m) { return m.created || 0; },
  }, spec);
}

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

    // Single attempt against one model. Keep the key out of the URL so it is
    // not copied into URL logs, browser history, or intermediary diagnostics.
    async once(model, systemText, userText, key) {
      const url = `${this.base}/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
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
      const res = await fetch(`${this.base}/models`, { headers: { 'x-goog-api-key': key } });
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

  /* ----------------------------------------------------------------- Groq */
  groq: openAiCompatible({
    id: 'groq',
    label: 'Groq',
    base: 'https://api.groq.com/openai/v1',
    fallbacks: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    keyUrl: 'https://console.groq.com/keys',
    keyCfg: 'groqKey', modelCfg: 'groqModel', keyInput: 'set-groq-key',
  }),

  /* ------------------------------------------------------------- Cerebras */
  cerebras: openAiCompatible({
    id: 'cerebras',
    label: 'Cerebras',
    base: 'https://api.cerebras.ai/v1',
    fallbacks: ['llama-3.3-70b', 'gpt-oss-120b', 'llama3.1-8b'],
    keyUrl: 'https://cloud.cerebras.ai/platform/apikeys',
    keyCfg: 'cerebrasKey', modelCfg: 'cerebrasModel', keyInput: 'set-cerebras-key',
  }),

  /* ----------------------------------------------------------- OpenRouter */
  openrouter: openAiCompatible({
    id: 'openrouter',
    label: 'OpenRouter',
    base: 'https://openrouter.ai/api/v1',
    fallbacks: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-flash'],
    keyUrl: 'https://openrouter.ai/keys',
    keyCfg: 'openrouterKey', modelCfg: 'openrouterModel', keyInput: 'set-openrouter-key',
    // `created` is already in seconds here, same as OpenAI.
  }),

  /* ----------------------------------------------------------- Mistral AI */
  mistral: openAiCompatible({
    id: 'mistral',
    label: 'Mistral AI',
    base: 'https://api.mistral.ai/v1',
    fallbacks: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    keyCfg: 'mistralKey', modelCfg: 'mistralModel', keyInput: 'set-mistral-key',
    // Mistral publishes per-model capability flags, so its embedding, OCR and
    // moderation models are dropped on the vendor's own say-so rather than by
    // guessing from the name. Only a positive "false" hides an entry.
    readModels(data) {
      return (data.data || [])
        .filter((m) => !m.capabilities || m.capabilities.completion_chat !== false)
        .map((m) => ({ id: String(m.id), created: (Number(m.created) || 0) * 1000 }));
    },
  }),

  /* --------------------------------------------------------------- Cohere */
  // Cohere borrows OpenAI's request shape but not its reply: /v2/chat returns
  // one `message` whose text arrives as blocks, so parse and send are its own.
  cohere: openAiCompatible({
    id: 'cohere',
    label: 'Cohere',
    base: 'https://api.cohere.com',
    fallbacks: ['command-a-03-2025', 'command-r-plus-08-2024', 'command-r-08-2024'],
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    keyCfg: 'cohereKey', modelCfg: 'cohereModel', keyInput: 'set-cohere-key',

    chatUrl() { return `${this.base}/v2/chat`; },

    parse(json) {
      const c = json?.message?.content;
      const text = typeof c === 'string'
        ? c
        : (Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('') : '');
      return { text: text.trim() };
    },

    async send(model, systemText, userText, key) {
      const res = await fetch(this.chatUrl(key), {
        method: 'POST',
        headers: this.headers(key),
        body: JSON.stringify(this.buildBody(model, systemText, userText)),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw apiError(`${this.label} request failed (${res.status}).`, res.status, errorDetail(data));
      }
      const { text } = this.parse(data);
      if (!text) throw new Error(`${this.label} returned no text (${data?.finish_reason || 'empty response'}).`);
      return { text, model, fellBack: false };
    },

    // endpoint=chat is the vendor's own filter, so embedding and rerank models
    // never reach the picker.
    modelsUrl() { return `${this.base}/v1/models?page_size=100&endpoint=chat`; },
    readModels(data) {
      return (data.models || []).map((m) => ({ id: String(m.name), created: 0 }));
    },
    // No timestamps here, but the ids end in an MM-YYYY release stamp — the
    // only ordering signal on offer, so this ranks by name like Gemini does.
    rankKey(m) {
      const d = String(m.id).match(/-(\d{2})-(\d{4})$/);
      let score = d ? Number(d[2]) * 100 + Number(d[1]) : 0;
      if (/light|nightly|beta/.test(m.id)) score -= 100000;
      return score;
    },
  }),

  /* ---------------------------------------------------------- Hugging Face */
  huggingface: openAiCompatible({
    id: 'huggingface',
    label: 'Hugging Face',
    base: 'https://router.huggingface.co/v1',
    fallbacks: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    keyUrl: 'https://huggingface.co/settings/tokens',
    keyCfg: 'huggingfaceKey', modelCfg: 'huggingfaceModel', keyInput: 'set-huggingface-key',
  }),
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
    .filter((m) => (p.isChatModel || isChatModel)(m.id))
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
   report system prompt. It lives in the synced prompt row, not localStorage, so
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
  '',
  'Length discipline:',
  '- make the point, support it with the dated evidence, stop. do not restate it in different words.',
  '- one fully-argued recommendation beats three sketched ones. depth on the thing that matters, silence on the rest.',
  '- no throat-clearing. no sentence whose only job is to announce the next sentence.',
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
  saveLocalItem('prompt', state.data.prompts);
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
    '## the month in five bullets',
    '  - HARD CAP 110 words. this is the skim layer: if they read nothing else in the report, they still got the month.',
    '  - exactly 5 bullets, one line each, in this order: the dominant thread, what genuinely progressed, what quietly stalled, the decision being avoided, the single highest-value action.',
    '  - then one blunt verdict line prefixed `**verdict:**` — what this month bought them, or what it cost.',
    '  - cite specifics (projects, dates, numbers, decisions). if the entries are thin, say that plainly instead of inflating them.',
    '## the five questions that matter',
    '  - HARD CAP 90 words. EXACTLY 5 questions, one list item each. no sub-bullets, no preamble, no closing note.',
    '  - a SEPARATE pass generates the questions they actually answer, so do not try to be exhaustive here. pick the 5 whose answers would most change what next month looks like.',
    '  - cover five different angles, one question each: a contradiction between two dated entries; a commitment made and never closed; a stated priority that does not survive scrutiny; a theme conspicuously thin or absent this month; the decision the entries keep circling without making.',
    '  - prefix each with its theme in brackets, e.g. `[ai]`. name the specific thing — the project, the date, the number, the person. a question that could be asked of any journal is worthless here.',
    '  - no two may probe the same thing from a different angle. no generic regrets, no gentleness.',
    '## self-improvement operating plan',
    '  - HARD CAP 240 words. turn the month\'s most important observations into a realistic 30-day plan. this section is advice, not questions.',
    '  - EXACTLY 3 priorities, no more. favor unfinished commitments, recurring friction, and choices with real downstream impact.',
    '  - one `###` heading per priority, then exactly these four bullets, labels bolded exactly as written:',
    '    - **why now:** the evidence from the entries, with a date.',
    '    - **7-day move:** one action they can finish this week.',
    '    - **measurement:** the observable outcome before the next report — how they will know progress is real and not just felt.',
    '    - **what this costs:** what gets less attention because this got more. every priority displaces something.',
    '  - close with a one-line `### stop doing` block: one tempting, lower-value activity to cut, defer, or cap — and what it frees up.',
    '  - practical only. no pep talk, no advice the entries do not support.',
    '## life advice',
    '  - HARD CAP 470 words for this whole section. still the most substantial part of the report — prose with `###` subheadings, not a bullet dump.',
    '  - this is the section they actually came for, but density beats volume: make the point, support it with dated evidence, stop. a paragraph restating the previous one in different words is padding — cut it.',
    '  - use these five `###` subheadings, written EXACTLY as shown (they address the reader as "you", like the rest of the report):',
    '    - `### the pattern you cannot see` (≤130 words) — the thing recurring across months that is invisible from inside it. name it, show the dated evidence, say where it leads if nothing changes.',
    '    - `### the decision being avoided` (≤130 words) — the choice the entries keep circling without making. state it plainly, lay out the real options with their actual costs, and say which one you would take and why.',
    '    - `### leverage` (≤70 words) — where a small change compounds. be specific about the mechanism, not just the suggestion.',
    '    - `### the honest risk` (≤70 words) — what is most likely to go wrong in the next 6–12 months given these entries. not catastrophizing; the realistic failure mode, and the cheapest hedge against it.',
    '    - `### what is actually working` (≤70 words) — the thing they are underrating and should do more of. evidence-based, not consolation.',
    '  - the first two carry the weight. the last three are one tight paragraph each — if a point is made in two sentences, stop at two.',
    '  - if a subheading has nothing real behind it, keep the heading and say in one line that the entries do not support it. do not invent material to fill it.',
    '  - where the entries are about work, money, health, or relationships, engage with the substance. do not retreat to process advice.',
    '  - argue for your recommendations. show the reasoning so they can disagree with it on the merits.',
    '## write this down next month',
    '  - HARD CAP 60 words. 2–3 bullets: things that, logged even one line a day, would have made this report materially sharper.',
    '  - name what was missing and why it mattered — a stretch of undated days, a decision with no stated reason, a project referenced only by shorthand.',
    '',
    'ADVICE DIRECTIVE — governs `## self-improvement operating plan` and `## life advice`.',
    'This is written by the user and overrides the tone guidance above for those two sections where they conflict:',
    '<<<ADVICE_DIRECTIVE>>>',
    '',
    'LENGTH IS A HARD REQUIREMENT, not a suggestion. The whole report must come in under 1000 words.',
    'The per-section caps above are ceilings, not targets — come in under them whenever the entries do not justify the words.',
    'A shorter report that says something is strictly better than a longer one that pads. Cut throat-clearing, restatement, and any sentence that only announces what the next sentence will say.',
    '',
    'Rules: output only the report as Markdown. no preamble, no closing note. exactly the five `##` sections above, in that order. every question goes on its own line as a list item.',
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
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

/* ------------------------------------------------------ collapsed report */
/* ---------------------------------------------------------------------------
   Every `##` section becomes a <details>. Shortening the prompt trades depth
   for skimmability; folding trades nothing — the full text is one click away,
   so the report can stay substantial without costing a 12-minute read.

   Deliberately generic over heading text: reports generated before the prompt
   was cut down have different section names (and nine of them), and they still
   have to render. Anything without `##` headings falls through to plain
   rendering rather than being swallowed.
--------------------------------------------------------------------------- */
// The summary and the advice — the two meant to be READ, not referred back to.
// `executive overview` is the pre-cut name for the summary section.
const OPEN_SECTIONS = /^(the month in five bullets|executive overview|life advice)$/;

// Collapsed sections advertise their own weight, so skipping one is a choice
// rather than a guess.
function sectionMeta(body) {
  const w = (body.trim().match(/\S+/g) || []).length;
  const q = body.split('\n').filter((l) => /^\s*([-*+]|\d+[.)])\s/.test(l) && l.includes('?')).length;
  return q ? `${q} question${q === 1 ? '' : 's'} · ${w} words` : `${w} words`;
}

// A bare /\n(?=##\s)/ split cuts inside fenced code blocks: it invents a
// section from the fenced line AND leaves the block unterminated, which renders
// as an EMPTY <pre>. Toggle on fences exactly the way mdToHtml does, so the two
// always agree on what counts as code.
function splitSections(src) {
  const out = [];
  let cur = [], inFence = false;
  for (const line of src.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    else if (!inFence && /^##\s/.test(line) && cur.length) { out.push(cur.join('\n')); cur = []; }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

function reportToHtml(md) {
  const src = (md || '').replace(/\r\n/g, '\n');
  const parts = splitSections(src);
  if (!parts.some((p) => /^##\s/.test(p))) return mdToHtml(src);
  let html = '';
  for (const part of parts) {
    const m = part.match(/^##\s+(.+)/);
    if (!m) { html += mdToHtml(part); continue; }   // anything before the first ##
    const title = m[1].trim();
    const nl = part.indexOf('\n');
    const body = nl === -1 ? '' : part.slice(nl + 1);
    const open = OPEN_SECTIONS.test(title.toLowerCase()) ? ' open' : '';
    html +=
      `<details class="rsec"${open}>` +
      `<summary><span class="rsec-t">${mdInline(title)}</span>` +
      `<span class="rsec-m">${sectionMeta(body)}</span></summary>` +
      `<div class="rsec-b">${mdToHtml(body)}</div></details>`;
  }
  return html;
}

/* =============================================================== sync core */
function setSync(kind, label) {
  const el = $('#sync-status');
  el.className = 'sync-status' + (kind ? ' is-' + kind : '');
  $('.sync-label', el).textContent = label;
  // The sync button's own icon spins while a sync is in flight, so the state is
  // legible from the control you pressed and not only from the status pill.
  $('#btn-sync').classList.toggle('is-busy', kind === 'busy');
}
function schedulePush() {
  setSync('dirty', 'unsynced');
  clearTimeout(state.pushTimer);
  state.pushTimer = setTimeout(flushPush, 1200);
}
async function flushPush() {
  clearTimeout(state.pushTimer);
  if (!state.dirty) { setSync('synced', 'synced'); return true; }
  if (state.pushInFlight) return state.pushInFlight;
  setSync('busy', 'syncing…');
  state.pushInFlight = (async () => {
    try { await dataPushNow(); setSync('synced', 'synced'); return true; }
    catch (e) { setSync('error', 'sync failed'); toast(e.message, 'err'); return false; }
    finally {
      state.pushInFlight = null;
      if (!state.pendingChanges.size) clearDirty();
    }
  })();
  return state.pushInFlight;
}

async function cloudSync(announcedRevision, announce = true) {
  if (!canSync()) {
    if (announce) toast('Sign in to Supabase first.', 'err');
    return;
  }
  if (state.syncInFlight) {
    const revision = Number(announcedRevision);
    if (Number.isFinite(revision)) {
      state.queuedRevision = Math.max(state.queuedRevision || 0, revision);
    }
    return state.syncInFlight;
  }
  setSync('busy', 'syncing…');
  state.syncInFlight = (async () => {
    try {
      const remote = await dataPull(announcedRevision);
      if (remote) {
        state.data = mergeData(state.data, remote);
        await cacheData(state.data);
        stageAllChanges();
        renderHistory();
        if (state.currentId && !state.data.reports.find((r) => r.id === state.currentId)) {
          state.currentId = null;
          showEmpty();
        } else if (state.currentId) {
          renderReport(state.data.reports.find((r) => r.id === state.currentId));
        }
      }
      if (state.pendingChanges.size && !(await flushPush())) return;
      setSync('synced', 'synced');
      if (announce) toast('Synced with Supabase.', 'ok');
    } catch (e) {
      setSync('error', 'sync failed');
      if (announce) toast(e.message, 'err');
      else console.warn('Realtime sync failed:', e.message);
    }
  })();
  try {
    await state.syncInFlight;
  } finally {
    state.syncInFlight = null;
    const queued = state.queuedRevision;
    state.queuedRevision = null;
    if (queued && queued > state.remoteRevision) {
      cloudSync(queued, false);
    }
  }
}

function subscribeCloud() {
  const client = cloudClient();
  if (!client || !cloudUserId || state.realtimeChannel) return;
  state.realtimeChannel = client.channel(`daily-sync-${cloudUserId}`).on(
    'postgres_changes',
    {
      event: 'UPDATE', schema: SUPABASE_CONFIG.schema, table: 'daily_sync_state',
      filter: `user_id=eq.${cloudUserId}`,
    },
    (payload) => {
      const revision = Number(payload?.new?.revision || 0);
      if (revision > state.remoteRevision) cloudSync(revision, false);
    }
  ).subscribe((status) => {
    // Close the small gap between the first read and subscription readiness.
    if (status === 'SUBSCRIBED') cloudSync(undefined, false);
  });
}

/* ============================================================ report flow */
async function generateReport() {
  const miss = missingSecrets();
  if (miss.length) {
    toast('Missing keys: ' + miss.join(', ') + '. Opening Settings.', 'err');
    openSettings();
    return;
  }
  // Only a default for the range — the month the report is filed under is
  // decided below, from the entries actually read.
  const reqMonth = $('#target-month').value || prevMonthStr();
  const reqStart = $('#range-start').value || monthFirstDay(reqMonth);
  const reqEnd = $('#range-end').value || monthLastDay(reqMonth);
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

    // File the report under the month its entries are actually in, not under
    // whatever the month box was holding. The two can disagree, and the dates
    // are the half that came from real data — a report read entirely from
    // August must not be stored, listed, prompted or exported as July.
    const month = dominantMonth(slice.map((e) => e.date), reqMonth);

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
    saveLocalItem('report', report);
    showProgress(true, 'Saving to Supabase…');
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
  clearTimeout(state.pushTimer);
  await flushPush();
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
  const ok = await confirmDialog('Delete report', `Delete the ${r.month} report from Supabase? This can't be undone.`);
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
  saveLocalItem('report', r);
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
    // A <button> inside the <li>: these rows were plain list items with a click
    // handler, so they could not be reached or activated from the keyboard.
    const li = document.createElement('li');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'history-item' + (r.id === state.currentId ? ' active' : '');
    if (r.id === state.currentId) item.setAttribute('aria-current', 'true');
    const modelLabel = r.provider ? `${providerLabel(r.provider)} · ${r.model}` : r.model;
    const range = (r.rangeStart && r.rangeEnd) ? fmtDayRange(r.rangeStart, r.rangeEnd) : '';
    const month = document.createElement('span');
    month.className = 'hi-month';
    month.textContent = r.month || '';
    const sub = document.createElement('span');
    sub.className = 'hi-sub';
    [range, modelLabel, fmtDate(r.generatedAt)].filter(Boolean).forEach((text) => {
      const span = document.createElement('span');
      span.textContent = text;
      sub.appendChild(span);
    });
    // Follow-ups are the main way answers get in now, so the list has to show
    // which reports still have questions waiting.
    const fu = r.followups || [];
    if (fu.length) {
      const answered = document.createElement('span');
      answered.textContent = `· ${fu.filter((f) => f.a && f.a.trim()).length}/${fu.length} answered`;
      sub.appendChild(answered);
    }
    if (r.reflection) {
      const reflected = document.createElement('span');
      reflected.textContent = '· reflected';
      sub.appendChild(reflected);
    }
    item.append(month, sub);
    item.addEventListener('click', () => {
      selectReport(r.id);
      // On a phone the drawer is covering the report that was just opened.
      if (compactView()) setSidebar(false);
    });
    li.appendChild(item);
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
  // Provenance for a rewritten report: generatedAt moves on regeneration, so
  // without this the report looks like a first pass that simply ran late.
  const revEl = $('#meta-revised');
  if (r.regenCount) {
    revEl.textContent =
      `revised ×${r.regenCount} · ${r.answersUsed || 0} answer${r.answersUsed === 1 ? '' : 's'} used`;
    revEl.classList.remove('hidden');
  } else {
    revEl.textContent = '';
    revEl.classList.add('hidden');
  }
  const tags = $('#theme-tags');
  tags.innerHTML = '';
  (r.themes || []).slice(0, 6).forEach((t) => {
    const s = document.createElement('span');
    s.className = 'theme-tag';
    s.textContent = `${t.label} · ${t.score}`;
    tags.appendChild(s);
  });
  $('#report-body').innerHTML = reportToHtml(r.report);
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
      <textarea class="fu-input" data-fu="${escapeHtml(f.id)}" rows="2"
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
  saveLocalItem('report', r);
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
    saveLocalItem('report', r);
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

/* --------------------------------------------------- regenerate in place */
/* ---------------------------------------------------------------------------
   Re-runs a month that already has a report, with the answers to ITS OWN
   follow-ups now in the prompt as established fact. Until this existed, the
   only way to see answers land was to generate the month again, which stacked
   a second report beside the first.

   Updates in place, keeping the id. A duplicate month report is not a second
   month of thinking, and `answeredContextBlock` is capped by CHARACTERS — the
   same Q&A pairs carried twice would spend that budget saying one thing twice.

   Follow-ups are APPENDED, never replaced. mergeReportPair unions them by id,
   so a question dropped here returns from any device still holding the old
   copy; keeping them is the only choice stable under sync, and it is what keeps
   every answer feeding future reports.
--------------------------------------------------------------------------- */
async function regenerateWithAnswers() {
  const r = currentReport();
  if (!r) return;
  const miss = missingSecrets();
  if (miss.length) {
    toast('Missing keys: ' + miss.join(', ') + '. Opening Settings.', 'err');
    openSettings();
    return;
  }
  const answered = (r.followups || []).filter((f) => f.a && f.a.trim()).length;
  if (!answered) {
    toast('Answer at least one follow-up first — there is nothing new to feed the model yet.', '');
    return;
  }
  const ok = await confirmDialog(
    'Regenerate with answers',
    `Rewrite the ${r.month} report using your ${answered} answered follow-up${answered === 1 ? '' : 's'} as ` +
    `established fact? The report text is replaced. Your answers are kept, and new questions are added below them.`
  );
  if (!ok) return;

  const btn = $('#btn-regen');
  btn.disabled = true;
  // An answer typed a second ago is already in state.data — onFollowupInput
  // writes through synchronously — so the prompt is current. The pending
  // debounce is only a duplicate push racing the one at the end of this run.
  clearTimeout(state.followupTimer);
  showProgress(true, 'Fetching journal…');
  try {
    const entries = parseEntries(await githubFetchNotes());
    const reqStart = r.requestedStart || r.rangeStart;
    const reqEnd = r.requestedEnd || r.rangeEnd;
    const slice = sliceForRange(entries, reqStart, reqEnd);
    if (!slice.length) {
      throw new Error(`No entries found for ${reqStart} → ${reqEnd} in ${cfg().notesPath}.`);
    }
    // Re-derived, not reused: the journal may have gained entries in this range
    // since the first pass, and the theme tags are shown on the report.
    showProgress(true, 'Analyzing themes…');
    const themes = analyzeThemes(slice.map((e) => e.body).join('\n'));
    const loops = findOpenLoops(slice);

    const provider = r.provider && PROVIDERS[r.provider] ? r.provider : activeProvider();
    const picked = await resolveModel(provider, (t) => showProgress(true, t));
    showProgress(true, `Interrogating ${picked.model}…`);
    // buildUserPrompt pulls answeredContextBlock() itself — that is the whole
    // mechanism. The answers arrive under ALREADY ANSWERED as fact.
    const gen = await providerGenerate(
      provider, picked.model, buildSystemPrompt(),
      buildUserPrompt(r.month, slice, themes, loops),
      (m, fb) => showProgress(true, `${fb ? 'Falling back to' : 'Interrogating'} ${m}…`)
    );
    if (gen.fellBack) toast(`"${picked.model}" unavailable — used "${gen.model}" instead.`, 'ok');

    showProgress(true, 'Drafting follow-up questions…');
    const existing = new Set((r.followups || []).map((f) => normQuote(f.q)));
    const fresh = (await generateFollowups(
      provider, gen.model, gen.text, slice, r.month,
      (m, fb) => showProgress(true, `${fb ? 'Falling back to' : 'Drafting questions with'} ${m}…`)
    )).filter((f) => !existing.has(normQuote(f.q)));

    r.report = gen.text;
    r.provider = provider;
    r.model = gen.model;
    r.modelAuto = !!picked.auto;
    r.themes = themes;
    r.themeSummary = themes.length ? themes.slice(0, 4).map((t) => t.label).join(', ') : 'none detected';
    r.entryCount = slice.length;
    r.rangeStart = slice[0].date;
    r.rangeEnd = slice[slice.length - 1].date;
    r.followups = [...(r.followups || []), ...fresh];
    r.answersUsed = answered;
    r.regenCount = (r.regenCount || 0) + 1;
    r.regeneratedAt = new Date().toISOString();
    // generatedAt moves with it: reportStamp resolves merge conflicts on the
    // newest timestamp, so leaving it would let a stale copy on another device
    // outrank this rewrite and quietly restore the old text.
    r.generatedAt = r.regeneratedAt;

    saveLocalItem('report', r);
    renderReport(r);
    renderHistory();
    await flushPushImmediate();
    toast(
      `${r.month} rewritten with ${answered} answer${answered === 1 ? '' : 's'}` +
      (fresh.length ? ` · ${fresh.length} new question${fresh.length === 1 ? '' : 's'}` : ''),
      'ok'
    );
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
  // The progress row sits inside the Generate panel, so a collapsed panel would
  // swallow it. Work in flight always reopens the panel it belongs to.
  if (on) setPanel('generate', true);
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
// The month a set of 'YYYY-MM-DD' dates belongs to: whichever 'YYYY-MM' holds
// the most of them, ties going to the earlier month. A range is normally one
// month, but one read across a boundary should be labelled by where its weight
// actually sits rather than by whichever end happened to come first.
function dominantMonth(dates, fallback) {
  const tally = new Map();
  for (const d of dates) {
    const m = /^(\d{4}-\d{2})-\d{2}$/.exec(d || '');
    if (m) tally.set(m[1], (tally.get(m[1]) || 0) + 1);
  }
  let best = '';
  for (const month of [...tally.keys()].sort()) {
    if (!best || tally.get(month) > tally.get(best)) best = month;
  }
  return best || fallback || '';
}
// Days in an inclusive date range, so a range can be attributed to a month
// without the entries themselves. Capped: the inputs accept any year, and an
// absurd span should not spin the loop.
function daysInRange(startStr, endStr) {
  const out = [];
  const cur = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  if (isNaN(cur) || isNaN(end)) return out;
  while (cur <= end && out.length < 4000) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}
function monthForRange(startStr, endStr) {
  return dominantMonth(daysInRange(startStr, endStr), (startStr || endStr || '').slice(0, 7));
}
// Reset the date range to span the whole selected month.
function syncRangeToMonth() {
  const month = $('#target-month').value || prevMonthStr();
  $('#range-start').value = monthFirstDay(month);
  $('#range-end').value = monthLastDay(month);
}
// The reverse, which never existed: the month box drove the range but nothing
// drove it back, so hand-picking dates in another month left the box sitting on
// its previous-month default — and that stale value, not the dates, is what
// went on to label the report. Programmatic .value assignment fires no change
// event, so this and syncRangeToMonth cannot ping-pong.
function syncMonthToRange() {
  const month = monthForRange($('#range-start').value, $('#range-end').value);
  if (month) $('#target-month').value = month;
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
// `persist` is false on boot: with no stored choice the app should keep
// following the system preference rather than freezing whatever it resolved to
// the first time it ran.
function applyTheme(t, persist = true) {
  document.documentElement.setAttribute('data-theme', t);
  if (persist) localStorage.setItem(LS.theme, t);
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
  // Treat cloud data as untrusted input even though RLS limits it to this user.
  // These values feed class names and data attributes, so normalize them before
  // building the delegated-action markup.
  const type = ['forecast', 'commitment'].includes(c.type) ? c.type : 'forecast';
  const status = ['open', 'proposed', 'void', ...CLAIM_VERDICTS].includes(c.status)
    ? c.status : 'open';
  const proposed = CLAIM_VERDICTS.includes(c.proposedVerdict) ? c.proposedVerdict : 'partial';
  const id = escapeHtml(c.id);
  const conf = Math.round(c.confidence * 100) + '%';
  const due = c.dueDate ? ` · due ${escapeHtml(fmtDay(c.dueDate))}` : '';
  const overdue = status === 'open' && c.dueDate && c.dueDate < todayStr();
  const ev = c.evidence
    ? `<div class="claim-ev"><span class="ev-date">${escapeHtml(fmtDay(c.evidenceDate))}</span>${escapeHtml(c.evidence)}</div>`
    : '';
  const actions = status === 'proposed'
    ? `<div class="claim-actions">
         <span class="muted">model says <strong>${proposed}</strong> —</span>
         <button class="btn btn-mini ok" data-claim="${id}" data-verdict="${proposed}">accept</button>
         <button class="btn btn-mini" data-claim="${id}" data-verdict="${proposed === 'right' ? 'wrong' : 'right'}">no, ${proposed === 'right' ? 'wrong' : 'right'}</button>
         <button class="btn btn-mini" data-claim="${id}" data-verdict="partial">partial</button>
         <button class="btn btn-mini" data-claim="${id}" data-verdict="open">reject</button>
       </div>`
    : status === 'open'
      ? `<div class="claim-actions">
           <button class="btn btn-mini ok" data-claim="${id}" data-verdict="right">right</button>
           <button class="btn btn-mini" data-claim="${id}" data-verdict="wrong">wrong</button>
           <button class="btn btn-mini" data-claim="${id}" data-verdict="partial">partial</button>
           <button class="btn btn-mini" data-claim="${id}" data-verdict="void">not a claim</button>
         </div>`
      : `<div class="claim-actions">
           <span class="verdict v-${status}">${status}</span>
           <button class="btn btn-mini" data-claim="${id}" data-verdict="open">reopen</button>
         </div>`;
  return `<li class="claim s-${status}${overdue ? ' overdue' : ''}">
    <div class="claim-top">
      <span class="claim-type t-${type}">${type}</span>
      <span class="claim-conf" title="how sure they sounded">${conf}</span>
      ${c.domain ? `<span class="claim-domain">${escapeHtml(c.domain)}</span>` : ''}
      <span class="claim-when">${escapeHtml(fmtDay(c.sourceDate))}${due}${overdue ? ' · overdue' : ''}</span>
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

// Render before showing, so focus lands on populated content rather than on an
// empty body that fills in a frame later.
function openLedger() {
  renderLedger();
  openModal($('#ledger-modal'));
}
function closeLedger() { closeModal($('#ledger-modal')); }

/* ================================================================= shake */
// Rejected credentials get a physical answer as well as a written one. Reading
// offsetWidth forces a reflow so the animation restarts on a repeated failure
// instead of only playing the first time.
function shake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

/* =============================================================== toasts */
function toast(msg, kind = '') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const ico = kind === 'ok' ? 'i-check' : kind === 'err' ? 'i-alert' : 'i-info';
  el.innerHTML =
    `<svg class="ico ico-sm toast-ico" aria-hidden="true"><use href="#${ico}"/></svg>` +
    `<span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 300); }, kind === 'err' ? 6000 : 3800);
}

/* ================================================================ overlays */
/* ----------------------------------------------------------------------------
   Dialogs previously appeared and vanished with a bare `.hidden` toggle. That
   left four things unhandled: no exit animation, no scroll lock (the page
   scrolled behind an open dialog), no focus containment, and focus was never
   returned to the control that opened it. Every overlay routes through here so
   all four behave identically, and so Escape works on the confirm dialog too.
---------------------------------------------------------------------------- */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

// Matches --dur-fast in the stylesheet: how long the node is held on screen so
// the close animation can play before it is hidden.
const CLOSE_MS = 150;

// A stack, not a flag: the confirm dialog opens on top of the ledger.
const overlayStack = [];

const visibleFocusable = (root) =>
  $$(FOCUSABLE, root).filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);

const topOverlay = () =>
  (overlayStack.length ? overlayStack[overlayStack.length - 1].modal : null);

// One place decides whether the background may scroll: any open dialog, the
// mobile drawer, or the lock screen.
function syncScrollLock() {
  const locked = !$('#lock-screen').classList.contains('hidden');
  const drawer = compactView() && sidebarOpen();
  document.body.classList.toggle('scroll-lock', overlayStack.length > 0 || drawer || locked);
}

function openModal(modal) {
  if (!modal.classList.contains('hidden')) return;
  modal.classList.remove('hidden', 'is-closing');
  overlayStack.push({ modal, restore: document.activeElement });
  syncScrollLock();
  const first = visibleFocusable(modal)[0];
  if (first) first.focus();
}

function closeModal(modal) {
  if (!modal || modal.classList.contains('hidden') || modal.classList.contains('is-closing')) return;
  const i = overlayStack.findIndex((o) => o.modal === modal);
  const entry = i === -1 ? null : overlayStack.splice(i, 1)[0];
  modal.classList.add('is-closing');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('is-closing');
  }, CLOSE_MS);
  syncScrollLock();
  // Announced so a promise-based dialog can settle when it is dismissed by
  // Escape or the backdrop rather than by its own buttons.
  modal.dispatchEvent(new CustomEvent('overlay:close'));
  if (entry && entry.restore && document.contains(entry.restore)) entry.restore.focus();
}

// Tab is confined to the topmost dialog; Escape closes it. With no dialog open,
// Escape dismisses the mobile drawer.
function onOverlayKeydown(e) {
  const modal = topOverlay();
  if (!modal) {
    if (e.key === 'Escape' && compactView() && sidebarOpen()) setSidebar(false);
    return;
  }
  if (e.key === 'Escape') { e.preventDefault(); closeModal(modal); return; }
  if (e.key !== 'Tab') return;
  const items = visibleFocusable(modal);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ================================================================= sidebar */
/* Below 900px the sidebar is an overlay drawer. It used to stack ABOVE main, so
   every trip from History to a report scrolled past the whole generate form. */
const compactMQ = window.matchMedia('(max-width: 900px)');
const compactView = () => compactMQ.matches;
const sidebarOpen = () => $('#app').getAttribute('data-sidebar') === 'expanded';

function setSidebar(open, persist = true) {
  $('#app').setAttribute('data-sidebar', open ? 'expanded' : 'collapsed');
  $('#btn-sidebar').setAttribute('aria-expanded', String(open));
  // Only the desktop preference is remembered. On a phone the drawer covers the
  // report, so it always starts closed regardless of how it was last left.
  if (persist && !compactView()) localStorage.setItem(LS.sidebar, open ? '1' : '0');
  syncScrollLock();
}

const toggleSidebar = () => setSidebar(!sidebarOpen());

function applySidebarForViewport() {
  setSidebar(compactView() ? false : localStorage.getItem(LS.sidebar) !== '0', false);
}

/* ========================================================== sidebar panels */
/* Generate and History each collapse to their header. Expanded together they
   are taller than a laptop viewport, which used to push History off the bottom
   of the sticky column with nothing to scroll. Both default to open. */
const PANELS = ['generate', 'history'];

function readPanels() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS.panels) || '{}');
    return PANELS.reduce((acc, name) => {
      acc[name] = raw[name] !== false;   // anything but an explicit false is open
      return acc;
    }, {});
  } catch {
    return PANELS.reduce((acc, name) => (acc[name] = true, acc), {});
  }
}

function setPanel(name, open, persist = true) {
  const card = $('#' + name + '-card');
  const btn = $(`.card-toggle[data-panel="${name}"]`);
  // Guarded: a panel can be absent from the DOM (or renamed) without taking
  // boot down with it.
  if (!card || !btn) return;
  card.classList.toggle('is-collapsed', !open);
  btn.setAttribute('aria-expanded', String(open));
  if (!persist) return;
  const state = readPanels();
  state[name] = open;
  try { localStorage.setItem(LS.panels, JSON.stringify(state)); } catch { /* quota */ }
}

function togglePanel(name) {
  const card = $('#' + name + '-card');
  if (!card) return;
  setPanel(name, card.classList.contains('is-collapsed'));
}

function applyPanels() {
  const state = readPanels();
  PANELS.forEach((name) => setPanel(name, state[name], false));
}

/* =========================================================== confirm modal */
function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      $('#confirm-ok').removeEventListener('click', ok);
      $('#confirm-cancel').removeEventListener('click', cancel);
      modal.removeEventListener('overlay:close', dismissed);
      closeModal(modal);
      resolve(val);
    };
    const ok = () => finish(true);
    const cancel = () => finish(false);
    // Escape and backdrop clicks go through closeModal, which fires this — so a
    // dismissed dialog resolves false instead of leaving the caller awaiting
    // forever.
    const dismissed = () => finish(false);
    $('#confirm-ok').addEventListener('click', ok);
    $('#confirm-cancel').addEventListener('click', cancel);
    modal.addEventListener('overlay:close', dismissed);
    openModal(modal);
  });
}

/* ============================================================ settings UI */
// Refill the directive on open: it syncs, so another device may have changed it
// since this modal was last built.
function openSettings() {
  fillAdvicePrompt();
  openModal($('#settings-modal'));
}
function closeSettings() { closeModal($('#settings-modal')); }

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
  $('#cloud-account').textContent = cloudEmail || 'not signed in';
  $('#set-provider').value = activeProvider();
  $('#set-openai-key').value = c.openaiKey;
  $('#set-anthropic-key').value = c.anthropicKey;
  $('#set-gemini-key').value = c.geminiKey;
  $('#set-groq-key').value = c.groqKey;
  $('#set-cerebras-key').value = c.cerebrasKey;
  $('#set-openrouter-key').value = c.openrouterKey;
  $('#set-mistral-key').value = c.mistralKey;
  $('#set-cohere-key').value = c.cohereKey;
  $('#set-huggingface-key').value = c.huggingfaceKey;
  $('#set-repo').value = c.repo;
  $('#set-notes-path').value = c.notesPath;
  $('#set-branch').value = c.branch;
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
  el.textContent = 'saved';
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

  const tData = line('Supabase account');
  try {
    await dataPull();
    done(tData, true, `Supabase account: ok (${cloudEmail})`);
  } catch (e) { done(tData, false, `Supabase account: failed (${e.message})`); }

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
  $('#lock-screen').setAttribute('aria-hidden', 'false');
  $('#app').setAttribute('aria-hidden', 'true');
  syncScrollLock();
  setTimeout(() => $('#lock-input').focus(), 50);
}
function hideLock() {
  $('#lock-screen').classList.add('hidden');
  $('#lock-screen').setAttribute('aria-hidden', 'true');
  $('#app').removeAttribute('aria-hidden');
  syncScrollLock();
}

async function finishCloudLogin() {
  if (!state.cacheHydrated) {
    state.data = normalizeData(await readCache());
    state.dirty = localStorage.getItem(LS.dirty) === '1';
    state.cacheHydrated = true;
    renderHistory();
    const lastId = localStorage.getItem(LS.lastId);
    if (lastId && state.data.reports.find((r) => r.id === lastId)) selectReport(lastId);
  }
  $('#auth-screen').classList.add('hidden');
  $('#auth-screen').setAttribute('aria-hidden', 'true');
  $('#app').classList.remove('hidden');
  // The drawer state depends on the viewport, which is only meaningful once the
  // shell is actually on screen.
  applySidebarForViewport();
  fillSettings();
  updateChecklist();
  if (isLocked()) showLock();
  else onUnlocked();
}

async function signOutDaily() {
  if (state.dirty) await flushPush();
  await clearCache();
  await cloudSignOut();
  [LS.cache, LS.lastId, LS.dirty].forEach((key) => localStorage.removeItem(key));
  location.reload();
}

/* ==================================================================== init */
function bindSettingsInputs() {
  const map = {
    'set-github-token': 'githubToken',
    'set-openai-key': 'openaiKey',
    'set-anthropic-key': 'anthropicKey',
    'set-gemini-key': 'geminiKey',
    'set-groq-key': 'groqKey',
    'set-cerebras-key': 'cerebrasKey',
    'set-openrouter-key': 'openrouterKey',
    'set-mistral-key': 'mistralKey',
    'set-cohere-key': 'cohereKey',
    'set-huggingface-key': 'huggingfaceKey',
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
      // Every provider key input ends in -key; the journal's is -token.
      if (/-key$/.test(id)) populateModelOptions();
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
      const revealing = inp.type === 'password';
      inp.type = revealing ? 'text' : 'password';
      // Drives both the assistive-tech state and which of the two glyphs the
      // stylesheet shows.
      btn.setAttribute('aria-pressed', String(revealing));
    });
  });
}

async function init() {
  // Retire credentials from the former GitHub data-repository backend.
  ['msi.data' + 'Token', 'msi.data' + 'Repo', 'msi.data' + 'Path',
   'msi.data' + 'Branch'].forEach((key) => localStorage.removeItem(key));
  loadCfg();

  // Theme (respect stored pref, else system). The inline <head> script already
  // resolved this before first paint; this only keeps the JS state in step.
  const storedTheme = localStorage.getItem(LS.theme);
  applyTheme(
    storedTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    Boolean(storedTheme)
  );
  applySidebarForViewport();

  // Defaults for controls.
  $('#target-month').value = prevMonthStr();
  syncRangeToMonth();
  fillSettings();
  bindSettingsInputs();
  bindReveal();
  updateChecklist();
  renderHistory();

  // Top bar.
  $('#btn-sync').addEventListener('click', () => cloudSync());
  $('#btn-theme').addEventListener('click', toggleTheme);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-signout').addEventListener('click', signOutDaily);
  $$('[data-close-settings]').forEach((el) => el.addEventListener('click', closeSettings));
  $$('[data-open-settings]').forEach((el) => el.addEventListener('click', openSettings));

  // Sidebar: button, scrim, Ctrl/Cmd+B, and a re-resolve when the viewport
  // crosses the drawer breakpoint.
  $('#btn-sidebar').addEventListener('click', toggleSidebar);
  $$('[data-close-sidebar]').forEach((el) => el.addEventListener('click', () => setSidebar(false)));
  // Collapsible sidebar panels.
  $$('.card-toggle[data-panel]').forEach((btn) =>
    btn.addEventListener('click', () => togglePanel(btn.dataset.panel)));
  applyPanels();
  compactMQ.addEventListener('change', applySidebarForViewport);
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'b') return;
    if ($('#app').classList.contains('hidden')) return;
    e.preventDefault();
    toggleSidebar();
  });

  // Any dialog backdrop dismisses its own dialog, including the confirm dialog,
  // whose backdrop previously did nothing.
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal(e.target.closest('.modal'));
  });

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
  $('#range-start').addEventListener('change', syncMonthToRange);
  $('#range-end').addEventListener('change', syncMonthToRange);
  $('#btn-generate').addEventListener('click', generateReport);
  $('#btn-copy').addEventListener('click', copyCurrentReport);
  $('#btn-download').addEventListener('click', downloadCurrentReport);
  $('#btn-delete').addEventListener('click', deleteCurrentReport);
  $('#reflection-input').addEventListener('input', onReflectionInput);

  // Follow-ups. Delegated — the list is rebuilt on every report switch.
  $('#btn-followups').addEventListener('click', askMoreFollowups);
  $('#btn-regen').addEventListener('click', regenerateWithAnswers);
  $('#followup-list').addEventListener('input', onFollowupInput);

  // Settings actions.
  $('#btn-refresh-models').addEventListener('click', refreshModels);
  $('#btn-test').addEventListener('click', testConnections);
  $('#set-advice-prompt').addEventListener('input', onAdviceInput);
  $('#btn-reset-advice').addEventListener('click', resetAdvicePrompt);

  // Focus containment + Escape for whichever dialog is on top; Escape also
  // dismisses the mobile drawer when no dialog is open.
  document.addEventListener('keydown', onOverlayKeydown);

  $('#lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hash = await sha256Hex($('#lock-input').value);
    if (hash === localStorage.getItem(LS.passHash)) {
      hideLock(); onUnlocked();
    } else {
      $('#lock-error').classList.remove('hidden');
      $('#lock-input').value = '';
      shake($('#lock-form'));
      $('#lock-input').focus();
    }
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('#auth-submit');
    const message = $('#auth-error');
    button.disabled = true;
    button.textContent = 'Signing in…';
    message.classList.add('hidden');
    const result = await cloudSignIn(
      $('#auth-email').value.trim(), $('#auth-password').value
    );
    if (result.ok) {
      $('#auth-password').value = '';
      await finishCloudLogin();
    } else {
      message.textContent = result.error;
      message.classList.remove('hidden');
      button.disabled = false;
      button.textContent = 'Sign in';
      shake($('#auth-form'));
    }
  });

  try {
    const session = await getCloudSession();
    if (session) await finishCloudLogin();
  } catch (error) {
    $('#auth-error').textContent = error.message;
    $('#auth-error').classList.remove('hidden');
  }

  setSync('', 'not synced');
}

// Runs once the app is visible (after unlock, or immediately if no lock).
function onUnlocked() {
  if (canSync()) {
    subscribeCloud();
    cloudSync();
  }
}

document.addEventListener('DOMContentLoaded', init);
