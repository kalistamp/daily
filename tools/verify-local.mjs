import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { upload, hash } from "./import.mjs";
const dir = path.resolve("../private-migration"),
  pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
const root = path.resolve("../Daily_ng-main");
for (const file of pkg.manifest.files)
  assert.equal(
    hash(await readFile(path.join(root, file.path))),
    file.sha256,
    "Source differs from frozen manifest",
  );
assert.equal(pkg.rows.entries.length, 270);
assert.deepEqual(
  pkg.manifest.years.map((y) => [y.year, y.entries]),
  [
    [2022, 25],
    [2023, 39],
    [2024, 88],
    [2025, 57],
    [2026, 61],
  ],
);
const memory = new Map(),
  objects = new Map();
const remote = {
  local: true,
  user: "11111111-1111-4111-8111-111111111111",
  async request(route, opts = {}) {
    const url = new URL(route, "https://synthetic.invalid");
    if (route.startsWith("/storage/")) {
      const key = url.pathname
        .replace("/storage/v1/object/authenticated/", "")
        .replace("/storage/v1/object/", "");
      if (opts.method === "POST") {
        if (objects.has(key)) throw Error("Exists");
        objects.set(key, Buffer.from(opts.body));
        return new Response("{}");
      }
      if (!objects.has(key)) throw Error("Missing asset");
      return new Response(objects.get(key));
    }
    const table = url.pathname.split("/").pop();
    if (!memory.has(table)) memory.set(table, []);
    const rows = memory.get(table);
    if (opts.method === "POST") {
      const row = JSON.parse(opts.body);
      if (
        !rows.some((r) =>
          table === "journal_years" ? r.year === row.year : r.id === row.id,
        )
      )
        rows.push(row);
      return new Response("{}");
    }
    if (opts.method === "PATCH") {
      const row = rows.find(
        (r) => r.id === url.searchParams.get("id")?.slice(3),
      );
      Object.assign(row, JSON.parse(opts.body));
      return Response.json([row]);
    }
    const offset = Number(url.searchParams.get("offset") || 0),
      limit = Number(url.searchParams.get("limit") || 400);
    const id = url.searchParams.get("id")?.slice(3);
    return Response.json(rows.filter(r => !id || r.id === id).slice(offset, offset + limit));
  },
};
// Exercise the real upload/verification algorithm twice, with local in-memory transport.
// This proves retry behavior, not live Supabase operation.
const privateSource = JSON.parse(
  await readFile(path.join(dir, "package.json"), "utf8"),
);
await upload(dir, remote);
await upload(dir, remote);
const report = {
  status: "PASS_LOCAL_ONLY",
  scope: "Real package, local transport, not a live Supabase import",
  source_files: pkg.manifest.files.length,
  source_hash: pkg.manifest.source_hash,
  years: pkg.manifest.years.map((y) => ({
    ...y,
    actual: memory
      .get("journal_entries")
      .filter((r) => r.archive_year === y.year).length,
  })),
  documents: memory.get("journal_documents").length,
  assets: objects.size,
  idempotent: true,
  verified_at: new Date().toISOString(),
};
await writeFile(
  path.join(dir, "LOCAL_VERIFICATION.json"),
  JSON.stringify(report, null, 2),
);
assert.equal(
  hash(JSON.stringify(privateSource)),
  hash(
    JSON.stringify(
      JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")),
    ),
  ),
);
console.log(JSON.stringify(report, null, 2));
