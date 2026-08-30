/** HTTP adapter for the workspace inbox. The company slug is an access anchor,
 * never an implied ledger destination. */
import { Buffer } from "node:buffer";
import { authorizeWorkspaceRoute } from "../../core/workspace-access";
import { listWorkspaceCompanies } from "../../core/workspace";
import { openWorkspaceControlDb, openWorkspaceControlReadOnlyDb } from "../../core/workspace-control";
import { approveWorkspaceInboxAssignment, completeWorkspaceInboxAssignment, ingestWorkspaceInboxSource, inspectWorkspaceInboxSource, listWorkspaceInboxSources } from "../../core/workspace-document-inbox";
import type { ServerConfig } from "../config";
import { resolveCockpitActor } from "../actor";
import { ApiError } from "../errors";
import { assertLocalhostWriteAllowed, assertMutationContentType, assertMutationOriginAllowed, withCompanyMutation } from "../mutations";
import { okResponse, readJsonBody, requireString } from "./_shared";

function actor(config: ServerConfig) { if (!config.requestPrincipal) throw ApiError.unauthorized("missing or invalid credentials"); return resolveCockpitActor(config.requestPrincipal).createdBy; }
function writeGate(request: Request, config: ServerConfig): void { assertLocalhostWriteAllowed(request, config); assertMutationOriginAllowed(request, config); assertMutationContentType(request); }
function requireConfirm(body: Record<string, unknown>): void { if (body.confirm !== true) throw ApiError.badRequest("denne handling er irreversibel og kræver 'confirm: true'", { subcode: "CONFIRM_REQUIRED" }); }
function allowedCompanies(config: ServerConfig): Set<string> {
  const principal = config.requestPrincipal;
  if (!config.betterAuthProvider || !principal?.userId) return new Set(listWorkspaceCompanies(config.workspaceRoot).map(c => c.slug));
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot); try { return new Set(listWorkspaceCompanies(config.workspaceRoot).filter(company => authorizeWorkspaceRoute(db, config.workspaceRoot, { userId: principal.userId!, companySlug: company.slug, permission: "company.documents.upload" }).allowed).map(company => company.slug)); } finally { db.close(); }
}
function sourceForAnchor(config: ServerConfig, anchor: string, sourceId: string) { const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot); try { return inspectWorkspaceInboxSource(db, sourceId, anchor, allowedCompanies(config)); } finally { db.close(); } }

export function handleWorkspaceInboxList(config: ServerConfig, anchor: string, url: URL): Response {
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot); try { return okResponse(listWorkspaceInboxSources(db, { visibilityAnchorSlug: anchor, cursor: Number(url.searchParams.get("cursor") ?? 0), limit: Number(url.searchParams.get("limit") ?? 25), visibleCompanySlugs: allowedCompanies(config) })); } finally { db.close(); }
}
export function handleWorkspaceInboxInspect(config: ServerConfig, anchor: string, sourceId: string): Response { const source = sourceForAnchor(config, anchor, sourceId); if (!source) throw ApiError.notFound("workspace inbox source not found"); return okResponse({ source }); }
export async function handleWorkspaceInboxIngest(config: ServerConfig, request: Request, anchor: string): Promise<Response> {
  writeGate(request, config); const body = await readJsonBody(request); requireConfirm(body);
  if (typeof body.bytesBase64 !== "string") throw ApiError.badRequest("bytesBase64 is required");
  let bytes: Buffer; try { bytes = Buffer.from(body.bytesBase64, "base64"); } catch { throw ApiError.badRequest("bytesBase64 is invalid"); }
  const db = openWorkspaceControlDb(config.workspaceRoot); try {
    const source = ingestWorkspaceInboxSource(db, { sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined, visibilityAnchorSlug: anchor, idempotencyKey: requireString(body, "idempotencyKey"), bytes, filename: requireString(body, "filename"), mimeType: requireString(body, "mimeType"), transport: requireString(body, "transport") as any, transportIdentity: typeof body.transportIdentity === "string" ? body.transportIdentity : undefined, receivedAt: requireString(body, "receivedAt"), metadata: body.metadata as Record<string, unknown>, candidates: Array.isArray(body.candidates) ? body.candidates as any : [], visibleCompanySlugs: allowedCompanies(config), actor: actor(config) });
    return okResponse({ source }, 201);
  } finally { db.close(); }
}
export async function handleWorkspaceInboxApprove(config: ServerConfig, request: Request, anchor: string, sourceId: string): Promise<Response> {
  writeGate(request, config); const body = await readJsonBody(request); requireConfirm(body); const companySlug = requireString(body, "companySlug");
  if (!allowedCompanies(config).has(companySlug)) throw ApiError.notFound("workspace inbox source not found");
  const db = openWorkspaceControlDb(config.workspaceRoot); try { if (!inspectWorkspaceInboxSource(db, sourceId, anchor)) throw ApiError.notFound("workspace inbox source not found"); return okResponse({ source: approveWorkspaceInboxAssignment(db, { sourceId, companySlug, actor: actor(config) }) }); } finally { db.close(); }
}
export async function handleWorkspaceInboxComplete(config: ServerConfig, request: Request, anchor: string, sourceId: string): Promise<Response> {
  // `withCompanyMutation` owns the original body for confirm/CSRF/idempotency
  // handling. Read a clone solely to discover the explicitly selected target.
  const body = await readJsonBody(request.clone()); const companySlug = requireString(body, "companySlug");
  if (!allowedCompanies(config).has(companySlug) || !sourceForAnchor(config, anchor, sourceId)) throw ApiError.notFound("workspace inbox source not found");
  const result = await withCompanyMutation(request, config, companySlug, (ctx) => { const control = openWorkspaceControlDb(config.workspaceRoot); try { return { ok: true, source: completeWorkspaceInboxAssignment(control, ctx.db, ctx.companyRoot, { sourceId, companySlug, actor: ctx.actor.createdBy }) }; } finally { control.close(); } }, { requireConfirm: true });
  return okResponse(result);
}
