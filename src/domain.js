export function calendarDay(
  now = new Date(),
  timeZone = "America/Los_Angeles",
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !isNaN(date) && date.toISOString().slice(0, 10) === value;
}
export function isoWeek(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3,
  );
  return 1 + Math.round((date - firstThursday) / (7 * 86400000));
}
export function countdown(now = new Date()) {
  const day = calendarDay(now),
    year = Number(day.slice(0, 4));
  const end = Date.UTC(year + 1, 0, 1),
    start = Date.UTC(year, 0, 1);
  const total = (end - start) / 86400000;
  const left = Math.round((end - Date.parse(`${day}T00:00:00Z`)) / 86400000);
  const dayOfYear = total - left + 1;
  return {
    year,
    left,
    total,
    dayOfYear,
    week: isoWeek(day),
    quarter: Math.floor(Number(day.slice(5, 7) - 1) / 3) + 1,
    elapsed: (dayOfYear / total) * 100,
  };
}
export function sortedEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      (b.entry_date || "9999").localeCompare(a.entry_date || "9999") ||
      a.source_order - b.source_order ||
      a.id.localeCompare(b.id),
  );
}
export function entryPayload(row) {
  const year = Number(row.archive_year);
  if (!Number.isInteger(year) || year < 1900 || year > 2200)
    throw new Error("Choose a year between 1900 and 2200.");
  if (
    row.entry_date &&
    (!validDate(row.entry_date) || Number(row.entry_date.slice(0, 4)) !== year)
  )
    throw new Error("The date must be valid and match the selected year.");
  if (!String(row.title || "").trim() && !String(row.body_md || "").trim())
    throw new Error("Add a title or an entry.");
  if (String(row.body_md || "").length > 1000000)
    throw new Error("This entry is too large (maximum 1 million characters).");
  return {
    ...row,
    archive_year: year,
    entry_date: row.entry_date || null,
    title: String(row.title || "").trim(),
    body_md: String(row.body_md || ""),
  };
}
export function resolveSource(from, href) {
  from = from || "";
  if (
    /^[a-z][a-z\d+.-]*:/i.test(href) ||
    href.startsWith("//") ||
    href.startsWith("#")
  )
    return null;
  let decoded;
  try {
    decoded = decodeURIComponent(href.split("#")[0]);
  } catch {
    return null;
  }
  const parts = from.split("/");
  parts.pop();
  for (const part of decoded.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

// --- History scanning helpers ---------------------------------------------
// Entries are daily "reports" written as bold-led bullets under a date-only
// heading, so `title` is usually empty. These pure helpers derive the real,
// human-meaningful metadata the user already wrote (lead topic, topics
// covered, item count, summary) and bucket entries by recency for fast
// scanning. Used by the entry list, the reader header, and search so a single
// definition keeps them consistent.
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function weekdayLabel(date) {
  if (!validDate(date)) return "";
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function shortDate(date) {
  if (!validDate(date)) return date || "";
  const d = new Date(`${date}T00:00:00Z`);
  return `${MONTH[d.getUTCMonth()].slice(0, 3)} ${d.getUTCDate()}`;
}

// Reduce inline Markdown to readable plain text for labels and summaries.
export function plainText(md) {
  return String(md || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_>#~|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(value, max) {
  const s = String(value || "").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "\u2026" : s;
}

export function entryMeta(row = {}) {
  const body = String(row.body_md || "");
  const topics = [];
  for (const match of body.matchAll(/\*\*([^*\n]{1,120}?)\*\*/g)) {
    const term = plainText(match[1]);
    if (term.length >= 2 && !topics.some((t) => t.toLowerCase() === term.toLowerCase()))
      topics.push(clip(term, 42));
  }
  const itemCount = (body.match(/^\s*(?:[*+-]|\d+[.)])\s+\S/gm) || []).length;
  let title = String(row.title || "").trim();
  if (!title) {
    const heading = (body.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m) || [])[1];
    const firstLine = plainText(body).split(/(?<=[.!?])\s/)[0];
    title = topics[0] || (heading && plainText(heading)) || firstLine || "";
  }
  title = clip(title, 90);
  let summary = "";
  for (const line of body.split(/\r?\n/)) {
    const text = plainText(line);
    if (!text) continue;
    summary = text;
    if (text.toLowerCase() !== title.toLowerCase()) break;
  }
  const words = (plainText(body).match(/\S+/g) || []).length;
  return {
    title,
    displayTitle: title || "Untitled entry",
    topics,
    itemCount,
    summary: clip(summary, 200),
    words,
  };
}

// Group key + label for recency buckets. `today` is a YYYY-MM-DD string.
export function entryBucket(date, today = calendarDay()) {
  if (!validDate(date)) return { key: "undated", label: "Undated", order: -1 };
  const start = new Date(`${today}T00:00:00Z`);
  const weekStart = new Date(start);
  weekStart.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const at = Date.parse(`${date}T00:00:00Z`);
  if (at >= weekStart.getTime()) return { key: "this-week", label: "This Week", order: 4 };
  if (at >= lastWeekStart.getTime()) return { key: "last-week", label: "Last Week", order: 3 };
  if (date.slice(0, 7) === today.slice(0, 7))
    return { key: "earlier-month", label: "Earlier This Month", order: 2 };
  const [y, m] = date.split("-");
  return { key: `m-${y}-${m}`, label: `${MONTH[Number(m) - 1]} ${y}`, order: 1 };
}
