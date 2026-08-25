// Document list, file serve, and booking-options read handlers.

import { purchaseVatPreflightSnapshot } from "../../cli/purchase-vat-preflight";
import { migrate, openDb } from "../../core/db";
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
  const db = openDb(companyPaths(companyRootForSlug(config.workspaceRoot, slug)).db);
  try {
    migrate(db);
    return okResponse({ preflight: purchaseVatPreflightSnapshot(db, id) });
  } finally {
    db.close();
  }
}

/** Read-only extraction evidence. Never includes a stored path or provider configuration. */
export function handleCompanyDocumentInvoiceExtraction(config: ServerConfig, slug: string, idRaw: string): Response {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest("document id must be a positive integer");
  const db = openDb(companyPaths(companyRootForSlug(config.workspaceRoot, slug)).db);
  try { migrate(db); return okResponse({ extraction: invoiceExtractionSurface(db, id) }); } finally { db.close(); }
}

function parsedStatus(db: any, documentId: number) {
  return db.query(`SELECT id, document_id AS documentId, source_sha256_hash AS sourceSha256, parser_id AS parserId, parser_version AS parserVersion, contract_version AS contractVersion, status, error_code AS errorCode, page_count AS pageCount, item_count AS itemCount, text_length AS textLength, result_sha256_hash AS resultHash, created_at AS createdAt FROM document_pdf_parses WHERE document_id=? ORDER BY id DESC LIMIT 1`).get(documentId) ?? null;
}
/** Read-only PDF parse state; parser errors are persisted as codes, not stderr. */
export function handleCompanyDocumentParseStatus(config: ServerConfig, slug: string, idRaw: string): Response {
  const id = Number(idRaw); if (!Number.isInteger(id) || id <= 0) throw ApiError.badRequest("document id must be a positive integer");
  const db = openDb(companyPaths(companyRootForSlug(config.workspaceRoot, slug)).db); try { migrate(db); return okResponse({ parse: parsedStatus(db, id) }); } finally { db.close(); }
}
/** Read-only parsed pages, capped at ten to bound agent and HTTP responses. */
export function handleCompanyDocumentParsedText(config: ServerConfig, slug: string, idRaw: string, url: URL): Response {
  const id = Number(idRaw), offset = Number(url.searchParams.get("offset") ?? "0"), limit = Number(url.searchParams.get("limit") ?? "10");
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw ApiError.badRequest("document id, offset and limit (1..10) are invalid");
  const db = openDb(companyPaths(companyRootForSlug(config.workspaceRoot, slug)).db); try { migrate(db); const parse = parsedStatus(db, id); const pages = parse ? db.query(`SELECT page_number AS pageNumber, width, height, rotation, text, item_count AS itemCount FROM document_pdf_parse_pages WHERE parse_id=? ORDER BY page_number LIMIT ? OFFSET ?`).all(parse.id, limit, offset) : []; return okResponse({ parse, pages, offset, limit, nextOffset: pages.length === limit ? offset + limit : null }); } finally { db.close(); }
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
