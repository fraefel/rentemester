// Tests: src/core/invoice-bad-debt.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { applyInvoicePayment, getInvoiceStatus } from "../../src/core/invoice-payments";
import { writeOffInvoiceBadDebt } from "../../src/core/invoice-bad-debt";
import { buildVatReport } from "../../src/core/vat";
import { postJournalEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { importBankCsv } from "../../src/core/bank";
import { issueCreditNote } from "../../src/core/credit-notes";

function setupStandardBadDebtFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  const issued = issueInvoice(db, root, {
    invoiceType: "full",
    vatTreatment: "standard",
    issueDate: "2026-05-16",
    dueDate: "2026-06-15",
    invoiceNumber: "2026-0001",
    seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
    lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
    totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
    currency: "DKK",
  });
  expect(issued.ok).toBe(true);
  expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);
  return { root, db, issued };
}

function setupPartPaidFxBadDebtFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  const issued = issueInvoice(db, root, {
    invoiceType: "full",
    vatTreatment: "standard",
    issueDate: "2026-05-16",
    dueDate: "2026-06-15",
    invoiceNumber: "2026-0001",
    seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    buyer: { name: "Kunde GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
    lines: [{ description: "Consulting", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }],
    totals: {
      netAmount: 100,
      vatRate: 0.25,
      vatAmount: 25,
      grossAmount: 125,
      fxRateToDkk: 7.4321,
      netAmountDkk: 743.21,
      vatAmountDkk: 185.8,
      grossAmountDkk: 929.01,
    },
    currency: "EUR",
  });
  expect(issued.ok).toBe(true);
  expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);
  const csvPath = join(root, "partial-payment.csv");
  writeFileSync(
    csvPath,
    "transaction_date,booking_date,text,amount,currency,amount_dkk,fx_rate_to_dkk,reference\n" +
      "2026-06-20,2026-06-20,Partial payment,50.05,EUR,371.98,7.4321,FX-PARTIAL\n",
  );
  expect(importBankCsv(db, root, csvPath).ok).toBe(true);
  const bank = db.query(
    "SELECT id FROM bank_transactions WHERE reference = 'FX-PARTIAL'",
  ).get() as { id: number };
  expect(applyInvoicePayment(db, {
    invoiceDocumentId: issued.documentId!,
    bankTransactionId: bank.id,
    paymentDate: "2026-06-20",
    amount: 50.05,
  }).ok).toBe(true);
  return { root, db, issued };
}

describe("invoice bad debt", () => {
  test("writes off an unpaid standard-rated invoice and reduces output VAT deterministically", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const journalCountBeforeInvalid = (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
    const invalidVatAccount = writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
      vatAccountNo: "7000",
    });
    expect(invalidVatAccount.ok).toBe(false);
    expect(invalidVatAccount.errors.join(" ")).toContain("confirmed output VAT account 1200");
    const invalidExpenseAccount = writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
      expenseAccountNo: "7000",
    });
    expect(invalidExpenseAccount.ok).toBe(false);
    expect(invalidExpenseAccount.errors.join(" ")).toContain("debit-normal expense account");
    expect(db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: journalCountBeforeInvalid });
    expect(db.query("SELECT COUNT(*) AS n FROM invoice_bad_debt_writeoffs").get()).toEqual({ n: 0 });

    const writeOff = writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
    });
    expect(writeOff.ok).toBe(true);
    expect(writeOff.appliedRules).toContain("DK-INVOICE-BAD-DEBT-WRITEOFF-001");
    expect(writeOff.appliedRules).toContain("DK-VAT-BAD-DEBT-001");
    expect(writeOff.grossAmount).toBe(1250);
    expect(writeOff.netAmount).toBe(1000);
    expect(writeOff.vatAmount).toBe(250);
    expect(writeOff.openBalance).toBe(0);

    const status = getInvoiceStatus(db, issued.documentId!, "2026-07-01");
    expect(status.ok).toBe(true);
    expect(status.openBalance).toBe(0);
    expect(status.status).toBe("written_off");
    expect(status.totalBadDebtWrittenOff).toBe(1250);
    expect(status.badDebtWriteOffs).toHaveLength(1);

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(writeOff.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "3080", debit_amount: 1000, credit_amount: 0, vat_code: "DK_BAD_DEBT_25" },
      { account_no: "1200", debit_amount: 250, credit_amount: 0, vat_code: null },
      { account_no: "1100", debit_amount: 0, credit_amount: 1250, vat_code: null },
    ]);

    const vat = buildVatReport(db, "2026-05-01", "2026-07-31");
    expect(vat.ok).toBe(true);
    expect(vat.outputVat).toBe(0);
    expect(vat.badDebtReliefBase25).toBe(1000);

    expect(verifyAuditChain(db).ok).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects direct bad-debt links with the wrong account shape and audits legacy evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-evidence-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK",
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const wrongJournal = postJournalEntry(db, {
      transactionDate: "2026-07-01",
      text: "Legacy bad-debt journal with liability instead of output VAT",
      documentId: issued.documentId!,
      lines: [
        { accountNo: "3080", debitAmount: 1000, vatCode: "DK_BAD_DEBT_25" },
        { accountNo: "7000", debitAmount: 250 },
        { accountNo: "1100", creditAmount: 1250 },
      ],
    });
    expect(wrongJournal.ok).toBe(true);
    const insertLegacyLink = () => db.run(
      `INSERT INTO invoice_bad_debt_writeoffs
         (invoice_document_id, writeoff_date, gross_amount, net_amount, vat_amount, journal_entry_id)
       VALUES (?, '2026-07-01', 1250, 1000, 250, ?)`,
      issued.documentId!,
      wrongJournal.entryId!,
    );
    expect(insertLegacyLink).toThrow(
      "invoice bad-debt writeoff requires the exact VAT-relief expense/output-VAT/receivable journal",
    );
    expect(db.query("SELECT COUNT(*) AS n FROM invoice_bad_debt_writeoffs").get()).toEqual({ n: 0 });

    db.exec("DROP TRIGGER invoice_bad_debt_writeoffs_validate_insert");
    insertLegacyLink();
    const status = getInvoiceStatus(db, issued.documentId!, "2026-07-01");
    expect(status.ok).toBe(false);
    expect(status.errors.join(" ")).toContain("does not match the exact VAT-relief");
    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.join(" ")).toContain("does not match the exact VAT-relief");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("enforces the immutable VAT split, chronology, cumulative cap, and historical account snapshot", () => {
    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-backdate-");
      const journalCount = (fixture.db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
      const backdated = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-05-01",
      });
      expect(backdated.ok).toBe(false);
      expect(backdated.errors.join(" ")).toContain("cannot be before invoice date 2026-05-16");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: journalCount });
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-vat-ratio-");
      const wrongSplitJournal = postJournalEntry(fixture.db, {
        transactionDate: "2026-07-01",
        text: "Bad debt with forged VAT split",
        documentId: fixture.issued.documentId!,
        lines: [
          { accountNo: "3080", debitAmount: 1249, vatCode: "DK_BAD_DEBT_25" },
          { accountNo: "1200", debitAmount: 1 },
          { accountNo: "1100", creditAmount: 1250 },
        ],
      });
      expect(wrongSplitJournal.ok).toBe(true);
      expect(() => fixture.db.run(
        `INSERT INTO invoice_bad_debt_writeoffs
           (invoice_document_id, writeoff_date, gross_amount, net_amount, vat_amount, journal_entry_id)
         VALUES (?, '2026-07-01', 1250, 1249, 1, ?)`,
        fixture.issued.documentId!,
        wrongSplitJournal.entryId!,
      )).toThrow("exact VAT-relief expense/output-VAT/receivable journal");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM invoice_bad_debt_writeoffs").get()).toEqual({ n: 0 });
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-cumulative-");
      const postWriteOffJournal = (date: string, text: string) => postJournalEntry(fixture.db, {
        transactionDate: date,
        text,
        documentId: fixture.issued.documentId!,
        lines: [
          { accountNo: "3080", debitAmount: 1000, vatCode: "DK_BAD_DEBT_25" },
          { accountNo: "1200", debitAmount: 250 },
          { accountNo: "1100", creditAmount: 1250 },
        ],
      });
      const firstJournal = postWriteOffJournal("2026-07-01", "First exact bad-debt journal");
      expect(firstJournal.ok).toBe(true);
      fixture.db.run(
        `INSERT INTO invoice_bad_debt_writeoffs
           (invoice_document_id, writeoff_date, gross_amount, net_amount, vat_amount, journal_entry_id)
         VALUES (?, '2026-07-01', 1250, 1000, 250, ?)`,
        fixture.issued.documentId!,
        firstJournal.entryId!,
      );
      const secondJournal = postWriteOffJournal("2026-07-02", "Second over-cap bad-debt journal");
      expect(secondJournal.ok).toBe(true);
      expect(() => fixture.db.run(
        `INSERT INTO invoice_bad_debt_writeoffs
           (invoice_document_id, writeoff_date, gross_amount, net_amount, vat_amount, journal_entry_id)
         VALUES (?, '2026-07-02', 1250, 1000, 250, ?)`,
        fixture.issued.documentId!,
        secondJournal.entryId!,
      )).toThrow("exact VAT-relief expense/output-VAT/receivable journal");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM invoice_bad_debt_writeoffs").get()).toEqual({ n: 1 });
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-role-history-");
      const writeOff = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-01",
      });
      expect(writeOff.ok).toBe(true);
      const registration = (fixture.db.query(
        "SELECT registration_datetime FROM journal_entries WHERE id = ?",
      ).get(writeOff.entryId!) as { registration_datetime: string }).registration_datetime;
      fixture.db.run(
        `INSERT INTO accounts
           (account_no, name, type, normal_balance, active, allow_direct_posting)
         VALUES ('1201', 'Ny salgsmoms', 'vat', 'credit', 1, 1)`,
      );
      fixture.db.run(
        "UPDATE account_role_mappings SET status = 'superseded' WHERE role = 'output_vat' AND status = 'confirmed'",
      );
      fixture.db.run(
        `INSERT INTO account_role_mappings
           (role, account_no, status, version, confirmed_by, confirmation_source, confirmed_at)
         VALUES ('output_vat', '1201', 'confirmed', 2, 'user:test', 'explicit', ?)`,
        registration,
      );
      fixture.db.run("UPDATE accounts SET active = 0 WHERE account_no IN ('1200', '3080')");
      expect(getInvoiceStatus(fixture.db, fixture.issued.documentId!, "2026-07-01").ok).toBe(true);
      expect(verifyAuditChain(fixture.db).ok).toBe(true);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("writes off a non-DKK invoice using stored DKK totals for ledger relief", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-fx-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde GmbH", address: "Berlin", vatOrCvr: "DE123456789" },
      lines: [{ description: "Consulting", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }],
      totals: { netAmount: 100, vatRate: 0.25, vatAmount: 25, grossAmount: 125, fxRateToDkk: 7.46, netAmountDkk: 746, vatAmountDkk: 186.5, grossAmountDkk: 932.5 },
      currency: "EUR"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const writeOff = writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
    });
    expect(writeOff.ok).toBe(true);
    expect(writeOff.grossAmount).toBe(125);
    expect(writeOff.netAmount).toBe(100);
    expect(writeOff.vatAmount).toBe(25);

    const entry = db.query("SELECT currency, amount_foreign, amount_dkk, fx_rate_to_dkk FROM journal_entries WHERE id = ?").get(writeOff.entryId!) as any;
    expect(entry).toEqual({ currency: "EUR", amount_foreign: 125, amount_dkk: 932.5, fx_rate_to_dkk: 7.46 });

    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_entry_id = ? ORDER BY jl.id ASC`
    ).all(writeOff.entryId!) as any[];
    expect(lines).toEqual([
      { account_no: "3080", debit_amount: 746, credit_amount: 0, vat_code: "DK_BAD_DEBT_25" },
      { account_no: "1200", debit_amount: 186.5, credit_amount: 0, vat_code: null },
      { account_no: "1100", debit_amount: 0, credit_amount: 932.5, vat_code: null },
    ]);

    const status = getInvoiceStatus(db, issued.documentId!, "2026-07-01");
    expect(status.openBalance).toBe(0);
    expect(status.status).toBe("written_off");
    expect(status.totalBadDebtWrittenOff).toBe(125);

    expect(verifyAuditChain(db).ok).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("uses the exact remaining FX carrying balance after a partial payment", () => {
    {
      const fixture = setupPartPaidFxBadDebtFixture("rentemester-bad-debt-fx-carrying-");
      const writeOff = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-01",
      });
      expect(writeOff.ok).toBe(true);
      expect(writeOff.grossAmount).toBe(74.95);
      expect(writeOff.vatAmount).toBe(14.99);
      const entry = fixture.db.query(
        "SELECT amount_foreign, amount_dkk, fx_rate_to_dkk FROM journal_entries WHERE id = ?",
      ).get(writeOff.entryId!) as { amount_foreign: number; amount_dkk: number; fx_rate_to_dkk: number };
      expect(entry.amount_foreign).toBe(74.95);
      expect(entry.amount_dkk).toBe(557.03);
      expect(Math.round(entry.fx_rate_to_dkk * 1_000_000)).toBe(7_432_021);
      expect(fixture.db.query(
        `SELECT a.account_no, jl.debit_amount, jl.credit_amount
           FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id
          WHERE jl.journal_entry_id = ?
          ORDER BY jl.id`,
      ).all(writeOff.entryId!)).toEqual([
        { account_no: "3080", debit_amount: 445.62, credit_amount: 0 },
        { account_no: "1200", debit_amount: 111.41, credit_amount: 0 },
        { account_no: "1100", debit_amount: 0, credit_amount: 557.03 },
      ]);
      expect(fixture.db.query(
        `SELECT ROUND(100 * (SUM(jl.debit_amount) - SUM(jl.credit_amount))) / 100 AS balance
           FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id
          WHERE a.account_no = '1100'`,
      ).get()).toEqual({ balance: 0 });
      expect(getInvoiceStatus(fixture.db, fixture.issued.documentId!, "2026-07-01").status).toBe("written_off");
      expect(verifyAuditChain(fixture.db).ok).toBe(true);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupPartPaidFxBadDebtFixture("rentemester-bad-debt-fx-legacy-rate-");
      const legacy = postJournalEntry(fixture.db, {
        transactionDate: "2026-07-01",
        text: "Legacy original-rate bad-debt relief",
        documentId: fixture.issued.documentId!,
        currency: "EUR",
        amountForeign: 74.95,
        amountDkk: 557.04,
        fxRateToDkk: 7.4321,
        lines: [
          { accountNo: "3080", debitAmount: 445.64, vatCode: "DK_BAD_DEBT_25" },
          { accountNo: "1200", debitAmount: 111.4 },
          { accountNo: "1100", creditAmount: 557.04 },
        ],
      });
      expect(legacy.ok).toBe(true);
      const insertLegacy = () => fixture.db.run(
        `INSERT INTO invoice_bad_debt_writeoffs
           (invoice_document_id, writeoff_date, gross_amount, net_amount, vat_amount, journal_entry_id)
         VALUES (?, '2026-07-01', 74.95, 59.96, 14.99, ?)`,
        fixture.issued.documentId!,
        legacy.entryId!,
      );
      expect(insertLegacy).toThrow("exact VAT-relief expense/output-VAT/receivable journal");
      fixture.db.exec("DROP TRIGGER invoice_bad_debt_writeoffs_validate_insert");
      insertLegacy();
      expect(getInvoiceStatus(fixture.db, fixture.issued.documentId!, "2026-07-01").ok).toBe(false);
      expect(verifyAuditChain(fixture.db).ok).toBe(false);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("allocates VAT cumulatively and rejects backdated principal events that invalidate a write-off", () => {
    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-vat-cumulative-");
      const first = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-01",
        grossAmount: 0.03,
      });
      const second = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-02",
        grossAmount: 0.03,
      });
      const final = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-03",
      });
      expect([first.vatAmount, second.vatAmount, final.vatAmount]).toEqual([0.01, 0, 249.99]);
      expect([first.ok, second.ok, final.ok]).toEqual([true, true, true]);
      expect(getInvoiceStatus(fixture.db, fixture.issued.documentId!, "2026-07-03").status).toBe("written_off");
      expect(verifyAuditChain(fixture.db).ok).toBe(true);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-credit-chronology-");
      expect(writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-01",
        grossAmount: 625,
      }).ok).toBe(true);
      const credit = issueCreditNote(fixture.db, fixture.root, {
        originalInvoiceDocumentId: fixture.issued.documentId!,
        issueDate: "2026-06-01",
        reason: "Backdated credit must not invalidate later bad debt",
        grossAmount: 626,
      });
      expect(credit.ok).toBe(false);
      expect(credit.errors.join(" ")).toContain("cannot be linked after an invoice bad-debt writeoff");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM credit_note_postings").get()).toEqual({ n: 0 });
      expect(getInvoiceStatus(fixture.db, fixture.issued.documentId!, "2026-07-01").ok).toBe(true);
      expect(verifyAuditChain(fixture.db).ok).toBe(true);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-credit-vat-allocation-");
      const credit = issueCreditNote(fixture.db, fixture.root, {
        originalInvoiceDocumentId: fixture.issued.documentId!,
        issueDate: "2026-06-01",
        reason: "Odd-ore credit before bad debt",
        grossAmount: 625.03,
      });
      expect(credit.ok).toBe(true);
      const writeOff = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-01",
      });
      expect(writeOff.ok).toBe(true);
      expect(writeOff.grossAmount).toBe(624.97);
      expect(writeOff.vatAmount).toBe(124.99);
      expect(verifyAuditChain(fixture.db).ok).toBe(true);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-payment-chronology-");
      expect(writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-01",
        grossAmount: 625,
      }).ok).toBe(true);
      expect(() => fixture.db.transaction(() => {
        const journal = postJournalEntry(fixture.db, {
          transactionDate: "2026-06-01",
          text: "Backdated payment must not invalidate later bad debt",
          documentId: fixture.issued.documentId!,
          lines: [
            { accountNo: "2000", debitAmount: 626 },
            { accountNo: "1100", creditAmount: 626 },
          ],
        });
        expect(journal.ok).toBe(true);
        fixture.db.run(
          `INSERT INTO invoice_payments
             (invoice_document_id, journal_entry_id, payment_date, amount, currency)
           VALUES (?, ?, '2026-06-01', 626, 'DKK')`,
          fixture.issued.documentId!,
          journal.entryId!,
        );
      }, { immediate: true })()).toThrow("payment would invalidate existing invoice bad-debt evidence");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM invoice_payments").get()).toEqual({ n: 0 });
      expect(getInvoiceStatus(fixture.db, fixture.issued.documentId!, "2026-07-01").ok).toBe(true);
      expect(verifyAuditChain(fixture.db).ok).toBe(true);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }

    {
      const fixture = setupStandardBadDebtFixture("rentemester-bad-debt-future-credit-");
      expect(issueCreditNote(fixture.db, fixture.root, {
        originalInvoiceDocumentId: fixture.issued.documentId!,
        issueDate: "2026-07-10",
        reason: "Future credit already exists",
        grossAmount: 100,
      }).ok).toBe(true);
      const backdatedWriteOff = writeOffInvoiceBadDebt(fixture.db, {
        invoiceDocumentId: fixture.issued.documentId!,
        writeOffDate: "2026-07-01",
        grossAmount: 625,
      });
      expect(backdatedWriteOff.ok).toBe(false);
      expect(backdatedWriteOff.errors.join(" ")).toContain("exact VAT-relief expense/output-VAT/receivable journal");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM invoice_bad_debt_writeoffs").get()).toEqual({ n: 0 });
      expect(verifyAuditChain(fixture.db).ok).toBe(true);
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("blocks bad-debt write-off above open principal balance", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bad-debt-over-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      dueDate: "2026-06-15",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK"
    });
    expect(issued.ok).toBe(true);
    expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);

    const writeOff = writeOffInvoiceBadDebt(db, {
      invoiceDocumentId: issued.documentId!,
      writeOffDate: "2026-07-01",
      grossAmount: 1300,
    });
    expect(writeOff.ok).toBe(false);
    expect(writeOff.errors[0]).toContain("exceeds open principal balance");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
