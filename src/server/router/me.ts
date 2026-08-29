// Hosted Better Auth session context for the cockpit UI.

import { getWorkspaceSessionContext } from "../../core/workspace-access";
import { openWorkspaceControlDb } from "../../core/workspace-control";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse } from "./_shared";

/**
 * GET /api/me is intentionally hosted-only. Local legacy deployments retain
 * their existing UI path and never receive synthetic user identity fields.
 */
export function handleMe(config: ServerConfig): Response {
  if (config.requestPrincipal?.via !== "better-auth" && config.requestPrincipal?.via !== "service-principal") {
    throw ApiError.unauthorized("missing or invalid credentials");
  }
  const userId = config.requestPrincipal.userId ?? "";
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    return okResponse(context);
  } finally {
    db.close();
  }
}
