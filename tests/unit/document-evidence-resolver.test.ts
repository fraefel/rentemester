import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../src/core/db";
import { PdfParseError, parseRegisteredPdfDocument } from "../../src/core/document-pdf-parser";
import {
  DocumentEvidenceError,
  snapshotRegisteredDocument,
  snapshotRegisteredDocumentEvidence,
} from "../../src/core/document-storage";
import { ScriptedInvoiceExtractor } from "../../src/core/invoice-extraction";
import { ensureCompanyDirs } from "../../src/core/paths";
import { extractDocumentInvoice } from "../../src/server/invoice-extraction-surface";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-evidence-resolver-"));
  const paths = ensureCompanyDirs(root);
  const original = Buffer.from("synthetic original evidence\n");
  const issued = Buffer.from("synthetic issued evidence\n");
  writeFileSync(join(paths.documentsOriginals, "same.pdf"), original);
  writeFileSync(join(paths.invoicesIssued, "same.pdf"), issued);
  return {
    root,
    paths,
    original,
    issued,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function expectReason(run: () => unknown, reason: string, forbidden?: string) {
  try {
    run();
    throw new Error("expected evidence resolution to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentEvidenceError);
    expect(error).toMatchObject({ reason });
    expect(String(error)).not.toContain(forbidden ?? "/legacy/private/company");
  }
}

describe("registered document evidence resolver", () => {
  test("rebases current, relative, POSIX and Windows paths only from one exact known suffix", () => {
    const f = fixture();
    try {
      const references = [
        join(f.paths.documentsOriginals, "same.pdf"),
        "documents/originals/same.pdf",
        "/legacy/private/company/documents/originals/same.pdf",
        "C:\\legacy\\company\\documents\\originals\\same.pdf",
      ];
      for (const storedPath of references) {
        const snapshot = snapshotRegisteredDocumentEvidence(f.root, {
          storedPath,
          expectedSha256: sha256(f.original),
          documentType: "purchase_sale",
        });
        expect(snapshot.bytes).toEqual(f.original);
        expect(snapshot.path).toBe(realpathSync(join(f.paths.documentsOriginals, "same.pdf")));
      }

      const issued = snapshotRegisteredDocumentEvidence(f.root, {
        storedPath: "/legacy/company/invoices/issued/same.pdf",
        expectedSha256: sha256(f.issued),
        documentType: "issued_invoice_pdf",
      });
      expect(issued.bytes).toEqual(f.issued);
      expect(issued.path).toBe(realpathSync(join(f.paths.invoicesIssued, "same.pdf")));
    } finally {
      f.cleanup();
    }
  });

  test("rejects basename-only ambiguity, traversal, malformed and wrong-store paths", () => {
    const f = fixture();
    try {
      for (const storedPath of [
        "same.pdf",
        "documents/originals/../same.pdf",
        "documents//originals/same.pdf",
        "documents/originals/nested/same.pdf",
        "prefix/documents/originals/documents/originals/same.pdf",
        "invoices/issued/same.pdf",
      ]) {
        expectReason(() => snapshotRegisteredDocumentEvidence(f.root, {
          storedPath,
          expectedSha256: sha256(f.original),
          documentType: "purchase_sale",
        }), "invalid_path", storedPath);
      }
    } finally {
      f.cleanup();
    }
  });

  test("never falls through to another company, a symlink, a directory, or mismatched bytes", () => {
    const f = fixture();
    const other = fixture();
    try {
      rmSync(join(f.paths.documentsOriginals, "same.pdf"));
      expectReason(() => snapshotRegisteredDocumentEvidence(f.root, {
        storedPath: join(other.paths.documentsOriginals, "same.pdf"),
        expectedSha256: sha256(other.original),
        documentType: "purchase_sale",
      }), "unavailable", other.root);

      symlinkSync(join(other.paths.documentsOriginals, "same.pdf"), join(f.paths.documentsOriginals, "same.pdf"));
      expectReason(() => snapshotRegisteredDocumentEvidence(f.root, {
        storedPath: "documents/originals/same.pdf",
        expectedSha256: sha256(other.original),
        documentType: "purchase_sale",
      }), "unsafe_file");
      rmSync(join(f.paths.documentsOriginals, "same.pdf"));

      mkdirSync(join(f.paths.documentsOriginals, "same.pdf"));
      expectReason(() => snapshotRegisteredDocumentEvidence(f.root, {
        storedPath: "documents/originals/same.pdf",
        expectedSha256: sha256(f.original),
        documentType: "purchase_sale",
      }), "unsafe_file");
      rmSync(join(f.paths.documentsOriginals, "same.pdf"), { recursive: true });

      writeFileSync(join(f.paths.documentsOriginals, "same.pdf"), f.original);
      expectReason(() => snapshotRegisteredDocumentEvidence(f.root, {
        storedPath: "documents/originals/same.pdf",
        expectedSha256: "0".repeat(64),
        documentType: "purchase_sale",
      }), "hash_mismatch");
      try {
        snapshotRegisteredDocumentEvidence(f.root, {
          storedPath: "documents/originals/same.pdf",
          expectedSha256: "0".repeat(64),
          documentType: "purchase_sale",
        });
      } catch (error) {
        expect(error).toMatchObject({ code: "DOCUMENT_EVIDENCE_INTEGRITY_MISMATCH" });
      }
    } finally {
      f.cleanup();
      other.cleanup();
    }
  });

  test("resolves through the register without rewriting historical stored_path", () => {
    const f = fixture();
    const historicalPath = "/old-macos-volume/company/documents/originals/same.pdf";
    const db = openDb(f.paths.db);
    try {
      migrate(db);
      db.query(
        "INSERT INTO documents(source,stored_path,mime_type,sha256_hash,status,document_type) VALUES(?,?,?,?,?,?)",
      ).run("test", historicalPath, "application/pdf", sha256(f.original), "stored", "purchase_sale");
      expect(snapshotRegisteredDocument(db, f.root, 1).bytes).toEqual(f.original);
      expect(db.query("SELECT stored_path AS storedPath FROM documents WHERE id=1").get()).toEqual({
        storedPath: historicalPath,
      });
    } finally {
      db.close();
      f.cleanup();
    }
  });

  test("invoice extraction consumes the same rebased, hash-bound snapshot", async () => {
    const f = fixture();
    const historicalPath = "/old-linux-volume/company/documents/originals/same.pdf";
    const db = openDb(f.paths.db);
    try {
      migrate(db);
      db.query("INSERT INTO companies(id,name,country,currency,cvr) VALUES(1,?,?,?,?)").run(
        "Synthetic buyer",
        "DK",
        "DKK",
        "DK87654321",
      );
      db.query(
        `INSERT INTO documents(source,stored_path,mime_type,sha256_hash,status,document_type,
                               invoice_no,currency,amount_inc_vat)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run("test", historicalPath, "application/pdf", sha256(f.original), "stored", "purchase_sale", "INV-1", "DKK", 125);
      const fields = [
        ["invoiceNumber", "INV-1"], ["supplierName", "Synthetic supplier"],
        ["supplierCountry", "DK"], ["supplierLegalId", "DK12345678"],
        ["supplierLegalIdKind", "dk_cvr"], ["buyerName", "Synthetic buyer"],
        ["buyerCountry", "DK"], ["buyerLegalId", "DK87654321"],
        ["buyerLegalIdKind", "dk_cvr"], ["invoiceDate", "2026-01-02"],
        ["currency", "DKK"], ["netAmount", 100], ["vatAmount", 25], ["grossAmount", 125],
      ].map(([key, value]) => ({ key, value, confidence: 0.99, page: 1, sourceText: String(key) })) as never;
      const extractor = new ScriptedInvoiceExtractor({ fields });
      await extractDocumentInvoice(
        db,
        f.root,
        1,
        extractor,
        "agent:test",
      );
      expect(extractor.calls).toBe(1);
      expect(db.query("SELECT sha256_hash AS sha256Hash FROM invoice_extraction_documents WHERE document_id=1").get()).toEqual({
        sha256Hash: sha256(f.original),
      });
      expect(db.query("SELECT stored_path AS storedPath FROM documents WHERE id=1").get()).toEqual({ storedPath: historicalPath });
    } finally {
      db.close();
      f.cleanup();
    }
  });

  test("PDF parsing records missing and hash-conflicting sources as bounded source_unavailable failures", async () => {
    const f = fixture();
    const db = openDb(f.paths.db);
    try {
      migrate(db);
      const insert = db.query(
        "INSERT INTO documents(source,stored_path,mime_type,sha256_hash,status,document_type) VALUES(?,?,?,?,?,?)",
      );
      insert.run("test", "/legacy/company/documents/originals/same.pdf", "application/pdf", "0".repeat(64), "stored", "purchase_sale");
      insert.run("test", "/legacy/company/documents/originals/missing.pdf", "application/pdf", sha256(f.original), "stored", "purchase_sale");
      for (const documentId of [1, 2]) {
        try {
          await parseRegisteredPdfDocument(db, f.root, { documentId, createdBy: "agent:test" });
          throw new Error("expected parsing to fail before child launch");
        } catch (error) {
          expect(error).toBeInstanceOf(PdfParseError);
          expect(error).toMatchObject({ code: "source_unavailable" });
        }
      }
      expect(db.query("SELECT document_id AS documentId,error_code AS errorCode FROM document_pdf_parse_attempts ORDER BY id").all()).toEqual([
        { documentId: 1, errorCode: "source_unavailable" },
        { documentId: 2, errorCode: "source_unavailable" },
      ]);
    } finally {
      db.close();
      f.cleanup();
    }
  });
});
