#!/usr/bin/env bun
/** Offline benchmark of the production PDF batch scheduler. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompany } from "../src/core/company";
import { openDb, migrate } from "../src/core/db";
import { parseRegisteredPdfBatch, planCurrentPdfParses } from "../src/core/document-pdf-parser";
import { ingestDocument } from "../src/core/documents";
import { companyPaths } from "../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../src/core/workspace";
import { syntheticTextPdf } from "../tests/fixtures/pdf-parser/synthetic-text-pdf";

const verify = Bun.argv.includes("--verify");
const concurrency = 4;
const documentCount = concurrency * 2 + 1;
const now = () => performance.now();
const rate = (documents: number, pages: number, elapsedMs: number) => ({
  documentsPerSecond: Number((documents / (elapsedMs / 1000)).toFixed(3)),
  pagesPerSecond: Number((pages / (elapsedMs / 1000)).toFixed(3)),
});

async function delayOnlySchedulerComparison() {
  const delayMs = 35;
  const run = async (limit: number) => {
    let next = 0;
    await Promise.all(Array.from({ length: limit }, async () => {
      while (next < documentCount) { next += 1; await Bun.sleep(delayMs); }
    }));
  };
  const serialStart = now(); await run(1); const serialMs = now() - serialStart;
  const parallelStart = now(); await run(concurrency); const parallelMs = now() - parallelStart;
  return { delayMs, documents: documentCount, serialMs: Number(serialMs.toFixed(2)), parallelMs: Number(parallelMs.toFixed(2)) };
}

const root = mkdtempSync(join(tmpdir(), "rentemester-pdf-benchmark-"));
try {
  initWorkspace(root);
  const company = createCompany(root, { name: "Synthetic Benchmark ApS" });
  const companyRoot = companyRootForSlug(root, company.slug);
  const db = openDb(companyPaths(companyRoot).db); migrate(db);
  const pdfPath = join(root, "synthetic.pdf");
  const malformedPath = join(root, "malformed.pdf");
  writeFileSync(malformedPath, "%PDF-1.4\nthis is deliberately malformed\n");
  let documentNo = 0;
  const ingest = (malformed = false) => {
    documentNo += 1;
    if (!malformed) writeFileSync(pdfPath, Buffer.concat([Buffer.from(syntheticTextPdf()), Buffer.from(`% benchmark-${documentNo}\n`)]));
    const result = ingestDocument(db, companyRoot, malformed ? malformedPath : pdfPath, {
      source: "email", documentType: "purchase_sale", currency: "DKK",
      issueDate: "2026-01-01", invoiceNo: `${malformed ? "BAD" : "SYN"}-${documentNo}`,
      deliveryDescription: "Synthetic parser benchmark", amountIncVat: 1, vatAmount: 0,
      sender: { name: "Synthetic supplier", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK11223344" },
      recipient: { name: "Synthetic Benchmark ApS", address: "Testvej 2, 2100 København Ø", vatOrCvr: "DK12345678" },
    }, { forceDuplicateLogicalIdentity: true, createdBy: "agent:benchmark", createdByProgram: "benchmark-pdf-parser" });
    if (!result.ok || !result.documentId) throw new Error(`synthetic ingest failed: ${result.errors?.join(",")}`);
    return result.documentId;
  };

  const malformedIndex = concurrency - 1;
  const requestedDocumentIds = Array.from({ length: documentCount }, (_, index) => ingest(index === malformedIndex));
  const pendingBefore = planCurrentPdfParses(db, { limit: 100 });
  if (JSON.stringify(pendingBefore.documentIds) !== JSON.stringify(requestedDocumentIds)) throw new Error("benchmark setup did not produce deterministic current parse keys");
  const firstResumePage = planCurrentPdfParses(db, { limit: concurrency });
  const secondResumePage = planCurrentPdfParses(db, { limit: concurrency, cursor: firstResumePage.nextCursor! });
  const finalResumePage = planCurrentPdfParses(db, { limit: concurrency, cursor: secondResumePage.nextCursor! });
  const resumedDocumentIds = [...firstResumePage.documentIds, ...secondResumePage.documentIds, ...finalResumePage.documentIds];

  let activeWorkers = 0, maxActiveWorkers = 0, coldWorkerLaunches = 0;
  const coldStart = now();
  const coldBatch = await parseRegisteredPdfBatch(db, companyRoot, pendingBefore.documentIds, {
    concurrency,
    createdBy: "agent:benchmark",
    createdByProgram: "benchmark-pdf-parser",
    onActiveChildren: (active) => { activeWorkers = active; maxActiveWorkers = Math.max(maxActiveWorkers, active); },
    onChildWorkerLaunch: () => { coldWorkerLaunches += 1; },
  });
  const coldMs = now() - coldStart;
  const malformed = coldBatch[malformedIndex];
  const successful = coldBatch.filter((item: any) => item.ok && item.result.status === "ok");
  const coldPages = successful.reduce((pages: number, item: any) => pages + item.result.pages.length, 0);
  const pendingAfter = planCurrentPdfParses(db, { limit: 100 });

  let warmWorkerLaunches = 0;
  const warmStart = now();
  const warmBatch = await parseRegisteredPdfBatch(db, companyRoot, requestedDocumentIds, {
    concurrency,
    createdBy: "agent:benchmark",
    createdByProgram: "benchmark-pdf-parser",
    onChildWorkerLaunch: () => { warmWorkerLaunches += 1; },
  });
  const warmMs = now() - warmStart;
  const schedulerComparison = await delayOnlySchedulerComparison();
  const report = {
    parser: "pdfjs-dist@6.2.108",
    coldParser: { documents: successful.length, pages: coldPages, ms: Number(coldMs.toFixed(2)), ...rate(successful.length, coldPages, coldMs), childWorkerLaunches: coldWorkerLaunches },
    warmCache: { documents: warmBatch.length, ms: Number(warmMs.toFixed(2)), childWorkerLaunches: warmWorkerLaunches, allCached: warmBatch.every((item: any) => item.ok && item.result.cached) },
    batchScheduler: { requested: requestedDocumentIds.length, concurrency, activeWorkersAtCompletion: activeWorkers, maxActiveWorkers },
    failureIsolation: { malformedDocumentId: malformed?.documentId, malformedBatchOk: malformed?.ok, malformedStatus: malformed?.result?.status, malformedErrorCode: malformed?.result?.errorCode, successfulDocuments: successful.length },
    currentKeys: {
      pendingBefore: pendingBefore.documentIds,
      resumeCursors: [firstResumePage.nextCursor, secondResumePage.nextCursor, finalResumePage.nextCursor],
      resumedDocumentIds,
      pendingAfter: pendingAfter.documentIds,
      stableOutputOrder: coldBatch.map((item: any) => item.documentId).every((id: number, index: number) => id === requestedDocumentIds[index]),
    },
    delayOnlySchedulerComparison: schedulerComparison,
    peakRssBytes: process.memoryUsage?.().rss ?? null,
  };
  if (verify && (
    report.coldParser.pagesPerSecond <= 0 || report.coldParser.documentsPerSecond <= 0 ||
    report.coldParser.childWorkerLaunches !== documentCount || report.warmCache.childWorkerLaunches !== 0 || !report.warmCache.allCached ||
    report.batchScheduler.maxActiveWorkers !== concurrency || report.batchScheduler.maxActiveWorkers > concurrency ||
    report.failureIsolation.malformedStatus !== "malformed_pdf" || report.failureIsolation.successfulDocuments !== documentCount - 1 ||
    JSON.stringify(report.currentKeys.resumedDocumentIds) !== JSON.stringify(requestedDocumentIds) || report.currentKeys.resumeCursors[2] !== null ||
    report.currentKeys.pendingAfter.length !== 0 || !report.currentKeys.stableOutputOrder ||
    report.delayOnlySchedulerComparison.parallelMs >= report.delayOnlySchedulerComparison.serialMs * 0.9
  )) throw new Error(`benchmark verification failed: ${JSON.stringify(report)}`);
  console.log(JSON.stringify(report));
  db.close();
} finally { rmSync(root, { recursive: true, force: true }); }
