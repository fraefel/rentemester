import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCompany } from "../../src/core/company";
import { migrate, openDb } from "../../src/core/db";
import { parseRegisteredPdfBatch, planCurrentPdfParses } from "../../src/core/document-pdf-parser";
import { ingestDocument } from "../../src/core/documents";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { syntheticTextPdf } from "../fixtures/pdf-parser/synthetic-text-pdf";

test("PDF batch bounds requests before opening a source", async () => {
  const db = new Database(":memory:");
  await expect(parseRegisteredPdfBatch(db, "/missing", Array.from({ length: 101 }, (_, i) => i + 1))).rejects.toThrow("limit is 100");
  await expect(parseRegisteredPdfBatch(db, "/missing", [], { concurrency: 5 })).rejects.toThrow("between 1 and 4");
  expect(await parseRegisteredPdfBatch(db, "/missing", [])).toEqual([]);
  db.close();
});

test("PDF batch uses bounded real children, isolates malformed status, and reuses current parse keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "rentemester-pdf-batch-test-"));
  try {
    initWorkspace(root);
    const company = createCompany(root, { name: "Synthetic Batch ApS" });
    const companyRoot = companyRootForSlug(root, company.slug);
    const db = openDb(companyPaths(companyRoot).db); migrate(db);
    const pdfPath = join(root, "synthetic.pdf");
    const malformedPath = join(root, "malformed.pdf");
    writeFileSync(malformedPath, "%PDF-1.4\nmalformed\n");
    let invoice = 0;
    const ingest = (malformed = false) => {
      invoice += 1;
      if (!malformed) writeFileSync(pdfPath, Buffer.concat([Buffer.from(syntheticTextPdf()), Buffer.from(`% test-${invoice}\n`)]));
      const result = ingestDocument(db, companyRoot, malformed ? malformedPath : pdfPath, {
        source: "email", documentType: "purchase_sale", currency: "DKK", issueDate: "2026-01-01", invoiceNo: `PDF-${invoice}`,
        deliveryDescription: "Synthetic parser test", amountIncVat: 1, vatAmount: 0,
        sender: { name: "Synthetic supplier", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK11223344" },
        recipient: { name: "Synthetic Batch ApS", address: "Testvej 2, 2100 København Ø", vatOrCvr: "DK12345678" },
      }, { forceDuplicateLogicalIdentity: true, createdBy: "agent:test", createdByProgram: "document-pdf-parser-batch-test" });
      if (!result.ok || !result.documentId) throw new Error("synthetic ingest failed");
      return result.documentId;
    };
    const documentIds = [ingest(), ingest(), ingest(true), ingest(), ingest(), ingest()];
    const legacy = db.query("SELECT stored_path AS storedPath FROM documents WHERE id=?").get(documentIds[1]!) as { storedPath: string };
    db.query("UPDATE documents SET stored_path=? WHERE id=?").run(
      `/old-linux-company/documents/originals/${basename(legacy.storedPath)}`,
      documentIds[1]!,
    );
    let maxActive = 0, launches = 0;
    const batch = await parseRegisteredPdfBatch(db, companyRoot, documentIds, {
      concurrency: 2,
      createdBy: "agent:test",
      onActiveChildren: (active) => { maxActive = Math.max(maxActive, active); },
      onChildWorkerLaunch: () => { launches += 1; },
    });
    expect(batch.map((item: any) => item.documentId)).toEqual(documentIds);
    expect(maxActive).toBe(2);
    expect(launches).toBe(documentIds.length);
    expect(batch[2]?.ok).toBe(true);
    expect((batch[2] as any)?.result.status).toBe("malformed_pdf");
    expect(batch.filter((item: any) => item.ok && item.result.status === "ok")).toHaveLength(documentIds.length - 1);
    expect(planCurrentPdfParses(db, { limit: 100 }).documentIds).toEqual([]);

    let warmLaunches = 0;
    const warm = await parseRegisteredPdfBatch(db, companyRoot, documentIds, { concurrency: 2, createdBy: "agent:test", onChildWorkerLaunch: () => { warmLaunches += 1; } });
    expect(warmLaunches).toBe(0);
    expect(warm.every((item: any) => item.ok && item.result.cached)).toBe(true);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
