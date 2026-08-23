import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { seedAccounts, postJournalEntry, postVerifiedHistoricalImportEntry, verifyAuditChain } from "../../src/core/ledger";
import { addBankAccount, importBankCsv } from "../../src/core/bank";
import { linkBankTransactionToJournal } from "../../src/core/bank-journal-reconciliation";
import { listBankTransactions } from "../../src/core/reconciliation";
import { syncUnmatchedBankTransactionExceptions } from "../../src/core/exceptions";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-bank-history-link-"));
  const paths = ensureCompanyDirs(root);
  const db = openDb(paths.db);
  migrate(db);
  seedAccounts(db);
  const account = addBankAccount(db, { name: "Migration bank", slug: "migration-bank", ledgerAccountNo: "2000" });
  expect(account.ok).toBe(true);
  const csv = join(root, "bank.csv");
  writeFileSync(csv, [
    "transaction_date,text,amount,currency,reference",
    "2026-03-04,Historic card,-100.00,DKK,BANK-1",
    "2026-03-05,Other card,-50.00,DKK,BANK-2",
  ].join("\n"));
  const imported = importBankCsv(db, root, csv, { account: "migration-bank" });
  expect(imported.ok).toBe(true);
  const banks = db.query("SELECT id, reference FROM bank_transactions ORDER BY id").all() as Array<{ id: number; reference: string }>;
  const posted = postVerifiedHistoricalImportEntry(db, {
    transactionDate: "2026-03-02",
    text: "Imported historic card purchase",
    createdBy: "agent:test",
    lines: [
      { accountNo: "3000", debitAmount: 100 },
      { accountNo: "2000", creditAmount: 100 },
    ],
  });
  expect(posted.ok).toBe(true);
  return { root, db, bank1: banks[0]!.id, bank2: banks[1]!.id, journalId: Number(posted.entryId) };
}

describe("append-only bank reconciliation for imported journals", () => {
  test("links without a new journal, resolves the exception, and is idempotent", () => {
    const { root, db, bank1, journalId } = setup();
    try {
      expect(syncUnmatchedBankTransactionExceptions(db).ok).toBe(true);
      const countBefore = (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
      const linked = linkBankTransactionToJournal(db, {
        bankTransactionId: bank1,
        journalEntryId: journalId,
        matchMethod: "settlement-lag-amount",
        sourceReference: "synthetic:migration-voucher-1",
        createdBy: "agent:test",
        createdByProgram: "rentemester-import-test",
      });
      expect(linked.ok).toBe(true);
      expect(linked.idempotent).toBe(false);
      expect((db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n).toBe(countBefore);
      expect(listBankTransactions(db, { status: "matched" }).rows.map((row) => row.id)).toEqual([bank1]);
      expect(db.query("SELECT status FROM exceptions WHERE related_bank_transaction_id = ? AND type = 'UNMATCHED_BANK_TRANSACTION'").get(bank1)).toEqual({ status: "resolved" });
      expect(verifyAuditChain(db, { companyRoot: root }).ok).toBe(true);

      const repeated = linkBankTransactionToJournal(db, {
        bankTransactionId: bank1,
        journalEntryId: journalId,
        matchMethod: "settlement-lag-amount",
        createdBy: "agent:test",
      });
      expect(repeated.ok).toBe(true);
      expect(repeated.idempotent).toBe(true);
      expect(db.query("SELECT COUNT(*) AS n FROM bank_journal_reconciliation_links").get()).toEqual({ n: 1 });
      expect(() => db.run("UPDATE bank_journal_reconciliation_links SET note = 'x'")).toThrow("append-only");
      expect(() => db.run("DELETE FROM bank_journal_reconciliation_links")).toThrow("append-only");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed on amount mismatch and blocks a second accounting post", () => {
    const { root, db, bank1, bank2, journalId } = setup();
    try {
      const mismatch = linkBankTransactionToJournal(db, {
        bankTransactionId: bank2,
        journalEntryId: journalId,
        matchMethod: "manual-review",
        createdBy: "agent:test",
      });
      expect(mismatch.ok).toBe(false);
      expect(mismatch.errors.join(" ")).toContain("does not equal");

      expect(linkBankTransactionToJournal(db, {
        bankTransactionId: bank1,
        journalEntryId: journalId,
        matchMethod: "source-reference",
        sourceReference: "synthetic:ref",
        createdBy: "agent:test",
      }).ok).toBe(true);
      const duplicatePost = postJournalEntry(db, {
        transactionDate: "2026-03-04",
        text: "Must not double book",
        sourceBankTransactionId: bank1,
        createdBy: "agent:test",
        lines: [
          { accountNo: "5800", debitAmount: 100 },
          { accountNo: "2000", creditAmount: 100 },
        ],
      });
      expect(duplicatePost.ok).toBe(false);
      expect(duplicatePost.errors.join(" ")).toContain("already reconciled");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
