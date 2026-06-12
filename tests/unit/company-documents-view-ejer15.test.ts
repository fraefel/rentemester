// Tests: src/server/data/company-views/documents.ts (EJER-15)
//
// The company's OWN issued-invoice PDF artifact (document_type
// 'issued_invoice_pdf') must NOT appear in the bilag list nor inflate the
// "ubehandlet" (unlinked) counter — it is an internal output, not an inbound
// voucher the owner must process.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { issueInvoice } from "../../src/core/issued-invoices";
import { renderIssuedInvoicePdf } from "../../src/core/invoice-pdf";
import { buildCompanyDocuments } from "../../src/server/data/company-views/documents";
import { registerWorkspaceCompany } from "../../src/core/workspace";

function invoicePayload() {
  return {
    invoiceType: "full" as const,
    vatTreatment: "standard" as const,
    issueDate: "2026-05-16",
    invoiceNumber: "2026-0001",
    seller: { name: "Rentemester ApS", address: "Testvej 1, 2100 København Ø", vatOrCvr: "DK12345678" },
    buyer: { name: "Kunde A/S", address: "Købervej 9, 8000 Aarhus C", vatOrCvr: "DK87654321" },
    lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
    totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
    currency: "DKK",
    dueDate: "2026-06-15",
  };
}

describe("company documents view — issued_invoice_pdf is hidden (EJER-15)", () => {
  test("the invoice's own PDF artifact is excluded from the bilag list and counter", () => {
    const ws = mkdtempSync(join(tmpdir(), "rentemester-ejer15-ws-"));
    try {
      const root = join(ws, "acme-aps");
      const paths = ensureCompanyDirs(root);
      registerWorkspaceCompany(ws, {
        slug: "acme-aps",
        name: "Acme ApS",
        createdAt: new Date().toISOString(),
        archived: false,
      });
      const db = openDb(paths.db);
      migrate(db);
      seedAccounts(db);

      const issued = issueInvoice(db, root, invoicePayload());
      expect(issued.ok).toBe(true);
      // Render the PDF artifact — this writes the issued_invoice_pdf documents row.
      const pdf = renderIssuedInvoicePdf(db, root, { invoiceDocumentId: issued.documentId! });
      expect(pdf.ok).toBe(true);

      // Sanity: an issued_invoice_pdf row really does exist in the table.
      const pdfRows = db
        .query("SELECT COUNT(*) AS n FROM documents WHERE document_type = 'issued_invoice_pdf'")
        .get() as { n: number };
      expect(pdfRows.n).toBeGreaterThan(0);
      db.close();

      const view = buildCompanyDocuments(ws, "acme-aps");
      // No row in the bilag list may be the internal PDF artifact.
      expect(view.documents.every((d) => d.documentType !== "issued_invoice_pdf")).toBe(true);
      // And it must not be counted as an unlinked/ubehandlet bilag.
      expect(view.documents.length).toBe(view.linkedCount + view.unlinkedCount);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
