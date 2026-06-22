// Tests: src/core/companies-schema.ts — the legacy NOT NULL -> nullable
// `vat_period_type` rebuild. This path only fires on a ledger that an interim
// #289 build migrated to `vat_period_type NOT NULL DEFAULT 'quarter'`; it was
// previously untested. The rebuild must relax nullability WITHOUT losing data,
// the CHECK constraints on the other columns, or the companies_fiscal_lock
// trigger.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureNullableVatPeriodColumn } from "../../src/core/companies-schema";

/** A ledger shaped like the interim #289 build: vat_period_type is NOT NULL. */
function legacyDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE companies (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Unnamed company',
      country TEXT NOT NULL DEFAULT 'DK',
      currency TEXT NOT NULL DEFAULT 'DKK',
      cvr TEXT,
      fiscal_year_start_month INTEGER NOT NULL DEFAULT 1 CHECK(fiscal_year_start_month BETWEEN 1 AND 12),
      fiscal_year_label_strategy TEXT NOT NULL DEFAULT 'end-year' CHECK(fiscal_year_label_strategy IN ('end-year', 'start-year', 'span')),
      payment_terms_days INTEGER NOT NULL DEFAULT 14 CHECK(payment_terms_days BETWEEN 0 AND 365),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      vat_period_type TEXT NOT NULL DEFAULT 'quarter' CHECK(vat_period_type IN ('month', 'quarter', 'half-year'))
    );
    CREATE TABLE journal_entries (id INTEGER PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS companies_fiscal_lock
    BEFORE UPDATE ON companies
    WHEN (OLD.fiscal_year_start_month != NEW.fiscal_year_start_month
       OR OLD.fiscal_year_label_strategy != NEW.fiscal_year_label_strategy)
     AND EXISTS(SELECT 1 FROM journal_entries LIMIT 1)
    BEGIN
      SELECT RAISE(ABORT, 'fiscal year configuration is locked after the first journal entry');
    END;
  `);
  db.run(
    "INSERT INTO companies (id, name, fiscal_year_start_month, payment_terms_days, vat_period_type) VALUES (1, 'Legacy ApS', 3, 30, 'half-year')",
  );
  return db;
}

function vatColumnIsNullable(db: Database): boolean {
  const cols = db.query("PRAGMA table_info(companies)").all() as Array<{ name: string; notnull: number }>;
  const col = cols.find((c) => c.name === "vat_period_type");
  return col !== undefined && col.notnull === 0;
}

describe("ensureNullableVatPeriodColumn — legacy NOT NULL rebuild", () => {
  test("relaxes NOT NULL to nullable while preserving every stored value", () => {
    const db = legacyDb();
    expect(vatColumnIsNullable(db)).toBe(false);

    ensureNullableVatPeriodColumn(db);

    expect(vatColumnIsNullable(db)).toBe(true);
    const row = db.query("SELECT name, fiscal_year_start_month AS f, payment_terms_days AS p, vat_period_type AS v FROM companies WHERE id = 1").get() as {
      name: string;
      f: number;
      p: number;
      v: string | null;
    };
    expect(row).toEqual({ name: "Legacy ApS", f: 3, p: 30, v: "half-year" });
    db.close();
  });

  test("an explicit NULL write succeeds after the rebuild (the deregistration path)", () => {
    const db = legacyDb();
    ensureNullableVatPeriodColumn(db);
    db.run("UPDATE companies SET vat_period_type = NULL WHERE id = 1");
    const v = db.query("SELECT vat_period_type AS v FROM companies WHERE id = 1").get() as { v: string | null };
    expect(v.v).toBeNull();
    db.close();
  });

  test("CHECK constraints on the OTHER columns survive the rebuild", () => {
    const db = legacyDb();
    ensureNullableVatPeriodColumn(db);
    // fiscal_year_start_month BETWEEN 1 AND 12 — a bogus value must still be rejected.
    expect(() =>
      db.run("INSERT INTO companies (id, name, fiscal_year_start_month) VALUES (2, 'Bad', 99)"),
    ).toThrow();
    // payment_terms_days BETWEEN 0 AND 365.
    expect(() =>
      db.run("INSERT INTO companies (id, name, payment_terms_days) VALUES (3, 'Bad', 9999)"),
    ).toThrow();
    // fiscal_year_label_strategy IN (...).
    expect(() =>
      db.run("INSERT INTO companies (id, name, fiscal_year_label_strategy) VALUES (4, 'Bad', 'bogus')"),
    ).toThrow();
    // The vat_period_type CHECK still rejects an out-of-set value.
    expect(() =>
      db.run("UPDATE companies SET vat_period_type = 'yearly' WHERE id = 1"),
    ).toThrow();
    db.close();
  });

  test("the companies_fiscal_lock trigger is restored by the rebuild", () => {
    const db = legacyDb();
    ensureNullableVatPeriodColumn(db);
    // With at least one journal entry, changing the fiscal-year config must be
    // blocked by the (re-created) trigger.
    db.run("INSERT INTO journal_entries (id) VALUES (1)");
    expect(() =>
      db.run("UPDATE companies SET fiscal_year_start_month = 5 WHERE id = 1"),
    ).toThrow(/fiscal year configuration is locked/);
    db.close();
  });

  test("is idempotent: a second call on the already-nullable table is a no-op", () => {
    const db = legacyDb();
    ensureNullableVatPeriodColumn(db);
    expect(vatColumnIsNullable(db)).toBe(true);
    ensureNullableVatPeriodColumn(db);
    expect(vatColumnIsNullable(db)).toBe(true);
    const count = db.query("SELECT COUNT(*) AS n FROM companies").get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });
});
