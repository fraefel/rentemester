/** Deterministic, offline PDF text extraction.  The parser never opens paths. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAuditLog } from "./actor";
import { snapshotRegisteredPdfDocument } from "./document-storage";

export const PDF_PARSER_ID = "pdfjs-dist";
export const PDF_PARSER_VERSION = "6.2.108";
export const PDF_PARSER_CONTRACT_VERSION = "document-pdf-text-v1";
export const PDF_PARSE_TIMEOUT_MS = 15_000;
const MAX_STDOUT = 16 * 1024 * 1024, MAX_STDERR = 64 * 1024;
const MAX_PAGES = 200, MAX_ITEMS_PAGE = 25_000, MAX_ITEMS = 200_000, MAX_TEXT = 5 * 1024 * 1024;
export type PdfParseStatus = "ok" | "no_text_layer" | "malformed_pdf" | "encrypted_pdf" | "unsupported_pdf" | "resource_limit";
export type PdfLayoutItem = { text: string; x: number; y: number; width: number; height: number; font: string };
export type PdfParsePage = { pageNumber: number; width: number; height: number; rotation: number; text: string; layout: PdfLayoutItem[] };
export type PdfParseResult = { contractVersion: string; inputSha256: string; status: PdfParseStatus; errorCode: string | null; pages: PdfParsePage[] };
export type PdfParseRun = PdfParseResult & { cached: boolean; parseId?: number; resultHash: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const inputHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function boundedRead(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  return (async () => { if (!stream) return Buffer.alloc(0); const reader = stream.getReader(); const parts: Buffer[] = []; let size = 0; try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) throw new Error("child output limit exceeded"); parts.push(Buffer.from(next.value)); } return Buffer.concat(parts); } finally { reader.releaseLock(); } })();
}
function valid(result: unknown, expectedHash: string): result is PdfParseResult {
  if (!result || typeof result !== "object") return false;
  const r = result as Partial<PdfParseResult>;
  if (r.contractVersion !== PDF_PARSER_CONTRACT_VERSION || r.inputSha256 !== expectedHash || !["ok","no_text_layer","malformed_pdf","encrypted_pdf","unsupported_pdf","resource_limit"].includes(String(r.status)) || !Array.isArray(r.pages)) return false;
  if (r.pages.length > MAX_PAGES) return false;
  let items = 0, text = 0;
  return r.pages.every((page, i) => {
    const p = page as PdfParsePage;
    if (!p || p.pageNumber !== i + 1 || !Number.isFinite(p.width) || p.width <= 0 || !Number.isFinite(p.height) || p.height <= 0 || ![0,90,180,270].includes(p.rotation) || typeof p.text !== "string" || !Array.isArray(p.layout) || p.layout.length > MAX_ITEMS_PAGE) return false;
    items += p.layout.length; text += p.text.length;
    return items <= MAX_ITEMS && text <= MAX_TEXT && p.layout.every((x) => typeof x.text === "string" && [x.x,x.y,x.width,x.height].every(Number.isFinite) && typeof x.font === "string");
  });
}

/** Run the fixed child under a private cwd and a minimal environment. */
export async function parsePdfBytes(bytes: Uint8Array, options: { timeoutMs?: number; workerPath?: string } = {}): Promise<PdfParseResult> {
  const expectedHash = inputHash(bytes); const timeoutMs = options.timeoutMs ?? PDF_PARSE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PDF_PARSE_TIMEOUT_MS) throw new Error("invalid PDF parser timeout");
  const cwd = mkdtempSync(join(tmpdir(), "rentemester-pdf-"));
  try {
    const worker = options.workerPath ?? join(import.meta.dir, "document-pdf-parser-worker.ts");
    const child = Bun.spawn([process.execPath, "run", worker], { cwd, env: { PATH: process.env.PATH ?? "", TZ: "UTC", LANG: "C" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(bytes); child.stdin.end();
    let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([boundedRead(child.stdout, MAX_STDOUT), boundedRead(child.stderr, MAX_STDERR), child.exited]);
      if (timedOut) throw new Error("PDF parser timed out");
      if (exitCode !== 0) throw new Error("PDF parser crashed");
      if (stderr.length > MAX_STDERR) throw new Error("PDF parser stderr limit exceeded");
      let parsed: unknown; try { parsed = JSON.parse(stdout.toString("utf8")); } catch { throw new Error("PDF parser protocol violation"); }
      if (!valid(parsed, expectedHash)) throw new Error("PDF parser protocol violation");
      return parsed;
    } finally { clearTimeout(timer); }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

function terminal(status: PdfParseStatus) { return ["ok","no_text_layer","malformed_pdf","encrypted_pdf","unsupported_pdf","resource_limit"].includes(status); }
function hydrate(row: any, cached: boolean): PdfParseRun {
  const pages = JSON.parse(row.result_json).pages as PdfParsePage[];
  return { contractVersion: row.contract_version, inputSha256: row.source_sha256_hash, status: row.status, errorCode: row.error_code, pages, cached, parseId: row.id, resultHash: row.result_sha256_hash };
}
export async function parseRegisteredPdfDocument(db: Database, companyRoot: string, input: { documentId: number; createdBy?: string; createdByProgram?: string; timeoutMs?: number; workerPath?: string }): Promise<PdfParseRun> {
  const snapshot = snapshotRegisteredPdfDocument(db, companyRoot, input.documentId);
  const existing = db.query(`SELECT * FROM document_pdf_parses WHERE document_id=? AND source_sha256_hash=? AND parser_id=? AND parser_version=? AND contract_version=?`).get(input.documentId, snapshot.sha256, PDF_PARSER_ID, PDF_PARSER_VERSION, PDF_PARSER_CONTRACT_VERSION);
  if (existing) return hydrate(existing, true);
  const result = await parsePdfBytes(snapshot.bytes, { timeoutMs: input.timeoutMs, workerPath: input.workerPath });
  if (!terminal(result.status)) throw new Error("PDF parser returned non-terminal status");
  const resultHash = hash(result); const itemCount = result.pages.reduce((n, p) => n + p.layout.length, 0); const textLength = result.pages.reduce((n, p) => n + p.text.length, 0);
  try {
    const persisted = db.transaction(() => {
      const row = db.query(`INSERT INTO document_pdf_parses(document_id,source_sha256_hash,parser_id,parser_version,contract_version,status,error_code,page_count,item_count,text_length,result_json,result_sha256_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).get(input.documentId, snapshot.sha256, PDF_PARSER_ID, PDF_PARSER_VERSION, PDF_PARSER_CONTRACT_VERSION, result.status, result.errorCode, result.pages.length, itemCount, textLength, canonical(result), resultHash) as { id: number };
      const insertPage = db.query(`INSERT INTO document_pdf_parse_pages(parse_id,page_number,width,height,rotation,text,layout_json,item_count) VALUES(?,?,?,?,?,?,?,?)`);
      for (const page of result.pages) insertPage.run(row.id, page.pageNumber, page.width, page.height, page.rotation, page.text, canonical(page.layout), page.layout.length);
      insertAuditLog(db, { eventType: "document_pdf_parse", entityType: "document", entityId: input.documentId, message: `Parsed PDF document ${input.documentId} (${snapshot.sha256})`, createdBy: input.createdBy, createdByProgram: input.createdByProgram });
      return row.id;
    }).immediate();
    return { ...result, cached: false, parseId: persisted, resultHash };
  } catch (error) {
    const winner = db.query(`SELECT * FROM document_pdf_parses WHERE document_id=? AND source_sha256_hash=? AND parser_id=? AND parser_version=? AND contract_version=?`).get(input.documentId, snapshot.sha256, PDF_PARSER_ID, PDF_PARSER_VERSION, PDF_PARSER_CONTRACT_VERSION);
    if (winner && (winner as any).result_sha256_hash === resultHash) return hydrate(winner, true);
    if (winner) throw new Error("PDF parser cache collision has non-deterministic result");
    throw error;
  }
}
export async function parseRegisteredPdfBatch(db: Database, companyRoot: string, documentIds: readonly number[], options: { concurrency?: number; createdBy?: string; createdByProgram?: string; onActiveChildren?: (active: number) => void } = {}) {
  if (documentIds.length > 100) throw new Error("PDF parser batch limit is 100 documents");
  const concurrency = options.concurrency ?? 2; if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("PDF parser concurrency must be between 1 and 4");
  const output: Array<{ documentId: number; ok: true; result: PdfParseRun } | { documentId: number; ok: false; error: string }> = new Array(documentIds.length); let next = 0, active = 0;
  const worker = async () => { for (;;) { const index = next++; if (index >= documentIds.length) return; active++; options.onActiveChildren?.(active); try { output[index] = { documentId: documentIds[index]!, ok: true, result: await parseRegisteredPdfDocument(db, companyRoot, { documentId: documentIds[index]!, createdBy: options.createdBy, createdByProgram: options.createdByProgram }) }; } catch (e) { output[index] = { documentId: documentIds[index]!, ok: false, error: e instanceof Error ? e.message : "PDF parse failed" }; } finally { active--; options.onActiveChildren?.(active); } } };
  await Promise.all(Array.from({ length: Math.min(concurrency, documentIds.length) }, worker)); return output;
}
