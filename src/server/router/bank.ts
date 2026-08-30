// Bank-transaction list + registered bank-accounts read handlers.

import type { ServerConfig } from "../config";
import { buildCompanyBankAccounts } from "../data/bank-accounts-view";
import { buildCompanyBank, resolveYearParam } from "../data";
import { okResponse } from "./_shared";
import { companyRootForSlug } from "../../core/workspace";
import { companyPaths } from "../../core/paths";
import { openDb, migrate } from "../../core/db";
import { planBankReconciliationCorrection } from "../../core/bank-journal-reconciliation";
import { ApiError } from "../errors";

export function handleCompanyBank(
  config: ServerConfig,
  slug: string,
  url: URL,
): Response {
  const year = resolveYearParam(url.searchParams.get("year"));
  const data = buildCompanyBank(config.workspaceRoot, slug, year);
  return okResponse({ bank: data });
}

/**
 * GET /api/companies/:slug/bank-accounts — Bankkonti + CSV-mapping-profiler
 * (#345). Read-only. POST på samme path opretter en konto.
 */
export function handleCompanyBankAccounts(
  config: ServerConfig,
  slug: string,
): Response {
  const data = buildCompanyBankAccounts(config.workspaceRoot, slug);
  return okResponse({ bankAccounts: data });
}

/** GET is a pure inspection endpoint: it opens no transaction and writes no plan. */
export function handleBankReconciliationCorrectionPlan(config: ServerConfig, slug: string, url: URL): Response {
  const bankTransactionId=Number(url.searchParams.get("bankTransactionId")), replacementJournalEntryId=Number(url.searchParams.get("replacementJournalEntryId"));
  if(!Number.isInteger(bankTransactionId)||bankTransactionId<=0||!Number.isInteger(replacementJournalEntryId)||replacementJournalEntryId<=0) throw ApiError.badRequest("bankTransactionId and replacementJournalEntryId must be positive integers");
  const db=openDb(companyPaths(companyRootForSlug(config.workspaceRoot,slug)).db); try { migrate(db); return okResponse({plan:planBankReconciliationCorrection(db,{bankTransactionId,replacementJournalEntryId})}); } finally { db.close(); }
}
