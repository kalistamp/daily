import {
  createIcons,
  BookOpen,
  LogOut,
  Plus,
  Pencil,
  History,
  Trash2,
  Download,
  RefreshCw,
  Settings,
  FileText,
  Folder,
  ShieldCheck,
  X,
  Archive,
  RotateCcw,
  Save,
  SunMoon,
  Scale,
  NotebookPen,
  ChevronDown,
} from "lucide";
import { client, CloudBackend, LocalBackend } from "./backend.js";
import {
  calendarDay,
  countdown,
  sortedEntries,
  entryPayload,
  entryMeta,
  entryBucket,
  weekdayLabel,
  shortDate,
} from "./domain.js";
import { renderMarkdown } from "./markdown.js";
import { mountInterrogation } from "./interrogation.js";
import {establishedContext} from '../supabase/functions/_shared/reflection.mjs';
import { providers } from "../supabase/functions/_shared/providers.mjs";
const app = document.querySelector("#app"),
  dialog = document.querySelector("#dialog");
const icons = {
  BookOpen,
  LogOut,
  Plus,
  Pencil,
  History,
  Trash2,
  Download,
  RefreshCw,
  Settings,
  FileText,
  Folder,
  ShieldCheck,
  X,
  Archive,
  RotateCcw,
  Save,
};
icons.SunMoon = SunMoon;
icons.Scale = Scale;
icons.NotebookPen=NotebookPen;icons.ChevronDown=ChevronDown;
let recovering = false;
let reportLoad = 0;
let backend,
  data,
  year = Number(calendarDay().slice(0, 4)),
  view = "entries",
  query = "",
  limit = 30,
  trash = false,
  reportRows = [],
  generation = 0,
  leaderboard,
  dirty = false;
let selectedEntryId = null;
let journalDetailOpen = false;
let expanded = new Set();
let modalDirty = false;
const tasks = new Set();
function syncBusy() {
  const working = tasks.size > 0;
  app.inert = working;
  dialog.inert = working;
  // Drives the sweep bar and the in-button dots; assistive tech gets aria-busy.
  app.setAttribute("aria-busy", working ? "true" : "false");
  document.documentElement.classList.toggle("working", working);
}
async function runTask(fn) {
  if (tasks.size) throw Error("Wait for the current request to finish.");
  const task = Symbol();
  tasks.add(task);
  syncBusy();
  try {
    return await fn();
  } finally {
    tasks.delete(task);
    syncBusy();
  }
}
const guardedTask = (fn) => (...args) => action(() => runTask(() => fn(...args)));
document.title = "Monthly Self-Interrogation";
document.documentElement.dataset.theme =
  localStorage.getItem("daily-ui-theme") ||
  localStorage.getItem("msi.theme") ||
  "dark";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name) => `<i data-lucide="${name}"></i>`;
const button = (name, label, attrs = "") =>
  `<button class="icon" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}>${icon(name)}</button>`;
const redrawIcons = () => createIcons({ icons });
function notice(message, tone = "") {
  const n = document.querySelector("#notice");
  n.className = tone;
  n.textContent = message;
  n.classList.add("visible");
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => n.classList.remove("visible"), 7000);
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function asset(row) {
  const current = backend, authId = generation;
  const blob = await current.asset(row);
  if (current !== backend || authId !== generation) return;
  download(blob, row.source_key.split("/").pop());
}
function markdown(el, text, source) {
  renderMarkdown(el, text, source, data?.assets || [], (row) =>
    action(() => asset(row)),
  );
}
function closeModal() {
  if (tasks.size) return;
  if (!modalDirty || confirm("Discard unsaved changes?")) {
    modalDirty = false;
    dialog.close();
  }
}
function modal(title, body, footer = "") {
  modalDirty = false;
  dialog.classList.remove("studio-editor");
  dialog.innerHTML = `<header><h2>${esc(title)}</h2>${button("x", "Close", "data-close")}</header><div class="body">${body}</div><footer>${footer || "<button data-close>Close</button>"}</footer>`;
  dialog
    .querySelectorAll("[data-close]")
    .forEach((b) => (b.onclick = closeModal));
  dialog.oninput = () => (modalDirty = true);
  dialog.oncancel = (e) => {
    e.preventDefault();
    closeModal();
  };
  if (!dialog.open) dialog.showModal();
  redrawIcons();
}
function formError(form, error) {
  form.querySelector(".error").textContent = error.message;
}
function login(message = "") {
  backend = null;
  data = null;
  reportRows = [];
  leaderboard = null;
  dirty = false;
  modalDirty = false;
  tasks.clear();
  syncBusy();
  dialog.close();
  dialog.replaceChildren();
  app.innerHTML = `<main class="auth"><div class="brand">${icon("book-open")}<h1>Daily</h1></div><h2>Your private journal</h2><p>Sign in to continue.</p><form id="login"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><div class="error">${esc(message)}</div><button class="primary">Sign in ${icon("shield-check")}</button><button type="button" class="link" id="reset">Reset password</button></form></main>`;
  redrawIcons();
  const form = document.querySelector("#login");
  app.querySelector('.brand h1').textContent='Monthly Self-Interrogation';
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = form.querySelector(".primary");
    b.disabled = true;
    try {
      const { data, error } = await client.auth.signInWithPassword(
        Object.fromEntries(new FormData(form)),
      );
      if (error) throw error;
      await authenticate(data.session);
    } catch (e) {
      login(e.message);
    } finally {
      b.disabled = false;
    }
  };
  document.querySelector("#reset").onclick = async () => {
    const email = form.elements.email.value;
    if (!email) return formError(form, Error("Enter your email first."));
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: new URL("./", location.href).href,
    });
    formError(form, error || Error("Check your email for a reset link."));
  };
}
async function authenticate(session) {
  const id = ++generation;
  if (!session) return login();
  const { data: owners, error } = await client
    .from("journal_owners")
    .select("user_id");
  if (id !== generation) return;
  if (error)
    throw Error("Private database setup is not ready. " + error.message);
  if (!owners?.length) throw Error("This account is not authorized for Daily.");
  backend = new CloudBackend(session.user);
  await reload();
  await refreshLeaderboard();
}
async function signout() {
  generation++;
  if (backend?.local) {
    location.href = "/__review/logout";
    return;
  }
  const { error } = await client.auth.signOut({ scope: "local" });
  login(
    error
      ? "Session ended locally. Revoke other sessions from account settings if needed."
      : "",
  );
}
async function reload() {
  const current = backend,
    id = generation;
  if (!current) return;
  const loaded = await current.load();
  if (id !== generation || current !== backend) return;
  data = loaded;
  render();
}
function navigate() {
  window.history.pushState(null, "", `#/${year}/${view}`);
}
function readRoute() {
  const m = location.hash.match(
    /^#\/(\d{4})\/(entries|documents|assets|reports|ledger|settings)$/,
  );
  if (m && Number(m[1]) >= 1900 && Number(m[1]) <= 2200) {
    year = Number(m[1]);
    view = m[2];
  }
}
function render() {
  if (!data) return;
  const c = countdown(),
    years = [
      ...new Set([
        year,
        c.year,
        ...data.years.map((y) => y.year),
        ...data.entries.map((e) => e.archive_year),
        ...data.documents.map((e) => e.archive_year),
        ...data.assets.map((e) => e.archive_year),
      ]),
    ].sort((a, b) => b - a);
  app.innerHTML = `<header class="topbar"><div class="brand">${icon("book-open")}<div><h1>Daily</h1><small>${backend.local ? "Private local review" : "Private journal"}</small></div>${backend.local ? '<span class="local-badge">LOCAL</span>' : ""}</div><div class="top-actions"><div class="countdown" id="countdown"></div><div class="leader"><select aria-label="Top agents" id="agents"><option>${backend.local ? "Agents unavailable offline" : "Loading agents..."}</option></select><small id="agent-status"><a href="https://arena.ai/leaderboard/agent" target="_blank" rel="noopener noreferrer">Arena · Overall</a></small></div>${button("log-out", "Sign out", 'id="signout"')}</div></header><div class="workspace"><nav class="sidebar" aria-label="Journal"><label><span>YEAR</span><select id="year" aria-label="Year">${years.map((y) => `<option ${y === year ? "selected" : ""}>${y}</option>`).join("")}</select></label>${[
    ["entries", "book-open", "Journal"],
    ["reports", "archive", "Reflections"],
    ["documents", "file-text", "Documents"],
    ["assets", "folder", "Archive"],
    ["ledger", "scale", "Claims ledger"],
  ]
    .map(
      ([id, ico, label]) =>
        `<button data-view="${id}" title="${label}" class="${view === id ? "active" : ""}">${icon(ico)}<span>${label}</span></button>`,
    )
    .join(
      "",
    )}<div class="bottom"><button data-view="settings" title="Settings" class="${view === "settings" ? "active" : ""}">${icon("settings")}<span>Settings</span></button></div></nav><main class="main" id="main"></main></div>`;
  document.querySelector("#signout").onclick = () => action(signout);
  app.querySelector(".brand h1").textContent = "Monthly Self-Interrogation";
  app.querySelector(".brand small").textContent = backend.local
    ? "Private local review"
    : "Daily journal & reflection partner";
  const modes = document.createElement("nav");
  modes.className = "modebar";
  modes.setAttribute("aria-label", "Workspace mode");
  modes.innerHTML = `<div class="controls"><button id="write-today">${icon("pencil")}Write today</button>${button("sun-moon", "Toggle light or dark theme", 'id="theme"')}</div>`;
  app.querySelector(".topbar").after(modes);
  const info = document.createElement("details");
  info.className = "workspace-info";
  info.innerHTML = '<summary>Workspace info</summary><div class="workspace-info-panel"></div>';
  info.querySelector("div").append(app.querySelector(".countdown"), app.querySelector(".leader"));
  app.querySelector(".top-actions").prepend(info);
  app.dataset.view = view;
  app.querySelectorAll(".sidebar [data-view]").forEach(el => {
    if (el.dataset.view === view) el.setAttribute("aria-current", "page");
  });
  document.querySelector("#write-today").onclick = () => {
    if (dirty) return notice("Save your reflection and answers first.");
    editEntry(undefined, Number(calendarDay().slice(0, 4)));
  };
  document.querySelector("#theme").onclick = () => {
    const value =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = value;
    localStorage.setItem("daily-ui-theme", value);
  };
  document.querySelector("#year").onchange = (e) => {
    if (dirty && !confirm("Discard unsaved changes?")) {
      e.target.value = String(year);
      return;
    }
    dirty = false;
    journalDetailOpen = false;
    year = Number(e.target.value);
    limit = 30;
    query = "";
    navigate();
    render();
  };
  document.querySelectorAll(".sidebar [data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        if (dirty && !confirm("Discard unsaved changes?")) return;
        dirty = false;
        journalDetailOpen = false;
        view = b.dataset.view;
        query = "";
        limit = 30;
        navigate();
        render();
      }),
  );
  if (view === "entries") renderEntries();
  else if (view === "documents") renderDocuments();
  else if (view === "assets") renderAssets();
  else if (view === "reports") action(renderReports);
  else if (view === "ledger") action(renderLedger);
  else renderSettings();
  redrawIcons();
  paintLeaderboard();
  paintCountdown();
}
function paintCountdown() {
  const el = document.querySelector("#countdown");
  if (!el) return;
  const c = countdown();
  const pct = Math.min(100, Math.max(0, c.elapsed));
  const key = `${c.year}-${c.dayOfYear}`;
  // The 30s tick would otherwise restart the draw animation, so only rebuild on a new day.
  if (el.dataset.day === key) return;
  el.dataset.day = key;
  const cx = 78,
    cy = 75,
    ticks = 12;
  let marks = "";
  for (let i = 0; i < ticks; i++) {
    const angle = (i / ticks) * 2 * Math.PI - Math.PI / 2;
    const sx = cx + Math.cos(angle) * 66,
      sy = cy + Math.sin(angle) * 66,
      ex = cx + Math.cos(angle) * 73,
      ey = cy + Math.sin(angle) * 73;
    marks += `<line class="cd-tick${(i / ticks) * 100 <= pct ? " spent" : ""}" x1="${sx.toFixed(1)}" y1="${sy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}"/>`;
  }
  el.innerHTML =
    `<div class="cd-dial"><svg viewBox="0 0 156 150" aria-hidden="true"><defs><linearGradient id="cd-grad" x1="0" y1="0" x2="1" y2="1"><stop class="cd-stop-a" offset="0%"/><stop class="cd-stop-b" offset="100%"/></linearGradient></defs><g class="cd-ticks">${marks}</g><circle class="cd-track" cx="${cx}" cy="${cy}" r="56" pathLength="100"/><circle class="cd-arc" cx="${cx}" cy="${cy}" r="56" pathLength="100"/><g class="cd-sat"><g transform="translate(${cx},19)"><circle class="cd-pulse" r="5"/><circle class="cd-core" r="4.5"/><circle class="cd-spark" r="1.8"/></g></g></svg><div class="cd-readout"><strong>${c.left}</strong><span>DAYS LEFT</span></div></div>` +
    `<dl class="cd-stats"><div><dt>Day</dt><dd>${c.dayOfYear} / ${c.total}</dd></div><div><dt>Week</dt><dd>${c.week}</dd></div><div><dt>Quarter</dt><dd>Q${c.quarter}</dd></div><div><dt>Elapsed</dt><dd>${c.elapsed.toFixed(1)}%</dd></div></dl>`;
  // CSSOM, not a style attribute: inline style attributes are blocked by the page CSP.
  el.style.setProperty("--pct", pct.toFixed(2));
}
const main = () => document.querySelector("#main");
function skeleton(rows = 3) {
  const el = document.createElement("div");
  el.className = "skeleton";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = Array.from({ length: rows })
    .map(
      () =>
        '<div class="sk-card"><span class="sk sk-title"></span><span class="sk"></span><span class="sk"></span><span class="sk sk-short"></span></div>',
    )
    .join("");
  main().append(el);
}
function head(title, subtitle, controls = "") {
  main().innerHTML = `<div class="viewhead"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><div class="controls">${controls}</div></div>`;
}
function renderEntries() {
  const yearControl = app.querySelector("#year")?.closest("label");
  const keepScroll = window.scrollY;
  const q = query.trim().toLowerCase();
  const rows = sortedEntries(
    data.entries.filter((e) => {
      if (e.archive_year !== year || Boolean(e.deleted_at) !== trash) return false;
      if (!q) return true;
      const meta = entryMeta(e);
      return (
        e.body_md + " " + meta.title + " " + meta.topics.join(" ") + " " + (e.entry_date || "")
      )
        .toLowerCase()
        .includes(q);
    }),
  );
  head(
    `${year} journal`,
    `${rows.length} ${trash ? "deleted " : ""}${rows.length === 1 ? "entry" : "entries"}`,
    `<input class="search" type="search" aria-label="Search entries" placeholder="Search topics, dates, text" value="${esc(query)}">${button("refresh-cw", "Refresh", 'id="refresh"')}${button(trash ? "book-open" : "trash-2", trash ? "Show entries" : "Show trash", 'id="trash"')}<button class="primary" id="new">${icon("plus")}New entry</button>`,
  );
  main().querySelector(".search").oninput = (e) => {
    query = e.target.value;
    const pos = e.target.selectionStart;
    renderEntries();
    const s = main().querySelector(".search");
    s.focus();
    if (pos !== null) s.setSelectionRange(pos, pos);
  };
  document.querySelector("#refresh").onclick = () => action(reload);
  document.querySelector("#trash").onclick = () => {
    trash = !trash;
    expanded.clear();
    render();
  };
  document.querySelector("#new").onclick = () => editEntry();

  const intro = data.years.find((y) => y.year === year) || { year, intro_md: "" };
  if (!trash && !q) {
    const el = document.createElement("details");
    el.className = "intro";
    el.innerHTML = `<summary aria-label="Year Notes"><span class="notes-icon">${icon("notebook-pen")}</span><span class="notes-title">Year Notes</span><span class="notes-year">${year}</span><span class="notes-chevron">${icon("chevron-down")}</span></summary><div class="notes-content"><div class="markdown"></div><button>${icon("pencil")}${intro.intro_md ? "Edit notes" : "Add notes"}</button></div>`;
    el.open = sessionStorage.getItem("daily-ui-notes-" + year) === "open";
    el.ontoggle = () => sessionStorage.setItem("daily-ui-notes-" + year, el.open ? "open" : "closed");
    markdown(el.querySelector(".markdown"), intro.intro_md);
    if (!intro.intro_md) el.querySelector(".markdown").textContent = "No year notes yet.";
    el.querySelector("button").onclick = () => editDocument(intro, "years");
    main().append(el);
  }

  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "feed-empty";
    empty.innerHTML = `<p>${query ? "No matching entries." : trash ? "Trash is empty." : "Your notebook starts here."}</p><small>${query ? "Try another topic, date, or phrase." : trash ? "Deleted entries can be restored here." : "Choose New entry to begin writing."}</small>`;
    main().append(empty);
    redrawIcons();
    return;
  }

  const visible = rows.slice(0, limit);
  const today = calendarDay();
  const groups = [];
  let current = null;
  for (const row of visible) {
    const bucket = entryBucket(row.entry_date, today);
    if (!current || current.key !== bucket.key) {
      current = { key: bucket.key, label: bucket.label, rows: [] };
      groups.push(current);
    }
    current.rows.push(row);
  }

  const feed = document.createElement("div");
  feed.className = "journal-feed";
  const jump = document.createElement("div");
  jump.className = "feed-jump";
  jump.setAttribute("aria-label", "Journal tools and time navigation");
  const anyOpen = visible.some((r) => expanded.has(r.id));
  jump.innerHTML =
    `<div class="feed-tools"><button class="jump-toggle" data-toggle="${anyOpen ? "collapse" : "expand"}">${anyOpen ? "Collapse all" : "Expand all"}</button></div>` +
    `<div class="feed-anchors">${groups
      .map(
        (g) =>
          `<button class="jump-chip" data-jump="grp-${esc(g.key)}">${esc(g.label)}<span>${g.rows.length}</span></button>`,
      )
      .join("")}</div>`;
  feed.append(jump);
  const tools = jump.querySelector(".feed-tools");
  if (yearControl) {
    yearControl.classList.add("feed-year");
    tools.prepend(yearControl);
  }
  tools.insertBefore(main().querySelector(".search"), tools.querySelector(".jump-toggle"));

  const listWrap = document.createElement("div");
  listWrap.className = "feed-list";
  feed.append(listWrap);

  const renderBody = (card, row) => {
    if (!row) return;
    const body = card.querySelector(".day-body");
    if (body.dataset.ready) return;
    body.dataset.ready = "1";
    const md = document.createElement("div");
    md.className = "markdown";
    body.append(md);
    markdown(md, row.body_md, row.source_key);
    const actions = document.createElement("div");
    actions.className = "entry-actions day-actions";
    actions.innerHTML = `${button("pencil", "Edit entry", "data-edit")}${button("history", "Revision history", "data-history")}${button(trash ? "rotate-ccw" : "trash-2", trash ? "Restore entry" : "Move entry to trash", "data-delete")}`;
    body.append(actions);
    actions.querySelector("[data-edit]").onclick = () => editEntry(row);
    actions.querySelector("[data-history]").onclick = () => action(() => history("entries", row));
    actions.querySelector("[data-delete]").onclick = () =>
      action(async () => {
        if (!trash && !confirm("Move this entry to trash? It can be restored.")) return;
        await backend.save(
          "entries",
          { id: row.id, deleted_at: trash ? null : new Date().toISOString() },
          row.revision,
        );
        expanded.delete(row.id);
        await reload();
      });
    redrawIcons();
  };

  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "feed-group";
    section.id = "grp-" + group.key;
    const heading = document.createElement("h3");
    heading.className = "feed-group-head";
    heading.innerHTML = `${esc(group.label)}<span class="feed-group-count">${group.rows.length}</span>`;
    section.append(heading);
    for (const row of group.rows) {
      const meta = entryMeta(row);
      const card = document.createElement("details");
      card.className = "day-card";
      card.dataset.id = row.id;
      const when = row.entry_date
        ? `<span class="day-dow">${esc(weekdayLabel(row.entry_date))}</span><span class="day-date">${esc(shortDate(row.entry_date))}</span>`
        : `<span class="day-dow">&mdash;</span><span class="day-date">Undated</span>`;
      const chips = meta.topics
        .slice(0, 5)
        .map((t) => `<span class="topic-chip">${esc(t)}</span>`)
        .join("");
      const more = meta.topics.length > 5 ? `<span class="topic-more">+${meta.topics.length - 5} more</span>` : "";
      const count = meta.itemCount
        ? `<span class="day-count">${meta.itemCount} item${meta.itemCount === 1 ? "" : "s"}</span>`
        : "";
      const flag = row.review_note ? `<span class="flag">${esc(row.review_note)}</span>` : "";
      const showSummary =
        meta.summary && meta.summary.toLowerCase() !== meta.displayTitle.toLowerCase();
      card.innerHTML =
        `<summary><div class="day-when">${when}</div><div class="day-main"><div class="day-title-row"><span class="day-title">${esc(meta.displayTitle)}</span>${count}</div>${chips || more ? `<div class="day-topics">${chips}${more}</div>` : ""}${showSummary ? `<p class="day-summary">${esc(meta.summary)}</p>` : ""}${flag}</div><span class="day-chevron">${icon("chevron-down")}</span></summary><div class="day-body"></div>`;
      card.addEventListener("toggle", () => {
        if (card.open) {
          expanded.add(row.id);
          renderBody(card, row);
        } else {
          expanded.delete(row.id);
        }
      });
      if (expanded.has(row.id)) card.open = true;
      section.append(card);
    }
    listWrap.append(section);
  }

  jump.querySelectorAll("[data-jump]").forEach((b) => {
    b.onclick = () =>
      document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  jump.querySelector("[data-toggle]").onclick = (e) => {
    const expand = e.currentTarget.dataset.toggle === "expand";
    for (const card of listWrap.querySelectorAll(".day-card")) card.open = expand;
    e.currentTarget.dataset.toggle = expand ? "collapse" : "expand";
    e.currentTarget.textContent = expand ? "Collapse all" : "Expand all";
  };

  main().append(feed);
  if (rows.length > limit) {
    const more = document.createElement("button");
    more.className = "pagination";
    more.textContent = `Load ${Math.min(30, rows.length - limit)} more (${rows.length - limit} remaining)`;
    more.onclick = () => {
      limit += 30;
      renderEntries();
    };
    feed.append(more);
  }
  if (keepScroll) window.scrollTo(0, keepScroll);
  redrawIcons();
}

function editEntry(original, entryYear = year) {
  const row = original || {
    archive_year: entryYear,
    entry_date:
      entryYear === Number(calendarDay().slice(0, 4))
        ? calendarDay()
        : `${entryYear}-01-01`,
    title: "",
    body_md: "",
  };
  modal(
    original ? "Edit entry" : "New entry",
    `<form id="editor"><div class="fields"><label>Year<input name="archive_year" type="number" min="1900" max="2200" required value="${row.archive_year}"></label><label>Date<input name="entry_date" type="date" value="${row.entry_date || ""}"></label><label class="full">Title<input name="title" value="${esc(row.title)}"></label><label class="full">Entry<textarea class="editor" name="body_md">${esc(row.body_md)}</textarea></label><label class="full">Review note<input name="review_note" value="${esc(row.review_note || "")}"></label></div><p class="error"></p></form>`,
    `<button type="button" id="preview">Preview</button><button class="primary" type="submit" form="editor">${icon("save")}Save entry</button>`,
  );
  const form = document.querySelector("#editor");
  dialog.classList.add("studio-editor");
  const fields = form.querySelector(".fields");
  const titleLabel = form.elements.title.closest("label");
  const bodyLabel = form.elements.body_md.closest("label");
  titleLabel.classList.add("studio-title");
  bodyLabel.classList.add("studio-body-label");
  form.elements.title.placeholder = "Untitled entry";
  form.elements.body_md.placeholder = "What is on your mind?";
  const details = document.createElement("details");
  details.className = "editor-details";
  details.innerHTML = "<summary>Entry details · date, year & review note</summary>";
  form.prepend(titleLabel, bodyLabel, details);
  details.append(fields);
  form.addEventListener("invalid", () => { details.open = true; }, true);
  const saveState = document.createElement("small");
  saveState.id = "entry-save-state";
  saveState.setAttribute("role", "status");
  saveState.textContent = original ? "Saved entry" : "Not saved yet";
  const counter = document.createElement("small");
  counter.id = "entry-count";
  counter.className = "editor-meta";
  dialog.querySelector("footer").prepend(saveState, counter);
  const paintCount = () => {
    const text = form.elements.body_md.value;
    const words = (text.match(/\S+/g) || []).length;
    counter.textContent = `${words} word${words === 1 ? "" : "s"} · ${text.length} characters`;
  };
  form.addEventListener("input", () => { saveState.textContent = "Unsaved changes"; paintCount(); });
  form.querySelector(".error").setAttribute("role", "alert");
  paintCount();
  form.elements.body_md.focus();
  document.querySelector("#preview").onclick = () => {
    let el = form.querySelector(".preview");
    if (el) {
      el.remove();
      bodyLabel.hidden = false;
      document.querySelector("#preview").textContent = "Preview";
      document.querySelector("#preview").setAttribute("aria-pressed", "false");
      form.elements.body_md.focus();
      return;
    }
    el = document.createElement("div");
    el.className = "markdown preview";
    markdown(el, form.elements.body_md.value, row.source_key);
    bodyLabel.after(el);
    bodyLabel.hidden = true;
    document.querySelector("#preview").textContent = "Continue writing";
    document.querySelector("#preview").setAttribute("aria-pressed", "true");
    el.tabIndex = -1;
    el.focus();
  };
  form.onsubmit = guardedTask(async (e) => {
    e.preventDefault();
    const current = backend, authId = generation;
    const b = dialog.querySelector("[type=submit]");
    b.disabled = true;
    saveState.textContent = "Saving…";
    try {
      const payload = entryPayload({
        ...Object.fromEntries(new FormData(form)),
        id: original?.id || crypto.randomUUID(),
      });
      await current.save("entries", payload, original?.revision);
      if (current !== backend || authId !== generation) return;
      modalDirty = false;
      dialog.close();
      year = payload.archive_year;
      expanded.add(payload.id);
      view = "entries";
      query = "";
      trash = false;
      navigate();
      await reload();
      notice("Entry saved.", "ok");
      main().querySelector(`.day-card[data-id="${payload.id}"] summary`)?.scrollIntoView({ block: "center" });
    } catch (e) {
      saveState.textContent = "Not saved";
      formError(form, e);
    } finally {
      b.disabled = false;
    }
  });
}
function editDocument(row, kind = "documents") {
  const isYear = kind === "years",
    key = isYear ? "intro_md" : "body_md";
  modal(
    isYear ? "Year notes" : "Edit document",
    `<form id="document"><div class="fields">${isYear ? "" : `<label class="full">Title<input name="title" required value="${esc(row.title || "")}"></label>`}<label class="full">Markdown<textarea class="editor" name="${key}">${esc(row[key] || "")}</textarea></label></div><p class="error"></p></form>`,
    `<button class="primary" form="document">${icon("save")}Save</button>`,
  );
  const form = document.querySelector("#document");
  form.onsubmit = guardedTask(async (e) => {
    e.preventDefault();
    const current = backend, authId = generation;
    try {
      await current.save(
        kind,
        {
          ...Object.fromEntries(new FormData(form)),
          ...(isYear
            ? { year: row.year }
            : {
                id: row.id || crypto.randomUUID(),
                archive_year: row.archive_year,
              }),
        },
        row.revision,
      );
      if (current !== backend || authId !== generation) return;
      modalDirty = false;
      dialog.close();
      await reload();
    } catch (e) {
      formError(form, e);
    }
  });
}
async function history(kind, row) {
  const current = backend, authId = generation, currentView = view, currentYear = year;
  const items = await current.history(kind, row.id || row.year);
  if (current !== backend || authId !== generation || currentView !== view || currentYear !== year) return;
  modal(
    "Revision history",
    items.length
      ? items
          .map(
            (r, i) =>
              `<div class="doc-row"><div><strong>Revision ${r.revision}</strong><small> · ${esc(r.created_at)}</small></div><button data-revision="${i}">View</button></div>`,
          )
          .join("")
      : "<p>No earlier revisions.</p>",
  );
  dialog.querySelectorAll("[data-revision]").forEach(
    (b) =>
      (b.onclick = () => {
        const r = items[Number(b.dataset.revision)];
        modal(
          "Revision " + r.revision,
          '<div class="markdown"></div>',
          `<button id="restore">${icon("rotate-ccw")}Restore this revision</button>`,
        );
        markdown(
          dialog.querySelector(".markdown"),
          r.snapshot.body_md || r.snapshot.intro_md,
          r.snapshot.source_key,
        );
        document.querySelector("#restore").onclick = guardedTask(async () => {
            if (
              !confirm(
                "Restore this revision? The current version will remain in history.",
              )
            )
              return;
            const s = r.snapshot;
            const patch =
              kind === "years"
                ? { year: row.year, intro_md: s.intro_md }
                : {
                    id: row.id,
                    title: s.title,
                    body_md: s.body_md,
                    archive_year: s.archive_year,
                    ...(kind === "entries"
                      ? { entry_date: s.entry_date, review_note: s.review_note }
                      : {}),
                    deleted_at: s.deleted_at || null,
                  };
            await current.save(kind, patch, row.revision);
            if (current !== backend || authId !== generation) return;
            dialog.close();
            await reload();
          });
      }),
  );
}
function renderDocuments() {
  const rows = data.documents.filter((r) => r.archive_year === year);
  head(
    `${year} documents`,
    `${rows.length} supporting documents`,
    `<button class="primary" id="newdoc">${icon("plus")}New document</button>`,
  );
  document.querySelector("#newdoc").onclick = () =>
    editDocument({ archive_year: year, title: "", body_md: "" });
  if (!rows.length) main().insertAdjacentHTML("beforeend", `<div class="empty">${icon("file-text")}<p>No documents for ${year}.</p><small>Supporting notes and references live here, separate from dated entries.</small></div>`);
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "doc-row";
    el.innerHTML = `<div><h3>${esc(row.title)}</h3><small>${esc(row.source_key || "Created in Daily")}</small></div><div class="entry-actions">${button("file-text", "Read", "data-read")}${button("pencil", "Edit", "data-edit")}${button("history", "History", "data-history")}</div>`;
    el.querySelector("[data-read]").onclick = () => {
      modal(row.title, '<div class="markdown"></div>');
      markdown(dialog.querySelector(".markdown"), row.body_md, row.source_key);
    };
    el.querySelector("[data-edit]").onclick = () => editDocument(row);
    el.querySelector("[data-history]").onclick = () =>
      action(() => history("documents", row));
    main().append(el);
  }
}
function renderAssets() {
  const rows = data.assets.filter((r) => r.archive_year === year);
  head(`${year} archive`, `${rows.length} preserved source files`);
  if (!rows.length) {
    main().insertAdjacentHTML("beforeend", `<div class="empty">${icon("folder")}<p>No preserved source files for ${year}.</p><small>Original files appear here after an import.</small></div>`);
    return;
  }
  const table = document.createElement("table");
  table.className = "table";
  table.innerHTML =
    "<thead><tr><th>Original file</th><th>Size</th><th></th></tr></thead><tbody></tbody>";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="filename">${esc(row.source_key)}</td><td>${(row.size_bytes / 1024).toFixed(1)} KB</td><td>${button("download", "Download original")}</td>`;
    tr.querySelector("button").onclick = () => action(() => asset(row));
    table.querySelector("tbody").append(tr);
  }
  main().append(table);
}
function paintLeaderboard() {
  if (!leaderboard) return;
  const select = document.querySelector("#agents");
  if (!select) return;
  select.innerHTML = leaderboard.agents?.length
    ? leaderboard.agents
        .map(
          (a, i) =>
            `<option>${i + 1}. ${esc(a.name)}${a.score != null ? " · " + esc(a.score) : ""}</option>`,
        )
        .join("")
    : "<option>Agent feed unavailable</option>";
  document.querySelector("#agent-status").innerHTML =
    `<a href="https://arena.ai/leaderboard/agent" target="_blank" rel="noopener noreferrer">Arena · Overall</a>${leaderboard.fetched_at ? " · " + (leaderboard.stale ? "Cached " : "Updated ") + esc(new Date(leaderboard.fetched_at).toLocaleString()) : ""}`;
}
async function refreshLeaderboard() {
  const current = backend, id = generation;
  if (!current || current.local) return;
  let result;
  try {
    result = await current.edge("agent-leaderboard", {});
  } catch {
    result = { agents: [] };
  }
  if (id !== generation || current !== backend) return;
  leaderboard = result;
  paintLeaderboard();
}
async function renderReports() {
  const requestId = ++reportLoad;
  head("Self-interrogation", `${year} · loading your reflections`);
  skeleton(2);
  const current = backend;
  const rows = await current.reports();
  if (current !== backend || view !== "reports" || requestId !== reportLoad)
    return;
  reportRows = rows;
  mountInterrogation({
    host: main(),
    backend: current,
    rows: reportRows,
    journal: data,
    year,
    esc,
    icon,
    markdown,
    notice,
    modal,
    download,
    manageReport: openReport,
    refreshIcons: redrawIcons,
    setDirty: (value) => (dirty = value),
    runTask,
    setModalDirty: (value) => (modalDirty = value),
    isCurrent: () =>
      backend === current && view === "reports" && requestId === reportLoad,
  });
  redrawIcons();
}
async function renderLedger() {
  const current = backend;
  const requestId = ++reportLoad;
  head("Claims ledger", String(year));
  skeleton(2);
  const rows = await current.reports();
  if (current !== backend || view !== "ledger" || requestId !== reportLoad) return;
  reportRows = rows;
  const claims = reportRows.filter(
    (r) =>
      r.entity_type === "claim" &&
      String(r.data.sourceDate || "").startsWith(String(year)),
  );
  main().querySelector(".skeleton")?.remove();
  if (!claims.length) main().insertAdjacentHTML("beforeend", `<div class="empty">${icon("scale")}<p>No claims recorded for ${year}.</p><small>Claims are extracted when you run Follow-ups on a monthly report.</small></div>`);
  if (claims.length) {
    for (const item of claims) {
      const el = document.createElement("div");
      el.className = "doc-row";
      el.innerHTML = `<div><p>${esc(item.data.quote)}</p><small>${esc(item.data.sourceDate)} · ${esc(item.data.status)}</small></div><button>Edit claim</button>`;
      el.querySelector("button").onclick = () => editClaim(item);
      main().append(el);
    }
  }
  redrawIcons();
}
function editClaim(item) {
  const c = item.data;
  modal(
    "Review claim",
    `<form id="claim"><label>Quote<textarea name="quote" rows="4">${esc(c.quote)}</textarea></label><label>Status<select name="status">${["proposed", "open", "right", "wrong", "partial", "void"].map((s) => `<option ${s === c.status ? "selected" : ""}>${s}</option>`).join("")}</select></label><label>Evidence<textarea name="evidence" rows="4">${esc(c.evidence || "")}</textarea></label><label>Evidence date<input type="date" name="evidenceDate" value="${esc(c.evidenceDate || "")}"></label><p class="error"></p></form>`,
    `<button class="primary" form="claim">Save claim</button>`,
  );
  document.querySelector("#claim").onsubmit = guardedTask(async (e) => {
    e.preventDefault();
    const current = backend, authId = generation;
    try {
      await current.saveReport("claim", item.entity_id, {
        ...c,
        ...Object.fromEntries(new FormData(e.target)),
      });
      if (current !== backend || authId !== generation) return;
      modalDirty = false;
      dialog.close();
      await renderLedger();
    } catch (err) {
      formError(e.target, err);
    }
  });
}
function savedFocus() {
  return (
    reportRows.find(
      (r) => r.entity_type === "prompt" && r.entity_id === "settings",
    )?.data?.advice ||
    reportRows.find(
      (r) => r.entity_type === "prompt" && r.entity_id === "report",
    )?.data?.text ||
    "Summarize patterns, progress and unresolved questions. Cite entry dates and avoid unsupported assumptions."
  );
}
function editPrompt() {
  const item = reportRows.find(
      (r) => r.entity_type === "prompt" && r.entity_id === "settings",
    ),
    focus =
      item?.data?.advice ||
      "Summarize patterns, progress and unresolved questions. Cite entry dates and avoid unsupported assumptions.";
  modal(
    "Report prompt",
    `<textarea id="prompt-text" class="editor">${esc(focus)}</textarea>`,
    `<button class="primary" id="save-prompt">Save prompt</button>`,
  );
  document.querySelector("#save-prompt").onclick = () =>
    action(async () => {
      await backend.saveReport("prompt", "settings", {
        ...item?.data,
        advice: document.querySelector("#prompt-text").value,
        adviceUpdatedAt: new Date().toISOString(),
      });
      dirty = false;
      dialog.close();
      await renderReports();
    });
}
function openReport(item) {
  const r = structuredClone(item.data);
  const current = backend, authId = generation;
  const stillCurrent = () => current === backend && authId === generation;
  modal(
    r.month || "Report",
    '<div class="report-body markdown"></div><h3>Reflection</h3><textarea id="reflection" rows="5"></textarea><div id="followups"></div><p class="error"></p>',
    `<button id="export-report">${icon("download")}Export</button><button id="edit-report">${icon("pencil")}Edit</button><button id="analyze-report">Follow-ups / claims</button><button id="delete-report" class="danger">Delete</button><button id="save-report" class="primary">${icon("save")}Save reflection</button>`,
  );
  markdown(dialog.querySelector(".report-body"), r.report);
  document.querySelector("#reflection").value = r.reflection || "";
  const follow = document.querySelector("#followups");
  for (const [i, f] of (r.followups || []).entries()) {
    const el = document.createElement("label");
    el.className = "followup";
    el.textContent = f.q;
    const input = document.createElement("textarea");
    input.value = f.a || "";
    input.dataset.index = i;
    el.append(input);
    follow.append(el);
  }
  document.querySelector("#save-report").onclick = guardedTask(async () => {
      r.reflection = document.querySelector("#reflection").value;
      r.reflectionUpdatedAt = new Date().toISOString();
      follow.querySelectorAll("textarea").forEach((t) => {
        r.followups[Number(t.dataset.index)].a = t.value;
        r.followups[Number(t.dataset.index)].answeredAt =
          new Date().toISOString();
      });
      await current.saveReport("report", item.entity_id, r);
      if (!stillCurrent()) return;
      modalDirty = false;
      dialog.close();
      await renderReports();
      notice("Report saved.", "ok");
    });
  document.querySelector("#export-report").onclick = () =>
    download(
      new Blob([r.report || ""], { type: "text/markdown" }),
      `${r.month || "report"}.md`,
    );
  document.querySelector("#edit-report").onclick = () => {
    if (modalDirty && !confirm("Discard unsaved reflection changes?")) return;
    modal(
      "Edit report",
      `<textarea class="editor" id="report-markdown">${esc(r.report)}</textarea>`,
      `<button class="primary" id="save-markdown">Save report</button>`,
    );
    document.querySelector("#save-markdown").onclick = guardedTask(async () => {
        await current.saveReport("report", item.entity_id, {
          ...r,
          report: document.querySelector("#report-markdown").value,
        });
        if (!stillCurrent()) return;
        modalDirty = false;
        dialog.close();
        await renderReports();
      });
  };
  document.querySelector("#delete-report").onclick = guardedTask(async () => {
      if (
        !confirm(
          "Delete this report? Export it first if needed. Its server revision history is retained.",
        )
      )
        return;
      await current.saveReport("report", item.entity_id, r, true);
      if (!stillCurrent()) return;
      modalDirty = false;
      dialog.close();
      await renderReports();
    });
  document.querySelector("#analyze-report").onclick = guardedTask(() => analyzeReport(item));
}
async function analyzeReport(item) {
  const activeBackend = backend,
    authId = generation;
  if (modalDirty) throw Error("Save your reflection first.");
  const r = item.data,
    entries = data.entries.filter(
      (e) =>
        !e.deleted_at &&
        e.entry_date >= (r.rangeStart || r.requestedStart) &&
        e.entry_date <= (r.rangeEnd || r.requestedEnd),
    );
  if (!entries.length) throw Error("No matching dated entries.");
  const context = establishedContext(reportRows);
  if (
    !confirm(
      `Send this report, ${entries.length} entries and ${context.included} earlier answers/reflections to ${r.provider} (${r.model}) for follow-up questions and claim extraction?`,
    )
  )
    return;
  const result = await activeBackend.edge("journal-ai", {
    provider: r.provider,
    model: r.model,
    operation: "followups",
    report: r.report,
    context,
    entries: entries.map((e) => ({ date: e.entry_date, text: e.body_md })),
  });
  if (activeBackend !== backend || authId !== generation) return;
  const parsed = JSON.parse(
    result.text.replace(/^```(?:json)?\s*|\s*```$/g, ""),
  );
  if (!Array.isArray(parsed?.followups) || !Array.isArray(parsed?.claims))
    throw Error(
      "Provider response was not valid structured output. No changes saved.",
    );
  const followups = parsed.followups
    .filter((f) => f && typeof f.q === "string" && f.q.trim())
    .slice(0, 12)
    .map((f) => ({
      id: crypto.randomUUID(),
      q: f.q,
      a: "",
      why: String(f.why || ""),
    }));
  const updatedReport = {
    ...r,
    followups: [...(r.followups || []), ...followups],
  };
  let count = 0;
  try {
  await activeBackend.saveReport("report", item.entity_id, updatedReport);
  for (const c of parsed.claims.slice(0, 20)) {
    if (activeBackend !== backend || authId !== generation) return;
    if (
      !c || typeof c.quote !== "string" || !c.quote.trim() ||
      !entries.some(
        (e) => e.entry_date === c.sourceDate && e.body_md.includes(c.quote),
      )
    )
      continue;
    const id = crypto.randomUUID();
    await activeBackend.saveReport("claim", id, {
      id,
      quote: c.quote,
      sourceDate: c.sourceDate,
      status: "proposed",
      confidence: c.confidence || "",
      evidence: "",
    });
    count++;
  }
  } catch (error) {
    if (activeBackend !== backend || authId !== generation) return;
    download(new Blob([JSON.stringify({report: {entity_id: item.entity_id, data: updatedReport}, claims: parsed.claims, saved_claims: count}, null, 2)], {type:"application/json"}), "daily-private-unsaved-analysis.json");
    throw Error("Analysis was not fully saved. A private recovery download was created; some results may already be saved. " + error.message);
  }
  if (activeBackend !== backend || authId !== generation) return;
  dialog.close();
  await renderReports();
  notice(
    `Saved ${followups.length} questions and ${count} source-verified claims.`,
  );
}
function generateReport() {
  const focus = savedFocus();
  modal(
    "New report",
    `<form id="generate-form"><div class="fields"><label>From<input name="start" type="date" value="${year}-01-01" required></label><label>Through<input name="end" type="date" value="${year}-12-31" required></label><label>Provider<select name="provider">${Object.keys(
      providers,
    )
      .map((p) => `<option>${p}</option>`)
      .join(
        "",
      )}</select></label><label>Model<input name="model" placeholder="Configured model ID" required></label><label class="full">Report focus<textarea name="focus" aria-label="Report focus" rows="3">${esc(focus)}</textarea></label></div><p class="error"></p></form>`,
    `<button class="primary" form="generate-form">Review and generate</button>`,
  );
  const form = document.querySelector("#generate-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const p = Object.fromEntries(new FormData(form)),
      entries = data.entries.filter(
        (r) =>
          !r.deleted_at && r.entry_date >= p.start && r.entry_date <= p.end,
      );
    if (!entries.length)
      return formError(form, Error("No dated entries in this range."));
    if (
      !confirm(
        `Send ${entries.length} journal entries from ${p.start} through ${p.end} to ${p.provider} (${p.model})? The provider will process this private content.`,
      )
    )
      return;
    const b = dialog.querySelector("footer button");
    b.disabled = true;
    const activeBackend = backend,
      authId = generation;
    try {
      const result = await activeBackend.edge("journal-ai", {
        ...p,
        entries: entries.map((r) => ({
          date: r.entry_date,
          text: r.body_md,
          title: r.title,
        })),
      });
      if (activeBackend !== backend || authId !== generation) return;
      const id = crypto.randomUUID(),
        report = {
          id,
          month: p.start.slice(0, 7),
          generatedAt: new Date().toISOString(),
          provider: p.provider,
          model: p.model,
          entryCount: entries.length,
          requestedStart: p.start,
          requestedEnd: p.end,
          rangeStart: p.start,
          rangeEnd: p.end,
          report: result.text,
          followups: [],
          reflection: "",
        };
      await backend.saveReport("report", id, report);
      dirty = false;
      dialog.close();
      await renderReports();
    } catch (e) {
      formError(form, e);
    } finally {
      b.disabled = false;
    }
  };
}
function renderSettings() {
  head("Settings", "Account and private data");
  main().insertAdjacentHTML(
    "beforeend",
    `<div class="settings"><div class="stats"><div><strong>${data.entries.length}</strong><small>entries</small></div><div><strong>${data.documents.length}</strong><small>documents</small></div><div><strong>${data.assets.length}</strong><small>source assets</small></div></div><section><h3>Year notes</h3><div class="controls"><input id="add-year" type="number" min="1900" max="2200" value="${year}" aria-label="Year for notes"><button id="year-notes">Edit year notes</button></div></section><section><h3>Private export</h3><p>Downloads contain sensitive journal text. Store them outside public repositories and shared folders.</p><button id="export">${icon("download")}Export journal JSON</button><button id="export-year">${icon("download")}Export ${year} Markdown</button></section><section><h3>Import session</h3><p>Temporary owner access token for the local importer. Never commit it or paste it into GitHub.</p><button id="token" ${backend.local ? "disabled" : ""}>${icon("download")}Export temporary session</button></section><section><h3>Legacy browser data</h3><p>Export unsynced local reports before clearing the old cache and credentials. Legacy data is never uploaded automatically.</p><button id="legacy">${icon("download")}Export legacy browser data</button><button id="clear-legacy" class="danger">Clear legacy storage</button></section><section><h3>Account recovery</h3><p>Keep your password unique and store a recovery method securely. Password reset and account recovery are handled by Supabase Auth.</p></section></div>`,
  );
  document.querySelector("#year-notes").onclick = () => {
    const y = Number(document.querySelector("#add-year").value);
    if (!Number.isInteger(y) || y < 1900 || y > 2200)
      return notice("Choose a valid year.");
    editDocument(
      data.years.find((r) => r.year === y) || { year: y, intro_md: "" },
      "years",
    );
  };
  document.querySelector("#export").onclick = () =>
    action(async () => {
      const current = backend, authId = generation, snapshot = data;
      const reports = await current.reports();
      if (current !== backend || authId !== generation) return;
      download(
        new Blob(
          [
            JSON.stringify(
              {
                exported_at: new Date().toISOString(),
                ...snapshot,
                reports,
              },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
        "daily-private-export.json",
      );
    });
  document.querySelector("#export-year").onclick = () =>
    download(
      new Blob(
        [
          (data.years.find((r) => r.year === year)?.intro_md || "") +
            "\n" +
            sortedEntries(
              data.entries.filter(
                (r) => r.archive_year === year && !r.deleted_at,
              ),
            )
              .map(
                (r) =>
                  `# ${r.entry_date || "UNRESOLVED"}${r.title ? " " + r.title : ""}\n\n${r.body_md}`,
              )
              .join("\n\n"),
        ],
        { type: "text/markdown" },
      ),
      `${year}-private.md`,
    );
  document.querySelector("#token").onclick = () =>
    action(async () => {
      const {
        data: { session },
      } = await client.auth.getSession();
      if (!session || !backend || session.user.id !== backend.user.id)
        throw Error("Session changed. Please sign in again.");
      download(
        new Blob([session.access_token], { type: "text/plain" }),
        "daily-session.private.txt",
      );
    });
  document.querySelector("#legacy").onclick = () => action(exportLegacy);
  document.querySelector("#clear-legacy").onclick = () =>
    action(async () => {
      if (
        !confirm(
          "Have you exported your legacy data? This clears old Daily browser credentials and caches, not cloud records.",
        )
      )
        return;
      for (const key of Object.keys(localStorage))
        if (key.startsWith("msi.")) localStorage.removeItem(key);
      for (const db of await indexedDB.databases())
        if (db.name?.startsWith("daily-cache-v2-"))
          await new Promise((resolve, reject) => {
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = resolve;
            req.onerror = () => reject(req.error);
            req.onblocked = () =>
              reject(Error("Close older Daily tabs before clearing."));
          });
      notice("Legacy storage cleared.", "ok");
    });
}
async function exportLegacy() {
  const result = {
    localStorage: Object.fromEntries(
      Object.entries(localStorage).filter(([k]) => k.startsWith("msi.")),
    ),
    databases: {},
  };
  for (const info of await indexedDB.databases()) {
    if (!info.name?.startsWith("daily-cache-v2-")) continue;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(info.name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stores = {};
    for (const name of db.objectStoreNames)
      stores[name] = await new Promise((resolve, reject) => {
        const req = db.transaction(name).objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    db.close();
    result.databases[info.name] = stores;
  }
  download(
    new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    "daily-legacy-private.json",
  );
}
window.addEventListener("beforeunload", (e) => {
  if (dirty || modalDirty || tasks.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("hashchange", () => {
  if(tasks.size){window.history.replaceState(null,'',`#/${year}/${view}`);return;}
  if(dirty || modalDirty){
    if(!confirm('Discard unsaved changes?')){window.history.replaceState(null,'',`#/${year}/${view}`);return;}
    dirty=false;
    modalDirty=false;
  }
  dialog.close();
  journalDetailOpen = false;
  readRoute();
  if (data) render();
});
setInterval(() => {
  paintCountdown();
  if (backend && !backend.local)
    action(async () => {
      const current = backend;
      const {
        data: { session },
      } = await client.auth.getSession();
      if (
        current === backend &&
        (!session ||
          session.expires_at * 1000 <= Date.now() ||
          session.user.id !== current.user.id)
      ) {
        generation++;
        login("Session expired. Please sign in again.");
      }
    });
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    paintCountdown();
    if (backend && !backend.local)
      action(async () => {
        const current = backend, id = generation;
        const {
          data: { session },
        } = await client.auth.getSession();
        if (current !== backend || id !== generation) return;
        if (!session || session.user.id !== current.user.id) {
          generation++;
          login("Please sign in again.");
        } else if (!dirty && !modalDirty && !dialog.open && !tasks.size) await reload();
      });
  }
});
client.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT" && !backend?.local) {
    generation++;
    login();
  }
  if (
    (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") &&
    backend &&
    !backend.local &&
    session?.user.id !== backend.user.id
  ) {
    generation++;
    login();
  }
  if (event === "PASSWORD_RECOVERY") {
    recovering = true;
    setTimeout(() => {
      modal(
        "Set a new password",
        '<form id="password-form"><label>New password<input type="password" name="password" minlength="12" autocomplete="new-password" required></label><p class="error"></p></form>',
        '<button class="primary" form="password-form">Update password</button>',
      );
      const f = document.querySelector("#password-form");
      f.onsubmit = async (e) => {
        e.preventDefault();
        const { error } = await client.auth.updateUser({
          password: f.elements.password.value,
        });
        if (error) formError(f, error);
        else {
          recovering = false;
          dirty = false;
          dialog.close();
          await action(() => authenticate(session));
        }
      };
    }, 0);
  }
});
async function boot() {
  readRoute();
  if (location.hostname === "127.0.0.1") {
    try {
      const res = await fetch("/__review/session", { cache: "no-store" });
      if (res.ok) {
        backend = new LocalBackend();
        await reload();
        return;
      }
    } catch (e) {
      notice(e.message);
    }
  }
  const {
    data: { session },
  } = await client.auth.getSession();
  if (recovering) return;
  try {
    await authenticate(session);
  } catch (e) {
    login(e.message);
  }
}
boot();
