import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs, companyPaths } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { inspectOpenLedger, openLedgerReadOnly } from "../../src/core/ledger-inspection";
import { documentPdfParsedText, documentPdfParseStatus } from "../../src/server/router/documents";

describe("document PDF public surfaces", () => {
  test("status and page DTOs are verified-table based, paginated, and redact layout", () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-surface-"));
    try {
      const paths = ensureCompanyDirs(root);
      const writable = openDb(paths.db); migrate(writable);
      writable.query("INSERT INTO documents(document_no, source, original_filename, mime_type, status, sha256_hash) VALUES(?,?,?,?,?,?)").run("D-1", "test", "safe.pdf", "application/pdf", "stored", "a".repeat(64));
      const result = writable.query("INSERT INTO document_pdf_parse_results(document_id,source_sha256_hash,parser_id,parser_version,contract_version,status,error_code,page_count,item_count,text_length,result_json,result_sha256_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").get(1, "a".repeat(64), "pdfjs-dist", "6.2.108", "document-pdf-text-v1", "ok", null, 2, 2, 10, "{}", "b".repeat(64)) as { id: number };
      const insert = writable.query("INSERT INTO document_pdf_parse_pages(result_id,page_number,width,height,rotation,text,layout_json,item_count,page_sha256_hash) VALUES(?,?,?,?,?,?,?,?,?)");
      insert.run(result.id, 1, 612, 792, 0, "hello", '[{"text":"hello","x":1,"y":2,"width":3,"height":4,"font":"F"}]', 1, "c".repeat(64));
      insert.run(result.id, 2, 612, 792, 0, "world", "[]", 1, "d".repeat(64));
      writable.close();

      const db = openLedgerReadOnly(companyPaths(root).db);
      expect(inspectOpenLedger(db).status).toBe("current");
      expect(documentPdfParseStatus(db, 1)).toEqual(expect.objectContaining({ documentId: 1, status: "ok", resultHash: "b".repeat(64) }));
      const page = documentPdfParsedText(db, 1, 0, 1);
      expect(page.pages).toHaveLength(1);
      expect(page.pages[0]).toEqual(expect.objectContaining({ pageNumber: 1, text: "hello", itemCount: 1 }));
      expect(page.pages[0]).not.toHaveProperty("layout");
      expect(page.pages[0].layoutHash).toMatch(/^[a-f0-9]{64}$/);
      expect(page.nextOffset).toBe(1);
      expect(documentPdfParsedText(db, 1, 1, 10).pages[0]?.text).toBe("world");
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
