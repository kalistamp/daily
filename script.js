/* ============================================================================
   Monthly Self-Interrogation Agent — application logic (vanilla JS, no deps)
   ----------------------------------------------------------------------------
   PRIVACY MODEL (confirmed):
     • Pure client-side. No backend server. Runs entirely in the browser.
     • The parent repository holding the private daily-journal markdown stays
       100% PRIVATE. Only the static files in this `docs/` folder are public.
     • All persistent data (reports + metadata) lives in a PRIVATE GitHub Gist
       as JSON. The Gist stays PRIVATE.
     • Secrets (GitHub token, Gist ID, Gemini API key, selected model) are kept
       EXCLUSIVELY in this browser's localStorage. They are NEVER written into
       any file in this public `docs/` folder — only sent directly over HTTPS to
       api.github.com and generativelanguage.googleapis.com.
   ========================================================================== */

'use strict';

/* -------------------------------------------------------------- constants */
const GIST_FILE = 'monthly-reports.json';
const LS = {
  githubToken: 'msi.githubToken',
  gistId:      'msi.gistId',
  geminiKey:   'msi.geminiKey',
  geminiModel: 'msi.geminiModel',
  repo:        'msi.repo',
  notesPath:   'msi.notesPath',
  branch:      'msi.branch',
  theme:       'msi.theme',
  passHash:    'msi.passHash',
  gistCache:   'msi.gistCache',
  lastId:      'msi.lastId',
};
// Gist ID pre-filled from the private gist provided by the user.
const DEFAULTS = {
  githubToken: '',
  gistId:      'ead6fb9238714dfc51d0b3fea495e899',
  geminiKey:   '',
  geminiModel: 'gemini-flash-latest',
  repo:        'kalistamp/Daily_ng',
  notesPath:   '2026/2026daily_pt1.md',
  branch:      'main',
};

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

function missingSecrets() {
  const c = cfg();
  const miss = [];
  if (!c.githubToken) miss.push('token');
  if (!c.gistId)      miss.push('gist');
  if (!c.geminiKey)   miss.push('gemini');
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
   REPO WRITE SAFETY  ·  the daily journal is STRICTLY READ-ONLY
   ---------------------------------------------------------------------------
   HARD INVARIANT: this app may WRITE repo content to exactly ONE shape of path
   — `monthly-reports/YYYY-MM.md` — and nothing else. The daily journal
   (2026/2026daily_pt1.md) and every other repo file are read-only. Every repo
   write MUST route through githubPutRepoFile(), which calls assertRepoWritable()
   BEFORE any network request. No code path PUT/PATCH/DELETEs the journal, and
   the guard resolves `.`/`..` so path traversal can never reach it.
--------------------------------------------------------------------------- */
const REPO_WRITE_ALLOW = /^monthly-reports\/\d{4}-\d{2}\.md$/;

// Collapse slashes and resolve "." / ".." so a crafted value can't traverse out
// of monthly-reports/ into the journal (e.g. "monthly-reports/../2026/…").
function normalizeRepoPath(p) {
  const out = [];
  for (const seg of String(p).replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

// Throws unless `path` is an allowlisted report file. Also explicitly refuses
// the journal path as a belt-and-suspenders denylist.
function assertRepoWritable(path) {
  const norm = normalizeRepoPath(path);
  const journal = normalizeRepoPath(cfg().notesPath || DEFAULTS.notesPath);
  if (norm === journal || norm === normalizeRepoPath(DEFAULTS.notesPath)) {
    throw new Error(`Blocked: "${norm}" is the read-only journal and must never be written.`);
  }
  if (!REPO_WRITE_ALLOW.test(norm)) {
    throw new Error(`Blocked: repo writes are limited to monthly-reports/YYYY-MM.md (got "${norm}").`);
  }
  return norm;
}

// The ONLY function permitted to write repo content. Guarded before any fetch.
async function githubPutRepoFile(path, markdown, message) {
  const safePath = assertRepoWritable(path);
  const { repo, branch } = cfg();
  const apiPath = encPath(safePath);
  let sha;
  const get = await fetch(`https://api.github.com/repos/${repo}/contents/${apiPath}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders() });
  if (get.ok) sha = (await get.json()).sha;
  const body = { message, content: b64EncodeUnicode(markdown), branch };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${apiPath}`, {
    method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.message || `Commit failed (${res.status}). Token needs Contents:write on ${repo}.`);
  }
  return (await res.json()).content?.html_url;
}

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

// Commits a generated report to monthly-reports/YYYY-MM.md ONLY. `month` is
// strictly validated, then the write is funneled through the guarded choke
// point (githubPutRepoFile) so it can never target the journal.
async function githubCommitReport(month, markdown) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) {
    throw new Error(`Invalid report month "${month}" — expected YYYY-MM.`);
  }
  return githubPutRepoFile(
    `monthly-reports/${month}.md`,
    markdown,
    `Add monthly self-interrogation report ${month}`
  );
}

/* ================================================================= Gemini */
async function geminiGenerate(model, systemText, userText) {
  const key = cfg().geminiKey;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: 4096 },
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Gemini request failed (${res.status}).`);
    err.status = res.status;
    err.gstatus = data?.error?.status;
    throw err;
  }
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = cand?.finishReason || data?.promptFeedback?.blockReason || 'empty response';
    throw new Error(`Gemini returned no text (${reason}).`);
  }
  return text;
}

async function geminiListModels() {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cfg().geminiKey)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Model list failed (${res.status}).`);
  return (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /gemini/i.test(n));
}

// Ordered fallback. Try the preferred model first (fast path). If it's
// unavailable/deprecated, discover the models THIS key can actually use
// (listModels only returns usable ones), rank them, and try each until one
// works — then remember the winner so later runs start there.
async function geminiGenerateSmart(preferred, systemText, userText, onModel) {
  const tried = new Set();
  const staticFallbacks = [
    'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash',
    'gemini-pro-latest', 'gemini-2.5-pro', 'gemini-flash-lite-latest', 'gemini-2.0-flash-lite',
  ];
  let queue = [preferred, ...staticFallbacks].filter(Boolean);
  let liveLoaded = false;
  let lastErr = null;

  for (let i = 0; i < queue.length; i++) {
    const model = queue[i];
    if (!model || tried.has(model)) continue;
    tried.add(model);
    if (onModel) onModel(model, tried.size > 1);
    try {
      const text = await geminiGenerate(model, systemText, userText);
      rememberModel(model);
      return { text, model, fellBack: model !== preferred };
    } catch (e) {
      lastErr = e;
      // Only walk the fallback chain for "this model isn't available" errors.
      // Auth / quota / safety / network errors stop immediately.
      if (!isModelAvailabilityError(e)) throw e;
      if (!liveLoaded) {
        liveLoaded = true;
        let live = [];
        try { live = (await geminiListModels()).sort((a, b) => rankModel(b) - rankModel(a)); } catch (_) { /* keep static queue */ }
        if (live.length) queue = queue.slice(0, i + 1).concat(live.filter((m) => !tried.has(m)));
      }
    }
  }
  throw new Error(`No available Gemini model worked (tried ${tried.size}). Last error: ${lastErr ? lastErr.message : 'unknown'}`);
}

function rememberModel(model) {
  if (model === cfg().geminiModel) return;
  setCfg('geminiModel', model);
  ensureModelOption(model);
  const sel = $('#set-gemini-model');
  if (sel) sel.value = model;
}

function isModelAvailabilityError(e) {
  if (e && e.status === 404) return true;
  const m = ((e && e.message) || '').toLowerCase();
  return /no longer available|not found|does not exist|is not supported|not supported for|unavailable|deprecated|call listmodels|unknown name|invalid model|not a valid/.test(m);
}

// Higher = preferred. Newer version > flash > pro > lite; penalize special/experimental variants.
function rankModel(name) {
  const n = (name || '').toLowerCase();
  let score = 0;
  const v = n.match(/(\d+)\.(\d+)/);
  if (v) score += (parseInt(v[1], 10) * 10 + parseInt(v[2], 10)) * 100;
  if (n.includes('flash') && !n.includes('lite')) score += 50;
  else if (n.includes('pro')) score += 45;
  else if (n.includes('lite')) score += 30;
  if (n.includes('latest')) score += 25;
  if (/exp|preview|thinking|image|audio|tts|vision|learnlm|embedding|aqa|gemma/.test(n)) score -= 300;
  return score;
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

function sliceForMonth(entries, monthStr, lookbackDays) {
  const [y, m] = monthStr.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0));           // last day of target month
  const start = new Date(Date.UTC(y, m - 1, 1));          // first day of target month
  start.setUTCDate(start.getUTCDate() - Number(lookbackDays || 0));
  return entries
    .filter((e) => {
      const d = new Date(e.date + 'T00:00:00Z');
      return !isNaN(d) && d >= start && d <= monthEnd;
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
    '',
    'Voice & style:',
    '- concise, slightly informal, lowercase starts where natural.',
    '- NOT beginner-level. assume high context. no fluff, no therapy-speak, no praise padding.',
    '- questions must be genuinely probing — the kind that are uncomfortable to answer honestly.',
    '- reference concrete specifics from the entries (projects, decisions, numbers, names) instead of generic prompts.',
    '',
    'Output EXACTLY these Markdown sections, in this order, using `##` headings:',
    '## executive overview',
    '  - 3–5 tight sentences on what actually happened this month: momentum, drift, and the real story under the surface.',
    '## theme-weighted question bank',
    '  - 8–12 questions, grouped/weighted toward the dominant themes you detect. prefix each with the theme in brackets, e.g. `[ai]`.',
    '## contradiction / open-loop detector',
    '  - 4–6 questions targeting contradictions, abandoned threads, and unfinished commitments you can see in the entries.',
    '## adversarial self-audit',
    '  - 4–6 questions written like a skeptical outsider poking holes in the reasoning, priorities, and excuses.',
    '## future-self letter',
    '  - 4–6 questions framed as if written by them 3–6 months from now, looking back — "why did you…", "did you ever…".',
    '## cross-domain synthesis',
    '  - 4–6 questions that force connections across unrelated domains in the entries (e.g. link a health pattern to a career decision).',
    '',
    'Rules: output only the report as Markdown. no preamble, no closing note. every question on its own line as a list item.',
  ].join('\n');
}

function buildUserPrompt(monthStr, slice, themes, loops) {
  const themeLine = themes.length
    ? themes.map((t) => `${t.label} (${t.score})`).join(', ')
    : 'none detected locally';
  const loopBlock = loops.length ? loops.map((l) => `- ${l}`).join('\n') : '- (none auto-detected)';
  const body = slice.map((e) => `### ${e.date}${e.title ? ' ' + e.title : ''}\n${e.body}`).join('\n\n');
  return [
    `TARGET MONTH: ${monthStr} (entries below may include a look-back window before the 1st).`,
    `LOCALLY DETECTED THEMES (weight): ${themeLine}`,
    `LOCALLY DETECTED OPEN LOOPS / UNFINISHED:`,
    loopBlock,
    '',
    '=== JOURNAL ENTRIES ===',
    body || '(no entries found)',
    '=== END ENTRIES ===',
  ].join('\n');
}

/* ============================================================ base64 utf8 */
function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
// GitHub returns base64 with embedded newlines; strip whitespace, then decode
// as UTF-8 (atob alone mangles multi-byte chars like em dashes / arrows).
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
  const lookback = clampInt($('#lookback-days').value, 0, 60, 14);
  const model = cfg().geminiModel || DEFAULTS.geminiModel;
  const btn = $('#btn-generate');
  btn.disabled = true;
  showProgress(true, 'Fetching journal…');
  try {
    const md = await githubFetchNotes();
    const entries = parseEntries(md);
    const slice = sliceForMonth(entries, month, lookback);
    if (!slice.length) {
      throw new Error(`No entries found for ${month} (+${lookback}d look-back) in ${cfg().notesPath}.`);
    }
    showProgress(true, 'Analyzing themes…');
    const joined = slice.map((e) => e.body).join('\n');
    const themes = analyzeThemes(joined);
    const loops = findOpenLoops(slice);

    showProgress(true, `Interrogating ${model}…`);
    const gen = await geminiGenerateSmart(
      model, buildSystemPrompt(), buildUserPrompt(month, slice, themes, loops),
      (m, isFallback) => showProgress(true, `${isFallback ? 'Falling back to' : 'Interrogating'} ${m}…`)
    );
    const reportMd = gen.text;
    if (gen.fellBack) toast(`"${model}" unavailable — used "${gen.model}" instead (saved as your model).`, 'ok');

    const report = {
      id: `${month}-${Date.now().toString(36)}`,
      month,
      generatedAt: new Date().toISOString(),
      model: gen.model,
      entryCount: slice.length,
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
    toast(`Report for ${month} generated (${slice.length} entries).`, 'ok');
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

async function commitCurrentReport() {
  const r = currentReport();
  if (!r) return;
  const btn = $('#btn-commit');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Committing…';
  try {
    const url = await githubCommitReport(r.month, r.report);
    toast('Committed to private repo → monthly-reports/' + r.month + '.md', 'ok');
    if (url) toast('View: ' + url, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
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

function copyCurrentReport() {
  const r = currentReport();
  if (!r) return;
  navigator.clipboard.writeText(r.report)
    .then(() => toast('Markdown copied.', 'ok'))
    .catch(() => toast('Copy failed.', 'err'));
}
function downloadCurrentReport() {
  const r = currentReport();
  if (!r) return;
  const blob = new Blob([r.report], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${r.month}.md`;
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
    li.innerHTML =
      `<span class="hi-month">${r.month}</span>` +
      `<span class="hi-sub"><span>${r.model}</span><span>${fmtDate(r.generatedAt)}</span>` +
      (r.reflection ? '<span>· reflected</span>' : '') + `</span>`;
    li.addEventListener('click', () => selectReport(r.id));
    list.appendChild(li);
  }
}

function renderReport(r) {
  if (!r) return showEmpty();
  $('#empty-state').classList.add('hidden');
  $('#report-view').classList.remove('hidden');
  $('#report-title').textContent = `${r.month} · self-interrogation`;
  $('#meta-month').textContent = r.month + (r.entryCount ? ` · ${r.entryCount} entries` : '');
  $('#meta-model').textContent = r.model;
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
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

function fillSettings() {
  const c = cfg();
  $('#set-github-token').value = c.githubToken;
  $('#set-gist-id').value = c.gistId;
  $('#set-gemini-key').value = c.geminiKey;
  $('#set-repo').value = c.repo;
  $('#set-notes-path').value = c.notesPath;
  $('#set-branch').value = c.branch;
  ensureModelOption(c.geminiModel);
  $('#set-gemini-model').value = c.geminiModel;
}
function ensureModelOption(name) {
  const sel = $('#set-gemini-model');
  if (name && ![...sel.options].some((o) => o.value === name)) {
    const o = document.createElement('option');
    o.value = name; o.textContent = name;
    sel.appendChild(o);
  }
}
function flashSaved() {
  const el = $('#settings-saved');
  el.textContent = 'saved ✓';
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => (el.textContent = 'changes auto-save'), 1200);
}

async function refreshModels() {
  if (!cfg().geminiKey) { toast('Add your Gemini API key first.', 'err'); return; }
  const btn = $('#btn-refresh-models');
  btn.disabled = true; const prev = btn.textContent; btn.textContent = '…';
  try {
    const models = (await geminiListModels()).sort((a, b) => rankModel(b) - rankModel(a));
    const sel = $('#set-gemini-model');
    const current = sel.value;
    sel.innerHTML = '';
    models.forEach((m) => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
    ensureModelOption(current);
    sel.value = models.includes(current) ? current : (models[0] || current);
    setCfg('geminiModel', sel.value);
    toast(`Loaded ${models.length} models.`, 'ok');
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

  const tGem = line('Gemini key');
  try {
    const models = await geminiListModels();
    done(tGem, true, `Gemini key: ok (${models.length} models)`);
  } catch (e) { done(tGem, false, `Gemini key: failed`); }
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
    });
  }
  $('#set-gemini-model').addEventListener('change', (e) => { setCfg('geminiModel', e.target.value); flashSaved(); });

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
  $('#btn-generate').addEventListener('click', generateReport);
  $('#btn-copy').addEventListener('click', copyCurrentReport);
  $('#btn-download').addEventListener('click', downloadCurrentReport);
  $('#btn-commit').addEventListener('click', commitCurrentReport);
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
