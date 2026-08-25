import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs, companyPaths } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { inspectOpenLedger, openLedgerReadOnly } from "../../src/core/ledger-inspection";
import { documentPdfParsedText, documentPdfParseStatus } from "../../src/server/router/documents";
import { createHash } from "node:crypto";

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

describe("document PDF public surfaces", () => {
  test("status and page DTOs are verified-table based, paginated, and redact layout", () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-surface-"));
    try {
      const paths = ensureCompanyDirs(root);
      const writable = openDb(paths.db); migrate(writable);
      const source = Buffer.from("%PDF-1.4\nsynthetic evidence\n");
      const sourceHash = createHash("sha256").update(source).digest("hex");
      mkdirSync(join(root, "documents", "originals"), { recursive: true });
      writeFileSync(join(root, "documents", "originals", "safe.pdf"), source);
      writable.query("INSERT INTO documents(document_no, source, original_filename, mime_type, status, stored_path, sha256_hash) VALUES(?,?,?,?,?,?,?)").run("D-1", "test", "safe.pdf", "application/pdf", "stored", "safe.pdf", sourceHash);
      const pages = [{ pageNumber: 1, width: 612, height: 792, rotation: 0, text: "hello", layout: [{ text: "hello", x: 1, y: 2, width: 3, height: 4, font: "F" }] }, { pageNumber: 2, width: 612, height: 792, rotation: 0, text: "world", layout: [] }];
      const evidence = { contractVersion: "document-pdf-text-v1", inputSha256: sourceHash, status: "ok", errorCode: null, pages };
      const resultHash = digest(evidence);
      const result = writable.query("INSERT INTO document_pdf_parse_results(document_id,source_sha256_hash,parser_id,parser_version,contract_version,status,error_code,page_count,item_count,text_length,result_json,result_sha256_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").get(1, sourceHash, "pdfjs-dist", "6.2.108", "document-pdf-text-v1", "ok", null, 2, 1, 10, canonical(evidence), resultHash) as { id: number };
      const insert = writable.query("INSERT INTO document_pdf_parse_pages(result_id,page_number,width,height,rotation,text,layout_json,item_count,page_sha256_hash) VALUES(?,?,?,?,?,?,?,?,?)");
      insert.run(result.id, 1, 612, 792, 0, "hello", canonical(pages[0]!.layout), 1, digest(pages[0]));
      insert.run(result.id, 2, 612, 792, 0, "world", canonical(pages[1]!.layout), 0, digest(pages[1]));
      writable.close();

      const db = openLedgerReadOnly(companyPaths(root).db);
      expect(inspectOpenLedger(db).status).toBe("current");
      expect(documentPdfParseStatus(db, root, 1)).toEqual(expect.objectContaining({ documentId: 1, status: "ok", resultHash }));
      const page = documentPdfParsedText(db, root, 1, 0, 1);
      expect(page.pages).toHaveLength(1);
      expect(page.pages[0]).toEqual(expect.objectContaining({ pageNumber: 1, text: "hello", itemCount: 1 }));
      expect(page.pages[0]).not.toHaveProperty("layout");
      expect(page.pages[0].layoutHash).toMatch(/^[a-f0-9]{64}$/);
      expect(page.nextOffset).toBe(1);
      expect(documentPdfParsedText(db, root, 1, 1, 10).pages[0]?.text).toBe("world");
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
