// Tests: src/core/invoice-booking.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import {
  postIssuedInvoiceToLedger,
  repairUnlinkedIssuedInvoiceBooking,
} from "../../src/core/invoice-booking";
import {
  postJournalEntry,
  reverseJournalEntry,
  seedAccounts,
  verifyAuditChain,
} from "../../src/core/ledger";
import { buildVatReport } from "../../src/core/vat";
import { storeViesValidation } from "../../src/core/vies";
import { applyInvoicePayment } from "../../src/core/invoice-payments";

function failingInvoicePostingLinkDb(realDb: any) {
  return new Proxy(realDb, {
    get(target, property, receiver) {
      if (property === "run") {
        return (sql: string, ...args: any[]) => {
          if (sql.includes("INSERT INTO issued_invoice_postings")) {
            throw new Error("simulated invoice posting link failure");
          }
          return target.run(sql, ...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
}

function failingLegacyReversalDb(realDb: any) {
  return new Proxy(realDb, {
    get(target, property, receiver) {
      if (property === "query") {
        return (sql: string) => {
          if (sql.includes("INSERT INTO journal_entries") && sql.includes("'reversed'")) {
            return { get() { throw new Error("simulated legacy reversal failure"); } };
          }
          return target.query(sql);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
}

describe("invoice ledger posting", () => {
  test("posts reverse-charge invoice without an output-VAT line", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-reverse-"));
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

    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);
    expect(posted.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-001");
    expect(db.query(
      `SELECT p.invoice_document_id, p.journal_entry_id, a.account_no, p.booked_gross_dkk
         FROM issued_invoice_postings p
         JOIN accounts a ON a.id = p.receivable_account_id
        WHERE p.invoice_document_id = ?`,
    ).get(issued.documentId!)).toEqual({
      invoice_document_id: issued.documentId!,
      journal_entry_id: posted.entryId!,
      account_no: "1100",
      booked_gross_dkk: 1000,
    });
    expect(posted.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-REVERSE-002");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 1000, credit_amount: 0, vat_code: null },
      { account_no: "1000", debit_amount: 0, credit_amount: 1000, vat_code: "REVERSE_CHARGE_EXEMPT" },
    ]);

    const vat = buildVatReport(db, "2026-05-01", "2026-05-31");
    expect(vat.ok).toBe(true);
    expect(vat.outputVat).toBe(0);
    expect(vat.salesBase25).toBe(0);
    expect(vat.reverseChargeSalesBase).toBe(1000);
    expect(vat.warnings).toEqual([]);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("posts non-DKK issued invoices to the ledger with stored FX basis and DKK line amounts", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-fx-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde GmbH", address: "Berlin" },
      lines: [{ description: "Consulting", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }],
      totals: { netAmount: 100, vatRate: 0.25, vatAmount: 25, grossAmount: 125, fxRateToDkk: 7.46, netAmountDkk: 746, vatAmountDkk: 186.5, grossAmountDkk: 932.5 },
      currency: "EUR"
    });
    expect(issued.ok).toBe(true);

    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);

    const entry = db.query("SELECT currency, amount_foreign, amount_dkk, fx_rate_to_dkk FROM journal_entries WHERE id = ?").get(posted.entryId!) as any;
    expect(entry).toEqual({ currency: "EUR", amount_foreign: 125, amount_dkk: 932.5, fx_rate_to_dkk: 7.46 });

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 932.5, credit_amount: 0, vat_code: null },
      { account_no: "1000", debit_amount: 0, credit_amount: 746, vat_code: "DK_SALE_25" },
      { account_no: "1200", debit_amount: 0, credit_amount: 186.5, vat_code: null },
    ]);

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects an issued invoice whose DKK totals do not satisfy net + vat = gross", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-divergent-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    // A non-DKK invoice whose payload DKK totals diverge from net+vat: the
    // stored vat/net DKK amounts do not sum to the gross DKK amount.
    const payload = {
      currency: "EUR",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      totals: {
        netAmount: 100, vatAmount: 25, grossAmount: 125,
        fxRateToDkk: 7.46,
        netAmountDkk: 600, vatAmountDkk: 186.5, grossAmountDkk: 932.5,
      },
    };
    const doc = db.query(
      `INSERT INTO documents (source, sha256_hash, invoice_no, invoice_date, amount_inc_vat, currency, vat_amount, document_type, payload_json)
       VALUES ('rentemester', 'divergent-booking-hash', '2026-0800X', '2026-05-16', 125, 'EUR', 25, 'issued_invoice', ?)
       RETURNING id`
    ).get(JSON.stringify(payload)) as { id: number };

    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: doc.id });
    expect(posted.ok).toBe(false);
    expect(posted.errors.join(" ")).toContain("net");
    expect(db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: 0 });

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("posts issued invoice once to receivables, revenue, and output VAT", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-"));
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

    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(true);
    expect(posted.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-001");

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(posted.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "1100", debit_amount: 1250, credit_amount: 0, vat_code: null },
      { account_no: "1000", debit_amount: 0, credit_amount: 1000, vat_code: "DK_SALE_25" },
      { account_no: "1200", debit_amount: 0, credit_amount: 250, vat_code: null },
    ]);

    const second = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(second.ok).toBe(false);
    expect(second.errors[0]).toContain("already has journal entry");

    const chain = verifyAuditChain(db);
    expect(chain.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rolls the journal, audit row, and sequence back when the explicit booking link cannot be inserted", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-link-rollback-"));
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
    expect(issued.ok).toBe(true);

    const failed = postIssuedInvoiceToLedger(failingInvoicePostingLinkDb(db), {
      invoiceDocumentId: issued.documentId!,
    });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join(" ")).toContain("simulated invoice posting link failure");
    expect(db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM issued_invoice_postings").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'journal_post'").get()).toEqual({ n: 0 });

    const retried = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(retried.ok).toBe(true);
    expect(retried.entryNo).toBe("2026-00001");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("never infers a legacy claim-shaped journal as the canonical invoice booking", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-legacy-shape-"));
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
    expect(issued.ok).toBe(true);
    const ambiguous = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Legacy claim-shaped document journal",
      documentId: issued.documentId!,
      lines: [
        { accountNo: "1100", debitAmount: 1250 },
        { accountNo: "1010", creditAmount: 1250 },
      ],
    });
    expect(ambiguous.ok).toBe(true);
    const posted = postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! });
    expect(posted.ok).toBe(false);
    expect(posted.errors.join(" ")).toMatch(/unresolved legacy|refusing to guess/i);
    expect(db.query("SELECT COUNT(*) AS n FROM issued_invoice_postings").get()).toEqual({ n: 0 });
    const settlement = applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1250,
    });
    expect(settlement.ok).toBe(false);
    expect(settlement.errors.join(" ")).toContain("unresolved legacy journal");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("atomically replaces and reverses one dependency-free unclassified legacy invoice journal", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-legacy-repair-"));
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
    expect(issued.ok).toBe(true);
    const legacy = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Legacy claim-shaped document journal",
      documentId: issued.documentId!,
      lines: [
        { accountNo: "1100", debitAmount: 1250 },
        { accountNo: "1010", creditAmount: 1250 },
      ],
    });
    expect(legacy.ok).toBe(true);

    expect(reverseJournalEntry(db, {
      entryId: legacy.entryId!,
      transactionDate: "2026-05-16",
      reason: "standalone attempt",
    }).ok).toBe(false);
    expect(() => db.run(
      `INSERT INTO journal_entries
         (entry_no, transaction_date, text, document_id, currency, rule_version,
          status, reversal_of_entry_id, previous_hash, entry_hash)
       VALUES ('2026-09999', '2026-05-16', 'direct bypass', ?, 'DKK', 'test',
               'reversed', ?, 'x', 'y')`,
      issued.documentId!,
      legacy.entryId!,
    )).toThrow("invoice evidence cannot be reversed");

    const repaired = repairUnlinkedIssuedInvoiceBooking(db, {
      invoiceDocumentId: issued.documentId!,
      legacyJournalEntryId: legacy.entryId!,
      reason: "Replace ambiguous migrated journal with canonical invoice evidence",
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.replacementJournalEntryId).toBeDefined();
    expect(repaired.reversalJournalEntryId).toBeDefined();
    expect(db.query(
      "SELECT journal_entry_id FROM issued_invoice_postings WHERE invoice_document_id = ?",
    ).get(issued.documentId!)).toEqual({ journal_entry_id: repaired.replacementJournalEntryId });
    expect(db.query(
      "SELECT id FROM journal_entries WHERE reversal_of_entry_id = ?",
    ).get(legacy.entryId!)).toEqual({ id: repaired.reversalJournalEntryId });

    const settlement = applyInvoicePayment(db, {
      invoiceDocumentId: issued.documentId!,
      paymentDate: "2026-05-20",
      amount: 1250,
    });
    expect(settlement.ok).toBe(true);
    expect(verifyAuditChain(db).ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("refuses legacy repair when migrated document evidence references the journal", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-legacy-import-link-"));
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
    expect(issued.ok).toBe(true);
    const legacy = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Migrated invoice journal with source evidence",
      documentId: issued.documentId!,
      lines: [
        { accountNo: "1100", debitAmount: 1250 },
        { accountNo: "1010", creditAmount: 1250 },
      ],
    });
    expect(legacy.ok).toBe(true);
    db.run(
      `INSERT INTO import_document_links
         (source_system, voucher_ref, document_id, journal_entry_id)
       VALUES ('legacy-import', 'INV-2026-0001', ?, ?)`,
      issued.documentId!,
      legacy.entryId!,
    );

    const repaired = repairUnlinkedIssuedInvoiceBooking(db, {
      invoiceDocumentId: issued.documentId!,
      legacyJournalEntryId: legacy.entryId!,
      reason: "must not detach migrated source evidence",
    });
    expect(repaired.ok).toBe(false);
    expect(repaired.errors.join(" ")).toContain("inbound evidence reference");
    expect(db.query("SELECT * FROM issued_invoice_postings").all()).toEqual([]);
    expect(db.query(
      "SELECT id FROM journal_entries WHERE reversal_of_entry_id = ?",
    ).get(legacy.entryId!)).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rolls the canonical replacement back when the legacy reversal fails", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-legacy-repair-rollback-"));
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
    const legacy = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Legacy journal",
      documentId: issued.documentId!,
      lines: [
        { accountNo: "1100", debitAmount: 1250 },
        { accountNo: "1010", creditAmount: 1250 },
      ],
    });
    expect(legacy.ok).toBe(true);
    const journalCountBefore = (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
    const auditCountBefore = (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;

    const failed = repairUnlinkedIssuedInvoiceBooking(failingLegacyReversalDb(db), {
      invoiceDocumentId: issued.documentId!,
      legacyJournalEntryId: legacy.entryId!,
      reason: "force reversal rollback",
    });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join(" ")).toContain("simulated legacy reversal failure");
    expect((db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n).toBe(journalCountBefore);
    expect((db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBe(auditCountBefore);
    expect(db.query("SELECT * FROM issued_invoice_postings").all()).toEqual([]);
    expect(db.query("SELECT id FROM journal_entries WHERE reversal_of_entry_id = ?",).get(legacy.entryId!)).toBeNull();

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
