import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/core/db";
import { setDocumentCompanyContext } from "../../src/core/document-company-context";
import { ingestDocument, validateDocumentMetadata, type DocumentMetadata } from "../../src/core/documents";
import { bookExpenseFromBank } from "../../src/core/expense-booking";
import { seedAccounts } from "../../src/core/ledger";
import { ensureCompanyDirs } from "../../src/core/paths";
import { registerPayable } from "../../src/core/payables";
import { buildVatReport } from "../../src/core/vat";

const mixedSimplifiedMetadata: DocumentMetadata = {
  source: "email",
  documentType: "purchase_sale",
  issueDate: "2026-08-21",
  invoiceNo: "SYN-571-1",
  deliveryDescription: "Synthetic mixed purchase",
  amountIncVat: 225,
  currency: "DKK",
  sender: { name: "Synthetic Supplier ApS", address: "Supplier Street 1", vatOrCvr: "DK11223344" },
  recipient: { name: "Printed Individual", address: "Personal Street 2" },
  vatAmount: 25,
  purchaseVatLines: [
    { classification: "dk_purchase_25", netAmount: 100, vatAmount: 25 },
    { classification: "exempt", netAmount: 100, vatAmount: 0 },
  ],
  danishSimplifiedPurchaseInvoice: true,
};

function setup(label: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-${label}-`));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  db.run(`INSERT INTO companies
    (id, name, country, currency, cvr, address, postal_code, city, vat_period_type)
    VALUES (1, 'Synthetic Buyer ApS', 'DK', 'DKK', 'DK12345678', 'Business Street 3', '1000', 'Testby', 'quarter')`);
  const file = join(root, "simplified-mixed.txt");
  writeFileSync(file, "Synthetic simplified invoice with mixed VAT lines\n");
  const document = ingestDocument(db, root, file, mixedSimplifiedMetadata, {
    createdBy: "agent:test",
    createdByProgram: "test",
  });
  expect(document).toMatchObject({ ok: true });
  return { root, db, documentId: Number(document.documentId) };
}

function close(fixture: ReturnType<typeof setup>) {
  fixture.db.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

function recordContext(fixture: ReturnType<typeof setup>) {
  return setDocumentCompanyContext(fixture.db, {
    documentId: fixture.documentId,
    sourceReference: "approval:SYN-571",
    businessUseReason: "Used exclusively for the synthetic company's activity",
    confirm: true,
    createdBy: "agent:test",
    createdByProgram: "unit-test",
  });
}

describe("mixed VAT lines on Danish simplified purchase invoices (#571)", () => {
  test("accepts a reconciled explicit split but rejects aggregate-only or inconsistent mixed evidence", () => {
    expect(validateDocumentMetadata(mixedSimplifiedMetadata)).toMatchObject({ ok: true });

    const aggregateOnly = { ...mixedSimplifiedMetadata, purchaseVatLines: undefined };
    expect(validateDocumentMetadata(aggregateOnly).errors)
      .toContain("Danish simplified invoice requires VAT consistent with the 25% Danish standard rate");

    expect(validateDocumentMetadata({
      ...mixedSimplifiedMetadata,
      purchaseVatLines: [
        { classification: "dk_purchase_25", netAmount: 100, vatAmount: 25 },
        { classification: "exempt", netAmount: 99, vatAmount: 0 },
      ],
    }).errors).toContain("purchaseVatLines net + VAT 224 must equal amountIncVat 225");

    expect(validateDocumentMetadata({
      ...mixedSimplifiedMetadata,
      vatAmount: 0,
      amountIncVat: 200,
      purchaseVatLines: [{ classification: "exempt", netAmount: 200, vatAmount: 0 }],
    }).errors).toContain("Danish simplified invoice requires an explicitly documented taxable purchaseVatLines amount");
  });

  test("keeps the #570 context gate and books only the documented taxable base from bank", () => {
    const fixture = setup("simplified-mixed-expense");
    try {
      const bankId = Number((fixture.db.query(`INSERT INTO bank_transactions
        (transaction_date, text, amount, currency, transaction_hash, status)
        VALUES ('2026-08-21', 'Synthetic mixed purchase', -225, 'DKK', 'bank-syn-571', 'imported') RETURNING id`).get() as { id: number }).id);
      const input = { documentId: fixture.documentId, bankTransactionId: bankId, expenseAccountNo: "3000", vatTreatment: "standard" as const };
      expect(bookExpenseFromBank(fixture.db, input).errors)
        .toContain("standard purchase VAT requires invoice-stated recipient identity or a valid hash-bound simplified-invoice company context");
      expect(recordContext(fixture)).toMatchObject({ ok: true, applied: true });
      const booked = bookExpenseFromBank(fixture.db, input);
      if (!booked.ok) throw new Error(booked.errors.join("; "));
      expect(fixture.db.query(`SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
        FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = ? ORDER BY jl.id`).all(booked.entryId!)).toEqual([
        { account_no: "3000", debit_amount: 100, credit_amount: 0, vat_code: "DK_PURCHASE_25" },
        { account_no: "3000", debit_amount: 100, credit_amount: 0, vat_code: "DK_PURCHASE_EXEMPT" },
        { account_no: "4000", debit_amount: 25, credit_amount: 0, vat_code: null },
        { account_no: "2000", debit_amount: 0, credit_amount: 225, vat_code: null },
      ]);
      expect(buildVatReport(fixture.db, "2026-08-01", "2026-08-31")).toMatchObject({
        purchaseBase25: 100,
        inputVat: 25,
      });
    } finally {
      close(fixture);
    }
  });

  test("uses the same exact split for the payable path", () => {
    const fixture = setup("simplified-mixed-payable");
    try {
      const input = {
        documentId: fixture.documentId,
        billDate: "2026-08-21",
        dueDate: "2026-09-04",
        expenseAccountNo: "3000",
        vatTreatment: "standard" as const,
      };
      expect(registerPayable(fixture.db, input).errors)
        .toContain("standard purchase VAT requires invoice-stated recipient identity or a valid hash-bound simplified-invoice company context");
      expect(recordContext(fixture)).toMatchObject({ ok: true, applied: true });
      const payable = registerPayable(fixture.db, input);
      if (!payable.ok) throw new Error(payable.errors.join("; "));
      expect(fixture.db.query(`SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
        FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = ? ORDER BY jl.id`).all(payable.entryId!)).toEqual([
        { account_no: "3000", debit_amount: 100, credit_amount: 0, vat_code: "DK_PURCHASE_25" },
        { account_no: "3000", debit_amount: 100, credit_amount: 0, vat_code: "DK_PURCHASE_EXEMPT" },
        { account_no: "4000", debit_amount: 25, credit_amount: 0, vat_code: null },
        { account_no: "7000", debit_amount: 0, credit_amount: 225, vat_code: null },
      ]);
    } finally {
      close(fixture);
    }
  });
});
