#!/usr/bin/env bun
/** Offline, real pdf.js benchmark. --verify also proves bounded coordination. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompany } from "../src/core/company";
import { openDb, migrate } from "../src/core/db";
import { ingestDocument } from "../src/core/documents";
import { parseRegisteredPdfDocument } from "../src/core/document-pdf-parser";
import { companyPaths } from "../src/core/paths";
import { initWorkspace, companyRootForSlug } from "../src/core/workspace";
import { syntheticTextPdf } from "../tests/fixtures/pdf-parser/synthetic-text-pdf";

const verify = Bun.argv.includes("--verify");
const concurrency = 4;
const now = () => performance.now();
const rate = (documents: number, pages: number, elapsedMs: number) => ({
  documentsPerSecond: Number((documents / (elapsedMs / 1000)).toFixed(3)),
  pagesPerSecond: Number((pages / (elapsedMs / 1000)).toFixed(3)),
});

const root = mkdtempSync(join(tmpdir(), "rentemester-pdf-benchmark-"));
try {
  initWorkspace(root);
  const company = createCompany(root, { name: "Synthetic Benchmark ApS" });
  const companyRoot = companyRootForSlug(root, company.slug);
  const db = openDb(companyPaths(companyRoot).db); migrate(db);
  const pdfPath = join(root, "synthetic.pdf");
  writeFileSync(pdfPath, syntheticTextPdf());
  const malformedPath = join(root, "malformed.pdf"); writeFileSync(malformedPath, "%PDF-1.4\nthis is deliberately malformed\n");
  let documentNo = 0;
  const ingest = (path: string, malformed = false) => {
    documentNo += 1;
    // A trailing PDF comment yields distinct source hashes without changing
    // text/layout, so each measured run has a real independent cache key.
    if (!malformed) writeFileSync(pdfPath, Buffer.concat([Buffer.from(syntheticTextPdf()), Buffer.from(`% benchmark-${documentNo}\n`)]));
    const result = ingestDocument(db, companyRoot, path, {
      source: "email", documentType: "purchase_sale", currency: "DKK",
      issueDate: "2026-01-01", invoiceNo: `${malformed ? "BAD" : "SYN"}-${documentNo}`,
      deliveryDescription: "Synthetic parser benchmark", amountIncVat: 1, vatAmount: 0,
      sender: { name: "Synthetic supplier", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK11223344" },
      recipient: { name: "Synthetic Benchmark ApS", address: "Testvej 2, 2100 København Ø", vatOrCvr: "DK12345678" },
    }, { forceDuplicateLogicalIdentity: true, createdBy: "agent:benchmark", createdByProgram: "benchmark-pdf-parser" });
    if (!result.ok || !result.documentId) throw new Error(`synthetic ingest failed: ${result.errors?.join(",")}`);
    return result.documentId;
  };
  const coldId = ingest(pdfPath);
  const coldStart = now(); const cold = await parseRegisteredPdfDocument(db, companyRoot, { documentId: coldId, createdBy: "agent:benchmark" }); const coldMs = now() - coldStart;
  const cacheStart = now(); const cached = await parseRegisteredPdfDocument(db, companyRoot, { documentId: coldId, createdBy: "agent:benchmark" }); const cacheMs = now() - cacheStart;
  const cacheChildLaunches = db.query("SELECT count(*) AS n FROM document_pdf_parse_attempts WHERE document_id=? AND outcome='parsed'").get(coldId) as { n: number };

  // The injected delay is only coordinator evidence; every child still imports
  // the production pdf.js worker and parses real bytes.
  const delayedWorker = join(root, "delayed-worker.ts");
  writeFileSync(delayedWorker, `await Bun.sleep(35); await import(${JSON.stringify(join(import.meta.dir, "../src/core/document-pdf-parser-worker.ts"))});\n`);
  let active = 0, activeMax = 0;
  const run = async (id: number) => { active += 1; activeMax = Math.max(activeMax, active); try { return await parseRegisteredPdfDocument(db, companyRoot, { documentId: id, createdBy: "agent:benchmark", workerPath: delayedWorker }); } finally { active -= 1; } };
  const serialIds = Array.from({ length: concurrency }, () => ingest(pdfPath));
  const serialStart = now(); const serial = []; for (const id of serialIds) serial.push(await run(id)); const serialMs = now() - serialStart;
  const parallelIds = Array.from({ length: concurrency }, () => ingest(pdfPath));
  const parallelStart = now(); const parallel = await Promise.all(parallelIds.map(run)); const parallelMs = now() - parallelStart;
  const malformedId = ingest(malformedPath, true);
  const malformed = await parseRegisteredPdfDocument(db, companyRoot, { documentId: malformedId, createdBy: "agent:benchmark" });
  const report = {
    parser: "pdfjs-dist@6.2.108", cold: { ms: Number(coldMs.toFixed(2)), ...rate(1, cold.pages.length, coldMs) },
    cache: { ms: Number(cacheMs.toFixed(2)), childLaunches: cacheChildLaunches.n - 1, cached: cached.cached },
    serial: { ms: Number(serialMs.toFixed(2)), ...rate(serial.length, serial.reduce((n, item) => n + item.pages.length, 0), serialMs) },
    parallel: { ms: Number(parallelMs.toFixed(2)), ...rate(parallel.length, parallel.reduce((n, item) => n + item.pages.length, 0), parallelMs) },
    coordinator: { injectedDelayMs: 35, maxActiveChildren: activeMax, limit: concurrency },
    failureIsolation: { malformedStatus: malformed.status, malformedErrorCode: malformed.errorCode, successfulParallel: parallel.every((item) => item.status === "ok") },
    peakRssBytes: process.memoryUsage?.().rss ?? null,
  };
  if (verify && (report.cold.pagesPerSecond <= 0 || report.parallel.pagesPerSecond <= 0 || !report.cache.cached || report.cache.childLaunches !== 0 || activeMax < 2 || activeMax > concurrency || parallelMs >= serialMs * 0.9 || malformed.status !== "malformed_pdf" || !report.failureIsolation.successfulParallel)) throw new Error(`benchmark verification failed: ${JSON.stringify(report)}`);
  console.log(JSON.stringify(report));
  db.close();
} finally { rmSync(root, { recursive: true, force: true }); }
