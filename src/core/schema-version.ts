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
  const eventsMigration = JSON.parse(PEPPOL_SUBMISSION_EVENTS_MIGRATION_ARTIFACT.toString("utf8")) as {
    sql: string;
  };
  const existing = db.query("SELECT id FROM schema_migrations WHERE id = 2").get();
  if (existing) return;
  db.transaction(() => {
    db.exec(eventsMigration.sql);
    db.query(
      `INSERT INTO schema_migrations (id, name, checksum, applied_by_version, applied_by_commit)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(2, PEPPOL_SUBMISSION_EVENTS_MIGRATION_NAME, PEPPOL_SUBMISSION_EVENTS_MIGRATION_CHECKSUM, build.version, build.gitCommit);
  }, { immediate: true })();
}
