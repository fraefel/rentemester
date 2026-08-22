import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBuildIdentity } from "./build-identity";

export const BASELINE_SCHEMA_VERSION = 1;
export const BASELINE_MIGRATION_NAME = "rentemester-schema-baseline-v1";

// The ledger checksum is derived from an immutable, reviewable migration
// artifact. Its own tests bind the artifact to the exact schema.sql bytes and
// baseline-normalization body in db.ts.
const BASELINE_MIGRATION_ARTIFACT = readFileSync(
  join(import.meta.dir, "migrations", "0001-baseline.json"),
);
export const BASELINE_MIGRATION_CHECKSUM = createHash("sha256")
  .update(BASELINE_MIGRATION_ARTIFACT)
  .digest("hex");
const PEPPOL_SUBMISSION_EVENTS_MIGRATION_ARTIFACT = readFileSync(
  join(import.meta.dir, "migrations", "0002-peppol-submission-events.json"),
);
export const PEPPOL_SUBMISSION_EVENTS_MIGRATION_CHECKSUM = createHash("sha256")
  .update(PEPPOL_SUBMISSION_EVENTS_MIGRATION_ARTIFACT)
  .digest("hex");
export const PEPPOL_SUBMISSION_EVENTS_MIGRATION_NAME = "rentemester-peppol-submission-events-v2";
const RECURRING_AUTOMATION_MIGRATION_ARTIFACT = readFileSync(
  join(import.meta.dir, "migrations", "0003-recurring-automation.json"),
);
export const RECURRING_AUTOMATION_MIGRATION_CHECKSUM = createHash("sha256")
  .update(RECURRING_AUTOMATION_MIGRATION_ARTIFACT)
  .digest("hex");
export const RECURRING_AUTOMATION_MIGRATION_NAME = "rentemester-recurring-automation-v3";
const DINERO_IMPORT_PROVENANCE_MIGRATION_ARTIFACT = readFileSync(
  join(import.meta.dir, "migrations", "0004-dinero-import-provenance.json"),
);
export const DINERO_IMPORT_PROVENANCE_MIGRATION_CHECKSUM = createHash("sha256")
  .update(DINERO_IMPORT_PROVENANCE_MIGRATION_ARTIFACT)
  .digest("hex");
export const DINERO_IMPORT_PROVENANCE_MIGRATION_NAME = "rentemester-dinero-import-provenance-v4";
const MIGRATION_OPEN_ITEMS_MIGRATION_ARTIFACT = readFileSync(
  join(import.meta.dir, "migrations", "0005-migration-open-items.json"),
);
export const MIGRATION_OPEN_ITEMS_MIGRATION_CHECKSUM = createHash("sha256")
  .update(MIGRATION_OPEN_ITEMS_MIGRATION_ARTIFACT)
  .digest("hex");
export const MIGRATION_OPEN_ITEMS_MIGRATION_NAME = "rentemester-migration-open-items-v5";

export type SupportedSchemaMigration = {
  id: number;
  name: string;
  checksum: string;
};

export type SchemaMigrationIdentity = {
  id: number;
  name: string;
  checksum?: string | null;
};

const SUPPORTED_SCHEMA_MIGRATIONS: readonly SupportedSchemaMigration[] = [
  {
    id: BASELINE_SCHEMA_VERSION,
    name: BASELINE_MIGRATION_NAME,
    checksum: BASELINE_MIGRATION_CHECKSUM,
  },
  {
    id: 2,
    name: PEPPOL_SUBMISSION_EVENTS_MIGRATION_NAME,
    checksum: PEPPOL_SUBMISSION_EVENTS_MIGRATION_CHECKSUM,
  },
  { id: 3, name: RECURRING_AUTOMATION_MIGRATION_NAME, checksum: RECURRING_AUTOMATION_MIGRATION_CHECKSUM },
  { id: 4, name: DINERO_IMPORT_PROVENANCE_MIGRATION_NAME, checksum: DINERO_IMPORT_PROVENANCE_MIGRATION_CHECKSUM },
  { id: 5, name: MIGRATION_OPEN_ITEMS_MIGRATION_NAME, checksum: MIGRATION_OPEN_ITEMS_MIGRATION_CHECKSUM },
];
export const CURRENT_SCHEMA_VERSION = SUPPORTED_SCHEMA_MIGRATIONS.at(-1)!.id;

type MigrationRow = {
  id: number;
  name: string;
  checksum?: string | null;
  applied_at: string;
  applied_by_version?: string | null;
  applied_by_commit?: string | null;
};

type MigrationColumn = {
  name: string;
  notnull: number;
};

function tableExists(db: Database): boolean {
  return db
    .query(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get() != null;
}

function migrationColumnInfo(db: Database): MigrationColumn[] {
  if (!tableExists(db)) return [];
  return db.query("PRAGMA table_info(schema_migrations)").all() as MigrationColumn[];
}

function migrationColumns(db: Database): Set<string> {
  return new Set(migrationColumnInfo(db).map((row) => row.name));
}

/** Validate a complete append-only prefix of the migrations this runtime knows. */
export function validateSchemaMigrationHistory(
  rows: readonly SchemaMigrationIdentity[],
  supported: readonly SupportedSchemaMigration[] = SUPPORTED_SCHEMA_MIGRATIONS,
  checksumsRequired = true,
): void {
  if (supported.some((migration, index) => migration.id !== index + 1)) {
    throw new Error("runtime schema migration catalog must be contiguous from version 1");
  }
  const newestSupported = supported.at(-1)?.id ?? 0;
  const newestApplied = rows.at(-1)?.id ?? 0;
  if (newestApplied > newestSupported) {
    throw new Error(
      `database schema version ${newestApplied} is newer than supported version ${newestSupported}; upgrade Rentemester before opening this ledger`,
    );
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const expected = supported[index];
    if (!expected || row.id !== expected.id) {
      throw new Error("schema migration history is not a complete append-only prefix");
    }
    if (row.name !== expected.name) {
      throw new Error(`schema migration ${row.id} has unexpected name '${row.name}'`);
    }
    if (checksumsRequired && !row.checksum) {
      throw new Error("schema migration history contains a missing checksum");
    }
    if (row.checksum && row.checksum !== expected.checksum) {
      throw new Error(
        `schema migration ${row.id} checksum mismatch; the ledger migration history may have been modified`,
      );
    }
  }
}

/** Reject a ledger created by newer or altered software before mutation. */
export function assertSchemaCompatibility(db: Database): void {
  if (!tableExists(db)) return;

  const columns = migrationColumns(db);
  const selectChecksum = columns.has("checksum") ? ", checksum" : "";
  const rows = db
    .query(`SELECT id, name, applied_at${selectChecksum} FROM schema_migrations ORDER BY id`)
    .all() as MigrationRow[];
  validateSchemaMigrationHistory(rows, SUPPORTED_SCHEMA_MIGRATIONS, columns.has("checksum"));
}

function createStrictMigrationTable(db: Database, name: string): void {
  db.exec(`
    CREATE TABLE ${name} (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_by_version TEXT NOT NULL,
      applied_by_commit TEXT
    );
  `);
}

/**
 * Stamp a successfully normalised schema and upgrade the legacy migration
 * ledger to strict NOT NULL provenance. A missing checksum is adopted only
 * when the legacy table never had a checksum column; once that column exists,
 * null means corrupt/incomplete history and assertSchemaCompatibility rejects it.
 */
export function recordSchemaBaseline(db: Database): void {
  const columns = migrationColumns(db);
  const columnInfo = migrationColumnInfo(db);
  const build = getBuildIdentity();
  const hasChecksumColumn = columns.has("checksum");
  const select = [
    "id",
    "name",
    "applied_at",
    hasChecksumColumn ? "checksum" : "NULL AS checksum",
    columns.has("applied_by_version")
      ? "applied_by_version"
      : "NULL AS applied_by_version",
    columns.has("applied_by_commit")
      ? "applied_by_commit"
      : "NULL AS applied_by_commit",
  ].join(", ");
  const rows = db
    .query(`SELECT ${select} FROM schema_migrations ORDER BY id`)
    .all() as MigrationRow[];

  validateSchemaMigrationHistory(rows, SUPPORTED_SCHEMA_MIGRATIONS, hasChecksumColumn);

  const strictColumns = new Map(columnInfo.map((column) => [column.name, column.notnull]));
  const isStrict =
    strictColumns.get("name") === 1 &&
    strictColumns.get("checksum") === 1 &&
    strictColumns.get("applied_at") === 1 &&
    strictColumns.get("applied_by_version") === 1 &&
    strictColumns.has("applied_by_commit");

  if (!isStrict) {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS schema_migrations_strict;");
      createStrictMigrationTable(db, "schema_migrations_strict");
      for (const row of rows) {
        db.query(
          `INSERT INTO schema_migrations_strict
             (id, name, checksum, applied_at, applied_by_version, applied_by_commit)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          row.id,
          row.name,
          row.checksum ?? SUPPORTED_SCHEMA_MIGRATIONS[row.id - 1]!.checksum,
          row.applied_at,
          row.applied_by_version ?? build.version,
          row.applied_by_commit ?? build.gitCommit,
        );
      }
      db.exec(`
        DROP TABLE schema_migrations;
        ALTER TABLE schema_migrations_strict RENAME TO schema_migrations;
      `);
    })();
  }

  const existing = db
    .query("SELECT id FROM schema_migrations WHERE id = ?")
    .get(BASELINE_SCHEMA_VERSION);
  if (!existing) {
    db.query(
      `INSERT INTO schema_migrations
         (id, name, checksum, applied_by_version, applied_by_commit)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      BASELINE_SCHEMA_VERSION,
      BASELINE_MIGRATION_NAME,
      BASELINE_MIGRATION_CHECKSUM,
      build.version,
      build.gitCommit,
    );
  }
}

export function readSchemaMigrations(db: Database): MigrationRow[] {
  if (!tableExists(db)) return [];
  return db
    .query(
      `SELECT id, name, checksum, applied_at, applied_by_version, applied_by_commit
         FROM schema_migrations
        ORDER BY id`,
    )
    .all() as MigrationRow[];
}

/** Apply migrations after the immutable v1 normalization has completed. */
export function applySchemaMigrations(db: Database): void {
  const build = getBuildIdentity();
  const migrations = [
    { id: 2, name: PEPPOL_SUBMISSION_EVENTS_MIGRATION_NAME, checksum: PEPPOL_SUBMISSION_EVENTS_MIGRATION_CHECKSUM, artifact: PEPPOL_SUBMISSION_EVENTS_MIGRATION_ARTIFACT },
    { id: 3, name: RECURRING_AUTOMATION_MIGRATION_NAME, checksum: RECURRING_AUTOMATION_MIGRATION_CHECKSUM, artifact: RECURRING_AUTOMATION_MIGRATION_ARTIFACT },
    { id: 4, name: DINERO_IMPORT_PROVENANCE_MIGRATION_NAME, checksum: DINERO_IMPORT_PROVENANCE_MIGRATION_CHECKSUM, artifact: DINERO_IMPORT_PROVENANCE_MIGRATION_ARTIFACT },
    { id: 5, name: MIGRATION_OPEN_ITEMS_MIGRATION_NAME, checksum: MIGRATION_OPEN_ITEMS_MIGRATION_CHECKSUM, artifact: MIGRATION_OPEN_ITEMS_MIGRATION_ARTIFACT },
  ];
  for (const migration of migrations) {
    if (db.query("SELECT id FROM schema_migrations WHERE id = ?").get(migration.id)) continue;
    const parsed = JSON.parse(migration.artifact.toString("utf8")) as { sql: string };
    db.transaction(() => {
      const recurringAlreadyUpgraded = migration.id === 3 &&
        (db.query("PRAGMA table_info(recurring_invoice_templates)").all() as Array<{ name: string }>)
          .some((column) => column.name === "interval_count");
      if (recurringAlreadyUpgraded) {
        // Recover a ledger whose v3 business tables committed but whose
        // migration row or auxiliary delivery table was lost. Never rebuild
        // the already-upgraded parent/child pair in that state.
        db.exec(`
          CREATE TABLE IF NOT EXISTS recurring_invoice_generation_claims (
            id INTEGER PRIMARY KEY,
            template_id INTEGER NOT NULL REFERENCES recurring_invoice_templates(id),
            period_index INTEGER NOT NULL CHECK(period_index >= 0),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(template_id, period_index)
          );
          INSERT OR IGNORE INTO recurring_invoice_generation_claims(template_id, period_index)
            SELECT template_id, period_index FROM recurring_invoice_generations;
          CREATE TABLE IF NOT EXISTS recurring_invoice_delivery_events (
            id INTEGER PRIMARY KEY,
            generation_id INTEGER NOT NULL REFERENCES recurring_invoice_generations(id),
            channel TEXT NOT NULL CHECK(channel IN ('email','digisense')),
            event_type TEXT NOT NULL CHECK(event_type IN ('attempted','acknowledged','accepted_pending','terminal_failed','uncertain','preflight_failed')),
            provider_id TEXT,
            message TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_recurring_invoice_delivery_events_generation
            ON recurring_invoice_delivery_events(generation_id,id DESC);
        `);
      } else {
        // A damaged migration ledger can be missing the v4 row while its
        // committed tables and guards remain. The migration is deliberately
        // replay-safe: remove only its canonical trigger names, then let the
        // IF NOT EXISTS table definitions preserve the recorded evidence.
        if (migration.id === 4 || migration.id === 5) {
          const triggerStatements = parsed.sql.match(/CREATE TRIGGER[\s\S]*?END;/gi) ?? [];
          for (const statement of triggerStatements) {
            const name = /CREATE TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement)?.[1];
            if (name) db.exec(`DROP TRIGGER IF EXISTS ${name};`);
          }
        }
        db.exec(parsed.sql);
      }
      db.query(`INSERT INTO schema_migrations (id, name, checksum, applied_by_version, applied_by_commit) VALUES (?, ?, ?, ?, ?)`)
        .run(migration.id, migration.name, migration.checksum, build.version, build.gitCommit);
    }, { immediate: true })();
  }

  // `migrate()` restores the immutable v1 trigger catalogue before applying
  // post-baseline migrations. On a second open that catalogue would otherwise
  // replace the v3 template guard with the old body that does not protect the
  // new cadence and channel columns. Re-assert the post-migration guards and
  // delivery reservation index on every open, including when v3 was already
  // recorded.
  if (db.query("SELECT id FROM schema_migrations WHERE id = 3").get()) {
    db.transaction(() => {
      db.exec(`
        DROP TRIGGER IF EXISTS recurring_invoice_templates_guard_update;
        CREATE TRIGGER recurring_invoice_templates_guard_update
        BEFORE UPDATE ON recurring_invoice_templates
        WHEN OLD.name != NEW.name
          OR OLD.interval != NEW.interval
          OR OLD.interval_count != NEW.interval_count
          OR OLD.delivery_channel != NEW.delivery_channel
          OR OLD.first_issue_date != NEW.first_issue_date
          OR OLD.payment_terms_days != NEW.payment_terms_days
          OR OLD.delivery_period_mode != NEW.delivery_period_mode
          OR OLD.payload_json != NEW.payload_json
          OR OLD.created_at != NEW.created_at
          OR NEW.next_issue_date < OLD.next_issue_date
          OR (OLD.active = 0 AND NEW.active = 1)
        BEGIN
          SELECT RAISE(ABORT, 'recurring invoice templates are append-only; only next_issue_date may advance and active may be retired');
        END;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_invoice_delivery_single_attempt
          ON recurring_invoice_delivery_events(generation_id)
          WHERE event_type = 'attempted';
      `);
    }, { immediate: true })();
  }

  // These tables are intentionally absent from the immutable v1 schema. Their
  // append-only guards therefore need the same drop+create reassertion on
  // every open as baseline triggers, including after a privileged tamper.
  if (db.query("SELECT id FROM schema_migrations WHERE id = 4").get()) {
    const parsed = JSON.parse(DINERO_IMPORT_PROVENANCE_MIGRATION_ARTIFACT.toString("utf8")) as { sql: string };
    const triggerStatements = parsed.sql.match(/CREATE TRIGGER[\s\S]*?END;/gi) ?? [];
    db.transaction(() => {
      for (const statement of triggerStatements) {
        const name = /CREATE TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement)?.[1];
        if (!name) continue;
        db.exec(`DROP TRIGGER IF EXISTS ${name};`);
        db.exec(statement);
      }
    }, { immediate: true })();
  }

  if (db.query("SELECT id FROM schema_migrations WHERE id = 5").get()) {
    const parsed = JSON.parse(MIGRATION_OPEN_ITEMS_MIGRATION_ARTIFACT.toString("utf8")) as { sql: string };
    const triggerStatements = parsed.sql.match(/CREATE TRIGGER[\s\S]*?END;/gi) ?? [];
    db.transaction(() => {
      for (const statement of triggerStatements) {
        const name = /CREATE TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(statement)?.[1];
        if (!name) continue;
        db.exec(`DROP TRIGGER IF EXISTS ${name};`);
        db.exec(statement);
      }
    }, { immediate: true })();
  }
}
