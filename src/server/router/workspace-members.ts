import type { Database } from "bun:sqlite";
import {
  activateWorkspaceUser,
  authorizeWorkspaceRoute,
  disableWorkspaceUser,
  grantCompanyMembership,
  listWorkspaceMembers,
  revokeCompanyMembership,
  type CompanyRole,
  type WorkspaceRole,
} from "../../core/workspace-access";
import { openWorkspaceControlDb } from "../../core/workspace-control";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse, readJsonBody, requireString } from "./_shared";

function principalUserId(config: ServerConfig): string {
  const principal = config.requestPrincipal;
  if (config.deploymentProfile !== "hosted" || (principal?.via !== "better-auth" && principal?.via !== "service-principal")) {
    throw ApiError.unauthorized("missing or invalid credentials");
  }
  const userId = principal.userId?.trim() ?? "";
  if (!userId) throw ApiError.unauthorized("missing or invalid credentials");
  return userId;
}

function actor(config: ServerConfig) {
  return { createdBy: `user:${principalUserId(config)}`, createdByProgram: "rentemester-cockpit" };
}

function requireCompanyOwner(config: ServerConfig, db: Database, companySlug: string): void {
  if (!authorizeWorkspaceRoute(db, config.workspaceRoot, {
    userId: principalUserId(config), companySlug, permission: "company.admin",
  }).allowed) {
    throw ApiError.unauthorized("missing or invalid credentials");
  }
}

export function handleWorkspaceMemberList(config: ServerConfig): Response {
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    const userId = principalUserId(config);
    const members = listWorkspaceMembers(db, config.workspaceRoot).map((member) => ({
      ...member,
      memberships: member.memberships.filter((membership) =>
        authorizeWorkspaceRoute(db, config.workspaceRoot, {
          userId, companySlug: membership.companySlug, permission: "company.admin",
        }).allowed
      ),
    }));
    return okResponse({ members });
  } finally { db.close(); }
}

export async function handleWorkspaceMemberAccessUpdate(
  config: ServerConfig,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const userId = requireString(body, "userId");
  const action = requireString(body, "action");
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    try {
      if (action === "set-role") {
        const result = activateWorkspaceUser(db, {
          userId,
          workspaceRole: requireString(body, "workspaceRole") as WorkspaceRole,
          ...actor(config),
        });
        return okResponse({ access: result.access });
      }
      if (action === "disable") {
        const result = disableWorkspaceUser(db, { userId, ...actor(config) });
        return okResponse({ access: result.access });
      }
      throw new Error("workspace member action is invalid");
    } catch {
      throw ApiError.badRequest("brugeradgangen kunne ikke ændres");
    }
  } finally { db.close(); }
}

export async function handleWorkspaceMemberCompanyUpdate(
  config: ServerConfig,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  const userId = requireString(body, "userId");
  const companySlug = requireString(body, "companySlug");
  const action = requireString(body, "action");
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    requireCompanyOwner(config, db, companySlug);
    try {
      if (action === "grant") {
        const result = grantCompanyMembership(db, config.workspaceRoot, {
          userId,
          companySlug,
          role: requireString(body, "role") as CompanyRole,
          ...actor(config),
        });
        return okResponse({ membership: result.membership });
      }
      if (action === "revoke") {
        const result = revokeCompanyMembership(db, config.workspaceRoot, {
          userId, companySlug, ...actor(config),
        });
        return okResponse({ membership: result.membership });
      }
      throw new Error("company member action is invalid");
    } catch {
      throw ApiError.badRequest("virksomhedsadgangen kunne ikke ændres");
    }
  } finally { db.close(); }
}
