// Tests: src/core/periods.ts — EJER-4: closing an accounting period must
// refuse when the period contains UNRECONCILED bank transactions (no posted
// journal entry linked via journal_entries.source_bank_transaction_id).
//
// The audit scenario: an incoming payment of 2,500 kr sat as an
// UNMATCHED_BANK_TRANSACTION exception; the owner "resolved" the exception
// with a free-text note WITHOUT booking it. The open-exceptions close guard
// then passed, the VAT period was closed, the VAT filing was 500 kr too low,
// and the late booking was rejected (closed period). The close guard must
// look at the reconciliation model itself — not only the exception queue.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntry } from "../../src/core/ledger";
import { seedNativeAccountRoles } from "../../src/core/account-roles";
import { ingestDocument } from "../../src/core/documents";
import { importBankCsv } from "../../src/core/bank";
import { closeAccountingPeriod } from "../../src/core/periods";
import { createPeriodCloseReadinessPacket, reviewPeriodCloseReadiness } from "../../src/core/period-close-readiness";
import {
  listExceptions,
  resolveException,
  syncUnmatchedBankTransactionExceptions,
} from "../../src/core/exceptions";

function setup(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const inbox = mkdtempSync(join(tmpdir(), `${prefix}inbox-`));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  seedNativeAccountRoles(db);
  db.query(
    `INSERT INTO companies (id, name, country, currency, cvr, company_form, fiscal_year_start_month, fiscal_year_label_strategy)
     VALUES (1, 'Rentemester ApS', 'DK', 'DKK', 'DK12345678', 'Anpartsselskab', 1, 'end-year')`,
  ).run();
  return { root, inbox, db };
}

function importOneBankTransaction(
  db: ReturnType<typeof openDb>,
  root: string,
  inbox: string,
  date: string,
  text: string,
  amount: number,
): number {
  const csv = join(inbox, `bank-${date}-${Math.abs(amount)}.csv`);
  writeFileSync(csv, `transaction_date,text,amount,currency\n${date},${text},${amount},DKK\n`);
  expect(importBankCsv(db, root, csv).ok).toBe(true);
  const row = db
    .query(
      `SELECT id FROM bank_transactions WHERE transaction_date = ? AND text = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(date, text) as { id: number };
  return row.id;
}

function teardown(args: { root: string; inbox: string; db: ReturnType<typeof openDb> }) {
  args.db.close();
  rmSync(args.root, { recursive: true, force: true });
  rmSync(args.inbox, { recursive: true, force: true });
}

function reviewed(db: ReturnType<typeof openDb>, packet: ReturnType<typeof createPeriodCloseReadinessPacket>) {
  const review = reviewPeriodCloseReadiness(db, { packet, reviewerActor: "user:ejer", reviewerPrincipal: { kind: "local-trusted", subjectId: "ejer" } });
  return { readinessPacketHash: packet.hash, readinessReviewId: review.id };
}

describe("closeAccountingPeriod — unreconciled bank transactions guard (EJER-4)", () => {
  test("refuses to close a period containing an unreconciled bank transaction, even when its exception was note-resolved without booking", () => {
    const ctx = setup("rentemester-close-unrec-");
    const { db } = ctx;

    // The 2,500 kr incoming payment from the audit scenario.
    const bankId = importOneBankTransaction(db, ctx.root, ctx.inbox, "2026-02-15", "Indbetaling kunde", 2500);

    // The agent surfaces it as an exception …
    syncUnmatchedBankTransactionExceptions(db);
    const ex = listExceptions(db, { status: "open" }).rows.find(
      (r) => r.type === "UNMATCHED_BANK_TRANSACTION",
    );
    expect(ex).toBeDefined();
    // … and the owner "resolves" it with a free-text note WITHOUT booking.
    expect(
      resolveException(db, { id: ex!.id, note: "Det er en indbetaling fra en kunde", resolvedBy: "user:ejer" }).ok,
    ).toBe(true);
    expect(
      listExceptions(db, { status: "open" }).rows.some((r) => r.type === "UNMATCHED_BANK_TRANSACTION"),
    ).toBe(false);

    // The close must STILL refuse: the bank transaction is unreconciled.
    const readiness = createPeriodCloseReadinessPacket(db, { periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    const close = closeAccountingPeriod(db, {
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      kind: "vat_quarter",
      createdBy: "user:ejer",
      ...reviewed(db, readiness),
    });
    expect(close.ok).toBe(false);
    const error = close.errors.join(" ");
    // Danish, names the count and an example, and explains the consequence.
    expect(error).toBe("PERIOD_CLOSE_BLOCKED:1");

    teardown(ctx);
  });

  test("force:true cannot waive an unavailable independent control reconciliation", () => {
    const ctx = setup("rentemester-close-unrec-force-");
    const { db } = ctx;

    importOneBankTransaction(db, ctx.root, ctx.inbox, "2026-02-15", "Indbetaling kunde", 2500);

    const readiness = createPeriodCloseReadinessPacket(db, { periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    const close = closeAccountingPeriod(db, {
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      kind: "vat_quarter",
      createdBy: "user:ejer",
      force: true,
      forceAuthorization: { principal: { kind: "local-trusted", subjectId: "ejer" }, permissions: ["company.period.force-close"] },
      forceConfirmed: true,
      forceReason: "synthetic unreconciled-bank close waiver",
      ...reviewed(db, readiness),
    });
    expect(close.ok).toBe(false);
    expect(close.errors).toContain("PERIOD_CLOSE_HAS_NONWAIVABLE_BLOCKERS");
    expect(db.query("SELECT COUNT(*) AS n FROM accounting_periods").get()).toEqual({ n: 0 });

    teardown(ctx);
  });

  test("a reconciled (booked) bank transaction and out-of-period transactions do not block close", () => {
    const ctx = setup("rentemester-close-unrec-ok-");
    const { db } = ctx;

    // In-period transaction, properly booked against a posted journal entry.
    const bankId = importOneBankTransaction(db, ctx.root, ctx.inbox, "2026-02-15", "Indbetaling kunde", 2500);
    const sourceFile = join(ctx.inbox, "F-100.txt");
    writeFileSync(sourceFile, "Faktura F-100\n2500 DKK\n");
    const doc = ingestDocument(db, ctx.root, sourceFile, {
      source: "email",
      issueDate: "2026-02-10",
      invoiceNo: "F-100",
      deliveryDescription: "Konsulentydelse",
      amountIncVat: 2500,
      currency: "DKK",
      sender: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      recipient: { name: "Kunde A/S", address: "Kundevej 2", vatOrCvr: "DK11223344" },
      vatAmount: 500,
      paymentDetails: "Bank transfer",
    });
    expect(doc.ok).toBe(true);
    expect(
      postJournalEntry(db, {
        transactionDate: "2026-02-15",
        text: "Indbetaling kunde — F-100",
        documentId: doc.documentId!,
        sourceBankTransactionId: bankId,
        lines: [
          { accountNo: "2000", debitAmount: 2500 },
          { accountNo: "1000", creditAmount: 2000, vatCode: "DK_SALE_25" },
          { accountNo: "1200", creditAmount: 500 },
        ],
      }).ok,
    ).toBe(true);

    // An unreconciled transaction OUTSIDE the period must not block either.
    importOneBankTransaction(db, ctx.root, ctx.inbox, "2026-04-05", "Indbetaling april", 1000);

    const readiness = createPeriodCloseReadinessPacket(db, { periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    const close = closeAccountingPeriod(db, {
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      kind: "vat_quarter",
      createdBy: "user:ejer",
      ...reviewed(db, readiness),
    });
    expect(close.errors).toEqual([]);
    expect(close.ok).toBe(true);

    teardown(ctx);
  });
});
