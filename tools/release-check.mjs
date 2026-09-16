import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
const names = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const forbidden =
  /(^|\/)(private[^/]*|node_modules|\.env(?:\..*)?|.*\.dump|.*\.backup|.*\.private\..*|.*\.map)(\/|$)/i;
let count = 0;
const buffers = [];
for (const name of names) {
  if (forbidden.test(name) && name !== ".env.example")
    throw Error(`Unsafe publish path: ${name}`);
  let bytes;
  try {
    bytes = await readFile(name);
  } catch (e) {
    if (e.code === "ENOENT") continue;
    throw e;
  }
  count++;
  const text = bytes.toString("utf8");
  if (
    /sb_secret_[a-zA-Z0-9]{12,}|gh[pousr]_[a-zA-Z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      text,
    )
  )
    throw Error(`Potential credential in ${name}`);
  buffers.push({ name, text });
}
const html = await readFile("index.html", "utf8");
if (!html.includes("./assets/app.js")) throw Error("Missing bundle reference");
if (!(await readFile("assets/app.js")).length) throw Error("Empty bundle");
let privateScan = "not available (CI checks synthetic/code only)";
try {
  const pkg = JSON.parse(
    await readFile("../private-migration/package.json", "utf8"),
  );
  const needles = new Set();
  for (const row of [...pkg.rows.entries, ...pkg.rows.documents])
    for (const line of row.body_md.split(/\r?\n/)) {
      const s = line.trim();
      if (s.length >= 100 && !/^https?:|^[-#=*_`<>\s]+$/.test(s))
        needles.add(s.slice(0, 100));
    }
  for (const { name, text } of buffers)
    for (const needle of needles)
      if (text.includes(needle))
        throw Error(`Private source text found in publishable file: ${name}`);
  privateScan = `PASS (${needles.size} private text fingerprints)`;
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
console.log(
  `PASS: ${count} publishable files checked; bundle present; no forbidden private paths or recognized credentials. Private text scan: ${privateScan}.`,
);
