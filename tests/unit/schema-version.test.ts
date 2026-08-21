import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../src/core/db";
import {
  BASELINE_MIGRATION_CHECKSUM,
  BASELINE_MIGRATION_NAME,
  BASELINE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  PEPPOL_SUBMISSION_EVENTS_MIGRATION_CHECKSUM,
  PEPPOL_SUBMISSION_EVENTS_MIGRATION_NAME,
  RECURRING_AUTOMATION_MIGRATION_CHECKSUM,
  RECURRING_AUTOMATION_MIGRATION_NAME,
  readSchemaMigrations,
  validateSchemaMigrationHistory,
} from "../../src/core/schema-version";

function seedV2RecurringLedger(db: Database) {
  db.exec(`
    CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, applied_by_version TEXT NOT NULL, applied_by_commit TEXT);
    INSERT INTO schema_migrations (id,name,checksum,applied_by_version) VALUES
      (1, '${BASELINE_MIGRATION_NAME}', '${BASELINE_MIGRATION_CHECKSUM}', '0.1.0'),
      (2, '${PEPPOL_SUBMISSION_EVENTS_MIGRATION_NAME}', '${PEPPOL_SUBMISSION_EVENTS_MIGRATION_CHECKSUM}', '0.1.0');
    CREATE TABLE recurring_invoice_templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, interval TEXT NOT NULL CHECK(interval IN ('monthly','quarterly','yearly')), first_issue_date TEXT NOT NULL, next_issue_date TEXT NOT NULL, payment_terms_days INTEGER NOT NULL DEFAULT 30, delivery_period_mode TEXT NOT NULL DEFAULT 'issue_month', payload_json TEXT NOT NULL, notes TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE recurring_invoice_generations (id INTEGER PRIMARY KEY, template_id INTEGER NOT NULL REFERENCES recurring_invoice_templates(id), period_index INTEGER NOT NULL, document_id INTEGER NOT NULL REFERENCES documents(id), invoice_number TEXT NOT NULL, issue_date TEXT NOT NULL, delivery_period_start TEXT, delivery_period_end TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(template_id, period_index));
  `);
  // The full schema supplies the historic documents table and all unrelated
  // baseline tables; IF NOT EXISTS intentionally preserves the v2 templates.
  db.exec(readFileSync(join(import.meta.dir, "..", "..", "src", "core", "schema.sql"), "utf8"));
  db.exec(`
    INSERT INTO documents (id, source, sha256_hash) VALUES (41, 'rentemester', 'v2-generation-document');
    INSERT INTO recurring_invoice_templates (id,name,interval,first_issue_date,next_issue_date,payment_terms_days,delivery_period_mode,payload_json,active) VALUES (7,'Historic','monthly','2026-01-31','2026-02-28',30,'issue_month','{}',1);
    INSERT INTO recurring_invoice_generations (id,template_id,period_index,document_id,invoice_number,issue_date) VALUES (9,7,0,41,'2026-0001','2026-01-31');
  `);
}

describe("schema version compatibility", () => {
  test("migrates a v2 recurring template and generation losslessly with foreign keys", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-v2-recurring-"));
    const path = join(root, "ledger.sqlite");
    try {
      const legacy = new Database(path);
      legacy.exec("PRAGMA foreign_keys = ON");
      seedV2RecurringLedger(legacy);
      legacy.close();

      const db = openDb(path);
      migrate(db);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("SELECT id, interval_count, delivery_channel FROM recurring_invoice_templates WHERE id = 7").get())
        .toEqual({ id: 7, interval_count: 1, delivery_channel: "manual" });
      expect(db.query("SELECT id, template_id, document_id FROM recurring_invoice_generations WHERE id = 9").get())
        .toEqual({ id: 9, template_id: 7, document_id: 41 });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => db.run("UPDATE recurring_invoice_generations SET invoice_number = 'x' WHERE id = 9")).toThrow("append-only");
      migrate(db);
      expect(() => db.run("UPDATE recurring_invoice_templates SET interval_count = 2 WHERE id = 7")).toThrow("append-only");
      expect(() => db.run("UPDATE recurring_invoice_templates SET delivery_channel = 'email' WHERE id = 7")).toThrow("append-only");
      expect(readSchemaMigrations(db)).toHaveLength(3);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("binds the immutable baseline artifact to schema and normalization bytes", () => {
    const core = join(import.meta.dir, "..", "..", "src", "core");
    const artifactPath = join(core, "migrations", "0001-baseline.json");
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      schemaSha256: string;
      normalizationSha256: string;
    };
    const source = readFileSync(join(core, "db.ts"), "utf8");
    const start = "  // BASELINE_MIGRATION_V1_NORMALIZATION_START\n";
    const end = "  // BASELINE_MIGRATION_V1_NORMALIZATION_END\n";
    const normalization = source.split(start)[1]?.split(end)[0];
    expect(normalization).toBeDefined();

    expect(artifact.schemaSha256).toBe(
      createHash("sha256").update(readFileSync(join(core, "schema.sql"))).digest("hex"),
    );
    expect(artifact.normalizationSha256).toBe(
      createHash("sha256").update(normalization!, "utf8").digest("hex"),
    );
    expect(BASELINE_MIGRATION_CHECKSUM).toBe(
      createHash("sha256").update(readFileSync(artifactPath)).digest("hex"),
    );
  });

  test("records the contiguous checksummed migration catalog idempotently", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db);

    expect(readSchemaMigrations(db)).toEqual([
      expect.objectContaining({
        id: BASELINE_SCHEMA_VERSION,
        name: BASELINE_MIGRATION_NAME,
        checksum: BASELINE_MIGRATION_CHECKSUM,
        applied_by_version: "0.1.0",
      }),
      expect.objectContaining({ id: 2, name: PEPPOL_SUBMISSION_EVENTS_MIGRATION_NAME, checksum: PEPPOL_SUBMISSION_EVENTS_MIGRATION_CHECKSUM }),
      expect.objectContaining({ id: 3, name: RECURRING_AUTOMATION_MIGRATION_NAME, checksum: RECURRING_AUTOMATION_MIGRATION_CHECKSUM }),
    ]);
    db.close();
  });

  test("opens a pre-change v1 ledger and applies the append-only v2 events migration", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec("DROP TABLE peppol_submission_events; DROP TABLE recurring_invoice_delivery_events; DELETE FROM schema_migrations WHERE id >= 2;");
    expect(readSchemaMigrations(db)).toHaveLength(1);
    migrate(db);
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peppol_submission_events'").get()).not.toBeNull();
    expect(readSchemaMigrations(db)).toHaveLength(3);
    db.close();
  });

  test("accepts a complete append-only history when a future runtime supports it", () => {
    const supported = [
      {
        id: BASELINE_SCHEMA_VERSION,
        name: BASELINE_MIGRATION_NAME,
        checksum: BASELINE_MIGRATION_CHECKSUM,
      },
      { id: 2, name: "rentemester-schema-v2", checksum: "v2-checksum" },
    ];
    const applied = [
      {
        id: BASELINE_SCHEMA_VERSION,
        name: BASELINE_MIGRATION_NAME,
        checksum: BASELINE_MIGRATION_CHECKSUM,
      },
      { id: 2, name: "rentemester-schema-v2", checksum: "v2-checksum" },
    ];

    expect(() => validateSchemaMigrationHistory(applied, supported)).not.toThrow();
    expect(() => validateSchemaMigrationHistory(applied.slice(1), supported)).toThrow(
      "complete append-only prefix",
    );
  });

  test("rejects a database made by newer software before creating business tables", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_by_version TEXT NOT NULL,
        applied_by_commit TEXT
      );
      INSERT INTO schema_migrations
        (id, name, checksum, applied_by_version)
      VALUES (4, 'future', 'abc', '0.2.0');
    `);

    expect(() => migrate(db)).toThrow("newer than supported version 3");
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'companies'").get(),
    ).toBeNull();
    db.close();
  });

  test("rejects a modified baseline checksum", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.query("UPDATE schema_migrations SET checksum = 'modified' WHERE id = 1").run();
    expect(() => migrate(db)).toThrow("checksum mismatch");
    db.close();
  });

  test("adopts a checksum only from a legacy table that never had the column", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO schema_migrations (id, name)
      VALUES (1, '${BASELINE_MIGRATION_NAME}');
    `);

    migrate(db);
    expect(readSchemaMigrations(db)[0]?.checksum).toBe(BASELINE_MIGRATION_CHECKSUM);
    const columns = db.query("PRAGMA table_info(schema_migrations)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.find((column) => column.name === "checksum")?.notnull).toBe(1);
    expect(columns.find((column) => column.name === "applied_by_version")?.notnull).toBe(1);
    db.close();
  });

  test("rejects a null checksum once the checksum column exists", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        applied_by_version TEXT
      );
      INSERT INTO schema_migrations (id, name, checksum, applied_by_version)
      VALUES (1, '${BASELINE_MIGRATION_NAME}', NULL, '0.1.0');
    `);

    expect(() => migrate(db)).toThrow("missing checksum");
    expect(
      db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'companies'").get(),
    ).toBeNull();
    db.close();
  });

  test("openDb rejects a newer on-disk database without changing its bytes or sidecars", () => {
    const directory = mkdtempSync(join(tmpdir(), "rentemester-schema-preflight-"));
    const path = join(directory, "ledger.sqlite");
    try {
      const db = new Database(path);
      db.exec(`
        CREATE TABLE schema_migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          applied_by_version TEXT NOT NULL,
          applied_by_commit TEXT
        );
        INSERT INTO schema_migrations
          (id, name, checksum, applied_by_version)
        VALUES (4, 'future', 'abc', '0.2.0');
      `);
      db.close();
      const beforeBytes = readFileSync(path);
      const beforeFiles = readdirSync(directory).sort();

      expect(() => openDb(path)).toThrow("newer than supported version 3");
      expect(readFileSync(path)).toEqual(beforeBytes);
      expect(readdirSync(directory).sort()).toEqual(beforeFiles);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
