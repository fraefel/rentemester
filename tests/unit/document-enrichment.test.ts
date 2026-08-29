import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyAuditLogIntegrity } from "../../src/core/audit-log";
import { openDb, migrate } from "../../src/core/db";
import { enrichDocumentMetadata, validateDocumentMetadata, type DocumentMetadata } from "../../src/core/documents";
import { bookExpenseFromBank } from "../../src/core/expense-booking";
import { seedAccounts } from "../../src/core/ledger";
import { ensureCompanyDirs } from "../../src/core/paths";

const completeMetadata: DocumentMetadata = {
  source: "email", issueDate: "2026-08-01", invoiceNo: "LEGACY-1", deliveryDescription: "Synthetic office supplies", amountIncVat: 125, currency: "DKK",
  sender: { name: "Synthetic supplier", address: "Supplier street 1", vatOrCvr: "DK11223344" },
  recipient: { name: "Synthetic buyer", address: "Buyer street 1", vatOrCvr: "DK12345678" }, vatAmount: 25,
};

function legacyDocument(status = "ingested", payload = { source: "email", invoiceNo: "LEGACY-1" }) {
  const root = mkdtempSync(join(tmpdir(), "rentemester-document-enrich-"));
  const db = openDb(ensureCompanyDirs(root).db); migrate(db); seedAccounts(db);
  const originalPayload = JSON.stringify(payload);
  const id = (db.query(`INSERT INTO documents (document_no, source, original_filename, stored_path, mime_type, sha256_hash, invoice_no, currency, status, document_type, payload_json, retain_until)
    VALUES ('DOC-2026-999999', 'email', 'legacy.txt', '/immutable/legacy.txt', 'text/plain', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'LEGACY-1', 'DKK', ?, 'purchase_sale', ?, '2031-08-01') RETURNING id`).get(status, originalPayload) as { id: number }).id;
  return { root, db, id, originalPayload };
}

describe("document metadata enrichment (#569)", () => {
  test("fills a legacy document once, preserves immutable evidence, provenance and audit chain", () => {
    const fixture = legacyDocument();
    try {
      expect(validateDocumentMetadata({ source: "email", invoiceNo: "LEGACY-1" }).ok).toBe(false);
      const before = fixture.db.query("SELECT sha256_hash, stored_path, original_filename, document_no, upload_datetime, retain_until FROM documents WHERE id = ?").get(fixture.id);
      expect(enrichDocumentMetadata(fixture.db, fixture.id, completeMetadata, { createdBy: "user:tester", createdByProgram: "test" })).toMatchObject({ ok: true, enriched: true });
      const after = fixture.db.query("SELECT sha256_hash, stored_path, original_filename, document_no, upload_datetime, retain_until, amount_inc_vat, vat_amount, sender_vat_cvr, payload_json FROM documents WHERE id = ?").get(fixture.id) as any;
      expect(after).toMatchObject({ ...before, amount_inc_vat: 125, vat_amount: 25, sender_vat_cvr: "DK11223344" });
      const payload = JSON.parse(after.payload_json);
      expect(payload).toMatchObject({ source: "email", sender: { name: "Synthetic supplier" } });
      expect(payload._enrichment).toBeUndefined();
      expect(fixture.db.query("SELECT original_payload_json, original_payload_sha256, enriched_metadata_json, enriched_metadata_sha256, actor, program FROM document_metadata_enrichments WHERE document_id = ?").get(fixture.id)).toEqual({
        original_payload_json: fixture.originalPayload,
        original_payload_sha256: createHash("sha256").update(fixture.originalPayload).digest("hex"),
        enriched_metadata_json: after.payload_json,
        enriched_metadata_sha256: createHash("sha256").update(after.payload_json).digest("hex"),
        actor: "user:tester", program: "test",
      });
      expect(fixture.db.query("SELECT event_type, actor, message FROM audit_log WHERE entity_id = ?").all(fixture.id)).toEqual([expect.objectContaining({ event_type: "document_metadata_enriched", actor: "user:tester via test", message: expect.stringContaining("enriched_metadata_sha256=") })]);
      expect(enrichDocumentMetadata(fixture.db, fixture.id, { ...completeMetadata, sender: { ...completeMetadata.sender! } })).toMatchObject({ ok: true, enriched: false });
      expect(enrichDocumentMetadata(fixture.db, fixture.id, { ...completeMetadata, amountIncVat: 126 }).ok).toBe(false);
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?").get(fixture.id)).toEqual({ n: 1 });
      expect(fixture.db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(verifyAuditLogIntegrity(fixture.db, { journalCrossCheck: false }).ok).toBe(true);
    } finally { fixture.db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test("has validation parity and only becomes bookable after enrichment, then rejects a linked retry", () => {
    const fixture = legacyDocument();
    try {
      const invalid = { source: "email", invoiceNo: "LEGACY-1" } as DocumentMetadata;
      expect(enrichDocumentMetadata(fixture.db, fixture.id, invalid).errors).toEqual(validateDocumentMetadata(invalid).errors);
      const bankId = (fixture.db.query("INSERT INTO bank_transactions (transaction_date, text, amount, currency, transaction_hash, status) VALUES ('2026-08-01', 'Synthetic supplier', -125, 'DKK', 'bank-569', 'imported') RETURNING id").get() as { id: number }).id;
      expect(bookExpenseFromBank(fixture.db, { documentId: fixture.id, bankTransactionId: bankId, expenseAccountNo: "3000", vatTreatment: "standard" }).ok).toBe(false);
      expect(enrichDocumentMetadata(fixture.db, fixture.id, completeMetadata).ok).toBe(true);
      expect(bookExpenseFromBank(fixture.db, { documentId: fixture.id, bankTransactionId: bankId, expenseAccountNo: "3000", vatTreatment: "standard" }).ok).toBe(true);
      expect(enrichDocumentMetadata(fixture.db, fixture.id, completeMetadata)).toMatchObject({
        ok: false,
        errors: ["document is linked to accounting evidence and cannot be enriched"],
      });
    } finally { fixture.db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test("fails closed for import links and every non-ingested status", () => {
    const imported = legacyDocument();
    try {
      imported.db.query("INSERT INTO journal_entries (entry_no, transaction_date, text, rule_version, entry_hash) VALUES ('J-570', '2026-08-01', 'Synthetic', 'test', 'hash')").run();
      const entry = imported.db.query("SELECT id FROM journal_entries WHERE entry_no = 'J-570'").get() as { id: number };
      imported.db.query("INSERT INTO import_document_links (source_system, voucher_ref, document_id, journal_entry_id) VALUES ('test', 'V-570', ?, ?)").run(imported.id, entry.id);
      expect(enrichDocumentMetadata(imported.db, imported.id, completeMetadata).ok).toBe(false);
    } finally { imported.db.close(); rmSync(imported.root, { recursive: true, force: true }); }
    const posted = legacyDocument("posted");
    try { expect(enrichDocumentMetadata(posted.db, posted.id, completeMetadata).errors).toContain("document is already posted or otherwise non-enrichable"); }
    finally { posted.db.close(); rmSync(posted.root, { recursive: true, force: true }); }
  });

  test("does not trust legacy payload provenance, accepts nested completion, and drops unknown caller fields", () => {
    const fixture = legacyDocument("ingested", {
      source: "email", invoiceNo: "LEGACY-1", sender: { name: "Synthetic supplier" },
      _enrichment: { metadataHash: "f".repeat(64) },
    });
    try {
      const input = { ...completeMetadata, unexpectedCallerField: "must not persist" } as DocumentMetadata;
      expect(enrichDocumentMetadata(fixture.db, fixture.id, input)).toMatchObject({ ok: true, enriched: true });
      const payload = fixture.db.query("SELECT payload_json FROM documents WHERE id = ?").get(fixture.id) as { payload_json: string };
      expect(JSON.parse(payload.payload_json)).not.toHaveProperty("unexpectedCallerField");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM document_metadata_enrichments WHERE document_id = ?").get(fixture.id)).toEqual({ n: 1 });
    } finally { fixture.db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test("rejects enrichment that would create a second purchase-invoice identity", () => {
    const fixture = legacyDocument();
    try {
      fixture.db.query(`INSERT INTO documents
        (document_no, source, sha256_hash, document_type, sender_vat_cvr, invoice_no, status)
        VALUES ('DOC-2026-999998', 'test', ?, 'purchase_sale', 'DK11223344', 'LEGACY-1', 'ingested')`).run("c".repeat(64));
      expect(enrichDocumentMetadata(fixture.db, fixture.id, completeMetadata).errors?.[0]).toContain("supplier and invoice identity");
      expect(fixture.db.query("SELECT COUNT(*) AS n FROM document_metadata_enrichments").get()).toEqual({ n: 0 });
    } finally { fixture.db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  test("fails closed for direct, import, and Dinero accounting links and rejects internal vouchers", () => {
    const direct = legacyDocument();
    try {
      direct.db.query("INSERT INTO journal_entries (document_id, entry_no, transaction_date, text, rule_version, entry_hash) VALUES (?, 'J-571', '2026-08-01', 'Synthetic', 'test', 'hash')").run(direct.id);
      expect(enrichDocumentMetadata(direct.db, direct.id, completeMetadata).ok).toBe(false);
    } finally { direct.db.close(); rmSync(direct.root, { recursive: true, force: true }); }

    const dinero = legacyDocument();
    try {
      const hash = "b".repeat(64);
      dinero.db.query("INSERT INTO dinero_import_sources (id, raw_sha256, raw_size_bytes, canonical_listing_sha256, canonical_listing_count) VALUES (1, ?, 1, ?, 1)").run(hash, hash);
      dinero.db.query("INSERT INTO dinero_import_inventories (id, source_id, source_raw_sha256, canonical_listing_sha256, canonical_listing_count, entry_count, total_size_bytes) VALUES (1, 1, ?, ?, 1, 1, 1)").run(hash, hash);
      dinero.db.query("INSERT INTO dinero_import_inventory_entries (inventory_id, entry_path, entry_size_bytes, entry_sha256) VALUES (1, 'receipt.txt', 1, ?)").run("a".repeat(64));
      dinero.db.query("INSERT INTO dinero_import_attempts (id, inventory_id, source_id, source_raw_sha256, parser_contract, actor, cutover_date, outcome, result_sha256) VALUES (1, 1, 1, ?, 'test', 'agent:test', '2026-08-01', 'accepted', ?)").run(hash, hash);
      dinero.db.query("INSERT INTO dinero_import_document_links (attempt_id, inventory_id, entry_path, entry_sha256, document_id, disposition) VALUES (1, 1, 'receipt.txt', ?, ?, 'linked')").run("a".repeat(64), dinero.id);
      expect(enrichDocumentMetadata(dinero.db, dinero.id, completeMetadata).ok).toBe(false);
    } finally { dinero.db.close(); rmSync(dinero.root, { recursive: true, force: true }); }

    const voucher = legacyDocument();
    try {
      expect(enrichDocumentMetadata(voucher.db, voucher.id, { ...completeMetadata, documentType: "internal_voucher" }).errors).toContain("internal voucher metadata cannot be enriched");
    } finally { voucher.db.close(); rmSync(voucher.root, { recursive: true, force: true }); }
  });
});
