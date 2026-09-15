import { build } from "esbuild";
import { mkdir, readdir, unlink } from "node:fs/promises";
await mkdir("assets", { recursive: true });
for (const file of await readdir("assets")) {
  if (/^app\.(js|css)(\.map)?$/.test(file)) await unlink(`assets/${file}`);
}
await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  minify: true,
  outfile: "assets/app.js",
  format: "esm",
  target: "es2022",
  legalComments: "eof",
});
console.log("Built static Pages assets. No private data is part of the build.");
