import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { ingestDocument, validateDocumentMetadata } from "../../src/core/documents";
import { registerPayable } from "../../src/core/payables";

const metadata = {
  source: "email", issueDate: "2026-07-18", invoiceNo: "MIX-1", deliveryDescription: "Blandet køb", amountIncVat: 1888.75, currency: "DKK",
  sender: { name: "Leverandør ApS", address: "Vej 1", vatOrCvr: "DK11223344" }, recipient: { name: "Rentemester ApS", address: "Vej 2", vatOrCvr: "DK12345678" }, vatAmount: 243.75,
  purchaseVatLines: [{ classification: "dk_purchase_25" as const, netAmount: 975, vatAmount: 243.75 }, { classification: "exempt" as const, netAmount: 670, vatAmount: 0 }],
};

describe("#530 mixed purchase VAT lines", () => {
  test("accepts, persists and books the exact taxable and exempt bases", () => {
    expect(validateDocumentMetadata(metadata).ok).toBe(true); // formerly rejected as 411.25 uniform VAT
    const root = mkdtempSync(join(tmpdir(), "rentemester-mixed-vat-"));
    const db = openDb(ensureCompanyDirs(root).db); migrate(db); db.run("INSERT INTO companies (name, vat_period_type) VALUES ('Rentemester ApS', 'quarter')"); seedAccounts(db);
    const file = join(root, "voucher.txt"); writeFileSync(file, "mixed purchase");
    const ingested = ingestDocument(db, root, file, metadata); expect(ingested.ok).toBe(true);
    expect(JSON.parse((db.query("SELECT payload_json FROM documents WHERE id = ?").get(ingested.documentId!) as any).payload_json).purchaseVatLines).toEqual(metadata.purchaseVatLines);
    const payable = registerPayable(db, { documentId: ingested.documentId!, billDate: "2026-07-18", dueDate: "2026-08-18", expenseAccountNo: "3000" });
    if (!payable.ok) throw new Error(payable.errors.join("; "));
    expect(db.query("SELECT jl.debit_amount, jl.credit_amount, jl.vat_code FROM journal_lines jl WHERE jl.journal_entry_id = ? ORDER BY jl.id").all(payable.entryId!)).toEqual([
      { debit_amount: 975, credit_amount: 0, vat_code: "DK_PURCHASE_25" }, { debit_amount: 670, credit_amount: 0, vat_code: "DK_PURCHASE_EXEMPT" }, { debit_amount: 243.75, credit_amount: 0, vat_code: null }, { debit_amount: 0, credit_amount: 1888.75, vat_code: null },
    ]);
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  test("rejects unreconciled mixed splits", () => {
    expect(validateDocumentMetadata({ ...metadata, purchaseVatLines: [{ classification: "dk_purchase_25", netAmount: 975, vatAmount: 243.75 }] }).errors).toContain("purchaseVatLines net + VAT 1218.75 must equal amountIncVat 1888.75");
  });
});
