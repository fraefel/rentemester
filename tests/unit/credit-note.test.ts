// Tests: src/core/credit-notes.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { issueCreditNote } from "../../src/core/credit-notes";
import { postJournalEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { storeViesValidation } from "../../src/core/vies";

function failingDocumentInsertDb(realDb: any) {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: string) => {
          const statement = target.query(sql);
          if (sql.includes("INSERT INTO documents")) {
            return { get() { throw new Error("simulated insert failure"); } };
          }
          return statement;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
}

describe("credit notes", () => {
  test("mirrors original invoice posting accounts when crediting a custom-booked invoice", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-custom-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    db.run("INSERT OR IGNORE INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES ('1001', 'Abonnementsomsætning', 'income', 'credit', NULL)");
    db.run("INSERT OR IGNORE INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES ('1101', 'Debitorer abonnement', 'asset', 'debit', NULL)");
    db.run("INSERT OR IGNORE INTO accounts (account_no, name, type, normal_balance, default_vat_code) VALUES ('1201', 'Salgsmoms abonnement', 'vat', 'credit', NULL)");

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Abonnement", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, {
      invoiceDocumentId: issued.documentId!,
      receivableAccountNo: "1101",
      revenueAccountNo: "1001",
      outputVatAccountNo: "1201"
    }).ok).toBe(true);

    const credit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Partial correction",
      grossAmount: 625
    });
    expect(credit.ok).toBe(true);

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(credit.journalEntryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1101", debit_amount: 0, credit_amount: 625, vat_code: null },
      { account_no: "1001", debit_amount: 500, credit_amount: 0, vat_code: "DK_SALE_25" },
      { account_no: "1201", debit_amount: 125, credit_amount: 0, vat_code: null },
    ]);

    const journalCount = (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
    const duplicate = postJournalEntry(db, {
      transactionDate: "2026-05-17",
      text: "Duplicate credit-note effect",
      documentId: credit.documentId!,
      lines: [
        { accountNo: "1101", debitAmount: 10 },
        { accountNo: "1001", creditAmount: 10, vatCode: "REVERSE_CHARGE_EXEMPT" },
      ],
    });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors.join(" ")).toContain("already has accounting journal");
    expect(db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: journalCount });

    expect(() => db.run(
      `INSERT INTO journal_entries
         (entry_no, transaction_date, text, document_id, rule_version,
          status, previous_hash, entry_hash)
       VALUES ('2026-9999', '2026-05-17', 'Direct duplicate credit journal',
               ?, 'test', 'posted', 'GENESIS', 'direct-duplicate')`,
      credit.documentId!,
    )).toThrow("credit note documents can have only one accounting journal");
    const originalJournal = db.query(
      `SELECT journal_entry_id AS id
         FROM issued_invoice_postings
        WHERE invoice_document_id = ?`,
    ).get(issued.documentId!) as { id: number };
    expect(() => db.run(
      `INSERT INTO journal_entries
         (entry_no, transaction_date, text, document_id, rule_version,
          status, reversal_of_entry_id, previous_hash, entry_hash)
       VALUES ('2026-9998', '2026-05-17', 'Forged reversal duplicate credit journal',
               ?, 'test', 'reversed', ?, 'GENESIS', 'forged-reversal-duplicate')`,
      credit.documentId!,
      originalJournal.id,
    )).toThrow("credit note documents can have only one accounting journal");
    expect(db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: journalCount });

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects canonical manual credit-note numbers from the wrong fiscal scope", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-scope-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);

    const credit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      creditNoteNumber: "CN-2099-0001",
      reason: "Wrong fiscal scope",
      grossAmount: 625
    });
    expect(credit.ok).toBe(false);
    expect(credit.errors[0]).toContain("does not match current fiscal scope 2026");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("does not burn an auto-numbered credit-note sequence when insert fails", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-rollback-"));
    const realDb = openDb(ensureCompanyDirs(root).db);
    migrate(realDb);
    seedAccounts(realDb);

    const issued = issueInvoice(realDb, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(realDb, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const failingDb = failingDocumentInsertDb(realDb);
    const failed = issueCreditNote(failingDb, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Should roll back sequence",
      grossAmount: 625
    });
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toContain("simulated insert failure");

    const sequence = realDb.query("SELECT value FROM sequences WHERE kind = 'credit_note' AND scope = 'company-1:2026'").get() as { value: number } | null;
    expect(sequence).toBeNull();

    const retried = issueCreditNote(realDb, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Retry succeeds",
      grossAmount: 625
    });
    expect(retried.ok).toBe(true);
    expect(retried.creditNoteNumber).toBe("CN-2026-0001");

    realDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rolls back document, journal, link, audit, and sequence when the credit-note file cannot be published", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-publish-rollback-"));
    const paths = ensureCompanyDirs(root);
    const db = openDb(paths.db);
    migrate(db);
    seedAccounts(db);

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
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const documentCountBefore = (db.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    const journalCountBefore = (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
    const auditCountBefore = (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    const blockedPath = join(paths.invoicesIssued, "CN-2026-0001.json");
    mkdirSync(blockedPath);

    const failed = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Publication must be atomic",
      grossAmount: 625,
    });
    expect(failed.ok).toBe(false);
    expect((db.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n).toBe(documentCountBefore);
    expect((db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n).toBe(journalCountBefore);
    expect((db.query("SELECT COUNT(*) AS n FROM credit_note_postings").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(auditCountBefore);
    expect(db.query("SELECT value FROM sequences WHERE kind = 'credit_note' AND scope = 'company-1:2026'").get()).toBeNull();
    expect(readdirSync(paths.invoicesIssued).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(blockedPath)).toBe(true);

    rmSync(blockedPath, { recursive: true, force: true });
    const retried = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Retry after destination is fixed",
      grossAmount: 625,
    });
    expect(retried.ok).toBe(true);
    expect(retried.creditNoteNumber).toBe("CN-2026-0001");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("mirrors a posted reverse-charge invoice without output VAT", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-reverse-fallback-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    storeViesValidation(db, {
      vatOrCvr: "DE123456789",
      valid: true,
      rawResponse: JSON.stringify({ valid: true })
    });

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "foreign_reverse_charge",
      reverseChargeBasis: "EU_MOMSDIREKTIV_ART_196",
      reverseChargeNote: "Reverse charge",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      lines: [{ description: "Consulting", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, grossAmount: 1000 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const credit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Cancel reverse-charge invoice"
    });
    expect(credit.ok).toBe(true);
    expect(credit.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-REVERSE-002");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(credit.journalEntryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 0, credit_amount: 1000, vat_code: null },
      { account_no: "1000", debit_amount: 1000, credit_amount: 0, vat_code: "REVERSE_CHARGE_EXEMPT" },
    ]);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("issues partial credit notes up to the original invoice amount and posts reversing sales lines", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const credit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Partial correction",
      grossAmount: 625
    });
    expect(credit.ok).toBe(true);
    expect(credit.appliedRules).toContain("DK-CREDIT-NOTE-001");
    expect(existsSync(credit.storedPath!)).toBe(true);

    const doc = db.query("SELECT document_type, invoice_no, payment_details FROM documents WHERE id = ?").get(credit.documentId!) as any;
    expect(doc.document_type).toBe("credit_note");
    expect(doc.payment_details).toBe("2026-0001");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(credit.journalEntryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 0, credit_amount: 625, vat_code: null },
      { account_no: "1000", debit_amount: 500, credit_amount: 0, vat_code: "DK_SALE_25" },
      { account_no: "1200", debit_amount: 125, credit_amount: 0, vat_code: null },
    ]);

    const second = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-18",
      reason: "Final correction"
    });
    expect(second.ok).toBe(true);

    const third = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-19",
      reason: "Too much",
      grossAmount: 1
    });
    expect(third.ok).toBe(false);
    expect(third.errors[0]).toContain("already fully credited");

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the append-only link trigger rejects a direct cumulative over-credit before it can poison audit state", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-trigger-cap-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
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
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);
    expect(issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "First half",
      grossAmount: 625,
    }).ok).toBe(true);

    const injected = db.query(
      `INSERT INTO documents
         (source, sha256_hash, invoice_no, invoice_date, amount_inc_vat, vat_amount,
          currency, status, document_type, payment_details)
       VALUES ('test', 'direct-overcredit', 'CN-2026-X999', '2026-05-18', 700, 140,
               'DKK', 'issued', 'credit_note', '2026-0001')
       RETURNING id`,
    ).get() as { id: number };
    const journal = postJournalEntry(db, {
      transactionDate: "2026-05-18",
      text: "Direct over-credit attempt",
      documentId: injected.id,
      lines: [
        { accountNo: "1100", creditAmount: 700 },
        { accountNo: "1000", debitAmount: 560, vatCode: "DK_SALE_25" },
        { accountNo: "1200", debitAmount: 140 },
      ],
    });
    expect(journal.ok).toBe(true);
    const receivable = db.query("SELECT id FROM accounts WHERE account_no = '1100'").get() as { id: number };
    expect(() => db.run(
      `INSERT INTO credit_note_postings
         (credit_note_document_id, original_invoice_document_id, journal_entry_id,
          receivable_account_id, booked_gross_dkk)
       VALUES (?, ?, ?, ?, 700)`,
      injected.id,
      issued.documentId!,
      journal.entryId!,
      receivable.id,
    )).toThrow("credit note postings exceed original invoice amount");
    expect(db.query(
      "SELECT credit_note_document_id FROM credit_note_postings WHERE credit_note_document_id = ?",
    ).get(injected.id)).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // KODE-3: per-line pro-rata rounding can make the scaled lines sum to one
  // øre more (or less) than the receivable counter-line, and postJournalEntry
  // then rejects the entry ("journal entry must balance"). The entry must
  // balance per construction: the receivable stays equal to the credit-note
  // gross (the bilag total), the VAT line stays pro-rata, and the rounding
  // residual lands on the revenue line — mirroring the fallback lines where
  // net = gross - vat by construction.
  test("books a partial credit note with skæve øre (125.06 gross, 62.53 credited)", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-odd-ore-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 100.05, lineTotalExVat: 100.05 }],
      totals: { netAmount: 100.05, vatRate: 0.25, vatAmount: 25.01, grossAmount: 125.06 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const credit = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-17",
      reason: "Partial correction with odd øre",
      grossAmount: 62.53
    });
    expect(credit.ok, credit.errors.join("; ")).toBe(true);

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(credit.journalEntryId!) as any[];
    // Revenue absorbs the rounding residual (50.03 pro-rata -> 50.02), VAT
    // stays pro-rata, and the receivable equals the credit-note gross. Line
    // order mirrors the original posting (receivable first).
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 0, credit_amount: 62.53, vat_code: null },
      { account_no: "1000", debit_amount: 50.02, credit_amount: 0, vat_code: "DK_SALE_25" },
      { account_no: "1200", debit_amount: 12.51, credit_amount: 0, vat_code: null },
    ]);

    // The cumulative cap still holds: the remaining 62.53 can be credited in
    // full, also balancing per construction, and the invoice is then fully
    // credited — with the 1100 receivable account netting to exactly zero.
    const second = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-18",
      reason: "Final correction with odd øre"
    });
    expect(second.ok, second.errors.join("; ")).toBe(true);

    const third = issueCreditNote(db, root, {
      originalInvoiceDocumentId: issued.documentId!,
      issueDate: "2026-05-19",
      reason: "Too much",
      grossAmount: 0.01
    });
    expect(third.ok).toBe(false);
    expect(third.errors[0]).toContain("already fully credited");

    const receivable = db.query(
      `SELECT COALESCE(SUM(jl.debit_amount), 0) - COALESCE(SUM(jl.credit_amount), 0) AS balance
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE a.account_no = '1100'`
    ).get() as { balance: number };
    expect(receivable.balance).toBeCloseTo(0, 2);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
