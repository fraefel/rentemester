import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importBankCsv } from "../../src/core/bank";
import { migrate, openDb } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { bookExpenseFromBank } from "../../src/core/expense-booking";
import { seedAccounts } from "../../src/core/ledger";
import { ensureCompanyDirs } from "../../src/core/paths";
import { buildVatReport } from "../../src/core/vat";

describe("internal vouchers backed by imported bank evidence (#554)", () => {
  test("books a 417 DKK bank fee without VAT and preserves immutable evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-internal-voucher-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-internal-voucher-inbox-"));
    try {
      const csv = join(root, "bank.csv");
      const evidenceFile = join(inbox, "prepared-bank-fee.txt");
      writeFileSync(csv, [
        "transaction_date,booking_date,text,amount,currency,reference",
        "2026-07-31,2026-07-31,BANKGEBYR,-417,DKK,REF-FEE-417",
      ].join("\n"));
      writeFileSync(evidenceFile, "Internt bilag: bankgebyr 417,00 DKK\nIngen moms.\n");

      const db = openDb(ensureCompanyDirs(root).db);
      migrate(db);
      seedAccounts(db);
      expect(importBankCsv(db, root, csv)).toMatchObject({ ok: true, imported: 1 });
      const bank = db.query(
        "SELECT id FROM bank_transactions WHERE reference = 'REF-FEE-417'",
      ).get() as { id: number };

      const ingested = ingestDocument(db, root, evidenceFile, {
        source: "internal-preparation",
        documentType: "internal_voucher",
        issueDate: "2026-07-31",
        deliveryDescription: "Bankgebyr",
        amountIncVat: 417,
        vatAmount: 0,
        currency: "DKK",
        sourceBankTransactionId: bank.id,
        accountingRationale: "Bankgebyr ifølge importeret kontoudtog; ingen moms.",
      }, {
        createdBy: "agent:test",
        createdByProgram: "bun:test",
      });
      expect(ingested.ok).toBe(true);
      expect(typeof ingested.documentId).toBe("number");
      expect(ingested.documentId!).toBeGreaterThan(0);
      expect(ingested.sha256).toMatch(/^[a-f0-9]{64}$/);

      const evidence = db.query(
        `SELECT document_id, bank_transaction_id, accounting_rationale, prepared_by,
                prepared_by_program
           FROM internal_voucher_evidence
          WHERE bank_transaction_id = ?`,
      ).get(bank.id) as Record<string, unknown>;
      expect(evidence).toEqual({
        document_id: ingested.documentId,
        bank_transaction_id: bank.id,
        accounting_rationale: "Bankgebyr ifølge importeret kontoudtog; ingen moms.",
        prepared_by: "agent:test",
        prepared_by_program: "bun:test",
      });
      expect(db.query(
        "SELECT actor FROM audit_log WHERE event_type = 'document_ingest'",
      ).get()).toEqual({ actor: "agent:test via bun:test" });

      const wrongVat = bookExpenseFromBank(db, {
        documentId: ingested.documentId!,
        bankTransactionId: bank.id,
        expenseAccountNo: "3300",
        vatTreatment: "standard",
      });
      expect(wrongVat.ok).toBe(false);
      expect(wrongVat.errors.join(" ")).toContain("requires explicit vatTreatment exempt");

      const booked = bookExpenseFromBank(db, {
        documentId: ingested.documentId!,
        bankTransactionId: bank.id,
        expenseAccountNo: "3300",
        vatTreatment: "exempt",
        createdBy: "agent:test",
        createdByProgram: "bun:test",
      });
      expect(booked).toMatchObject({
        ok: true,
        grossAmount: 417,
        netAmount: 417,
        vatAmount: 0,
        vatTreatment: "exempt",
      });
      const lines = db.query(
        `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
           FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id
          WHERE jl.journal_entry_id = ?
          ORDER BY jl.id`,
      ).all(booked.entryId!);
      expect(lines).toEqual([
        { account_no: "3300", debit_amount: 417, credit_amount: 0, vat_code: null },
        { account_no: "2000", debit_amount: 0, credit_amount: 417, vat_code: null },
      ]);
      expect(buildVatReport(db, "2026-07-01", "2026-09-30")).toMatchObject({
        ok: true,
        inputVat: 0,
        outputVat: 0,
      });

      expect(() => db.run(
        "UPDATE internal_voucher_evidence SET accounting_rationale = 'changed' WHERE document_id = ?",
        ingested.documentId!,
      )).toThrow("append-only");
      expect(() => db.run(
        "DELETE FROM internal_voucher_evidence WHERE document_id = ?",
        ingested.documentId!,
      )).toThrow("append-only");
      expect(() => db.run(
        "UPDATE documents SET delivery_description = 'changed' WHERE id = ?",
        ingested.documentId!,
      )).toThrow("append-only");
      expect(() => db.run(
        "DELETE FROM documents WHERE id = ?",
        ingested.documentId!,
      )).toThrow("append-only");
      expect(() => db.run(
        "UPDATE bank_transactions SET amount = -418 WHERE id = ?",
        bank.id,
      )).toThrow("append-only");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inbox, { recursive: true, force: true });
    }
  });

  test("fails closed when bank evidence is missing, inconsistent, reused, or incoming", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-internal-voucher-reject-"));
    const inbox = mkdtempSync(join(tmpdir(), "rentemester-internal-voucher-reject-inbox-"));
    try {
      const db = openDb(ensureCompanyDirs(root).db);
      migrate(db);
      seedAccounts(db);
      db.query(
        `INSERT INTO bank_transactions
           (id, transaction_date, booking_date, text, amount, currency,
            reference, import_batch_id, source_file_hash, transaction_hash)
         VALUES
           (1, '2026-07-31', '2026-07-31', 'FEE', -417, 'DKK', 'OUT', 'batch', 'source', 'tx-out'),
           (2, '2026-07-31', '2026-07-31', 'REFUND', 417, 'DKK', 'IN', 'batch', 'source', 'tx-in')`,
      ).run();

      const ingest = (name: string, overrides: Record<string, unknown> = {}) => {
        const file = join(inbox, `${name}.txt`);
        writeFileSync(file, `synthetic ${name}`);
        return ingestDocument(db, root, file, {
          source: "internal-preparation",
          documentType: "internal_voucher",
          issueDate: "2026-07-31",
          deliveryDescription: "Bankgebyr",
          amountIncVat: 417,
          vatAmount: 0,
          currency: "DKK",
          sourceBankTransactionId: 1,
          accountingRationale: "Synthetic evidence",
          ...overrides,
        });
      };

      expect(ingest("missing-bank", { sourceBankTransactionId: 999 }).errors?.join(" "))
        .toContain("does not exist");
      expect(ingest("wrong-amount", { amountIncVat: 418 }).errors?.join(" "))
        .toContain("does not match bank transaction amount");
      expect(ingest("wrong-date", { issueDate: "2026-07-30" }).errors?.join(" "))
        .toContain("does not match bank transaction date");
      expect(ingest("incoming", { sourceBankTransactionId: 2 }).errors?.join(" "))
        .toContain("not an outgoing payment");
      expect(ingest("missing-rationale", { accountingRationale: "" }).errors?.join(" "))
        .toContain("accountingRationale is required");
      expect(ingest("vat", { vatAmount: 1 }).errors?.join(" "))
        .toContain("vatAmount must be exactly 0");

      const accepted = ingest("accepted");
      expect(accepted.ok).toBe(true);
      expect(ingest("reused").errors?.join(" ")).toContain("already backs internal voucher");
      expect(db.query("SELECT COUNT(*) AS count FROM documents").get()).toEqual({ count: 1 });
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(inbox, { recursive: true, force: true });
    }
  });
});
