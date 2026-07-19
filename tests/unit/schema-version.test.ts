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
  readSchemaMigrations,
  validateSchemaMigrationHistory,
} from "../../src/core/schema-version";

describe("schema version compatibility", () => {
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

  test("records one checksummed baseline idempotently", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db);

    expect(readSchemaMigrations(db)).toEqual([
      expect.objectContaining({
        id: CURRENT_SCHEMA_VERSION,
        name: BASELINE_MIGRATION_NAME,
        checksum: BASELINE_MIGRATION_CHECKSUM,
        applied_by_version: "0.1.0",
      }),
    ]);
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
      VALUES (2, 'future', 'abc', '0.2.0');
    `);

    expect(() => migrate(db)).toThrow("newer than supported version 1");
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
        VALUES (2, 'future', 'abc', '0.2.0');
      `);
      db.close();
      const beforeBytes = readFileSync(path);
      const beforeFiles = readdirSync(directory).sort();

      expect(() => openDb(path)).toThrow("newer than supported version 1");
      expect(readFileSync(path)).toEqual(beforeBytes);
      expect(readdirSync(directory).sort()).toEqual(beforeFiles);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
