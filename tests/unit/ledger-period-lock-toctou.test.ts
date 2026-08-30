// Tests: src/core/ledger.ts postJournalEntry — KODE-4.
//
// validateJournalEntry (which includes the period-lock check via
// validateJournalTransactionDate) used to run OUTSIDE the write transaction.
// Between that validation and the INSERT, a period covering the transaction
// date could be closed (the TOCTOU window), and the posting would still land
// in the now-locked period. The fix re-checks the period lock INSIDE the
// BEGIN IMMEDIATE transaction, so a period closed after validation aborts the
// post deterministically.
//
// The race is made deterministic here by closing the period from inside a
// proxy that fires right as the transaction body begins — the same connection,
// the same write transaction, exactly the window the production code must
// defend.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { postJournalEntry, seedAccounts } from "../../src/core/ledger";
import { closeAccountingPeriod } from "../helpers/close-period";

function freshDb(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

describe("period-lock TOCTOU on postJournalEntry (KODE-4)", () => {
  test("a period closed during the write transaction aborts the post", () => {
    const { root, db } = freshDb("rentemester-toctou-");

    // Simulate the concurrent close happening AFTER validateJournalEntry has
    // accepted the date but BEFORE/AS the write transaction runs. We wrap
    // db.transaction so the first time it is invoked (the post's own
    // BEGIN IMMEDIATE), we first close the period — then run the real body.
    const realTransaction = db.transaction.bind(db);
    let closedOnce = false;
    (db as any).transaction = (fn: () => unknown, opts?: unknown) =>
      realTransaction(() => {
        if (!closedOnce) {
          closedOnce = true;
          const closed = closeAccountingPeriod(db, {
            periodStart: "2026-04-01",
            periodEnd: "2026-06-30",
            kind: "vat_quarter",
            // The period ends in the (harness-clock) future; force past the
            // EJER-6 future guard — this test exercises the KODE-4 race, not it.
            force: true,
          });
          expect(closed.ok).toBe(true);
        }
        return fn();
      }, opts as any);

    const result = postJournalEntry(db, {
      transactionDate: "2026-05-15",
      text: "Owner contribution racing a close",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 },
      ],
    });

    (db as any).transaction = realTransaction;

    // The re-check inside the transaction must reject the post.
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("closed period");

    // And nothing was written: no journal entry survived the aborted post.
    const count = (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n;
    expect(count).toBe(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a normal post into an open period still succeeds", () => {
    const { root, db } = freshDb("rentemester-toctou-ok-");
    const result = postJournalEntry(db, {
      transactionDate: "2026-05-15",
      text: "Owner contribution",
      lines: [
        { accountNo: "2000", debitAmount: 1000 },
        { accountNo: "5000", creditAmount: 1000 },
      ],
    });
    expect(result.ok).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
