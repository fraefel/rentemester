// Tests: src/core/opening-balance.ts postOpeningBalance — KODE-6.
//
// The primobalance journal entry is committed by postJournalEntry, and the
// idempotency marker row in `opening_balances` was inserted in a SEPARATE,
// later transaction. A crash between the two commits leaves a posted opening
// journal entry with NO marker — so a re-run posts a SECOND primobalance,
// doubling every opening balance. The fix adds a textual fallback: an existing
// opening journal entry (recognised by its `Primobalance` text prefix) makes a
// second call idempotent even when the marker row is missing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { postJournalEntry, seedAccounts } from "../../src/core/ledger";
import { OPENING_BALANCE_TEXT, postOpeningBalance } from "../../src/core/opening-balance";

function freshDb(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

const LINES = [
  { accountNo: "2000", debitAmount: 5000 },
  { accountNo: "5000", creditAmount: 5000 },
];

describe("opening balance crash-recovery idempotency (KODE-6)", () => {
  test("a primo entry posted but missing its marker row is not doubled on re-run", () => {
    const { root, db } = freshDb("rentemester-primo-idem-");

    // Simulate the crash window directly: postJournalEntry committed the primo-
    // balance journal entry, but the process died before the SEPARATE marker
    // transaction ran — so the opening journal entry is durable while the
    // opening_balances marker row is absent. (Both tables are append-only, so we
    // reproduce the state rather than deleting a marker.)
    const posted = postJournalEntry(db, {
      transactionDate: "2026-01-01",
      text: `${OPENING_BALANCE_TEXT} pr. 2026-01-01`,
      lines: LINES,
    });
    expect(posted.ok).toBe(true);
    expect((db.query("SELECT COUNT(*) AS n FROM opening_balances").get() as { n: number }).n).toBe(0);

    // Re-running must be rejected: the opening journal entry already exists, so
    // a second primobalance would double the books.
    const second = postOpeningBalance(db, { cutOverDate: "2026-01-01", lines: LINES });
    expect(second.ok).toBe(false);
    expect(second.errors.join(" ").toLowerCase()).toContain("opening balance");

    // Exactly one primobalance journal entry exists — not two.
    const primoCount = (
      db
        .query("SELECT COUNT(*) AS n FROM journal_entries WHERE text LIKE 'Primobalance%'")
        .get() as { n: number }
    ).n;
    expect(primoCount).toBe(1);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the normal idempotency path (marker present) still rejects a second call", () => {
    const { root, db } = freshDb("rentemester-primo-idem-2-");
    expect(postOpeningBalance(db, { cutOverDate: "2026-01-01", lines: LINES }).ok).toBe(true);
    expect(postOpeningBalance(db, { cutOverDate: "2026-01-01", lines: LINES }).ok).toBe(false);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a manual entry whose text merely starts with 'Primobalance' does not block the first real primobalance (KODE-6)", () => {
    const { root, db } = freshDb("rentemester-primo-idem-3-");

    // A normal manual posting that happens to share the 'Primobalance' prefix —
    // e.g. a correction booked BEFORE the actual primobalance is established.
    // The textual fallback must NOT mistake this for THE opening entry, or the
    // first genuine primobalance is rejected as a false positive.
    const manual = postJournalEntry(db, {
      transactionDate: "2026-01-01",
      text: "Primobalance-korrektion (manuel)",
      lines: LINES,
    });
    expect(manual.ok).toBe(true);

    // No real primobalance has been posted yet, so this MUST succeed.
    const primo = postOpeningBalance(db, { cutOverDate: "2026-01-01", lines: LINES });
    expect(primo.errors).toEqual([]);
    expect(primo.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
