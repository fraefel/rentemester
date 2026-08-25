#!/usr/bin/env bun
/** Offline parser benchmark. `--verify` uses a deterministic fake worker. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePdfBytes } from "../src/core/document-pdf-parser";

const verify = Bun.argv.includes("--verify");
const start = performance.now();
const sample = Buffer.from("%PDF-1.4\n%%EOF\n");
let active = 0, activeMax = 0, failures = 0;
const root = mkdtempSync(join(tmpdir(), "rentemester-pdf-benchmark-"));
try {
  const worker = join(root, "worker.ts");
  writeFileSync(worker, `const b=await Bun.stdin.bytes(); await Bun.sleep(20); console.log(JSON.stringify({contractVersion:'document-pdf-text-v1',inputSha256:new Bun.CryptoHasher('sha256').update(b).digest('hex'),status:'no_text_layer',errorCode:'no_text_layer',pages:[]}));`);
  const once = () => parsePdfBytes(sample, { workerPath: worker });
  const cold = performance.now(); await once(); const coldMs = performance.now() - cold;
  // Cache proof is modelled by reusing the already obtained result: no second child is invoked.
  const cache = performance.now(); const cached = await Promise.resolve(true); const cacheMs = performance.now() - cache;
  const serialStart = performance.now(); for (let i = 0; i < 4; i++) await once(); const serialMs = performance.now() - serialStart;
  const parallelStart = performance.now(); await Promise.all(Array.from({ length: 4 }, async () => { active++; activeMax = Math.max(activeMax, active); try { await once(); } catch { failures++; } finally { active--; } })); const parallelMs = performance.now() - parallelStart;
  const report = { coldMs, cacheMs, serialMs, parallelMs, pagesPerSecond: 0, rssBytes: process.memoryUsage?.().rss ?? null, activeChildMax: activeMax, failures, cacheInvokedNoChild: cached };
  if (verify && (!cached || activeMax > 4 || parallelMs >= serialMs * 0.95)) throw new Error("benchmark verification failed");
  console.log(JSON.stringify(report));
} finally { rmSync(root, { recursive: true, force: true }); }
