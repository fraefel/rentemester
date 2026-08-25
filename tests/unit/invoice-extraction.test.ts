import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { extractInvoice, recognizeSupplier, ScriptedInvoiceExtractor } from "../../src/core/invoice-extraction";

const cited = (key: any, value: unknown, confidence = 0.99) => ({ key, value, confidence, page: 1, sourceText: `${key}: ${String(value)}` });
function fields(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { invoiceNumber: "INV-42", supplierName: "Synthetic supplier", supplierCountry: "DK", supplierLegalId: "DK12345678", supplierLegalIdKind: "dk_cvr", buyerName: "Synthetic buyer", buyerCountry: "DK", buyerLegalId: "DK87654321", buyerLegalIdKind: "dk_cvr", invoiceDate: "2026-01-02", currency: "DKK", netAmount: 100, vatAmount: 25, grossAmount: 125 };
  return Object.entries({ ...base, ...overrides }).map(([key, value]) => cited(key, value));
}
function db() { const x = new Database(":memory:"); migrate(x); x.exec("INSERT INTO companies(id,name,country,currency,cvr) VALUES(1,'Synthetic buyer','DK','DKK','DK87654321'); INSERT INTO companies(id,name) VALUES(2,'Other'); INSERT INTO documents(id,source,sha256_hash) VALUES(1,'test','invoice-one'),(2,'test','invoice-two'),(3,'test','invoice-three')"); return x; }
const fixedClock = { now: () => new Date("2026-01-03T00:00:00.000Z") };

describe("invoice extraction evidence", () => {
  test("stores cited synthetic DK evidence immutably and recognizes suppliers only within its company", async () => {
    const x = db(); const result = await extractInvoice(x, { documentId: 1, companyId: 1, pdfBytes: Buffer.from("%PDF-dk"), extractor: new ScriptedInvoiceExtractor({ fields: fields() }), clock: fixedClock, selectedBuyer: { name: "Synthetic buyer", country: "DK", legalId: "DK87654321" } });
    expect(result.status).toBe("completed"); expect(result.autoPostingBlocked).toBe(false);
    expect(() => x.run("UPDATE invoice_extraction_fields SET source_text='changed' WHERE id=1")).toThrow("immutable");
    expect(recognizeSupplier(x, { companyId: 1, identifierKind: "dk_cvr", identifier: "DK12345678", supplierName: "Synthetic supplier", clock: fixedClock }).duplicate).toBe(false);
    expect(recognizeSupplier(x, { companyId: 2, identifierKind: "dk_cvr", identifier: "DK12345678", supplierName: "Synthetic supplier", clock: fixedClock }).duplicate).toBe(false); x.close();
  });
  test("supports EU and non-EU typed supplier evidence without inventing identities", async () => {
    for (const [country, id, kind] of [["DE", "DE123456789", "eu_vat"], ["US", "US-77", "non_eu"]] as const) { const x = db(); const result = await extractInvoice(x, { documentId: 1, companyId: 1, pdfBytes: Buffer.from(`%PDF-${country}`), extractor: new ScriptedInvoiceExtractor({ fields: fields({ supplierCountry: country, supplierLegalId: id, supplierLegalIdKind: kind, vatAmount: 0, grossAmount: 100, reverseChargeWording: "Reverse charge" }) }), clock: fixedClock }); expect(result.status).toBe("completed"); x.close(); }
  });
  test("missing citations, conflicts, and provider failures create resumable blocking evidence", async () => {
    const x = db(); const missing = await extractInvoice(x, { documentId: 1, companyId: 1, pdfBytes: Buffer.from("%PDF-missing"), extractor: new ScriptedInvoiceExtractor({ fields: fields({ buyerLegalId: "" }).filter(f => f.key !== "supplierName") }), clock: fixedClock }); expect(missing.status).toBe("needs_resolution"); expect(missing.autoPostingBlocked).toBe(true);
    const conflict = await extractInvoice(x, { documentId: 2, companyId: 1, pdfBytes: Buffer.from("%PDF-conflict"), extractor: new ScriptedInvoiceExtractor({ fields: fields({ grossAmount: 126 }) }), clock: fixedClock, suppliedMetadata: { grossAmount: 125 } }); expect(conflict.status).toBe("needs_resolution");
    const failed = await extractInvoice(x, { documentId: 3, companyId: 1, pdfBytes: Buffer.from("%PDF-failed"), extractor: new ScriptedInvoiceExtractor(new Error("offline"), "broken", "1"), clock: fixedClock }); expect(failed.status).toBe("needs_resolution"); expect(x.query("SELECT count(*) AS n FROM exceptions WHERE type='INVOICE_EXTRACTION'").get()).toEqual({ n: 3 }); x.close();
  });
  test("duplicate PDF bytes resume the same extractor identity without a second provider call", async () => {
    const x = db(); const extractor = new ScriptedInvoiceExtractor({ fields: fields() }); const first = await extractInvoice(x, { documentId: 1, companyId: 1, pdfBytes: Buffer.from("%PDF-duplicate"), extractor, clock: fixedClock }); const second = await extractInvoice(x, { documentId: 2, companyId: 1, pdfBytes: Buffer.from("%PDF-duplicate"), extractor, clock: fixedClock }); expect(first.attemptId).toBe(second.attemptId); expect(second.duplicate).toBe(true); expect(extractor.calls).toBe(1); x.close();
  });
  test("records bounded provider failures, actor attribution, and permits a successful retry", async () => {
    const x = db(); const bytes = Buffer.from("%PDF-retry");
    const failed = await extractInvoice(x, { documentId: 1, companyId: 1, pdfBytes: bytes, extractor: new ScriptedInvoiceExtractor(new Error("https://private.example/token=secret"), "retry", "1"), actor: "user:reviewer", clock: fixedClock });
    expect(failed.errors).toEqual(["EXTRACTION_PROVIDER_UNAVAILABLE"]);
    expect(JSON.stringify(x.query("SELECT resolution_json FROM invoice_extraction_resolutions").all())).not.toContain("secret");
    const retried = await extractInvoice(x, { documentId: 1, companyId: 1, pdfBytes: bytes, extractor: new ScriptedInvoiceExtractor({ fields: fields() }, "retry", "1"), actor: "user:reviewer", clock: fixedClock });
    expect(retried.status).toBe("completed");
    expect(x.query("SELECT count(*) AS n FROM invoice_extraction_attempts").get()).toEqual({ n: 2 });
    expect(x.query("SELECT actor FROM audit_log WHERE event_type='invoice_extraction_attempt' ORDER BY id LIMIT 1").get()).toEqual({ actor: "user:reviewer" });
    expect(x.query("SELECT initiated_by FROM invoice_extraction_attempts WHERE id=?").get(retried.attemptId)).toEqual({ initiated_by: "user:reviewer" });
    expect(x.query("SELECT initiated_by FROM invoice_extraction_results WHERE attempt_id=?").get(retried.attemptId)).toEqual({ initiated_by: "user:reviewer" });
    x.close();
  });
});
