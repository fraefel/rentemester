import { getWorkspaceSessionContext } from "../../core/workspace-access";
import { getGroupStructureOverview } from "../../core/group-manifest";
import { buildIntercompanyReconciliation } from "../../core/intercompany-reconciliation";
import { buildEliminationOverview } from "../../core/consolidation-eliminations";
import { buildConsolidatedReport, listAvailableConsolidationProfiles } from "../../core/consolidated-reports";
import { openWorkspaceControlReadOnlyDb } from "../../core/workspace-control";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse } from "./_shared";

/**
 * Structure/status only. This route deliberately does not resolve or open a
 * company ledger, call portfolio code, or perform a migration.
 */
export function handleGroupOverview(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.id.slice("user:".length);
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(getGroupStructureOverview(db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), asOf));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("asOf ")) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}

/** Membership-filtered, exact, read-only reciprocal balances. */
export function handleGroupReconciliation(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.id.slice("user:".length);
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(buildIntercompanyReconciliation(db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), asOf));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("asOf ")) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}

export function handleGroupEliminations(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.id.slice("user:".length);
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    return okResponse(buildEliminationOverview(db, new Set(context.companies.map((company) => company.slug)), asOf));
  } finally { db.close(); }
}

export function handleGroupReportProfiles(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.id.slice("user:".length);
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(listAvailableConsolidationProfiles(
        db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), asOf,
      ));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("asOf ")) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}

/** A report is returned only when every active group company is visible. */
export function handleGroupConsolidatedReport(config: ServerConfig, profileId: string | null, from: string | null, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth") throw ApiError.unauthorized("missing or invalid credentials");
  if (!profileId) throw ApiError.badRequest("profileId is required");
  if (!from) throw ApiError.badRequest("from is required as YYYY-MM-DD");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.id.slice("user:".length);
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(buildConsolidatedReport(db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), profileId, from, asOf));
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("asOf ") || error.message.startsWith("report period "))) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}
