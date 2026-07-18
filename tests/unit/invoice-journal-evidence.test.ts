// Tests: src/core/invoice-journal-evidence.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { postJournalEntry, reverseJournalEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { applyInvoicePayment, getInvoiceStatus } from "../../src/core/invoice-payments";
import { issueCreditNote } from "../../src/core/credit-notes";
import {
  validateInvoiceJournalEvidence,
  type InvoiceJournalApplicationCandidate,
} from "../../src/core/invoice-journal-evidence";

function setupEvidenceFixture(prefix: string, withDefaultPaymentJournal = true) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const paths = ensureCompanyDirs(root);
  const db = openDb(paths.db);
  migrate(db);
  seedAccounts(db);
  const invoicePayload = JSON.stringify({
    vatTreatment: "foreign_reverse_charge",
    totals: { netAmount: 100, grossAmount: 100 },
    lines: [{ lineTotalExVat: 100 }],
  });
  const invoiceAPath = join(paths.invoicesIssued, "2026-EVIDENCE-A.json");
  const invoiceBPath = join(paths.invoicesIssued, "2026-EVIDENCE-B.json");
  const invoiceABytes = `${invoicePayload}\nA\n`;
  const invoiceBBytes = `${invoicePayload}\nB\n`;
  writeFileSync(invoiceAPath, invoiceABytes);
  writeFileSync(invoiceBPath, invoiceBBytes);
  const invoiceAHash = createHash("sha256").update(invoiceABytes).digest("hex");
  const invoiceBHash = createHash("sha256").update(invoiceBBytes).digest("hex");

  const invoice = db.query(
    `INSERT INTO documents
       (source, sha256_hash, invoice_no, invoice_date, amount_inc_vat, vat_amount,
        currency, status, document_type, payload_json, stored_path)
     VALUES ('test', ?, '2026-EVIDENCE-A', '2026-05-01', 100, 0,
             'DKK', 'issued', 'issued_invoice', ?, ?)
     RETURNING id`,
  ).get(invoiceAHash, invoicePayload, invoiceAPath) as { id: number };
  const otherInvoice = db.query(
    `INSERT INTO documents
       (source, sha256_hash, invoice_no, invoice_date, amount_inc_vat, vat_amount,
        currency, status, document_type, payload_json, stored_path)
     VALUES ('test', ?, '2026-EVIDENCE-B', '2026-05-01', 100, 0,
             'DKK', 'issued', 'issued_invoice', ?, ?)
     RETURNING id`,
  ).get(invoiceBHash, invoicePayload, invoiceBPath) as { id: number };
  const bank = db.query(
    `INSERT INTO bank_transactions
       (transaction_date, text, amount, currency, transaction_hash)
     VALUES ('2026-05-02', 'Customer receipt', 100, 'DKK', 'invoice-evidence-bank-a')
     RETURNING id`,
  ).get() as { id: number };
  const otherBank = db.query(
    `INSERT INTO bank_transactions
       (transaction_date, text, amount, currency, transaction_hash)
     VALUES ('2026-05-02', 'Other receipt', 100, 'DKK', 'invoice-evidence-bank-b')
     RETURNING id`,
  ).get() as { id: number };
  const booking = postJournalEntry(db, {
    transactionDate: "2026-05-01",
    text: "Issued invoice booking",
    documentId: invoice.id,
    lines: [
      { accountNo: "1100", debitAmount: 100 },
      { accountNo: "1000", creditAmount: 100, vatCode: "REVERSE_CHARGE_EXEMPT" },
    ],
  });
  expect(booking.ok).toBe(true);
  db.run(
    `INSERT INTO issued_invoice_postings
       (invoice_document_id, journal_entry_id, receivable_account_id, booked_gross_dkk)
     SELECT ?, ?, id, 100 FROM accounts WHERE account_no = '1100'`,
    invoice.id,
    booking.entryId!,
  );
  const otherBooking = postJournalEntry(db, {
    transactionDate: "2026-05-01",
    text: "Other issued invoice booking",
    documentId: otherInvoice.id,
    lines: [
      { accountNo: "1100", debitAmount: 100 },
      { accountNo: "1000", creditAmount: 100, vatCode: "REVERSE_CHARGE_EXEMPT" },
    ],
  });
  expect(otherBooking.ok).toBe(true);
  db.run(
    `INSERT INTO issued_invoice_postings
       (invoice_document_id, journal_entry_id, receivable_account_id, booked_gross_dkk)
     SELECT ?, ?, id, 100 FROM accounts WHERE account_no = '1100'`,
    otherInvoice.id,
    otherBooking.entryId!,
  );
  const reminder = db.query(
    `INSERT INTO invoice_reminders
       (invoice_document_id, reminder_date, fee_amount, note)
     VALUES (?, '2026-05-01', 30, 'Evidence fixture claim')
     RETURNING id`,
  ).get(invoice.id) as { id: number };
  const claimBooking = postJournalEntry(db, {
    transactionDate: "2026-05-01",
    text: "Reminder claim booking",
    documentId: invoice.id,
    lines: [
      { accountNo: "1100", debitAmount: 30 },
      { accountNo: "1010", creditAmount: 30 },
    ],
  });
  expect(claimBooking.ok).toBe(true);
  db.run(
    "INSERT INTO invoice_reminder_postings (reminder_id, journal_entry_id) VALUES (?, ?)",
    reminder.id,
    claimBooking.entryId!,
  );
  const journal = withDefaultPaymentJournal
    ? postJournalEntry(db, {
      transactionDate: "2026-05-02",
      text: "Customer payment evidence",
      documentId: invoice.id,
      sourceBankTransactionId: bank.id,
      lines: [
        { accountNo: "2000", debitAmount: 100 },
        { accountNo: "1100", creditAmount: 100 },
      ],
    })
    : null;
  if (journal) expect(journal.ok).toBe(true);

  return { root, db, invoice, otherInvoice, bank, otherBank, journal };
}

function paymentCandidate(
  fixture: ReturnType<typeof setupEvidenceFixture>,
  overrides: Partial<InvoiceJournalApplicationCandidate> = {},
): InvoiceJournalApplicationCandidate {
  return {
    kind: "payment",
    invoiceDocumentId: fixture.invoice.id,
    bankTransactionId: fixture.bank.id,
    journalEntryId: fixture.journal?.entryId ?? null,
    effectiveDate: "2026-05-02",
    amount: 100,
    currency: "DKK",
    ...overrides,
  };
}

describe("invoice application journal evidence", () => {
  test("flags an extra active unclassified journal even when the invoice has a canonical booking link", () => {
    const fixture = setupEvidenceFixture("rentemester-invoice-evidence-extra-journal-");
    try {
      const status = getInvoiceStatus(fixture.db, fixture.invoice.id);
      expect(status.ok).toBe(false);
      expect(status.errors.join(" ")).toContain("unresolved legacy journal");
      expect(verifyAuditChain(fixture.db).ok).toBe(false);
    } finally {
      fixture.db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("detects a legacy sibling journal on a credit note globally and in the original invoice scope", () => {
    const fixture = setupEvidenceFixture("rentemester-credit-evidence-extra-journal-", false);
    const { db } = fixture;
    try {
      const credit = issueCreditNote(db, fixture.root, {
        originalInvoiceDocumentId: fixture.invoice.id,
        issueDate: "2026-05-03",
        reason: "Canonical partial credit",
        grossAmount: 50,
      });
      expect(credit.ok).toBe(true);
      expect(verifyAuditChain(db).ok).toBe(true);

      const canonicalLines = db.query(
        `SELECT a.account_no, jl.debit_amount, jl.credit_amount, jl.vat_code
           FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id
          WHERE jl.journal_entry_id = ?
          ORDER BY jl.id ASC`,
      ).all(credit.journalEntryId!) as Array<{
        account_no: string;
        debit_amount: number;
        credit_amount: number;
        vat_code: string | null;
      }>;

      // Simulate a pre-guard ledger: temporarily remove the document-type
      // discriminator so the historical duplicate can be created through the
      // normal hash-chain writer, then restore the legal credit-note identity.
      db.exec("DROP TRIGGER credit_note_single_active_journal; DROP TRIGGER documents_no_update_issued_invoice;");
      db.run("UPDATE documents SET document_type = 'other' WHERE id = ?", credit.documentId!);
      const duplicate = postJournalEntry(db, {
        transactionDate: "2026-05-03",
        text: "Legacy duplicate credit-note posting",
        documentId: credit.documentId!,
        lines: canonicalLines.map((line) => ({
          accountNo: line.account_no,
          debitAmount: Number(line.debit_amount) || undefined,
          creditAmount: Number(line.credit_amount) || undefined,
          vatCode: line.vat_code ?? undefined,
        })),
      });
      expect(duplicate.ok).toBe(true);
      db.run("UPDATE documents SET document_type = 'credit_note' WHERE id = ?", credit.documentId!);

      const global = validateInvoiceJournalEvidence(db);
      expect(global.ok).toBe(false);
      expect(global.errors.join(" ")).toContain("outside its canonical credit-note posting link");
      const scoped = validateInvoiceJournalEvidence(db, { invoiceDocumentId: fixture.invoice.id });
      expect(scoped.ok).toBe(false);
      expect(scoped.errors.join(" ")).toContain("outside its canonical credit-note posting link");
      expect(getInvoiceStatus(db, fixture.invoice.id).ok).toBe(false);
      expect(verifyAuditChain(db).ok).toBe(false);
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("claim posting links reject liability income and legacy bad evidence fails status and audit", () => {
    const fixture = setupEvidenceFixture("rentemester-claim-evidence-liability-", false);
    const { db } = fixture;
    try {
      const journalCount = (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
      expect(() => db.transaction(() => {
        const reminder = db.query(
          `INSERT INTO invoice_reminders
             (invoice_document_id, reminder_date, fee_amount, currency, note)
           VALUES (?, '2026-05-11', 25, 'DKK', 'Invalid liability claim')
           RETURNING id`,
        ).get(fixture.invoice.id) as { id: number };
        const badJournal = postJournalEntry(db, {
          transactionDate: "2026-05-11",
          text: "Invalid liability-backed reminder",
          documentId: fixture.invoice.id,
          lines: [
            { accountNo: "1100", debitAmount: 25 },
            { accountNo: "7000", creditAmount: 25 },
          ],
        });
        expect(badJournal.ok).toBe(true);
        db.run(
          "INSERT INTO invoice_reminder_postings (reminder_id, journal_entry_id) VALUES (?, ?)",
          reminder.id,
          badJournal.entryId!,
        );
      })()).toThrow("reminder posting must be an exact DKK receivable/income journal");
      expect(db.query("SELECT COUNT(*) AS n FROM journal_entries").get()).toEqual({ n: journalCount });

      const legacyReminder = db.query(
        `INSERT INTO invoice_reminders
           (invoice_document_id, reminder_date, fee_amount, currency, note)
         VALUES (?, '2026-05-11', 25, 'DKK', 'Legacy invalid liability claim')
         RETURNING id`,
      ).get(fixture.invoice.id) as { id: number };
      const legacyJournal = postJournalEntry(db, {
        transactionDate: "2026-05-11",
        text: "Legacy liability-backed reminder",
        documentId: fixture.invoice.id,
        lines: [
          { accountNo: "1100", debitAmount: 25 },
          { accountNo: "7000", creditAmount: 25 },
        ],
      });
      expect(legacyJournal.ok).toBe(true);
      db.exec("DROP TRIGGER invoice_reminder_postings_validate_insert");
      db.run(
        "INSERT INTO invoice_reminder_postings (reminder_id, journal_entry_id) VALUES (?, ?)",
        legacyReminder.id,
        legacyJournal.entryId!,
      );

      const status = getInvoiceStatus(db, fixture.invoice.id);
      expect(status.ok).toBe(false);
      expect(status.errors.join(" ")).toContain("credit income");
      const audit = verifyAuditChain(db);
      expect(audit.ok).toBe(false);
      expect(audit.errors.join(" ")).toContain("credit income");
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps posted evidence stable across a same-second account-role change", () => {
    const fixture = setupEvidenceFixture("rentemester-invoice-evidence-role-history-");
    const { db } = fixture;
    try {
      db.run(
        `INSERT INTO invoice_payments
           (invoice_document_id, bank_transaction_id, journal_entry_id, payment_date, amount, currency)
         VALUES (?, ?, ?, '2026-05-02', 100, 'DKK')`,
        fixture.invoice.id,
        fixture.bank.id,
        fixture.journal!.entryId!,
      );
      const postedAt = (db.query(
        "SELECT registration_datetime FROM journal_entries WHERE id = ?",
      ).get(fixture.journal!.entryId!) as { registration_datetime: string }).registration_datetime;
      db.run("INSERT INTO accounts (account_no, name, type, normal_balance) VALUES ('2100', 'New bank', 'asset', 'debit')");
      db.run("INSERT INTO accounts (account_no, name, type, normal_balance) VALUES ('1110', 'New debtors', 'asset', 'debit')");
      for (const [role, accountNo] of [["bank", "2100"], ["debtors", "1110"]] as const) {
        db.run("UPDATE account_role_mappings SET status = 'superseded' WHERE role = ? AND status = 'confirmed'", role);
        db.run(
          `INSERT INTO account_role_mappings
             (role, account_no, status, version, confirmed_by, confirmation_source, confirmed_at)
           VALUES (?, ?, 'confirmed', 2, 'user:test', 'explicit', ?)`,
          role,
          accountNo,
          postedAt,
        );
      }

      const status = getInvoiceStatus(db, fixture.invoice.id);
      expect(status.ok).toBe(true);
      expect(status.status).toBe("paid");
      expect(verifyAuditChain(db).ok).toBe(true);
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("does not accept a bank mapping that was superseded before the journal was posted", () => {
    const fixture = setupEvidenceFixture("rentemester-invoice-evidence-role-interval-", false);
    const { db } = fixture;
    try {
      db.run(
        `INSERT INTO accounts (account_no, name, type, normal_balance)
         VALUES ('2200', 'Former bank', 'asset', 'debit'),
                ('2300', 'Current bank', 'asset', 'debit')`,
      );
      db.run(
        `UPDATE account_role_mappings
            SET status = 'superseded', confirmed_at = '2026-01-01 00:00:00'
          WHERE role = 'bank' AND status = 'confirmed'`,
      );
      db.run(
        `INSERT INTO account_role_mappings
           (role, account_no, status, version, confirmed_by, confirmation_source, confirmed_at)
         VALUES ('bank', '2200', 'superseded', 2, 'user:test', 'explicit', '2026-02-01 00:00:00'),
                ('bank', '2300', 'confirmed', 3, 'user:test', 'explicit', '2026-03-01 00:00:00')`,
      );
      const staleBankJournal = postJournalEntry(db, {
        transactionDate: "2026-05-02",
        text: "Receipt on a superseded bank ledger",
        documentId: fixture.invoice.id,
        sourceBankTransactionId: fixture.otherBank.id,
        lines: [
          { accountNo: "2200", debitAmount: 100 },
          { accountNo: "1100", creditAmount: 100 },
        ],
      });
      expect(staleBankJournal.ok).toBe(true);

      const evidence = validateInvoiceJournalEvidence(db, {
        candidates: [paymentCandidate(fixture, {
          bankTransactionId: fixture.otherBank.id,
          journalEntryId: staleBankJournal.entryId!,
        })],
      });
      expect(evidence.ok).toBe(false);
      expect(evidence.errors.join(" ")).toContain("bank account effects do not match");
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects a balanced caller-supplied journal with reversed bank and receivable effects", () => {
    const fixture = setupEvidenceFixture("rentemester-invoice-evidence-semantics-", false);
    const { db } = fixture;
    try {
      const reversedEffects = postJournalEntry(db, {
        transactionDate: "2026-05-02",
        text: "Balanced but backwards customer payment",
        documentId: fixture.invoice.id,
        sourceBankTransactionId: fixture.otherBank.id,
        lines: [
          { accountNo: "1100", debitAmount: 100 },
          { accountNo: "2000", creditAmount: 100 },
        ],
      });
      expect(reversedEffects.ok).toBe(true);

      const result = applyInvoicePayment(db, {
        invoiceDocumentId: fixture.invoice.id,
        bankTransactionId: fixture.otherBank.id,
        journalEntryId: reversedEffects.entryId,
        paymentDate: "2026-05-02",
        amount: 100,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("bank account effects do not match");

      // The database trigger deliberately enforces structural context only;
      // the central evidence engine owns canonical/source-account semantics.
      // A legacy/directly injected row therefore remains fail-closed in both
      // status and audit instead of being counted as a payment.
      db.run(
        `INSERT INTO invoice_payments
           (invoice_document_id, bank_transaction_id, journal_entry_id, payment_date, amount, currency)
         VALUES (?, ?, ?, '2026-05-02', 100, 'DKK')`,
        fixture.invoice.id,
        fixture.otherBank.id,
        reversedEffects.entryId!,
      );
      expect(getInvoiceStatus(db, fixture.invoice.id).ok).toBe(false);
      expect(verifyAuditChain(db).ok).toBe(false);
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("validates exact context, amount, direction, status, and allowed journal groups", () => {
    const fixture = setupEvidenceFixture("rentemester-invoice-evidence-matrix-");
    const { db } = fixture;
    try {
      expect(validateInvoiceJournalEvidence(db, {
        candidates: [paymentCandidate(fixture)],
      })).toEqual({ ok: true, errors: [] });

      const cases: Array<[string, Partial<InvoiceJournalApplicationCandidate>, RegExp]> = [
        ["invoice", { invoiceDocumentId: fixture.otherInvoice.id }, /references invoice document/],
        ["bank", { bankTransactionId: fixture.otherBank.id }, /bank transaction .* does not match/],
        ["date", { effectiveDate: "2026-05-03" }, /date .* does not match/],
        ["currency", { currency: "EUR" }, /currency .* does not match/],
        ["amount", { amount: 99.99 }, /does not match invoice application total/],
        ["non-finite amount", { amount: Number.NaN }, /positive finite number/],
        ["direction", { kind: "refund" }, /wrong direction/],
        ["missing journal", { journalEntryId: 999999 }, /missing journal evidence/],
      ];
      for (const [_name, overrides, expected] of cases) {
        const result = validateInvoiceJournalEvidence(db, {
          candidates: [paymentCandidate(fixture, overrides)],
        });
        expect(result.ok).toBe(false);
        expect(result.errors.join(" ")).toMatch(expected);
      }

      const combined = validateInvoiceJournalEvidence(db, {
        candidates: [
          paymentCandidate(fixture, { amount: 70 }),
          paymentCandidate(fixture, { kind: "claim", amount: 30 }),
        ],
      });
      expect(combined).toEqual({ ok: true, errors: [] });

      const missingCompanion = validateInvoiceJournalEvidence(db, {
        candidates: [paymentCandidate(fixture, { amount: 70 })],
      });
      expect(missingCompanion.ok).toBe(false);
      expect(missingCompanion.errors.join(" ")).toContain("does not match invoice application total 70");

      const illegalGroup = validateInvoiceJournalEvidence(db, {
        candidates: [
          paymentCandidate(fixture, { amount: 50 }),
          paymentCandidate(fixture, { kind: "refund", amount: 50 }),
        ],
      });
      expect(illegalGroup.ok).toBe(false);
      expect(illegalGroup.errors.join(" ")).toContain("unsupported invoice application group");

      const reversal = reverseJournalEntry(db, {
        entryId: fixture.journal!.entryId!,
        transactionDate: "2026-05-02",
        reason: "Evidence status test",
      });
      expect(reversal.ok).toBe(false);
      expect(reversal.errors.join(" ")).toContain("protected invoice evidence");
      const evidenceAfterReversal = validateInvoiceJournalEvidence(db, {
        candidates: [paymentCandidate(fixture)],
      });
      expect(evidenceAfterReversal).toEqual({ ok: true, errors: [] });
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("status and audit fail closed on a persisted amount mismatch", () => {
    const fixture = setupEvidenceFixture("rentemester-invoice-evidence-tamper-");
    const { db } = fixture;
    try {
      db.exec("DROP TRIGGER invoice_refunds_require_journal");
      db.run(
        `INSERT INTO invoice_refunds
           (invoice_document_id, bank_transaction_id, journal_entry_id, refund_date, amount, currency, note)
         VALUES (?, ?, ?, '2026-05-02', 99.99, 'DKK', 'tampered evidence')`,
        fixture.invoice.id,
        fixture.bank.id,
        fixture.journal!.entryId!,
      );

      const status = getInvoiceStatus(db, fixture.invoice.id);
      expect(status.ok).toBe(false);
      expect(status.openBalance).toBeUndefined();
      expect(status.errors.join(" ")).toContain("invoice application total 99.99");

      const audit = verifyAuditChain(db);
      expect(audit.ok).toBe(false);
      expect(audit.errors.some((error) =>
        error.includes("journal entry") && error.includes("invoice application total 99.99"),
      )).toBe(true);
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("database guards reject missing and structurally mismatched refund/claim evidence", () => {
    const fixture = setupEvidenceFixture("rentemester-invoice-evidence-triggers-");
    const { db } = fixture;
    try {
      expect(() => db.run(
        `INSERT INTO invoice_payments
           (invoice_document_id, bank_transaction_id, journal_entry_id, payment_date, amount, currency)
         VALUES (?, ?, ?, '2026-05-03', 100, 'DKK')`,
        fixture.invoice.id,
        fixture.bank.id,
        fixture.journal!.entryId!,
      )).toThrow("invoice payment journal evidence must match");
      expect(() => db.run(
        `INSERT INTO invoice_refunds
           (invoice_document_id, bank_transaction_id, refund_date, amount, currency)
         VALUES (?, ?, '2026-05-02', 100, 'DKK')`,
        fixture.invoice.id,
        fixture.bank.id,
      )).toThrow("invoice refunds must reference a journal entry");
      expect(() => db.run(
        `INSERT INTO invoice_claim_payments
           (invoice_document_id, bank_transaction_id, payment_date, amount, currency)
         VALUES (?, ?, '2026-05-02', 100, 'DKK')`,
        fixture.invoice.id,
        fixture.bank.id,
      )).toThrow("invoice claim payments must reference a journal entry");

      expect(() => db.run(
        `INSERT INTO invoice_refunds
           (invoice_document_id, bank_transaction_id, journal_entry_id, refund_date, amount, currency)
         VALUES (?, ?, ?, '2026-05-03', 100, 'DKK')`,
        fixture.invoice.id,
        fixture.bank.id,
        fixture.journal!.entryId!,
      )).toThrow("invoice refund journal evidence must match");
      expect(() => db.run(
        `INSERT INTO invoice_claim_payments
           (invoice_document_id, bank_transaction_id, journal_entry_id, payment_date, amount, currency)
         VALUES (?, ?, ?, '2026-05-03', 100, 'DKK')`,
        fixture.invoice.id,
        fixture.bank.id,
        fixture.journal!.entryId!,
      )).toThrow("invoice claim payment journal evidence must match");
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
