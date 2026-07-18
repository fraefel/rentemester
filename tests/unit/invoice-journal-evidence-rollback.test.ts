// Tests: atomic journal/application writes for invoice settlement evidence.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { importBankCsv } from "../../src/core/bank";
import { settleInvoiceFromBank } from "../../src/core/invoice-settlement";
import { settleInvoiceClaimsFromBank } from "../../src/core/invoice-claim-settlement";
import { refundInvoiceToBank } from "../../src/core/invoice-refunds";
import { issueCreditNote } from "../../src/core/credit-notes";
import { registerInvoiceReminder, postInvoiceReminderToLedger } from "../../src/core/invoice-reminders";

function setupInvoice(prefix: string) {
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
  return { root, db, invoiceDocumentId: issued.documentId! };
}

function importBank(
  db: ReturnType<typeof openDb>,
  root: string,
  filename: string,
  date: string,
  amount: number,
  reference: string,
) {
  const csvPath = join(root, filename);
  writeFileSync(
    csvPath,
    `transaction_date,booking_date,text,amount,currency,reference\n${date},${date},Evidence rollback,${amount},DKK,${reference}\n`,
  );
  expect(importBankCsv(db, root, csvPath).ok).toBe(true);
  return db.query("SELECT id FROM bank_transactions WHERE reference = ?").get(reference) as { id: number };
}

function snapshot(db: ReturnType<typeof openDb>) {
  return {
    journals: db.query("SELECT COUNT(*) AS n FROM journal_entries").get(),
    payments: db.query("SELECT COUNT(*) AS n FROM invoice_payments").get(),
    refunds: db.query("SELECT COUNT(*) AS n FROM invoice_refunds").get(),
    claims: db.query("SELECT COUNT(*) AS n FROM invoice_claim_payments").get(),
    audits: db.query("SELECT COUNT(*) AS n FROM audit_log").get(),
    sequences: db.query(
      "SELECT kind, scope, value FROM sequences WHERE kind = 'journal_entry' ORDER BY scope",
    ).all(),
  };
}

function expectOneJournalAllocated(
  before: ReturnType<typeof snapshot>,
  after: ReturnType<typeof snapshot>,
) {
  expect((after.journals as { n: number }).n).toBe((before.journals as { n: number }).n + 1);
  const beforeSequences = before.sequences as Array<{ kind: string; scope: string; value: number }>;
  const afterSequences = after.sequences as Array<{ kind: string; scope: string; value: number }>;
  expect(afterSequences).toHaveLength(beforeSequences.length);
  for (let index = 0; index < beforeSequences.length; index += 1) {
    expect(afterSequences[index]?.scope).toBe(beforeSequences[index]?.scope);
    expect(afterSequences[index]?.value).toBe(beforeSequences[index]!.value + 1);
  }
}

describe("invoice journal evidence transaction rollback", () => {
  test("refund failure rolls back journal, audit, application and sequence before a gap-free retry", () => {
    const fixture = setupInvoice("rentemester-refund-evidence-rollback-");
    const { db } = fixture;
    try {
      const principal = importBank(db, fixture.root, "principal.csv", "2026-05-20", 1250, "RB-REFUND-PRINCIPAL");
      expect(settleInvoiceFromBank(db, { invoiceDocumentId: fixture.invoiceDocumentId, bankTransactionId: principal.id }).ok).toBe(true);
      expect(issueCreditNote(db, fixture.root, {
        originalInvoiceDocumentId: fixture.invoiceDocumentId,
        issueDate: "2026-05-21",
        reason: "Refund rollback setup",
      }).ok).toBe(true);
      const bank = importBank(db, fixture.root, "refund.csv", "2026-05-22", -1250, "RB-REFUND");

      db.exec(`CREATE TRIGGER force_refund_evidence_failure
        BEFORE INSERT ON invoice_refunds
        BEGIN SELECT RAISE(ABORT, 'forced refund evidence failure'); END;`);
      const before = snapshot(db);
      const failed = refundInvoiceToBank(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        bankTransactionId: bank.id,
      });
      expect(failed.ok).toBe(false);
      expect(failed.errors.join(" ")).toContain("forced refund evidence failure");
      expect(snapshot(db)).toEqual(before);

      db.exec("DROP TRIGGER force_refund_evidence_failure");
      const retry = refundInvoiceToBank(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        bankTransactionId: bank.id,
      });
      expect(retry.ok).toBe(true);
      expectOneJournalAllocated(before, snapshot(db));
      expect(verifyAuditChain(db).ok).toBe(true);
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("standalone claim failure rolls back journal, audit, application and sequence before retry", () => {
    const fixture = setupInvoice("rentemester-claim-evidence-rollback-");
    const { db } = fixture;
    try {
      expect(registerInvoiceReminder(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        reminderDate: "2026-06-26",
      }).ok).toBe(true);
      expect(postInvoiceReminderToLedger(db, { invoiceDocumentId: fixture.invoiceDocumentId }).ok).toBe(true);
      const principal = importBank(db, fixture.root, "principal.csv", "2026-06-27", 1250, "RB-CLAIM-PRINCIPAL");
      expect(settleInvoiceFromBank(db, { invoiceDocumentId: fixture.invoiceDocumentId, bankTransactionId: principal.id }).ok).toBe(true);
      const bank = importBank(db, fixture.root, "claim.csv", "2026-06-28", 100, "RB-CLAIM");

      db.exec(`CREATE TRIGGER force_claim_evidence_failure
        BEFORE INSERT ON invoice_claim_payments
        BEGIN SELECT RAISE(ABORT, 'forced claim evidence failure'); END;`);
      const before = snapshot(db);
      const failed = settleInvoiceClaimsFromBank(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        bankTransactionId: bank.id,
      });
      expect(failed.ok).toBe(false);
      expect(failed.errors.join(" ")).toContain("forced claim evidence failure");
      expect(snapshot(db)).toEqual(before);

      db.exec("DROP TRIGGER force_claim_evidence_failure");
      const retry = settleInvoiceClaimsFromBank(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        bankTransactionId: bank.id,
      });
      expect(retry.ok).toBe(true);
      expectOneJournalAllocated(before, snapshot(db));
      expect(verifyAuditChain(db).ok).toBe(true);
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("combined failure also rolls back the already-inserted principal row and both audit events", () => {
    const fixture = setupInvoice("rentemester-combined-evidence-rollback-");
    const { db } = fixture;
    try {
      expect(registerInvoiceReminder(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        reminderDate: "2026-06-26",
      }).ok).toBe(true);
      expect(postInvoiceReminderToLedger(db, { invoiceDocumentId: fixture.invoiceDocumentId }).ok).toBe(true);
      const bank = importBank(db, fixture.root, "combined.csv", "2026-06-28", 1350, "RB-COMBINED");

      db.exec(`CREATE TRIGGER force_combined_claim_failure
        BEFORE INSERT ON invoice_claim_payments
        BEGIN SELECT RAISE(ABORT, 'forced combined claim failure'); END;`);
      const before = snapshot(db);
      const failed = settleInvoiceFromBank(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        bankTransactionId: bank.id,
      });
      expect(failed.ok).toBe(false);
      expect(failed.errors.join(" ")).toContain("forced combined claim failure");
      expect(snapshot(db)).toEqual(before);

      db.exec("DROP TRIGGER force_combined_claim_failure");
      const retry = settleInvoiceFromBank(db, {
        invoiceDocumentId: fixture.invoiceDocumentId,
        bankTransactionId: bank.id,
      });
      expect(retry.ok).toBe(true);
      expect(retry.paymentId).toBeDefined();
      expect(retry.claimPaymentId).toBeDefined();
      expectOneJournalAllocated(before, snapshot(db));
      expect(verifyAuditChain(db).ok).toBe(true);
    } finally {
      db.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
