// Tests: src/core/db.ts — canonical trigger/view restoration.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, openDb } from "../../src/core/db";
import { inspectSchemaViews, repairCanonicalSchemaViews } from "../../src/core/ledger-inspection";

function failOneCanonicalTriggerCreate(realDb: any) {
  return new Proxy(realDb, {
    get(target, property, receiver) {
      if (property === "exec") {
        return (sql: string) => {
          if (/^CREATE TRIGGER\s+issued_invoice_postings_validate_insert\b/i.test(sql.trim())) {
            throw new Error("simulated canonical trigger create failure");
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as any;
}

describe("database trigger restoration", () => {
  test("a failed CREATE rolls the preceding DROP back and preserves the live guard", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-trigger-restore-"));
    const db = openDb(join(root, "ledger.sqlite"));
    migrate(db);
    db.exec(`
      DROP TRIGGER issued_invoice_postings_validate_insert;
      CREATE TRIGGER issued_invoice_postings_validate_insert
      BEFORE INSERT ON issued_invoice_postings
      BEGIN
        SELECT RAISE(ABORT, 'sentinel guard remains installed');
      END;
    `);

    expect(() => migrate(failOneCanonicalTriggerCreate(db))).toThrow(
      "simulated canonical trigger create failure",
    );
    const restoredSql = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'issued_invoice_postings_validate_insert'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    expect(restoredSql).toContain("sentinel guard remains installed");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("migrate leaves a stale view for explicit canonical repair", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-view-restore-"));
    const db = openDb(join(root, "ledger.sqlite"));
    migrate(db);
    db.exec(`
      DROP VIEW invoice_interest_correction_authorized_claims;
      CREATE VIEW invoice_interest_correction_authorized_claims AS
      SELECT 1 AS sentinel;
    `);

    migrate(db);
    const restoredSql = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'view' AND name = 'invoice_interest_correction_authorized_claims'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    expect(restoredSql).toContain("sentinel");
    expect(inspectSchemaViews(db).ok).toBe(false);

    const repaired = repairCanonicalSchemaViews(db);
    expect(repaired.ok).toBe(true);
    const canonicalSql = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'view' AND name = 'invoice_interest_correction_authorized_claims'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    expect(canonicalSql).toContain("WITH RECURSIVE");
    expect(canonicalSql).not.toContain("sentinel");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("migrate restores triggers but leaves view repair to the explicit command", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-claim-guard-restore-"));
    const db = openDb(join(root, "ledger.sqlite"));
    migrate(db);
    db.exec(`
      DROP TRIGGER credit_note_single_active_journal;
      CREATE TRIGGER credit_note_single_active_journal
      BEFORE INSERT ON journal_entries BEGIN SELECT 1; END;
      DROP TRIGGER journal_entries_reversal_shape_insert;
      CREATE TRIGGER journal_entries_reversal_shape_insert
      BEFORE INSERT ON journal_entries BEGIN SELECT 1; END;
      DROP TRIGGER invoice_reminder_postings_validate_insert;
      CREATE TRIGGER invoice_reminder_postings_validate_insert
      BEFORE INSERT ON invoice_reminder_postings BEGIN SELECT 1; END;
      DROP TRIGGER invoice_bad_debt_writeoffs_validate_insert;
      CREATE TRIGGER invoice_bad_debt_writeoffs_validate_insert
      AFTER INSERT ON invoice_bad_debt_writeoffs BEGIN SELECT 1; END;
      DROP VIEW invoice_claim_posting_journal_evidence;
      CREATE VIEW invoice_claim_posting_journal_evidence AS
      SELECT 1 AS sentinel;
      DROP VIEW invoice_bad_debt_writeoff_journal_evidence;
      CREATE VIEW invoice_bad_debt_writeoff_journal_evidence AS
      SELECT 1 AS sentinel;
    `);

    migrate(db);
    const creditTrigger = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'credit_note_single_active_journal'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    const claimTrigger = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'invoice_reminder_postings_validate_insert'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    const claimView = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'view' AND name = 'invoice_claim_posting_journal_evidence'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    const reversalTrigger = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'journal_entries_reversal_shape_insert'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    const badDebtTrigger = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'invoice_bad_debt_writeoffs_validate_insert'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    const badDebtView = (db.query(
      `SELECT sql FROM sqlite_master
        WHERE type = 'view' AND name = 'invoice_bad_debt_writeoff_journal_evidence'`,
    ).get() as { sql: string } | null)?.sql ?? "";
    expect(creditTrigger).toContain("only one accounting journal");
    expect(reversalTrigger).toContain("one existing unreversed posted original");
    expect(claimTrigger).toContain("exact DKK receivable/income journal");
    expect(claimView).toContain("sentinel");
    expect(badDebtTrigger).toContain("exact VAT-relief expense/output-VAT/receivable journal");
    expect(badDebtView).toContain("sentinel");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
