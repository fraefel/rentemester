// Document list, file serve, and booking-options read handlers.

import { purchaseVatPreflightSnapshot } from "../../cli/purchase-vat-preflight";
import { PDF_EVIDENCE_TAMPERED, PdfParseError, readVerifiedPdfParse } from "../../core/document-pdf-parser";
import { inspectOpenLedger, openLedgerReadOnly } from "../../core/ledger-inspection";
import { companyPaths } from "../../core/paths";
import { companyRootForSlug } from "../../core/workspace";
import type { ServerConfig } from "../config";
import {
  buildCompanyDocuments,
  buildDocumentBookingOptions,
  resolveCompanyDocumentFile,
} from "../data";
import { recordHostedDocumentAccess } from "../document-access-audit";
import { ApiError } from "../errors";
import { invoiceExtractionSurface } from "../invoice-extraction-surface";
import { responseBodyFromBytes } from "../response-body";
import { okResponse } from "./_shared";

export function handleCompanyDocuments(config: ServerConfig, slug: string): Response {
  const data = buildCompanyDocuments(config.workspaceRoot, slug);
  return okResponse({ documents: data });
}

/**
 * GET /api/companies/:slug/documents/:id/booking-options — the read-side data
 * the Bogfør-bilag modal needs (#407): the document fields to prefill, the
 * bookable expense accounts, and the unmatched outgoing bank transactions the
 * owner can pair the bilag with. A read route, so it bypasses the mutation
 * pipeline; an unknown company / ledger / document is a 404.
 */
export function handleCompanyDocumentBookingOptions(
  config: ServerConfig,
  slug: string,
  idRaw: string,
): Response {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest("document id must be a positive integer");
  }
  const data = buildDocumentBookingOptions(config.workspaceRoot, slug, id);
  return okResponse({ options: data });
}

/** Read-only VAT preflight. It deliberately performs no provider I/O. */
export function handleCompanyDocumentVatPreflight(config: ServerConfig, slug: string, idRaw: string): Response {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest("document id must be a positive integer");
  const db = openLedgerReadOnly(companyPaths(companyRootForSlug(config.workspaceRoot, slug)).db);
  try {
    if (inspectOpenLedger(db).status !== "current") throw ApiError.notFound("company ledger is not ready");
    return okResponse({ preflight: purchaseVatPreflightSnapshot(db, id) });
  } finally {
    db.close();
  }
}

/** Read-only extraction evidence. Never includes a stored path or provider configuration. */
export function handleCompanyDocumentInvoiceExtraction(config: ServerConfig, slug: string, idRaw: string): Response {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest("document id must be a positive integer");
  const db = openLedgerReadOnly(companyPaths(companyRootForSlug(config.workspaceRoot, slug)).db);
  try { if (inspectOpenLedger(db).status !== "current") throw ApiError.notFound("company ledger is not ready"); return okResponse({ extraction: invoiceExtractionSurface(db, id) }); } finally { db.close(); }
}

/**
 * Public, verified parser DTOs shared by HTTP, CLI and MCP.  Deliberately do
 * not expose parser result ids, stored paths, child diagnostics, or raw layout
 * coordinates.  Page text is evidence; layout is represented by its persisted
 * SHA-256 integrity hash.
 */
export type DocumentPdfParseStatusDto = {
  documentId: number; sourceSha256: string; parserId: string; parserVersion: string;
  contractVersion: string; status: string; errorCode: string | null; pageCount: number;
  itemCount: number; textLength: number; resultHash: string;
};
export function documentPdfParseStatus(db: any, companyRoot: string, documentId: number): DocumentPdfParseStatusDto | null {
  return readVerifiedPdfParse(db, companyRoot, documentId)?.parse ?? null;
}
export function documentPdfParsedText(db: any, companyRoot: string, documentId: number, offset = 0, limit = 10) {
  const verified=readVerifiedPdfParse(db, companyRoot, documentId); const parse=verified?.parse ?? null;
  if (!verified) return { parse, pages: [], offset, limit, nextOffset: null };
  const pages=verified.pages.slice(offset,offset+limit);
  return { parse, pages, offset, limit, nextOffset: offset + pages.length < verified.pages.length ? offset + pages.length : null };
}
function openVerifiedRead(config: ServerConfig, slug: string) {
  const db = openLedgerReadOnly(companyPaths(companyRootForSlug(config.workspaceRoot, slug)).db);
  const inspection = inspectOpenLedger(db);
  if (inspection.status !== "current") { db.close(); throw ApiError.notFound("company ledger is not ready"); }
  return db;
}
/** Read-only PDF parse state; parser errors are persisted as codes, not stderr. */
export function handleCompanyDocumentParseStatus(config: ServerConfig, slug: string, idRaw: string): Response {
  const id = Number(idRaw); if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest("document id must be a positive integer");
  const db = openVerifiedRead(config, slug); try { return okResponse({ parse: documentPdfParseStatus(db, companyRootForSlug(config.workspaceRoot, slug), id) }); } catch (error) { if (error instanceof PdfParseError && error.code === "tampered_result") throw ApiError.conflict("PDF evidence integrity verification failed", { subcode: PDF_EVIDENCE_TAMPERED }); throw error; } finally { db.close(); }
}
/** Read-only parsed pages, capped at ten to bound agent and HTTP responses. */
export function handleCompanyDocumentParsedText(config: ServerConfig, slug: string, idRaw: string, url: URL): Response {
  const id = Number(idRaw), offset = Number(url.searchParams.get("offset") ?? "0"), limit = Number(url.searchParams.get("limit") ?? "10");
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw ApiError.badRequest("document id, offset and limit (1..10) are invalid");
  const db = openVerifiedRead(config, slug); try { return okResponse(documentPdfParsedText(db, companyRootForSlug(config.workspaceRoot, slug), id, offset, limit)); } catch (error) { if (error instanceof PdfParseError && error.code === "tampered_result") throw ApiError.conflict("PDF evidence integrity verification failed", { subcode: PDF_EVIDENCE_TAMPERED }); throw error; } finally { db.close(); }
}

/**
 * GET /api/companies/:slug/documents/:id/file — serves the stored bilag file
 * so a human can open it in the cockpit. A read route, so it does not run the
 * mutation pipeline; an unknown company or document is a 404.
 */
export function handleCompanyDocumentFile(
  config: ServerConfig,
  slug: string,
  idRaw: string,
): Response {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest("document id must be a positive integer");
  }
  const file = resolveCompanyDocumentFile(config.workspaceRoot, slug, id);
  recordHostedDocumentAccess(config, {
    companySlug: slug,
    resourceType: "document_file",
    resourceId: id,
    outcome: "served",
    reasonCode: "authorized",
  });
  // Stored filenames never cross this boundary.  The resolver returns a
  // verified fd-backed byte snapshot and a generated safe name; all source
  // documents are attachments so untrusted document bytes cannot render in
  // the cockpit origin.
  return new Response(responseBodyFromBytes(file.bytes), {
    headers: {
      "content-type": file.mimeType,
      "content-disposition": `attachment; filename=\"${file.filename}\"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
