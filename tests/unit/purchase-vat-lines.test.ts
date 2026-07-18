import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { ingestDocument, validateDocumentMetadata } from "../../src/core/documents";
import { registerPayable } from "../../src/core/payables";
import { confirmAccountRole } from "../../src/core/account-roles";
import { importBankCsv } from "../../src/core/bank";
import { bookExpenseFromBank } from "../../src/core/expense-booking";
import { exportAuthorityPackage } from "../../src/core/authority-export";
import { exportSaftPackage } from "../../src/core/saft-export";
import { buildVatReport, postEuServiceReverseChargePurchase } from "../../src/core/vat";

const metadata = {
  source: "email", issueDate: "2026-07-18", invoiceNo: "MIX-1", deliveryDescription: "Blandet køb", amountIncVat: 1888.75, currency: "DKK",
  sender: { name: "Leverandør ApS", address: "Vej 1", vatOrCvr: "DK11223344" }, recipient: { name: "Rentemester ApS", address: "Vej 2", vatOrCvr: "DK12345678" }, vatAmount: 243.75,
  purchaseVatLines: [{ classification: "dk_purchase_25" as const, netAmount: 975, vatAmount: 243.75 }, { classification: "exempt" as const, netAmount: 670, vatAmount: 0 }],
};

describe("#530 mixed purchase VAT lines", () => {
  test("accepts, persists and books the exact taxable and exempt bases", () => {
    expect(validateDocumentMetadata(metadata).ok).toBe(true); // formerly rejected as 411.25 uniform VAT
    const root = mkdtempSync(join(tmpdir(), "rentemester-mixed-vat-"));
    const db = openDb(ensureCompanyDirs(root).db); migrate(db); db.run("INSERT INTO companies (name, vat_period_type, cvr, country, currency) VALUES ('Rentemester ApS', 'quarter', 'DK12345678', 'DK', 'DKK')"); seedAccounts(db);
    db.run("INSERT INTO accounts (account_no, name, type, normal_balance) VALUES ('9930', 'Imported creditors', 'liability', 'credit'), ('9950', 'Imported input VAT', 'vat', 'debit')");
    expect(confirmAccountRole(db, "creditors", "9930", "user:reviewer").ok).toBe(true);
    expect(confirmAccountRole(db, "input_vat", "9950", "user:reviewer").ok).toBe(true);
    const file = join(root, "voucher.txt"); writeFileSync(file, "mixed purchase");
    const ingested = ingestDocument(db, root, file, metadata); expect(ingested.ok).toBe(true);
    expect(JSON.parse((db.query("SELECT payload_json FROM documents WHERE id = ?").get(ingested.documentId!) as any).payload_json).purchaseVatLines).toEqual(metadata.purchaseVatLines);
    const payable = registerPayable(db, { documentId: ingested.documentId!, billDate: "2026-07-18", dueDate: "2026-08-18", expenseAccountNo: "3000" });
    if (!payable.ok) throw new Error(payable.errors.join("; "));
    expect(db.query("SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.journal_entry_id = ? ORDER BY jl.id").all(payable.entryId!)).toEqual([
      { account_no: "3000", debit_amount: 975, credit_amount: 0, vat_code: "DK_PURCHASE_25" }, { account_no: "3000", debit_amount: 670, credit_amount: 0, vat_code: "DK_PURCHASE_EXEMPT" }, { account_no: "9950", debit_amount: 243.75, credit_amount: 0, vat_code: null }, { account_no: "9930", debit_amount: 0, credit_amount: 1888.75, vat_code: null },
    ]);
    const authority = exportAuthorityPackage(db, root, {
      periodStart: "2026-07-01", periodEnd: "2026-07-31", outputDir: join(root, "authority"), generatedAt: "2026-07-31T23:59:59.000Z",
    });
    expect(authority.ok).toBe(true);
    const authorityDocuments = JSON.parse(readFileSync(join(authority.exportDir!, "machine-readable", "documents.json"), "utf8"));
    expect(authorityDocuments.find((row: any) => row.id === ingested.documentId)?.purchaseVatLines).toEqual(metadata.purchaseVatLines);
    const saft = exportSaftPackage(db, root, {
      periodStart: "2026-07-01", periodEnd: "2026-07-31", outputDir: join(root, "saft"), generatedAt: "2026-07-31T23:59:59.000Z",
    });
    expect(saft.ok).toBe(true);
    const xml = readFileSync(saft.saftXmlPath!, "utf8");
    expect(xml).toContain("<TaxClassification>dk_purchase_25</TaxClassification>");
    expect(xml).toContain("<TaxBase>975.00</TaxBase>");
    expect(xml).toContain("<TaxClassification>exempt</TaxClassification>");
    expect(xml).toContain("<TaxBase>670.00</TaxBase>");
    db.close(); rmSync(root, { recursive: true, force: true });
  });
  test("rejects unreconciled mixed splits", () => {
    expect(validateDocumentMetadata({ ...metadata, purchaseVatLines: [{ classification: "dk_purchase_25", netAmount: 975, vatAmount: 243.75 }] }).errors).toContain("purchaseVatLines net + VAT 1218.75 must equal amountIncVat 1888.75");
  });

  test("validates split totals even for a statutory-field-exempt receipt", () => {
    const result = validateDocumentMetadata({
      source: "photo-upload",
      documentType: "cash_register_receipt",
      purchaseVatLines: [{ classification: "exempt", netAmount: 100, vatAmount: 0 }],
    });
    expect(result.errors).toContain("purchaseVatLines requires amountIncVat");
    expect(result.errors).toContain("purchaseVatLines requires vatAmount");
  });

  test("keeps the first split model domestic and refuses treatments that would ignore it", () => {
    expect(validateDocumentMetadata({
      ...metadata,
      amountIncVat: 100,
      vatAmount: 0,
      purchaseVatLines: [{ classification: "eu_service_reverse_charge" as any, netAmount: 100, vatAmount: 0 }],
    }).errors.join(" ")).toContain("classification must be dk_purchase_25 or exempt");

    const root = mkdtempSync(join(tmpdir(), "rentemester-mixed-vat-treatment-gate-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    const voucher = join(root, "voucher.txt");
    writeFileSync(voucher, "structured exempt purchase");
    const doc = ingestDocument(db, root, voucher, {
      ...metadata,
      invoiceNo: "MIX-TREATMENT-GATE",
      amountIncVat: 150,
      vatAmount: 0,
      purchaseVatLines: [{ classification: "exempt", netAmount: 150, vatAmount: 0 }],
    });
    expect(doc.ok).toBe(true);
    const csv = join(root, "bank.csv");
    writeFileSync(csv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-07-18,2026-07-18,STRUCTURED PURCHASE,-150,DKK,MIX-TREATMENT-GATE",
    ].join("\n"));
    expect(importBankCsv(db, root, csv).ok).toBe(true);
    const bank = db.query("SELECT id FROM bank_transactions WHERE reference = 'MIX-TREATMENT-GATE'").get() as { id: number };
    for (const vatTreatment of ["reverse_charge", "representation"] as const) {
      const booked = bookExpenseFromBank(db, { documentId: doc.documentId!, bankTransactionId: bank.id, expenseAccountNo: "3000", vatTreatment });
      expect(booked.ok).toBe(false);
      expect(booked.errors.join(" ")).toContain("does not support structured purchaseVatLines");
    }
    const directReverseCharge = postEuServiceReverseChargePurchase(db, {
      transactionDate: "2026-07-18",
      text: "Structured reverse-charge attempt",
      documentId: doc.documentId!,
      netAmount: 150,
      expenseAccountNo: "3000",
    });
    expect(directReverseCharge.ok).toBe(false);
    expect(directReverseCharge.errors.join(" ")).toContain("does not support structured purchaseVatLines");
    expect(db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: 0 });
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("fails closed when a persisted split is corrupt instead of falling back to uniform VAT", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-mixed-vat-corrupt-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    db.run("INSERT INTO companies (name, vat_period_type, cvr, country, currency) VALUES ('Rentemester ApS', 'quarter', 'DK12345678', 'DK', 'DKK')");
    seedAccounts(db);
    const voucher = join(root, "voucher.txt");
    writeFileSync(voucher, "mixed purchase corrupt regression");
    const ingested = ingestDocument(db, root, voucher, metadata);
    expect(ingested.ok).toBe(true);
    const bankCsv = join(root, "bank.csv");
    writeFileSync(bankCsv, [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-07-18,2026-07-18,MIXED PURCHASE,-1888.75,DKK,MIX-CANONICAL-1",
    ].join("\n"));
    expect(importBankCsv(db, root, bankCsv).ok).toBe(true);
    db.run(
      "UPDATE documents SET payload_json = ? WHERE id = ?",
      JSON.stringify({
        ...metadata,
        amountIncVat: 1895,
        vatAmount: 250,
        purchaseVatLines: [
          { classification: "dk_purchase_25", netAmount: 1000, vatAmount: 250 },
          { classification: "exempt", netAmount: 645, vatAmount: 0 },
        ],
      }),
      ingested.documentId!,
    );
    const bank = db.query("SELECT id FROM bank_transactions WHERE reference = 'MIX-CANONICAL-1'").get() as { id: number };
    const booked = bookExpenseFromBank(db, { documentId: ingested.documentId!, bankTransactionId: bank.id, expenseAccountNo: "3000", vatTreatment: "standard" });
    expect(booked.ok).toBe(false);
    expect(booked.errors.join(" ")).toContain("canonical documents.amount_inc_vat");
    const payable = registerPayable(db, { documentId: ingested.documentId!, billDate: "2026-07-18", dueDate: "2026-08-18", expenseAccountNo: "3000" });
    expect(payable.ok).toBe(false);
    expect(payable.errors.join(" ")).toContain("invalid persisted purchaseVatLines");
    const authority = exportAuthorityPackage(db, root, { periodStart: "2026-07-01", periodEnd: "2026-07-31", outputDir: join(root, "authority"), generatedAt: "2026-07-31T23:59:59.000Z" });
    expect(authority.ok).toBe(false);
    expect(authority.errors.join(" ")).toContain("invalid persisted purchaseVatLines");
    const saft = exportSaftPackage(db, root, { periodStart: "2026-07-01", periodEnd: "2026-07-31", outputDir: join(root, "saft"), generatedAt: "2026-07-31T23:59:59.000Z" });
    expect(saft.ok).toBe(false);
    expect(saft.errors.join(" ")).toContain("invalid persisted purchaseVatLines");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("allocates positive and negative one-øre FX residuals without unbalancing", () => {
    for (const scenario of [
      { rate: 3.333333, expectedTaxable: 333.33, expectedExempt: 333.34 },
      { rate: 3.33335, expectedTaxable: 333.34, expectedExempt: 333.33 },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "rentemester-mixed-vat-fx-"));
      const db = openDb(ensureCompanyDirs(root).db);
      migrate(db);
      db.run("INSERT INTO companies (name, vat_period_type) VALUES ('Rentemester ApS', 'quarter')");
      seedAccounts(db);
      const csv = join(root, "bank.csv");
      writeFileSync(csv, [
        "transaction_date,booking_date,text,amount,currency,fx_rate_to_dkk,reference",
        `2026-07-18,2026-07-18,MIXED EUR,-750,DKK,${scenario.rate},FX-${scenario.rate}`,
      ].join("\n"));
      expect(importBankCsv(db, root, csv).ok).toBe(true);
      const voucher = join(root, "voucher.txt");
      writeFileSync(voucher, `mixed purchase ${scenario.rate}`);
      const doc = ingestDocument(db, root, voucher, {
        ...metadata,
        invoiceNo: `MIX-FX-${scenario.rate}`,
        amountIncVat: 225,
        vatAmount: 25,
        currency: "EUR",
        purchaseVatLines: [
          { classification: "dk_purchase_25", netAmount: 100, vatAmount: 25 },
          { classification: "exempt", netAmount: 100, vatAmount: 0 },
        ],
      });
      expect(doc.ok).toBe(true);
      const bank = db.query("SELECT id FROM bank_transactions WHERE reference = ?").get(`FX-${scenario.rate}`) as { id: number };
      const booked = bookExpenseFromBank(db, { documentId: doc.documentId!, bankTransactionId: bank.id, expenseAccountNo: "3000", vatTreatment: "standard" });
      if (!booked.ok) throw new Error(booked.errors.join("; "));
      const lines = db.query("SELECT debit_amount, credit_amount, vat_code FROM journal_lines WHERE journal_entry_id = ? ORDER BY id").all(booked.entryId!) as any[];
      expect(lines[0]).toMatchObject({ debit_amount: scenario.expectedTaxable, vat_code: "DK_PURCHASE_25" });
      expect(lines[1]).toMatchObject({ debit_amount: scenario.expectedExempt, vat_code: "DK_PURCHASE_EXEMPT" });
      const debit = lines.reduce((sum, line) => sum + Number(line.debit_amount), 0);
      const credit = lines.reduce((sum, line) => sum + Number(line.credit_amount), 0);
      expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
      expect(credit).toBe(750);
      expect(buildVatReport(db, "2026-07-01", "2026-07-31").warnings.some((warning) => warning.includes("input VAT mismatch"))).toBe(false);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
