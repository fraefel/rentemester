// Schema helpers for the `companies` table. Kept out of `db.ts` so callers
// like `periods.ts` can use them without pulling `db.ts`'s wider import
// graph (which transitively reaches `company.ts` via `retention.ts`).

import type { Database } from "bun:sqlite";

/**
 * Ensure `companies.vat_period_type` exists AND is nullable.
 *
 * The column was added in #289 as `NOT NULL DEFAULT 'quarter'` from a
 * defensive helper outside `migrate()`. A non-VAT-registered company has no
 * meaningful cadence — `null` is the canonical "not registered" state — so
 * the column must allow NULL. SQLite cannot relax a NOT NULL in place, so
 * for an older ledger we rebuild the `companies` row with the relaxed CHECK
 * and copy every stored column across. Idempotent: a fresh ledger gets the
 * column added nullable from the start; a ledger that already carries the
 * nullable column is a no-op.
 *
 * Called both from `migrate()` and from `setCompanyVatPeriodType` so a
 * caller that forgot to run `migrate(db)` still gets the correct shape.
 */
export function ensureNullableVatPeriodColumn(db: Database) {
  const cols = db.query("PRAGMA table_info(companies)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const existing = cols.find((c) => c.name === "vat_period_type");
  if (!existing) {
    // `DEFAULT 'quarter'` is deliberate: an EXISTING company row (a pre-#289
    // ledger that never had this column) was implicitly a quarterly VAT filer,
    // so it must come back registered — never silently flip to NULL = "not
    // VAT-registered". NULL is reserved for an EXPLICIT deregistration write
    // (`init --no-vat`, `set-profile --no-vat`, the PATCH-profile endpoint); it
    // is never the byproduct of adding the column. The CHECK still permits NULL
    // so those explicit writes succeed.
    db.exec(
      "ALTER TABLE companies ADD COLUMN vat_period_type TEXT DEFAULT 'quarter' " +
        "CHECK(vat_period_type IS NULL OR vat_period_type IN ('month', 'quarter', 'half-year'));",
    );
    return;
  }
  if (existing.notnull === 0) return;

  // Older ledger: the column carries the legacy `NOT NULL DEFAULT 'quarter'`
  // definition. Relax it to nullable. We rebuild from the table's CANONICAL
  // CREATE SQL (sqlite_master) and rewrite ONLY the vat_period_type column —
  // PRAGMA table_info does NOT expose CHECK constraints, so reconstructing the
  // column list from PRAGMA would silently DROP the CHECKs on the other columns
  // (fiscal_year_start_month, fiscal_year_label_strategy, payment_terms_days).
  // DROP TABLE also drops the table's triggers + indexes (e.g. the
  // `companies_fiscal_lock` config guard), so we capture and re-create them in
  // the same transaction rather than leaving them gone until the next migrate().
  const tableSql = (
    db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'companies'")
      .get() as { sql: string } | null
  )?.sql;
  if (!tableSql) return;
  // Drop only `NOT NULL` from the column, keeping its DEFAULT and CHECK. The
  // CHECK already admits NULL (`NULL IN (...)` is NULL, never FALSE, so a CHECK
  // passes), so relaxing nullability needs no CHECK change.
  const relaxedSql = tableSql.replace(
    /vat_period_type\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'quarter'/i,
    "vat_period_type TEXT DEFAULT 'quarter'",
  );
  if (relaxedSql === tableSql) {
    // The expected legacy fragment was not found (unknown column shape). Bail
    // out rather than risk a malformed rebuild — the column stays as it is.
    return;
  }
  const rebuildSql = relaxedSql.replace(
    /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?companies"?/i,
    "CREATE TABLE companies_vat_period_rebuild",
  );
  const triggers = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'companies' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  const indexes = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'companies' AND sql IS NOT NULL")
    .all() as Array<{ sql: string }>;
  const columnList = cols.map((c) => c.name).join(", ");

  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS companies_vat_period_rebuild;");
    db.exec(rebuildSql);
    db.exec(
      `INSERT INTO companies_vat_period_rebuild (${columnList}) SELECT ${columnList} FROM companies;`,
    );
    db.exec("DROP TABLE companies;");
    db.exec("ALTER TABLE companies_vat_period_rebuild RENAME TO companies;");
    for (const t of triggers) db.exec(t.sql);
    for (const i of indexes) db.exec(i.sql);
  })();
}
