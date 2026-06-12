// Tests: src/mcp/tools/invoice/_shared.ts — payload-opløsning af invoiceNumber (AGENT-8)
//
// Audit-fund AGENT-8: `invoice_settle_bank` (og søster-payload-tools med
// "Provide invoiceDocumentId OR invoiceNumber") returnerede ved UKENDT
// invoiceNumber den vildledende kernefejl "invoiceDocumentId must be a
// positive integer" — et felt agenten aldrig sendte. Nummer-opløsningen skal
// fejle FØRST med en klar fejl i stil med CLI'ens: "No issued invoice has
// invoice number '…' — check the value with 'invoice_list' or 'invoice_find'".
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { resolveInvoiceSelectorInPayload } from "../../src/mcp/tools/invoice/_shared";

let root: string;
let db: ReturnType<typeof openDb>;
let issuedDocumentId: number;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rentemester-mcp-resolution-"));
  db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  const issued = issueInvoice(db, root, {
    invoiceType: "full",
    vatTreatment: "standard",
    issueDate: "2026-05-16",
    invoiceNumber: "2026-0001",
    seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    buyer: { name: "Kunde A/S", address: "Købervej 9" },
    lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
    totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
    currency: "DKK",
  });
  expect(issued.ok).toBe(true);
  issuedDocumentId = Number(issued.documentId);
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("AGENT-8 — payload invoiceNumber resolution fails first with a clear error", () => {
  test("unknown invoiceNumber returns a clear error naming the number, not invoiceDocumentId", () => {
    const result = resolveInvoiceSelectorInPayload(
      db,
      { invoiceNumber: "9999-9999", amount: 100 },
      "invoiceDocumentId",
      "invoiceNumber",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.errors[0]).toBe(
      "No issued invoice has invoice number '9999-9999' — check the value with 'invoice_list' or 'invoice_find'",
    );
    // Den gamle vildledende fejl må ikke optræde.
    expect(result.envelope.errors.join(" ")).not.toContain("must be a positive integer");
  });

  test("known invoiceNumber resolves to the document id", () => {
    const result = resolveInvoiceSelectorInPayload(
      db,
      { invoiceNumber: "2026-0001" },
      "invoiceDocumentId",
      "invoiceNumber",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.payload.invoiceDocumentId).toBe(issuedDocumentId);
  });

  test("an explicit invoiceDocumentId passes through untouched (number ignored)", () => {
    const result = resolveInvoiceSelectorInPayload(
      db,
      { invoiceDocumentId: issuedDocumentId, invoiceNumber: "9999-9999" },
      "invoiceDocumentId",
      "invoiceNumber",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.payload.invoiceDocumentId).toBe(issuedDocumentId);
  });

  test("neither id nor number passes through so the core's own validation applies", () => {
    const result = resolveInvoiceSelectorInPayload(
      db,
      { amount: 100 },
      "invoiceDocumentId",
      "invoiceNumber",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.payload.invoiceDocumentId).toBeUndefined();
  });

  test("credit-note selector keys (originalInvoiceNumber) get the same clear error", () => {
    const result = resolveInvoiceSelectorInPayload(
      db,
      { originalInvoiceNumber: "9999-9999", issueDate: "2026-05-17", reason: "x" },
      "originalInvoiceDocumentId",
      "originalInvoiceNumber",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.envelope.errors[0]).toBe(
      "No issued invoice has invoice number '9999-9999' — check the value with 'invoice_list' or 'invoice_find'",
    );
  });

  test("a blank invoiceNumber passes through (treated as absent)", () => {
    const result = resolveInvoiceSelectorInPayload(
      db,
      { invoiceNumber: "   " },
      "invoiceDocumentId",
      "invoiceNumber",
    );
    expect(result.ok).toBe(true);
  });
});
