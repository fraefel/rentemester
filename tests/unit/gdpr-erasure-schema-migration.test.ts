// Tests: src/core/db.ts — widening/scoping GDPR erasure constraints.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { buildGdprSubjectExport } from "../../src/core/gdpr";

describe("GDPR erasure source migration", () => {
  test("preserves legacy tombstones, enables audit overlays and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-gdpr-source-migration-"));
    const db = openDb(join(root, "ledger.sqlite"));
    try {
      db.exec(`
        CREATE TABLE gdpr_erasures (
          id INTEGER PRIMARY KEY,
          subject_key TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('customers','vendors','documents','bank_transactions')),
          source_row_id INTEGER NOT NULL,
          redacted_fields TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          retained_until_at_erasure TEXT,
          erased_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(source, source_row_id)
        );
        INSERT INTO gdpr_erasures
          (id, subject_key, source, source_row_id, redacted_fields, rule_id,
           reason, retained_until_at_erasure, erased_at)
        VALUES
          (7, 'DK12345678', 'customers', 3, '["name"]', 'legacy-rule',
           'legacy reason', NULL, '2026-01-02 03:04:05'),
          (8, 'Legacy Navn', 'vendors', 4, '["name"]', 'legacy-rule',
           'legacy name reason', NULL, '2026-01-02 03:05:05'),
          (9, 'Legacy Same Name', 'documents', 12,
           '["name","address","vatOrCvr"]', 'legacy-rule',
           'legacy ambiguous-name reason', NULL, '2026-01-02 03:06:05');
      `);

      migrate(db);
      migrate(db);
      db.run(
        `INSERT INTO customers (id, name, vat_or_cvr, email)
         VALUES (3, 'Legacy Kunde', 'DK12345678', 'legacy@example.com')`,
      );
      db.run(
        `INSERT INTO vendors (id, name)
         VALUES (4, 'Legacy Navn')`,
      );
      db.run(
        `INSERT INTO documents
           (id, source, sha256_hash, invoice_date, sender_name,
            sender_address, sender_vat_cvr, recipient_name,
            recipient_address, recipient_vat_cvr)
         VALUES
           (12, 'legacy', 'legacy-shared-name-document', '2000-01-01',
            'Legacy Same Name', 'Afsendervej 1', 'DK11110000',
            'Legacy Same Name', 'Modtagervej 1', 'DK22220000')`,
      );

      const legacy = db
        .query(
          `SELECT id, subject_key, source, source_row_id, redacted_fields,
                  rule_id, reason, retained_until_at_erasure, erased_at
             FROM gdpr_erasures WHERE id = 7`,
        )
        .get();
      expect(legacy).toEqual({
        id: 7,
        subject_key: "DK12345678",
        source: "customers",
        source_row_id: 3,
        redacted_fields: '["name"]',
        rule_id: "legacy-rule",
        reason: "legacy reason",
        retained_until_at_erasure: null,
        erased_at: "2026-01-02 03:04:05",
      });
      const legacyOverlay = buildGdprSubjectExport(db, {
        cvr: "DK12345678",
      }).records.find((row) => row.source === "customers");
      expect(legacyOverlay).toBeDefined();
      expect(legacyOverlay!.erased).toBe(true);
      expect(legacyOverlay!.label).not.toBe("Legacy Kunde");
      expect(legacyOverlay!.personalData.name).not.toBe("Legacy Kunde");
      const legacyNameOverlay = buildGdprSubjectExport(db, {
        name: "Legacy Navn",
      }).records.find((row) => row.source === "vendors");
      expect(legacyNameOverlay).toBeDefined();
      expect(legacyNameOverlay!.erased).toBe(true);
      expect(legacyNameOverlay!.label).not.toBe("Legacy Navn");
      const legacyAmbiguousNameOverlay = buildGdprSubjectExport(db, {
        cvr: "DK22220000",
      }).records.find(
        (row) => row.source === "documents" && row.sourceRowId === 12,
      );
      expect(legacyAmbiguousNameOverlay).toBeDefined();
      expect(legacyAmbiguousNameOverlay!.erased).toBe(true);
      expect(legacyAmbiguousNameOverlay!.personalData.name).not.toBe(
        "Legacy Same Name",
      );
      expect(legacyAmbiguousNameOverlay!.personalData.vatOrCvr).toBeNull();

      expect(() =>
        db.run(
          `INSERT INTO gdpr_erasures
             (subject_key, source, source_row_id, redacted_fields, rule_id, reason)
           VALUES ('sha256:new', 'audit_log', 9, '["name"]', 'new-rule', 'new reason')`,
        ),
      ).not.toThrow();
      // The same document/audit row can identify multiple people (for example
      // invoice sender + recipient). Tombstones must therefore be scoped by
      // subject, not globally by source row.
      expect(() =>
        db.run(
          `INSERT INTO gdpr_erasures
             (subject_key, source, source_row_id, redacted_fields, rule_id, reason)
           VALUES ('sha256:other', 'audit_log', 9, '["name"]', 'new-rule', 'other subject')`,
        ),
      ).not.toThrow();
      expect(() =>
        db.run(
          `INSERT INTO gdpr_erasures
             (subject_key, source, source_row_id, redacted_fields, rule_id, reason)
           VALUES ('sha256:new', 'audit_log', 9, '["name"]', 'new-rule', 'duplicate')`,
        ),
      ).toThrow(/UNIQUE/);
      const sameRowSubjects = db
        .query(
          "SELECT COUNT(*) AS n FROM gdpr_erasures WHERE source = 'audit_log' AND source_row_id = 9",
        )
        .get() as { n: number };
      expect(sameRowSubjects.n).toBe(2);
      expect(() =>
        db.run("UPDATE gdpr_erasures SET reason = 'tampered' WHERE id = 7"),
      ).toThrow(/append-only/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
