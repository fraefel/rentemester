// Hosted document/PDF access evidence. Kept outside data resolvers so the
// resolver remains a pure, read-only company-ledger operation.

import { insertWorkspaceDocumentAccessAudit, openWorkspaceControlDb } from "../core/workspace-control";
import type { ServerConfig } from "./config";

export type DocumentAccessResourceType = "document_file" | "issued_invoice_pdf";

/**
 * Writes evidence before a successful response is constructed.  Failure is
 * intentionally allowed to propagate: serving evidence without its required
 * hosted audit record would make the access unaccountable.
 */
export function recordHostedDocumentAccess(
  config: ServerConfig,
  input: {
    companySlug: string;
    resourceType: DocumentAccessResourceType;
    resourceId: number | null;
    outcome: "served" | "denied";
    reasonCode: "authorized" | "authorization_denied";
  },
): void {
  const principal = config.requestPrincipal;
  if (!config.betterAuthProvider || principal?.via !== "better-auth") return;
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    insertWorkspaceDocumentAccessAudit(db, {
      actor: principal.id,
      companySlug: input.companySlug,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      requestId: config.requestId ?? null,
    });
  } finally {
    db.close();
  }
}
