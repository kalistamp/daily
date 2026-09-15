import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upload, verifyPackage } from "../tools/import.mjs";

test("import requires confirmed activation and refuses private output inside git", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daily-import-test-"));
  const pkg = { manifest: { id: "batch", source_hash: "hash", years: [{year: 2026, entries: 1}] }, rows: {
    entries: [{id: "entry", import_batch: "batch", archive_year: 2026, source_key: "synthetic.md", body_md: "Synthetic"}],
    documents: [], years: [{year: 2026, intro_md: ""}], assets: [],
  }};
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  const rows = new Map();
  let activate = false;
  const remote = {local: true, user: "synthetic-owner", async request(route, opts = {}) {
    const url = new URL(route, "https://synthetic.invalid");
    const table = url.pathname.split("/").pop();
    if (!rows.has(table)) rows.set(table, []);
    const data = rows.get(table);
    if (opts.method === "POST") {
      const item = JSON.parse(opts.body);
      if (!data.some(r => item.id ? r.id === item.id : r.year === item.year)) data.push(item);
      return Response.json({});
    }
    if (opts.method === "PATCH") {
      if (!activate) return Response.json([]);
      Object.assign(data[0], JSON.parse(opts.body));
      return Response.json([data[0]]);
    }
    return Response.json(data);
  }};
  await assert.rejects(upload(dir, remote), /activation was not confirmed/);
  await assert.rejects(access(path.join(dir, "LOCAL_TRANSPORT_VERIFICATION.json")), {code: "ENOENT"});
  await assert.rejects(verifyPackage(pkg, dir, remote), /not active/);
  activate = true;
  await upload(dir, remote);
  await upload(dir, remote);
  assert.equal(rows.get("journal_entries").length, 1);
  const report = JSON.parse(await readFile(path.join(dir, "LOCAL_TRANSPORT_VERIFICATION.json")));
  assert.equal(report.years[0].actual, 1);
  rows.get("journal_entries")[0].deleted_at = "2026-09-14T00:00:00Z";
  await assert.rejects(verifyPackage(pkg, dir, remote), /in trash/);
  const repo = path.join(dir, "repository");
  await mkdir(path.join(repo, ".git"), {recursive: true});
  await assert.rejects(upload(repo, remote), /inside a git repository/);
  await assert.rejects(verifyPackage(pkg, repo, remote), /inside a git repository/);
});
