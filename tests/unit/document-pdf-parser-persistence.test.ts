import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../src/core/db";
import { PDF_EVIDENCE_TAMPERED, PdfParseError, readVerifiedPdfParse } from "../../src/core/document-pdf-parser";
import { openLedgerReadOnly } from "../../src/core/ledger-inspection";
import { companyPaths, ensureCompanyDirs } from "../../src/core/paths";

const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

function fixture() {
  const root=mkdtempSync(join(tmpdir(), "pdf-evidence-")); const source=Buffer.from("%PDF-1.4\nverified\n"); const sourceHash=createHash("sha256").update(source).digest("hex");
  mkdirSync(join(root,"documents","originals"),{recursive:true}); writeFileSync(join(root,"documents","originals","evidence.pdf"),source);
  const db=openDb(ensureCompanyDirs(root).db); migrate(db);
  db.query("INSERT INTO documents(document_no,source,original_filename,mime_type,status,stored_path,sha256_hash) VALUES(?,?,?,?,?,?,?)").run("D-1","test","evidence.pdf","application/pdf","stored","documents/originals/evidence.pdf",sourceHash);
  const page={pageNumber:1,width:612,height:792,rotation:0,text:"verified",layout:[{text:"verified",x:1,y:2,width:3,height:4,font:"F"}]};
  const result={contractVersion:"document-pdf-text-v1",inputSha256:sourceHash,status:"ok",errorCode:null,pages:[page]};
  const row=db.query("INSERT INTO document_pdf_parse_results(document_id,source_sha256_hash,parser_id,parser_version,contract_version,status,error_code,page_count,item_count,text_length,result_json,result_sha256_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id").get(1,sourceHash,"pdfjs-dist","6.2.108","document-pdf-text-v1","ok",null,1,1,8,canonical(result),hash(result)) as {id:number};
  db.query("INSERT INTO document_pdf_parse_pages(result_id,page_number,width,height,rotation,text,layout_json,item_count,page_sha256_hash) VALUES(?,?,?,?,?,?,?,?,?)").run(row.id,1,612,792,0,"verified",canonical(page.layout),1,hash(page)); db.close();
  return {root, source, assertTampered() { const read=openLedgerReadOnly(companyPaths(root).db); try { expect(() => readVerifiedPdfParse(read,root,1)).toThrow(PdfParseError); try { readVerifiedPdfParse(read,root,1); } catch (error) { expect(error).toMatchObject({code:"tampered_result"}); expect(PDF_EVIDENCE_TAMPERED).toBe("PDF_EVIDENCE_TAMPERED"); } } finally { read.close(); } }};
}

describe("persisted PDF evidence verification", () => {
  test("rejects each persisted page column and each registered source byte", () => {
    const mutations: Array<[string,string,unknown]> = [["page_number","page_number",2],["width","width",613],["height","height",793],["rotation","rotation",90],["text","text","altered"],["layout_json","layout_json","[]"],["item_count","item_count",2],["page_sha256_hash","page_sha256_hash","0".repeat(64)]];
    for (const [, column, value] of mutations) { const f=fixture(); try { const db=openDb(companyPaths(f.root).db); db.exec("DROP TRIGGER document_pdf_parse_pages_no_update"); db.query(`UPDATE document_pdf_parse_pages SET ${column}=? WHERE result_id=1`).run(value); db.close(); f.assertTampered(); } finally { rmSync(f.root,{recursive:true,force:true}); } }
    for (let index=0; index<2; index++) { const f=fixture(); try { const changed=Buffer.from(f.source); changed[index]^=1; writeFileSync(join(f.root,"documents","originals","evidence.pdf"),changed); f.assertTampered(); } finally { rmSync(f.root,{recursive:true,force:true}); } }
  });
});
