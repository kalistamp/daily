import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { validDate } from "../src/domain.js";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function uuid(value) {
  const h = hash(value).slice(0, 32).split("");
  h[12] = "5";
  h[16] = "8";
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
export function normalizeDate(y, m, d) {
  const value = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return validDate(value) && Number(y) >= 1900 ? value : null;
}
export function splitJournal(text, sourceKey, sourceYear) {
  // Legacy headings are authoritative even inside malformed Markdown fences.
  const matches = [
    ...text.matchAll(/^#{1,6}\s+(\d{3,4})-(\d{1,2})-(\d{1,2})\b([^\r\n]*)/gm),
  ];
  const intro = text.slice(0, matches[0]?.index ?? text.length);
  const entries = matches.map((m, i) => {
    const end = matches[i + 1]?.index ?? text.length;
    const raw = text.slice(m.index, end),
      date = normalizeDate(m[1], m[2], m[3]);
    const body = raw.slice(m[0].length).replace(/^\r?\n/, "");
    return {
      id: uuid(`${sourceKey}:${i}`),
      entry_date: date,
      archive_year: date ? Number(date.slice(0, 4)) : sourceYear,
      title: m[4].replace(/^\s*[|:]?\s*/, ""),
      body_md: body,
      source_key: sourceKey,
      source_order: i,
      source_hash: hash(raw),
      review_note: !date
        ? `Unresolved source date: ${m[1]}-${m[2]}-${m[3]}`
        : Number(m[1]) !== sourceYear
          ? `Written date differs from source year ${sourceYear}; retained for review.`
          : "",
      _segment: { start: m.index, end, raw },
    };
  });
  if (intro + entries.map((e) => e._segment.raw).join("") !== text)
    throw new Error(`Incomplete segmentation: ${sourceKey}`);
  return { intro, entries };
}
const mime = (key) =>
  ({
    ".md": "text/markdown",
    ".txt": "text/plain",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".zip": "application/zip",
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".csv": "text/csv",
  })[path.extname(key).toLowerCase()] || "application/octet-stream";
export async function assertPrivateOutput(dir) {
  let current = path.resolve(dir);
  await mkdir(current, { recursive: true });
  current = await realpath(current);
  while (true) {
    try {
      await stat(path.join(current, ".git"));
      throw new Error(
        "Private migration output cannot be inside a git repository.",
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function prepare(source, output) {
  await assertPrivateOutput(output);
  source = await realpath(source);
  output = await realpath(output);
  if (output === source || output.startsWith(source + path.sep))
    throw new Error("Output must be outside the source.");
  const originals = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink())
        throw new Error("Source symlinks require review.");
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else
        originals.push({
          key: path.relative(source, p).split(path.sep).join("/"),
          bytes: await readFile(p),
        });
    }
  }
  await walk(source);
  originals.sort((a, b) => a.key.localeCompare(b.key));
  const sourceHash = hash(
      originals.map((f) => `${f.key}\0${hash(f.bytes)}`).join("\n"),
    ),
    batch = uuid(sourceHash);
  const rows = { entries: [], documents: [], years: [], assets: [] },
    introductions = new Map(),
    segments = [];
  const assetFiles = new Map();
  function asset(key, bytes, year) {
    const id = uuid(key),
      ext = path
        .extname(key)
        .replace(/[^.a-z0-9]/gi, "")
        .slice(0, 12);
    const name = `${id}${ext}`;
    assetFiles.set(name, bytes);
    rows.assets.push({
      id,
      archive_year: year,
      source_key: key,
      object_path: `${batch}/${name}`,
      mime_type: mime(key),
      sha256: hash(bytes),
      size_bytes: bytes.length,
      import_batch: batch,
    });
  }
  function doc(key, text, year) {
    rows.documents.push({
      id: uuid(`doc:${key}`),
      archive_year: year,
      title: path.basename(key),
      body_md: text,
      source_key: key,
      source_hash: hash(text),
      import_batch: batch,
    });
  }
  function standalone(key, text, year, dateMatch) {
    const date = normalizeDate(...dateMatch),
      note = !date
        ? "Ambiguous filename date; review before assigning a calendar date."
        : "";
    rows.entries.push({
      id: uuid(`${key}:0`),
      entry_date: date,
      archive_year: date ? Number(date.slice(0, 4)) : year,
      title: path.basename(key).replace(/\.md$/i, ""),
      body_md: text,
      source_key: key,
      source_order: 0,
      source_hash: hash(text),
      review_note: note,
      import_batch: batch,
    });
  }
  for (const f of originals) {
    const year = Number(f.key.split("/")[0]);
    if (!Number.isInteger(year))
      throw new Error("Every source file needs a source-year folder.");
    asset(f.key, f.bytes, year);
    if (/daily_pt\d+\.md$/i.test(f.key)) {
      const text = f.bytes.toString("utf8"),
        result = splitJournal(text, f.key, year);
      introductions.set(year, (introductions.get(year) || "") + result.intro);
      for (const e of result.entries) {
        segments.push({
          source: f.key,
          ...e._segment,
          raw: undefined,
          sha256: e.source_hash,
        });
        delete e._segment;
        rows.entries.push({ ...e, import_batch: batch });
      }
    } else if (
      year === 2023 &&
      /^2023\/\d{4}-\d{2}-\d{2}.*\.md$/i.test(f.key)
    ) {
      standalone(
        f.key,
        f.bytes.toString("utf8"),
        year,
        f.key.slice(5, 15).split("-"),
      );
    } else if (/\.zip$/i.test(f.key)) {
      let size = 0;
      const members = unzipSync(f.bytes, {
        filter: (e) => {
          size += e.originalSize;
          if (size > 250000000 || e.originalSize > 50000000)
            throw new Error("Archive expansion exceeds safety limit.");
          return !e.name.endsWith("/");
        },
      });
      for (const [name, raw] of Object.entries(members).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        const key = `${f.key}!/${name}`,
          bytes = Buffer.from(raw);
        asset(key, bytes, year);
        if (year === 2022) {
          const basename = path.posix.basename(name),
            m = basename.match(/^(\d{1,2})_(\d{1,2})_(\d{1,2})(?=\D|$)/);
          if (m)
            standalone(key, bytes.toString("utf8"), year, [
              m[3].length === 2 ? `20${m[3]}` : m[3],
              m[1],
              m[2],
            ]);
          else if (bytes.length < 100000 && !bytes.includes(0))
            doc(key, bytes.toString("utf8"), year);
        }
      }
    } else if (/\.(md|txt)$/i.test(f.key))
      doc(f.key, f.bytes.toString("utf8"), year);
  }
  for (const year of [
    ...new Set(
      rows.entries
        .map((e) => e.archive_year)
        .concat(originals.map((f) => Number(f.key.split("/")[0]))),
    ),
  ].sort())
    rows.years.push({ year, intro_md: introductions.get(year) || "" });
  const manifest = {
    version: 1,
    id: batch,
    source_hash: sourceHash,
    files: originals.map((f) => ({
      path: f.key,
      sha256: hash(f.bytes),
      bytes: f.bytes.length,
    })),
    segments,
    counts: Object.fromEntries(
      Object.entries(rows).map(([k, v]) => [k, v.length]),
    ),
    years: rows.years.map((y) => ({
      year: y.year,
      entries: rows.entries.filter((e) => e.archive_year === y.year).length,
      unresolved: rows.entries.filter(
        (e) => e.archive_year === y.year && !e.entry_date,
      ).length,
    })),
    exceptions: rows.entries
      .filter((e) => e.review_note)
      .map((e) => ({ id: e.id, source: e.source_key, note: e.review_note })),
  };
  await mkdir(path.join(output, "assets"), { recursive: true });
  for (const [name, bytes] of assetFiles)
    await writeFile(path.join(output, "assets", name), bytes, { flag: "w" });
  await writeFile(
    path.join(output, "package.json"),
    JSON.stringify({ manifest, rows }, null, 2),
  );
  await writeFile(
    path.join(output, "RECONCILIATION.md"),
    `# Private source reconciliation\n\nStatus: SOURCE PREPARATION VERIFIED. Database import has NOT been run.\n\nSource files: ${originals.length}. Candidate entries: ${rows.entries.length}. All aggregate text segments round-trip exactly; raw bytes are preserved as private assets.\n\n| Year | Expected entries | Unresolved dates | Database |\n| --- | ---: | ---: | --- |\n${manifest.years.map((y) => `| ${y.year} | ${y.entries} | ${y.unresolved} | NOT IMPORTED |`).join("\n")}\n\nDocuments: ${rows.documents.length}. Assets: ${rows.assets.length}. Date exceptions: ${manifest.exceptions.length}.\n\nWritten cross-year dates are retained; no typo correction is silently applied. Duplicate-day entries remain separate.\n`,
  );
  return manifest;
}
export async function remoteClient() {
  const url = process.env.SUPABASE_URL,
    key = process.env.SUPABASE_PUBLISHABLE_KEY,
    token = process.env.JOURNAL_ACCESS_TOKEN;
  if (!url || !key || !token)
    throw new Error(
      "Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and JOURNAL_ACCESS_TOKEN (signed-in owner session). Never use a service key.",
    );
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url))
    throw new Error("Expected an HTTPS Supabase project URL.");
  async function request(route, opts = {}) {
    const res = await fetch(url + route, {
      ...opts,
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        ...(route.startsWith("/rest/")
          ? { "Accept-Profile": "daily", "Content-Profile": "daily" }
          : {}),
        ...opts.headers,
      },
    });
    if (!res.ok)
      throw new Error(
        `Supabase request failed (${res.status}); no data logged.`,
      );
    return res;
  }
  const user = await (await request("/auth/v1/user")).json();
  if (!user.id) throw new Error("Owner authentication required.");
  const permitted = await (
    await request("/rest/v1/rpc/journal_access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).json();
  if (permitted !== true) throw new Error("Signed-in allowlisted owner required.");
  return { request, user: user.id };
}
export const tables = {
  entries: "journal_entries",
  documents: "journal_documents",
  years: "journal_years",
  assets: "journal_assets",
};
export async function verifyPackage(pkg, dir, remote, { writeReport = true, requireActive = true } = {}) {
  await assertPrivateOutput(dir);
  const results = [];
  let verifiedEntries=[];
  for (const [kind, items] of Object.entries(pkg.rows)) {
    const actual = [];
    for (let offset = 0; ; offset += 400) {
      const res = await remote.request(
        `/rest/v1/${tables[kind]}?select=*&user_id=eq.${remote.user}&order=${kind === "years" ? "year" : "id"}&offset=${offset}&limit=400`,
      );
      const page = await res.json();
      actual.push(...page);
      if (page.length < 400) break;
    }
    for (const item of items) {
      const got = actual.find((r) =>
        kind === "years" ? r.year === item.year : r.id === item.id,
      );
      if (!got) throw new Error(`Verification failed: missing ${kind} record.`);
      if ((kind === "entries" || kind === "documents") && got.deleted_at)
        throw new Error(`Verification failed: ${kind} record is in trash.`);
      for (const [key, value] of Object.entries(item)) {
        const expected =
          key === "object_path" ? `${remote.user}/${value}` : value;
        if (JSON.stringify(got[key]) !== JSON.stringify(expected))
          throw new Error(
            `Verification failed: ${kind}.${key} differs. Existing edits were not overwritten.`,
          );
      }
      if (kind === "assets") {
        const response = await remote.request(
          `/storage/v1/object/authenticated/daily-journal/${got.object_path}`,
        );
        if (hash(Buffer.from(await response.arrayBuffer())) !== item.sha256)
          throw new Error("Asset hash mismatch.");
      }
    }
    const count =
      kind === "years"
        ? items.length
        : actual.filter((r) => r.import_batch === pkg.manifest.id).length;
    if (count !== items.length)
      throw new Error(`Unexpected ${kind} count for import batch.`);
    results.push({
      kind,
      expected: items.length,
      actual: count,
      status: "PASS",
    });
  }
  const actualEntryRows=[];
  for(let offset=0;;offset+=400){
    const response=await remote.request(`/rest/v1/journal_entries?select=*&user_id=eq.${remote.user}&order=id&offset=${offset}&limit=400`);
    const page=await response.json();actualEntryRows.push(...page);if(page.length<400)break;
  }
  verifiedEntries=actualEntryRows.filter(r=>r.import_batch===pkg.manifest.id);
  const yearResults=pkg.manifest.years.map(y=>({...y,actual:verifiedEntries.filter(r=>r.archive_year===y.year).length}));
  if(yearResults.some(y=>y.entries!==y.actual))throw new Error('Year counts changed during verification.');
  const sourceResults=[...new Set(pkg.rows.entries.map(r=>r.source_key))].map(source=>({source,expected:pkg.rows.entries.filter(r=>r.source_key===source).length,actual:verifiedEntries.filter(r=>r.source_key===source).length}));
  if(sourceResults.some(s=>s.expected!==s.actual))throw new Error('Source counts changed during verification.');
  if (requireActive) {
    const batches = await (await remote.request(`/rest/v1/journal_imports?select=id,status&user_id=eq.${remote.user}&id=eq.${pkg.manifest.id}`)).json();
    if (batches.length !== 1 || batches[0].id !== pkg.manifest.id || batches[0].status !== "active")
      throw new Error("Import batch is not active. Run the importer to finish activation.");
  }
  const report = {
    status: "PASS",
    verified_at: new Date().toISOString(),
    batch: pkg.manifest.id,
    results,
    sources:sourceResults,
    years: yearResults.map((y) => ({
      ...y,
      status: "PASS (IDs, fields and asset hashes matched)",
    })),
  };
  if (remote.local) report.status = "PASS_LOCAL_TRANSPORT_ONLY";
  if (writeReport) await writeFile(
    path.join(
      dir,
      remote.local
        ? "LOCAL_TRANSPORT_VERIFICATION.json"
        : "DATABASE_VERIFICATION.json",
    ),
    JSON.stringify(report, null, 2),
  );
  return report;
}
export async function upload(dir, remote = undefined) {
  await assertPrivateOutput(dir);
  const pkg = JSON.parse(
    await readFile(path.join(dir, "package.json"), "utf8"),
  );
  remote = remote || (await remoteClient());
  async function insert(table, row) {
    await remote.request(`/rest/v1/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify(row),
    });
  }
  await insert("journal_imports", {
    id: pkg.manifest.id,
    user_id: remote.user,
    source_hash: pkg.manifest.source_hash,
    manifest: pkg.manifest,
    status: "staging",
  });
  for (const [kind, items] of Object.entries(pkg.rows))
    for (const item of items) {
      const row = { ...item, user_id: remote.user };
      if (kind === "assets") {
        row.object_path = `${remote.user}/${item.object_path}`;
        const bytes = await readFile(
          path.join(dir, "assets", path.basename(item.object_path)),
        );
        if (hash(bytes) !== item.sha256)
          throw new Error("Private package asset has changed.");
        try {
          await remote.request(
            `/storage/v1/object/daily-journal/${row.object_path}`,
            {
              method: "POST",
              headers: { "Content-Type": item.mime_type, "x-upsert": "false" },
              body: bytes,
            },
          );
        } catch (e) {
          const existing = await remote.request(
            `/storage/v1/object/authenticated/daily-journal/${row.object_path}`,
          );
          if (hash(Buffer.from(await existing.arrayBuffer())) !== item.sha256)
            throw e;
        }
      }
      await insert(tables[kind], row);
    }
  const report = await verifyPackage(pkg, dir, remote, { writeReport: false, requireActive: false });
  const activated = await remote.request(
    `/rest/v1/journal_imports?id=eq.${pkg.manifest.id}&user_id=eq.${remote.user}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ status: "active" }),
    },
  );
  const batches = await activated.json();
  if (!Array.isArray(batches) || batches.length !== 1 || batches[0].id !== pkg.manifest.id || batches[0].status !== "active")
    throw new Error("Import verification succeeded but activation was not confirmed. Retry the importer.");
  await writeFile(path.join(dir, remote.local ? "LOCAL_TRANSPORT_VERIFICATION.json" : "DATABASE_VERIFICATION.json"), JSON.stringify(report, null, 2));
  console.log(
    remote.local
      ? "Local transport verification passed (not a live import)."
      : "Import verified and activated. Private verification report saved.",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const command = process.argv[2] || "prepare",
    base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = path.resolve(
    process.argv[4] || path.join(base, "private-migration"),
  );
  try {
    if (command === "prepare") {
      const result = await prepare(
        path.resolve(process.argv[3] || path.join(base, "Daily_ng-main")),
        dir,
      );
      console.log(
        JSON.stringify(
          { counts: result.counts, years: result.years, output: dir },
          null,
          2,
        ),
      );
    } else if (command === "upload")
      await upload(path.resolve(process.argv[3] || dir));
    else if (command === "verify") {
      const folder = path.resolve(process.argv[3] || dir);
      await verifyPackage(
        JSON.parse(await readFile(path.join(folder, "package.json"), "utf8")),
        folder,
        await remoteClient(),
      );
      console.log("Database verification PASS.");
    } else throw new Error("Use prepare, upload or verify.");
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
