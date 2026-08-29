import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

function legacyDocument(status = "ingested") {
  const root = mkdtempSync(join(tmpdir(), "rentemester-document-enrich-"));
  const db = openDb(ensureCompanyDirs(root).db); migrate(db); seedAccounts(db);
  const originalPayload = JSON.stringify({ source: "email", invoiceNo: "LEGACY-1" });
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
      expect(payload._enrichment.originalPayload).toEqual(JSON.parse(fixture.originalPayload));
      expect(payload._enrichment.originalPayloadJson).toBe(fixture.originalPayload);
      expect(fixture.db.query("SELECT event_type, actor FROM audit_log WHERE entity_id = ?").all(fixture.id)).toEqual([{ event_type: "document_metadata_enriched", actor: "user:tester via test" }]);
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
      expect(enrichDocumentMetadata(fixture.db, fixture.id, completeMetadata).ok).toBe(false);
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
});
