import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { extractInvoice, ScriptedInvoiceExtractor } from "../../src/core/invoice-extraction";
import { invoiceExtractionSurface } from "../../src/server/invoice-extraction-surface";

const cited = (key: any, value: unknown) => ({ key, value, confidence: .99, page: 1, sourceText: `${key}:${value}` });
function fields(country = "DK", kind = "dk_cvr", id = "DK12345678") { return ["invoiceNumber", "supplierName", "buyerName", "invoiceDate", "currency", "netAmount", "vatAmount", "grossAmount"].map((key) => cited(key, ({ invoiceNumber: "X", supplierName: "S", buyerName: "B", invoiceDate: "2026-01-01", currency: "DKK", netAmount: 100, vatAmount: 25, grossAmount: 125 } as any)[key])).concat([cited("supplierCountry", country), cited("supplierLegalIdKind", kind), cited("supplierLegalId", id)]); }
function db() { const x = new Database(":memory:"); migrate(x); x.exec("INSERT INTO companies(id,name,country,cvr) VALUES(1,'B','DK','DK87654321'); INSERT INTO documents(id,source,sha256_hash) VALUES(1,'test','one'),(2,'test','two'),(3,'test','three'),(4,'test','four')"); return x; }
describe("invoice extraction surface parity", () => {
  test("publishes DK, EU, non-EU, missing/conflict and duplicate evidence without paths", async () => {
    const x = db();
    for (const [id, country, kind, legal] of [[1,"DK","dk_cvr","DK12345678"],[2,"DE","eu_vat","DE123456789"],[3,"US","non_eu","US-1"]] as const) await extractInvoice(x, { documentId: id, companyId: 1, pdfBytes: Buffer.from(`%PDF-${id}`), extractor: new ScriptedInvoiceExtractor({ fields: fields(country, kind, legal) }) });
    const conflict = await extractInvoice(x, { documentId: 4, companyId: 1, pdfBytes: Buffer.from("%PDF-conflict"), extractor: new ScriptedInvoiceExtractor({ fields: fields() }), suppliedMetadata: { grossAmount: 126 } });
    const visible = [1,2,3,4].map((id) => invoiceExtractionSurface(x, id));
    expect(visible.every((v) => v && "originalHash" in v && !JSON.stringify(v).includes("stored_path"))).toBe(true);
    expect(visible[3]!.status).toBe("needs_resolution");
    expect(conflict.duplicate).toBe(false); x.close();
  });
});
