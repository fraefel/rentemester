import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
const outdir = resolve(appRoot, "dist");

await rm(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [resolve(appRoot, "index.html")],
  outdir,
  minify: true,
  publicPath: "/",
  sourcemap: "linked",
  target: "browser",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
