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
export function countdown(now = new Date()) {
  const day = calendarDay(now),
    year = Number(day.slice(0, 4));
  const end = Date.UTC(year + 1, 0, 1),
    start = Date.UTC(year, 0, 1);
  return {
    year,
    left: Math.round((end - Date.parse(`${day}T00:00:00Z`)) / 86400000),
    total: (end - start) / 86400000,
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
