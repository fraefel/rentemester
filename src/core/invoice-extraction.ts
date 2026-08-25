import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { recordException } from "./exceptions";
import { resolveSupplierIdentity, type SupplierIdentifierKind } from "./supplier-identity";

export const MAX_INVOICE_PDF_BYTES = 10 * 1024 * 1024;
export type InvoiceExtractionClock = { now(): Date };
export const systemInvoiceExtractionClock: InvoiceExtractionClock = { now: () => new Date() };
export type InvoiceEvidenceBox = { x: number; y: number; width: number; height: number };
export type InvoiceEvidenceField = { key: InvoiceEvidenceKey; value: unknown; confidence: number; page: number; sourceText: string; box?: InvoiceEvidenceBox };
export type InvoiceEvidenceKey = "invoiceNumber" | "supplierName" | "supplierCountry" | "supplierLegalId" | "supplierLegalIdKind" | "buyerName" | "buyerCountry" | "buyerLegalId" | "buyerLegalIdKind" | "invoiceDate" | "currency" | "netAmount" | "vatAmount" | "grossAmount" | "reverseChargeWording";
export type InvoiceExtractorInput = { pdfBytes: Buffer; sha256: string };
export type InvoiceExtractorOutput = { fields: InvoiceEvidenceField[] };
export interface InvoiceExtractor { id: string; version: string; supports(input: InvoiceExtractorInput): boolean; extract(input: InvoiceExtractorInput): Promise<InvoiceExtractorOutput>; }

/** Deterministic test seam; production code must inject an actual extractor. */
export class ScriptedInvoiceExtractor implements InvoiceExtractor {
  readonly id: string; readonly version: string; calls = 0;
  constructor(private readonly script: InvoiceExtractorOutput | Error, id = "scripted", version = "1") { this.id = id; this.version = version; }
  supports(): boolean { return true; }
  async extract(): Promise<InvoiceExtractorOutput> { this.calls++; if (this.script instanceof Error) throw this.script; return this.script; }
}

const keys = new Set<InvoiceEvidenceKey>(["invoiceNumber", "supplierName", "supplierCountry", "supplierLegalId", "supplierLegalIdKind", "buyerName", "buyerCountry", "buyerLegalId", "buyerLegalIdKind", "invoiceDate", "currency", "netAmount", "vatAmount", "grossAmount", "reverseChargeWording"]);
const nonEmpty = (v: unknown, max = 500) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
const isoDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const money = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
function validField(rawField: unknown): string | undefined {
  if (!rawField || typeof rawField !== "object") return "EXTRACTION_INVALID_FIELD";
  const value = rawField as Partial<InvoiceEvidenceField>;
  if (typeof value.key !== "string" || !keys.has(value.key as InvoiceEvidenceKey) || !Number.isFinite(value.confidence) || value.confidence! < 0 || value.confidence! > 1 || !Number.isInteger(value.page) || value.page! < 1 || !nonEmpty(value.sourceText, 4000)) return "EXTRACTION_INVALID_PROVENANCE";
  if (value.box !== undefined && (!value.box || typeof value.box !== "object" || ![value.box.x, value.box.y, value.box.width, value.box.height].every(n => typeof n === "number" && Number.isFinite(n)) || value.box.width < 0 || value.box.height < 0)) return "EXTRACTION_INVALID_BOX";
  const field = value as InvoiceEvidenceField;
  if (["supplierLegalId", "buyerLegalId"].includes(field.key) && !nonEmpty(field.value, 64)) return "legal identifiers require cited source text and a non-empty exact value";
  if ((field.key === "invoiceDate" && !isoDate(field.value)) || (["netAmount", "vatAmount", "grossAmount"].includes(field.key) && !money(field.value)) || (field.key === "currency" && (!nonEmpty(field.value, 3) || String(field.value).trim().length !== 3))) return `invalid ${field.key} value`;
  return undefined;
}
function at(clock: InvoiceExtractionClock) { return clock.now().toISOString(); }
function exception(db: Database, documentId: number, attemptId: number, message: string, evidence: unknown) { return recordException(db, { type: "INVOICE_EXTRACTION", severity: "high", relatedDocumentId: documentId, message, requiredAction: "Review cited invoice evidence and append a resolution before posting", resolutionKey: `invoice-extraction:${attemptId}`, sourceEvidence: evidence }); }
const providerErrorCode = (cause: unknown) => cause instanceof Error && cause.message === "extractor does not support this PDF" ? "EXTRACTION_UNSUPPORTED" : "EXTRACTION_PROVIDER_UNAVAILABLE";

export function registerInvoicePdf(db: Database, input: { documentId: number; companyId: number; pdfBytes: Buffer; clock?: InvoiceExtractionClock }) {
  if (!Number.isInteger(input.documentId) || !Number.isInteger(input.companyId) || input.pdfBytes.length === 0 || input.pdfBytes.length > MAX_INVOICE_PDF_BYTES) throw new Error(`PDF bytes must be between 1 and ${MAX_INVOICE_PDF_BYTES}`);
  const sha256 = createHash("sha256").update(input.pdfBytes).digest("hex"); const clock = input.clock ?? systemInvoiceExtractionClock;
  const existing = db.query("SELECT id,document_id,sha256_hash FROM invoice_extraction_documents WHERE sha256_hash=?").get(sha256) as any;
  if (existing) return { extractionDocumentId: existing.id as number, documentId: existing.document_id as number, sha256, duplicate: true };
  const row = db.query("INSERT INTO invoice_extraction_documents(document_id,company_id,sha256_hash,pdf_bytes,byte_length,created_at) VALUES(?,?,?,?,?,?) RETURNING id").get(input.documentId, input.companyId, sha256, Buffer.from(input.pdfBytes), input.pdfBytes.length, at(clock)) as { id: number };
  return { extractionDocumentId: row.id, documentId: input.documentId, sha256, duplicate: false };
}

export async function extractInvoice(db: Database, input: { documentId: number; companyId: number; pdfBytes: Buffer; extractor: InvoiceExtractor; clock?: InvoiceExtractionClock; actor?: string; suppliedMetadata?: { invoiceNumber?: string; currency?: string; grossAmount?: number }; selectedBuyer?: { name?: string; country?: string; legalId?: string }; confidenceThreshold?: number }) {
  const clock = input.clock ?? systemInvoiceExtractionClock; const registered = registerInvoicePdf(db, { ...input, clock });
  const versionPattern = `${input.extractor.version}%`;
  const existing = db.query("SELECT a.id FROM invoice_extraction_attempts a JOIN invoice_extraction_resolutions r ON r.attempt_id=a.id AND r.field_key='extraction_status' WHERE a.extraction_document_id=? AND a.extractor_id=? AND a.extractor_version LIKE ? AND json_extract(r.resolution_json,'$.status')='completed' ORDER BY r.id DESC LIMIT 1").get(registered.extractionDocumentId, input.extractor.id, versionPattern) as { id: number } | null;
  if (existing) return { ...loadInvoiceExtractionEvidence(db, existing.id), duplicate: true };
  const actor = input.actor?.trim() || "system:invoice-extraction";
  const retryCount = (db.query("SELECT count(*) AS n FROM invoice_extraction_attempts WHERE extraction_document_id=? AND extractor_id=? AND extractor_version LIKE ?").get(registered.extractionDocumentId, input.extractor.id, versionPattern) as { n: number }).n;
  const storedVersion = retryCount === 0 ? input.extractor.version : `${input.extractor.version}#retry-${retryCount}`;
  const attempt = db.query("INSERT INTO invoice_extraction_attempts(extraction_document_id,extractor_id,extractor_version,status,created_at,initiated_by) VALUES(?,?,?,?,?,?) RETURNING id").get(registered.extractionDocumentId, input.extractor.id, storedVersion, "started", at(clock), actor) as { id: number };
  db.query("INSERT INTO audit_log(event_type,entity_type,entity_id,message,actor) VALUES(?,?,?,?,?)").run("invoice_extraction_attempt", "invoice_extraction_attempt", attempt.id, "Invoice extraction attempt started", actor);
  const extractorInput = { pdfBytes: Buffer.from(input.pdfBytes), sha256: registered.sha256 };
  let output: InvoiceExtractorOutput;
  try { if (!input.extractor.supports(extractorInput)) throw new Error("extractor does not support this PDF"); output = await input.extractor.extract(extractorInput); }
  catch (cause) { const code = providerErrorCode(cause); db.query("INSERT INTO invoice_extraction_resolutions(attempt_id,field_key,resolution_json,resolved_by,created_at) VALUES(?,?,?,?,?)").run(attempt.id, "provider_failure", JSON.stringify({ code }), actor, at(clock)); db.query("INSERT INTO invoice_extraction_resolutions(attempt_id,field_key,resolution_json,resolved_by,created_at) VALUES(?,?,?,?,?)").run(attempt.id, "extraction_status", JSON.stringify({ status: "needs_resolution", errors: [code] }), actor, at(clock)); exception(db, input.documentId, attempt.id, code, { code }); return { attemptId: attempt.id, status: "needs_resolution" as const, duplicate: false, errors: [code] }; }
  const rawFields = output && Array.isArray(output.fields) ? output.fields : [];
  const errors = !output || !Array.isArray(output.fields) ? ["EXTRACTION_INVALID_RESPONSE"] : rawFields.map(validField).filter((x): x is string => !!x); const seen = new Set<string>(); for (const f of rawFields) { const key = f && typeof f === "object" ? (f as InvoiceEvidenceField).key : undefined; if (key && seen.has(key)) errors.push("EXTRACTION_DUPLICATE_FIELD"); if (key) seen.add(key); }
  if (errors.length) { exception(db, input.documentId, attempt.id, "EXTRACTION_INVALID_RESPONSE", errors); db.query("INSERT INTO invoice_extraction_resolutions(attempt_id,field_key,resolution_json,resolved_by,created_at) VALUES(?,?,?,?,?)").run(attempt.id, "extraction_status", JSON.stringify({ status: "needs_resolution", errors: [...new Set(errors)].slice(0, 20) }), actor, at(clock)); return { attemptId: attempt.id, status: "needs_resolution" as const, duplicate: false, errors: [...new Set(errors)].slice(0, 20), autoPostingBlocked: true }; }
  const result = db.query("INSERT INTO invoice_extraction_results(attempt_id,result_json,created_at,initiated_by) VALUES(?,?,?,?) RETURNING id").get(attempt.id, JSON.stringify({ extractor: { id: input.extractor.id, version: input.extractor.version } }), at(clock), actor) as { id: number };
  for (const f of output.fields) db.query("INSERT INTO invoice_extraction_fields(result_id,field_key,value_json,confidence,page_number,source_text,box_json) VALUES(?,?,?,?,?,?,?)").run(result.id, f.key, JSON.stringify(f.value), f.confidence, f.page, f.sourceText, f.box ? JSON.stringify(f.box) : null);
  const evidence = loadInvoiceExtractionEvidence(db, attempt.id); const checks = validateInvoiceEvidence(evidence, input); const status = checks.errors.length ? "needs_resolution" : "completed";
  if (checks.errors.length) exception(db, input.documentId, attempt.id, checks.errors.join("; "), evidence);
  // Attempts are immutable, so their terminal disposition is an append-only resolution event.
  db.query("INSERT INTO invoice_extraction_resolutions(attempt_id,field_key,resolution_json,resolved_by,created_at) VALUES(?,?,?,?,?)").run(attempt.id, "extraction_status", JSON.stringify({ status, errors: checks.errors }), actor, at(clock));
  db.query("INSERT INTO audit_log(event_type,entity_type,entity_id,message,actor) VALUES(?,?,?,?,?)").run("invoice_extraction_result", "invoice_extraction_attempt", attempt.id, `Invoice extraction ${status}`, actor);
  return { ...evidence, attemptId: attempt.id, status, duplicate: false, errors: checks.errors, autoPostingBlocked: status !== "completed" };
}

export type InvoiceExtractionEvidence = { attemptId: number; documentId: number; companyId: number; status: string; fields: Partial<Record<InvoiceEvidenceKey, InvoiceEvidenceField>>; resolutions: Array<{ fieldKey: string; value: unknown }> };
/** Canonical loader for preflight, posting rules and batches. */
export function loadInvoiceExtractionEvidence(db: Database, attemptId: number): InvoiceExtractionEvidence {
  const row = db.query("SELECT a.id,d.document_id,d.company_id,a.status FROM invoice_extraction_attempts a JOIN invoice_extraction_documents d ON d.id=a.extraction_document_id WHERE a.id=?").get(attemptId) as any;
  if (!row) throw new Error("invoice extraction attempt does not exist");
  const result = db.query("SELECT id FROM invoice_extraction_results WHERE attempt_id=?").get(attemptId) as { id: number } | null;
  const fields: InvoiceExtractionEvidence["fields"] = {};
  if (result) for (const f of db.query("SELECT field_key,value_json,confidence,page_number,source_text,box_json FROM invoice_extraction_fields WHERE result_id=?").all(result.id) as any[]) fields[f.field_key as InvoiceEvidenceKey] = { key: f.field_key, value: JSON.parse(f.value_json), confidence: f.confidence, page: f.page_number, sourceText: f.source_text, box: f.box_json ? JSON.parse(f.box_json) : undefined };
  const resolutions = (db.query("SELECT field_key,resolution_json FROM invoice_extraction_resolutions WHERE attempt_id=? ORDER BY id").all(attemptId) as any[]).map(r => ({ fieldKey: r.field_key, value: JSON.parse(r.resolution_json) }));
  const terminal = resolutions.filter(r => r.fieldKey === "extraction_status").at(-1)?.value as { status?: string } | undefined;
  return { attemptId, documentId: row.document_id, companyId: row.company_id, status: terminal?.status ?? row.status, fields, resolutions };
}
export const loadInvoiceExtractionForPreflight = loadInvoiceExtractionEvidence;
export const loadInvoiceExtractionForRules = loadInvoiceExtractionEvidence;
export const loadInvoiceExtractionForBatch = loadInvoiceExtractionEvidence;
export function inspectDocumentInvoiceExtraction(db: Database, documentId: number): InvoiceExtractionEvidence | null {
  const row = db.query("SELECT a.id FROM invoice_extraction_attempts a JOIN invoice_extraction_documents d ON d.id=a.extraction_document_id WHERE d.document_id=? ORDER BY a.id DESC LIMIT 1").get(documentId) as { id: number } | null;
  return row ? loadInvoiceExtractionEvidence(db, row.id) : null;
}
function validateInvoiceEvidence(e: InvoiceExtractionEvidence, input: Parameters<typeof extractInvoice>[1]) {
  const f = e.fields; const errors: string[] = []; const threshold = input.confidenceThreshold ?? 0.8;
  for (const key of ["invoiceNumber", "supplierName", "buyerName", "invoiceDate", "currency", "netAmount", "vatAmount", "grossAmount"] as InvoiceEvidenceKey[]) if (!f[key] || f[key]!.confidence < threshold) errors.push(`${key} is missing or below material confidence`);
  if (f.netAmount && f.vatAmount && f.grossAmount && Math.abs(Number(f.netAmount.value) + Number(f.vatAmount.value) - Number(f.grossAmount.value)) > 0.01) errors.push("net amount plus VAT must equal gross amount");
  if (input.suppliedMetadata?.invoiceNumber && f.invoiceNumber?.value !== input.suppliedMetadata.invoiceNumber) errors.push("invoice number conflicts with supplied metadata");
  if (input.suppliedMetadata?.currency && f.currency?.value !== input.suppliedMetadata.currency) errors.push("currency conflicts with supplied metadata");
  if (input.suppliedMetadata?.grossAmount !== undefined && f.grossAmount?.value !== input.suppliedMetadata.grossAmount) errors.push("gross amount conflicts with supplied metadata");
  for (const [key, value] of Object.entries(input.selectedBuyer ?? {})) { const field = f[`buyer${key[0]!.toUpperCase()}${key.slice(1)}` as InvoiceEvidenceKey]; if (value && (!field || field.value !== value)) errors.push(`buyer ${key} conflicts with selected company`); }
  for (const side of ["supplier", "buyer"] as const) { const id = f[`${side}LegalId` as InvoiceEvidenceKey]; const kind = f[`${side}LegalIdKind` as InvoiceEvidenceKey]; const country = f[`${side}Country` as InvoiceEvidenceKey]; if (!f[`${side}Name` as InvoiceEvidenceKey] || !country || !id || !kind) errors.push(`${side} identity evidence is missing`); else if (!String(id.sourceText).includes(String(id.value)) || !resolveSupplierIdentity({ country: String(country.value), identifier: String(id.value), identifierKind: kind.value as SupplierIdentifierKind }).ok) errors.push(`${side} legal identifier is not supported by cited typed identity evidence`); }
  return { errors };
}
export function recognizeSupplier(db: Database, input: { companyId: number; identifierKind: SupplierIdentifierKind; identifier: string; supplierName: string; clock?: InvoiceExtractionClock }) {
  if (!nonEmpty(input.identifier, 64) || !nonEmpty(input.supplierName, 256)) throw new Error("exact typed supplier identity and name are required");
  const old = db.query("SELECT id,supplier_name FROM company_supplier_recognitions WHERE company_id=? AND identifier_kind=? AND identifier=?").get(input.companyId, input.identifierKind, input.identifier.trim()) as any;
  if (old) return { id: old.id, supplierName: old.supplier_name, duplicate: true };
  const row = db.query("INSERT INTO company_supplier_recognitions(company_id,identifier_kind,identifier,supplier_name,created_at) VALUES(?,?,?,?,?) RETURNING id").get(input.companyId, input.identifierKind, input.identifier.trim(), input.supplierName.trim(), at(input.clock ?? systemInvoiceExtractionClock)) as { id: number };
  return { id: row.id, supplierName: input.supplierName.trim(), duplicate: false };
}
