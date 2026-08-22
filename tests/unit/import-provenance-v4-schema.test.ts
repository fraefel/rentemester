import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";

const hash = (letter: string) => letter.repeat(64);

function seedProvenance(db: Database) {
  db.query("INSERT INTO documents (id, source, sha256_hash) VALUES (1, 'test', ?)").run(hash("c"));
  db.query(`INSERT INTO dinero_import_sources
    (id, raw_sha256, raw_size_bytes, canonical_listing_sha256, canonical_listing_count)
    VALUES (1, ?, 9, ?, 1)`).run(hash("a"), hash("b"));
  db.query(`INSERT INTO dinero_import_inventories
    (id, source_id, source_raw_sha256, canonical_listing_sha256, canonical_listing_count, entry_count, total_size_bytes)
    VALUES (1, 1, ?, ?, 1, 1, 9)`).run(hash("a"), hash("b"));
  db.query("INSERT INTO dinero_import_inventory_entries (inventory_id, entry_path, entry_size_bytes, entry_sha256) VALUES (1, 'docs/a.pdf', 9, ?)").run(hash("c"));
  db.query(`INSERT INTO dinero_import_attempts
    (id, inventory_id, source_id, source_raw_sha256, parser_contract, actor, cutover_date, outcome, result_sha256)
    VALUES (1, 1, 1, ?, 'dinero-v1', 'agent:test', '2025-01-01', 'accepted', ?)`).run(hash("a"), hash("e"));
}

describe("Dinero import provenance v4", () => {
  test("binds inventories to their complete source tuple and links one digest to both entry and document", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    seedProvenance(db);
    db.query(`INSERT INTO dinero_import_archive_evidence
      (attempt_id, inventory_id, source_id, source_raw_sha256, fiscal_year, archive_sha256, archive_size_bytes)
      VALUES (1, 1, 1, ?, 2024, ?, 9)`).run(hash("a"), hash("f"));
    db.query(`INSERT INTO dinero_import_document_links
      (attempt_id, inventory_id, entry_path, entry_sha256, document_id, disposition)
      VALUES (1, 1, 'docs/a.pdf', ?, 1, 'linked')`).run(hash("c"));

    expect(() => db.query(`INSERT INTO dinero_import_inventories
      (id, source_id, source_raw_sha256, canonical_listing_sha256, canonical_listing_count, entry_count, total_size_bytes)
      VALUES (2, 1, ?, ?, 1, 1, 9)`).run(hash("a"), hash("d"))).toThrow();
    expect(() => db.query(`INSERT INTO dinero_import_inventories
      (id, source_id, source_raw_sha256, canonical_listing_sha256, canonical_listing_count, entry_count, total_size_bytes)
      VALUES (2, 1, ?, ?, 2, 1, 9)`).run(hash("a"), hash("b"))).toThrow();
    db.query(`INSERT INTO dinero_import_sources
      (id, raw_sha256, raw_size_bytes, canonical_listing_sha256, canonical_listing_count)
      VALUES (2, ?, 9, ?, 1)`).run(hash("1"), hash("2"));
    expect(() => db.query(`INSERT INTO dinero_import_attempts
      (id, inventory_id, source_id, source_raw_sha256, parser_contract, actor, cutover_date, outcome, result_sha256)
      VALUES (2, 1, 2, ?, 'dinero-v1', 'agent:test', '2025-01-01', 'rejected', ?)`).run(hash("1"), hash("e"))).toThrow();
    db.query("INSERT INTO documents (id, source, sha256_hash) VALUES (2, 'test', ?)").run(hash("d"));
    expect(() => db.query(`INSERT INTO dinero_import_document_links
      (attempt_id, inventory_id, entry_path, entry_sha256, document_id, disposition)
      VALUES (1, 1, 'docs/a.pdf', ?, 2, 'linked')`).run(hash("c"))).toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    db.exec("DROP TRIGGER dinero_import_attempts_no_update; CREATE TRIGGER dinero_import_attempts_no_update BEFORE UPDATE ON dinero_import_attempts BEGIN SELECT 1; END;");
    migrate(db);
    expect(() => db.run("UPDATE dinero_import_attempts SET actor = 'agent:other' WHERE id = 1")).toThrow("append-only");
    expect(() => db.run("DELETE FROM dinero_import_document_links WHERE id = 1")).toThrow("append-only");
    db.close();
  });

  test("rejects a non-hex 64-character value in every v4 SHA field", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    const invalid = hash("z");
    expect(() => db.query("INSERT INTO dinero_import_sources (raw_sha256, raw_size_bytes, canonical_listing_sha256, canonical_listing_count) VALUES (?, 1, ?, 0)").run(invalid, hash("a"))).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_sources (raw_sha256, raw_size_bytes, canonical_listing_sha256, canonical_listing_count) VALUES (?, 1, ?, 0)").run(hash("a"), invalid)).toThrow();
    seedProvenance(db);
    expect(() => db.query("INSERT INTO dinero_import_inventories (id, source_id, source_raw_sha256, canonical_listing_sha256, canonical_listing_count, entry_count, total_size_bytes) VALUES (2, 1, ?, ?, 1, 0, 0)").run(invalid, hash("b"))).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_inventories (id, source_id, source_raw_sha256, canonical_listing_sha256, canonical_listing_count, entry_count, total_size_bytes) VALUES (2, 1, ?, ?, 1, 0, 0)").run(hash("a"), invalid)).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_inventory_entries (inventory_id, entry_path, entry_size_bytes, entry_sha256) VALUES (1, 'bad-entry', 0, ?)").run(invalid)).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_attempts (id, inventory_id, source_id, source_raw_sha256, parser_contract, actor, cutover_date, outcome, result_sha256) VALUES (2, 1, 1, ?, 'v1', 'agent:test', '2025-01-01', 'accepted', ?)").run(invalid, hash("e"))).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_attempts (id, inventory_id, source_id, source_raw_sha256, parser_contract, actor, cutover_date, outcome, result_sha256) VALUES (2, 1, 1, ?, 'v1', 'agent:test', '2025-01-01', 'accepted', ?)").run(hash("a"), invalid)).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_archive_evidence (attempt_id, inventory_id, source_id, source_raw_sha256, fiscal_year, archive_sha256, archive_size_bytes) VALUES (1, 1, 1, ?, 2024, ?, 0)").run(invalid, hash("f"))).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_archive_evidence (attempt_id, inventory_id, source_id, source_raw_sha256, fiscal_year, archive_sha256, archive_size_bytes) VALUES (1, 1, 1, ?, 2024, ?, 0)").run(hash("a"), invalid)).toThrow();
    expect(() => db.query("INSERT INTO dinero_import_document_links (attempt_id, inventory_id, entry_path, entry_sha256, document_id, disposition) VALUES (1, 1, 'docs/a.pdf', ?, 1, 'linked')").run(invalid)).toThrow();
    db.close();
  });

  test("does not infer v4 provenance from legacy archive rows", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
    db.exec("INSERT INTO import_archive_years (source_system, fiscal_year, posting_count, balance_count) VALUES ('prior-system', 2024, 0, 0);");
    for (const table of ["sources", "inventories", "inventory_entries", "attempts", "archive_evidence", "document_links"]) {
      db.exec(`DROP TRIGGER dinero_import_${table}_no_update; DROP TRIGGER dinero_import_${table}_no_delete;`);
    }
    db.exec(`DROP TABLE dinero_import_document_links; DROP TABLE dinero_import_archive_evidence; DROP TABLE dinero_import_attempts; DROP TABLE dinero_import_inventory_entries; DROP TABLE dinero_import_inventories; DROP TABLE dinero_import_sources; DELETE FROM schema_migrations WHERE id = 4;`);
    migrate(db);
    expect(db.query("SELECT COUNT(*) AS count FROM dinero_import_attempts").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM dinero_import_archive_evidence").get()).toEqual({ count: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
