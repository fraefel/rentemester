import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { extractInvoice, inspectDocumentInvoiceExtraction, MAX_INVOICE_PDF_BYTES, type InvoiceExtractor } from "../core/invoice-extraction";

export async function extractDocumentInvoice(db: Database, documentId: number, extractor: InvoiceExtractor, actor?: string) {
  const doc = db.query("SELECT id, stored_path, mime_type, invoice_no, currency, amount_inc_vat, sha256_hash FROM documents WHERE id=?").get(documentId) as { id: number; stored_path: string | null; mime_type: string | null; invoice_no: string | null; currency: string | null; amount_inc_vat: number | null; sha256_hash: string } | null;
  const company = db.query("SELECT id,name,country,cvr FROM companies ORDER BY id LIMIT 1").get() as { id: number; name: string | null; country: string | null; cvr: string | null } | null;
  if (!doc || !company) throw new Error("document or company does not exist");
  if (doc.mime_type !== "application/pdf" || !doc.stored_path) throw new Error("invoice extraction supports stored PDF documents only");
  let pdfBytes: Buffer;
  try { pdfBytes = readFileSync(doc.stored_path); } catch { throw new Error("EXTRACTION_SNAPSHOT_UNAVAILABLE"); }
  if (pdfBytes.length === 0 || pdfBytes.length > MAX_INVOICE_PDF_BYTES) throw new Error("EXTRACTION_SNAPSHOT_INVALID");
  const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
  if (sha256 !== doc.sha256_hash) throw new Error("EXTRACTION_SNAPSHOT_HASH_MISMATCH");
  return extractInvoice(db, { documentId, companyId: company.id, pdfBytes: Buffer.from(pdfBytes), extractor, actor, suppliedMetadata: { ...(doc.invoice_no ? { invoiceNumber: doc.invoice_no } : {}), ...(doc.currency ? { currency: doc.currency } : {}), ...(doc.amount_inc_vat !== null ? { grossAmount: doc.amount_inc_vat } : {}) }, selectedBuyer: { name: company.name ?? undefined, country: company.country ?? undefined, legalId: company.cvr ?? undefined } });
}

export function invoiceExtractionSurface(db: Database, documentId: number) {
  const evidence = inspectDocumentInvoiceExtraction(db, documentId);
  if (!evidence) return null;
  const hash = db.query("SELECT sha256_hash FROM invoice_extraction_documents WHERE document_id=?").get(documentId) as { sha256_hash: string } | null;
  const exception = db.query("SELECT id,status FROM exceptions WHERE type='INVOICE_EXTRACTION' AND related_document_id=? ORDER BY id DESC LIMIT 1").get(documentId) as { id: number; status: string } | null;
  const terminal = evidence.resolutions.filter((r) => r.fieldKey === "extraction_status").at(-1)?.value as { errors?: unknown } | undefined;
  return { attemptId: evidence.attemptId, documentId: evidence.documentId, status: evidence.status, originalHash: hash?.sha256_hash ?? null, fields: Object.values(evidence.fields), resolutions: evidence.resolutions, conflicts: Array.isArray(terminal?.errors) ? terminal.errors : [], exceptionState: exception ? { id: exception.id, status: exception.status } : null };
}
