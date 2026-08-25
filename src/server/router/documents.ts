// Document list, file serve, and booking-options read handlers.

import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { recordHostedDocumentAccess } from "../document-access-audit";
import {
  buildCompanyDocuments,
  buildDocumentBookingOptions,
  resolveCompanyDocumentFile,
} from "../data";
import { okResponse } from "./_shared";
import { responseBodyFromBytes } from "../response-body";
import { companyRootForSlug } from "../../core/workspace";
import { companyPaths } from "../../core/paths";
import { openDb, migrate } from "../../core/db";
import { purchaseVatPreflightSnapshot } from "../../cli/purchase-vat-preflight";
import { invoiceExtractionSurface } from "../invoice-extraction-surface";

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
