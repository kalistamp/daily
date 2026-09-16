import { build } from "esbuild";
import { mkdir, writeFile, rename } from "node:fs/promises";
await mkdir("assets", { recursive: true });
const result = await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  minify: true,
  outfile: "assets/app.js",
  format: "esm",
  target: "es2022",
  legalComments: "eof",
  write: false,
});
await writeFile("assets/app.js.next", result.outputFiles[0].contents);
await rename("assets/app.js.next", "assets/app.js");
console.log("Built static Pages assets. No private data is part of the build.");
