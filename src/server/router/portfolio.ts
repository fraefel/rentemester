// Portfolio + workspace company-list read handlers.

import type { ServerConfig } from "../config";
import { discoverWorkspaceCompanies } from "../discovery";
import { buildPortfolioOverview, resolveAsOfDate } from "../data";
import { okResponse } from "./_shared";
import { openWorkspaceControlDb } from "../../core/workspace-control";
import { listActiveCompanyMembershipSlugs } from "../../core/workspace-access";
import { listWorkspaceCompanies } from "../../core/workspace";

/**
 * Hosted Better Auth reads are restricted before any discovery or ledger read.
 * Local and shared-secret modes intentionally retain their legacy full-workspace
 * behaviour for single-owner installations.
 */
function hostedVisibleCompanySlugs(config: ServerConfig): string[] | null {
  if (!config.betterAuthProvider || config.requestPrincipal?.via !== "better-auth") return null;
  const userId = config.requestPrincipal.id.slice("user:".length);
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    return listActiveCompanyMembershipSlugs(db, config.workspaceRoot, userId);
  } finally {
    db.close();
  }
}

export function handlePortfolio(config: ServerConfig, url: URL): Response {
  const asOf = resolveAsOfDate(url.searchParams.get("asOf"));
  const visibleSlugs = hostedVisibleCompanySlugs(config);
  const overview = buildPortfolioOverview(
    config.workspaceRoot,
    asOf,
    visibleSlugs === null ? {} : { companySlugs: visibleSlugs },
  );
  return okResponse({ portfolio: overview });
}

export function handleCompanyList(config: ServerConfig): Response {
  // Discover-and-adopt any present-but-unlisted company directory before
  // listing (#256): an owner who set a company up via the CLI then opened the
  // cockpit must see that real company, not "0 virksomheder" + a blank create.
  const visibleSlugs = hostedVisibleCompanySlugs(config);
  const companies = visibleSlugs === null
    ? discoverWorkspaceCompanies(config.workspaceRoot)
    : (() => {
      const allowed = new Set(visibleSlugs);
      // Hosted reads must not run discover-and-adopt: authorization is only
      // meaningful for companies already registered in the manifest.
      return listWorkspaceCompanies(config.workspaceRoot).filter((company) => allowed.has(company.slug));
    })();
  return okResponse({
    workspace: config.workspaceRoot,
    count: companies.length,
    companies: companies.map((c) => ({
      slug: c.slug,
      name: c.name,
      createdAt: c.createdAt,
      archived: c.archived,
    })),
  });
}
