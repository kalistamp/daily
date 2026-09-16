import http from "node:http";
import path from "node:path";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { entryPayload } from "../src/domain.js";
import { assertPrivateOutput } from "./import.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const folder = path.resolve(
  process.env.DAILY_REVIEW_DIR || path.join(root, "../private-migration"),
);
const review = process.argv.includes("--review"),
  secret = randomBytes(32).toString("hex"),
  cookie = randomBytes(32).toString("hex");
let data,
  queue = Promise.resolve();
if (review) {
  await assertPrivateOutput(folder);
  const pkg = JSON.parse(
    await readFile(path.join(folder, "package.json"), "utf8"),
  );
  try {
    data = JSON.parse(
      await readFile(path.join(folder, "review-state.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    data = { ...pkg.rows, revisions: [], reports: pkg.rows.reports || [] };
    for (const kind of ["entries", "documents", "years"])
      for (const row of data[kind]) row.revision = 1;
  }
}
async function persist() {
  await writeFile(path.join(folder, "review-state.next"), JSON.stringify(data));
  await rename(
    path.join(folder, "review-state.next"),
    path.join(folder, "review-state.json"),
  );
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const json = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`)
      return json(403, { error: "Invalid host" });
    const url = new URL(req.url, origin);
    if (
      review &&
      url.pathname === "/review" &&
      url.searchParams.get("token") === secret
    ) {
      res.writeHead(303, {
        "Set-Cookie": `daily_review=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
        Location: "/",
      });
      return res.end();
    }
    if (url.pathname.startsWith("/__review/")) {
      if (
        !review ||
        !(req.headers.cookie || "")
          .split(";")
          .some((x) => x.trim() === `daily_review=${cookie}`)
      )
        return json(401, {
          error: "Private local review requires the launch link.",
        });
      if (
        req.method === "POST" &&
        (req.headers.origin !== origin ||
          req.headers["content-type"] !== "application/json")
      )
        return json(403, { error: "Invalid request origin." });
      if (req.method === "GET") {
        if (url.pathname === "/__review/logout") {
          res.writeHead(303, {
            "Set-Cookie":
              "daily_review=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
            Location: "/",
          });
          return res.end();
        }
        if (url.pathname === "/__review/session")
          return json(200, { local: true });
        if (url.pathname === "/__review/data")
          return json(
            200,
            Object.fromEntries(
              ["entries", "documents", "years", "assets"].map((k) => [
                k,
                data[k],
              ]),
            ),
          );
        if (url.pathname === "/__review/reports")
          return json(200, data.reports);
        if (url.pathname === "/__review/history")
          return json(
            200,
            data.revisions
              .filter(
                (r) =>
                  r.entity === url.searchParams.get("kind") &&
                  r.entity_id === url.searchParams.get("id"),
              )
              .reverse(),
          );
        if (url.pathname === "/__review/asset") {
          const asset = data.assets.find(
            (a) => a.id === url.searchParams.get("id"),
          );
          if (!asset) return json(404, { error: "Not found" });
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": "attachment",
          });
          return res.end(
            await readFile(
              path.join(folder, "assets", path.basename(asset.object_path)),
            ),
          );
        }
      }
      if (req.method === "POST") {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 2000000) return json(413, { error: "Too large" });
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        queue = queue
          .catch(() => {})
          .then(async () => {
            const before = structuredClone(data);
            try {
            if (url.pathname === "/__review/save") {
              const { kind, expected } = input;
              let row = input.row;
              if (!["entries", "documents", "years"].includes(kind))
                throw Error("Invalid record type");
              const index = data[kind].findIndex((r) =>
                  kind === "years" ? r.year === row.year : r.id === row.id,
                ),
                old = data[kind][index];
              if (kind === "entries") row = entryPayload({ ...old, ...row });
              if ((old && old.revision !== expected) || (!old && expected != null))
                throw Error(
                  "Conflict: this record changed. Your draft was not saved.",
                );
              if (old)
                data.revisions.push({
                  entity: kind,
                  entity_id: String(old.id || old.year),
                  revision: old.revision,
                  snapshot: structuredClone(old),
                  created_at: new Date().toISOString(),
                });
              const saved = {
                ...old,
                ...row,
                ...(kind !== "years"
                  ? { id: old?.id || row.id || randomUUID() }
                  : {}),
                revision: (old?.revision || 0) + 1,
                updated_at: new Date().toISOString(),
              };
              if (old) data[kind][index] = saved;
              else data[kind].push(saved);
              await persist();
              return json(200, saved);
            }
            if (url.pathname === "/__review/report") {
              const { type, id, remove } = input;
              if (!["report", "claim", "prompt"].includes(type))
                throw Error("Invalid type");
              data.reports = data.reports.filter(
                (r) => r.entity_type !== type || r.entity_id !== id,
              );
              if (!remove)
                data.reports.push({
                  entity_type: type,
                  entity_id: id,
                  data: input.data,
                });
              await persist();
              return json(200, { ok: true });
            }
            json(404, { error: "Not found" });
            } catch (error) {
              data = before;
              throw error;
            }
          });
        await queue;
        return;
      }
      return json(404, { error: "Not found" });
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return json(405, { error: "Method not allowed" });
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (
      !["index.html", "style.css"].includes(name) &&
      !/^assets\/[a-zA-Z0-9_.-]+$/.test(name)
    )
      return json(404, { error: "Not found" });
    const bytes = await readFile(path.join(root, name));
    res.writeHead(200, {
      "Content-Type": name.endsWith(".html")
        ? "text/html; charset=utf-8"
        : name.endsWith(".css")
          ? "text/css"
          : "text/javascript",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch (e) {
    json(e.code === "ENOENT" ? 404 : 400, {
      error: e.code === "ENOENT" ? "Not found" : e.message,
    });
  }
});
let port = Number(process.env.PORT || 4173);
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") server.listen(++port, "127.0.0.1");
  else throw e;
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Daily local ${review ? "PRIVATE review" : "server"}: http://127.0.0.1:${server.address().port}/${review ? "review?token=" + secret : ""}`,
  ),
);
