import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import {
  CURRENT_SCHEMA_VERSION,
  supportedSchemaMigrations,
  type SchemaMigrationIdentity,
} from "./schema-version";

export type LedgerInspection =
  | { status: "current"; currentVersion: number; requiredVersion: number; pending: [] }
  | { status: "pending"; currentVersion: number; requiredVersion: number; pending: SchemaMigrationIdentity[] }
  | { status: "newer"; currentVersion: number; requiredVersion: number; pending: [] ; error: string }
  | { status: "corrupt"; currentVersion: number; requiredVersion: number; pending: []; error: string }
  | { status: "unavailable"; currentVersion: number; requiredVersion: number; pending: []; error: string };

const requiredVersion = CURRENT_SCHEMA_VERSION;
const unavailable = (error: string): LedgerInspection => ({ status: "unavailable", currentVersion: 0, requiredVersion, pending: [], error });
const corrupt = (currentVersion: number, error: string): LedgerInspection => ({ status: "corrupt", currentVersion, requiredVersion, pending: [], error });

/**
 * Opens an existing ledger without ever creating a directory, journal sidecar,
 * or migration row. Callers must close the returned handle.
 */
export function openLedgerReadOnly(path: string): Database {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("ledger must not be a symbolic link");
  if (!stat.isFile()) throw new Error("ledger must be a regular file");
  const db = new Database(path, { readonly: true });
  db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;");
  return db;
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

export function inspectOpenLedger(db: Database): LedgerInspection {
  let currentVersion = 0;
  try {
    for (const name of ["schema_migrations", "companies", "audit_log"]) {
      if (!tableExists(db, name)) return corrupt(0, `missing critical schema primitive: ${name}`);
    }
    const columns = new Set((db.query("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>).map((r) => r.name));
    for (const column of ["id", "name", "checksum", "applied_at", "applied_by_version"]) {
      if (!columns.has(column)) return corrupt(0, `schema_migrations is missing required column: ${column}`);
    }
    const rows = db.query("SELECT id, name, checksum FROM schema_migrations ORDER BY id").all() as SchemaMigrationIdentity[];
    currentVersion = rows.at(-1)?.id ?? 0;
    const supported = supportedSchemaMigrations();
    if (currentVersion > requiredVersion) {
      return { status: "newer", currentVersion, requiredVersion, pending: [], error: "database schema is newer than this Rentemester runtime" };
    }
    for (let i = 0; i < rows.length; i += 1) {
      const actual = rows[i]!;
      const expected = supported[i];
      if (!expected || actual.id !== expected.id || actual.name !== expected.name || actual.checksum !== expected.checksum) {
        return corrupt(currentVersion, `schema migration ${actual.id} is not the required checksummed append-only prefix`);
      }
    }
    const quick = db.query("PRAGMA quick_check").all() as Array<{ quick_check: string }>;
    if (quick.some((row) => Object.values(row)[0] !== "ok")) return corrupt(currentVersion, "sqlite quick_check failed");
    const foreignKeys = db.query("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) return corrupt(currentVersion, "sqlite foreign_key_check failed");
    if (currentVersion < requiredVersion) {
      return { status: "pending", currentVersion, requiredVersion, pending: supported.slice(currentVersion).map(({ id, name, checksum }) => ({ id, name, checksum })) };
    }
    return { status: "current", currentVersion, requiredVersion, pending: [] };
  } catch (error) {
    return corrupt(currentVersion, error instanceof Error ? error.message : String(error));
  }
}

export function inspectLedger(path: string): LedgerInspection {
  let db: Database | undefined;
  try {
    db = openLedgerReadOnly(path);
    return inspectOpenLedger(db);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  } finally {
    db?.close();
  }
}
