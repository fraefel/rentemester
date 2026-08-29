import { authorizeWorkspaceRoute } from "../../core/workspace-access";
import { openWorkspaceControlDb, openWorkspaceControlReadOnlyDb } from "../../core/workspace-control";
import { createWorkspaceServicePrincipal, revokeWorkspaceServiceCredential, rotateWorkspaceServiceCredential } from "../../core/workspace-service-principals";
import { openWorkspaceBetterAuth } from "../better-auth";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse, readJsonBody, requireString } from "./_shared";

function requireOwner(config: ServerConfig) {
  const principal = config.requestPrincipal;
  if (config.deploymentProfile !== "hosted" || principal?.via !== "better-auth" || !principal.userId) throw ApiError.unauthorized("missing or invalid credentials");
  const db = openWorkspaceControlDb(config.workspaceRoot);
  const allowed = authorizeWorkspaceRoute(db, config.workspaceRoot, { userId: principal.userId, permission: "workspace.manage" }).allowed;
  if (!allowed) { db.close(); throw ApiError.unauthorized("missing or invalid credentials"); }
  return { db, actor: principal.id };
}

/** Listing credentials must be a pure inspection path: no schema migration,
 * journal-mode change or writable control-db handle is needed. */
function requireOwnerRead(config: ServerConfig) {
  const principal = config.requestPrincipal;
  if (config.deploymentProfile !== "hosted" || principal?.via !== "better-auth" || !principal.userId) throw ApiError.unauthorized("missing or invalid credentials");
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  const allowed = authorizeWorkspaceRoute(db, config.workspaceRoot, { userId: principal.userId, permission: "workspace.manage" }).allowed;
  if (!allowed) { db.close(); throw ApiError.unauthorized("missing or invalid credentials"); }
  return { db };
}

function authRuntime(config: ServerConfig) {
  const hosted = config.hostedBetterAuth;
  if (!hosted) throw ApiError.notFound("ukendt endpoint");
  return openWorkspaceBetterAuth(config.workspaceRoot, {
    secret: hosted.secret, secrets: hosted.secrets, legacySecret: hosted.legacySecret,
    baseURL: hosted.baseURL, trustedOrigins: hosted.trustedOrigins, deploymentMode: "hosted", useSecureCookies: true, rateLimitIpHeader: hosted.rateLimitIpHeader,
  });
}

function noStore(response: Response): Response { response.headers.set("cache-control", "no-store"); return response; }

export function handleServicePrincipalList(config: ServerConfig): Response {
  const { db } = requireOwnerRead(config);
  try {
    const principals = db.query(`SELECT p.user_id AS serviceAccountId, p.display_name AS displayName, p.created_at AS createdAt,
      (SELECT COUNT(*) FROM "apikey" k WHERE k."referenceId"=p.user_id AND k."configId"='workspace-service-principal' AND COALESCE(k."enabled",1)=1) AS activeCredentialCount
      FROM rm_workspace_service_principals p ORDER BY p.created_at, p.user_id`).all();
    return noStore(okResponse({ principals }));
  } finally { db.close(); }
}

export async function handleServicePrincipalCreate(config: ServerConfig, request: Request): Promise<Response> {
  const body = await readJsonBody(request); if (body.confirm !== true) throw ApiError.badRequest("confirm: true is required");
  const { db, actor } = requireOwner(config); const runtime = authRuntime(config);
  try {
    const issued = await createWorkspaceServicePrincipal(db, runtime.auth, { displayName: requireString(body, "displayName"), actor, ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}) });
    return noStore(okResponse({ serviceAccountId: issued.serviceAccountId, credentialId: issued.credentialId, secret: issued.secret }, 201));
  } finally { runtime.close(); db.close(); }
}

export async function handleServicePrincipalRotate(config: ServerConfig, request: Request): Promise<Response> {
  const body = await readJsonBody(request); if (body.confirm !== true) throw ApiError.badRequest("confirm: true is required");
  const { db, actor } = requireOwner(config); const runtime = authRuntime(config);
  try {
    const issued = await rotateWorkspaceServiceCredential(db, runtime.auth, { serviceAccountId: requireString(body, "serviceAccountId"), credentialId: requireString(body, "credentialId"), actor, ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}) });
    return noStore(okResponse({ serviceAccountId: issued.serviceAccountId, credentialId: issued.credentialId, secret: issued.secret }));
  } finally { runtime.close(); db.close(); }
}

export async function handleServicePrincipalRevoke(config: ServerConfig, request: Request): Promise<Response> {
  const body = await readJsonBody(request); if (body.confirm !== true) throw ApiError.badRequest("confirm: true is required");
  const { db, actor } = requireOwner(config); const runtime = authRuntime(config);
  try {
    await revokeWorkspaceServiceCredential(db, runtime.auth, { serviceAccountId: requireString(body, "serviceAccountId"), credentialId: requireString(body, "credentialId"), actor, ...(typeof body.operationId === "string" ? { operationId: body.operationId } : {}) });
    return noStore(okResponse({ revoked: true }));
  } finally { runtime.close(); db.close(); }
}
