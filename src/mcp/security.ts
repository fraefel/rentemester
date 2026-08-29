import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { defaultKeyHasher } from "@better-auth/api-key";
import type { RoutePermission } from "../core/access-permissions";
import { authorizeWorkspaceRoute } from "../core/workspace-access";
import { openWorkspaceControlReadOnlyDb } from "../core/workspace-control";
import { findWorkspaceCompany, isValidSlug, listWorkspaceCompanies } from "../core/workspace";
import { WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID } from "../server/better-auth";

export const MCP_TOOL_PERMISSIONS: Readonly<Record<string, RoutePermission>> = Object.freeze(Object.fromEntries([
  ["agent_capability_search", "public.read"], ["agent_workflow_describe", "public.read"], ["cvr_lookup", "public.read"], ["invoice_validate", "public.read"], ["meta_about", "public.read"],
  ["portfolio_overview", "workspace.read"], ["company_add", "workspace.manage"],
  ..."accounts_list accounts_roles_status accrual_register_report asset_register_report audit_log_list audit_verify bank_account_list bank_list bank_suggest_matches bookkeeping_batch_status budget_forecast budget_list budget_vs_actual company_profile_get customer_list efaktura_onboarding_status efaktura_status exceptions_list import_archive_list invoice_compensation_calc invoice_find invoice_interest_calc invoice_interest_correction_calc invoice_list invoice_overdue invoice_status journal_dry_run journal_list mileage_list mileage_report payable_list period_close_readiness period_list posting_rule_explain reconcile_bank recurring_invoice_list retention_status system_healthcheck tax_return_prepare vat_oss_report vat_report vendor_list".split(" ").map((n) => [n, "company.read"]),
  ..."documents_invoice_extraction documents_list documents_parsed_text documents_parse_status".split(" ").map((n) => [n, "company.documents.read"]),
  ..."documents_ingest documents_parse documents_parse_pending mail_intake_ingest imap_intake_poll".split(" ").map((n) => [n, "company.documents.upload"]),
  ..."accounts_add accounts_role_confirm bank_account_update company_sync_cvr customer_create documents_enrich documents_extract_invoice documents_set_company_context posting_rule_propose recurring_invoice_create vendor_create".split(" ").map((n) => [n, "company.master-data"]),
  ..."accrual_register asset_register bank_import bookkeeping_batch_dry_run budget_set efaktura_konfigurer efaktura_modtag efaktura_modtag_workspace efaktura_onboard efaktura_registrer expense_book invoice_claim_compensation invoice_claim_interest invoice_credit_note invoice_issue invoice_render invoice_remind mileage_log payable_register recurring_invoice_generate recurring_invoice_run_workspace".split(" ").map((n) => [n, "company.draft.write"]),
  ..."accrual_recognize asset_depreciate asset_write_off bookkeeping_batch_apply expense_vat_preflight_apply invoice_apply_payment invoice_post invoice_post_compensation invoice_post_interest invoice_post_interest_correction invoice_post_reminder invoice_refund_bank invoice_settle_bank invoice_settle_claim_bank invoice_write_off_bad_debt journal_post journal_reverse payable_pay period_close vat_post_eu_service_purchase vat_post_representation_purchase".split(" ").map((n) => [n, "company.ledger.post"]),
  ..."bookkeeping_batch_approve exception_resolve posting_rule_approve".split(" ").map((n) => [n, "company.review"]),
  ..."gdpr_audit_log gdpr_discover gdpr_export import_archive_year mileage_export".split(" ").map((n) => [n, "company.export"]),
  ..."customer_validate_vat expense_vat_preflight vat_eu_sales_list".split(" ").map((n) => [n, "company.external-lookup"]),
  ..."efaktura_send invoice_send_email peppol_submit_public_invoice".split(" ").map((n) => [n, "company.external-send"]),
  ..."system_backup system_backup_archive system_backup_confirm_placement system_backup_destination_add system_backup_destination_list system_backup_destination_remove system_backup_governance system_backup_lock system_backup_place system_backup_status system_backup_verify_remote_placement system_export_authority system_restore_backup".split(" ").map((n) => [n, "company.admin"]),
] as Array<[string, RoutePermission]>));

export type McpSecurityContext = { workspaceRoot: string; verify(): Promise<{ serviceAccountId: string; credentialId: string } | null> };
export type McpAuthenticatedPrincipal = { kind: "service-account"; subjectId: string; credentialId: string };
const requestPrincipal = new AsyncLocalStorage<McpAuthenticatedPrincipal>();
export function currentMcpAuthenticatedPrincipal(): McpAuthenticatedPrincipal | undefined { return requestPrincipal.getStore(); }

/** Captures the secret once then removes it from child-process environment. */
export function createMcpSecurityContextFromEnv(env: NodeJS.ProcessEnv = process.env): McpSecurityContext | null {
  const token = env.RENTEMESTER_SERVICE_PRINCIPAL_TOKEN?.trim();
  if (!token) return null;
  delete env.RENTEMESTER_SERVICE_PRINCIPAL_TOKEN;
  const configured = env.RENTEMESTER_WORKSPACE?.trim();
  if (!configured) throw new Error("MCP service credentials require RENTEMESTER_WORKSPACE");
  const workspaceRoot = realpathSync(configured);
  return {
    workspaceRoot,
    async verify() {
      const hash = await defaultKeyHasher(token);
      const db = openWorkspaceControlReadOnlyDb(workspaceRoot);
      try {
        const row = db.query(`SELECT "referenceId" AS user_id, "id" AS credential_id FROM "apikey" WHERE "key" = ? AND "configId" = ? AND COALESCE("enabled",1) = 1 AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)`).get(hash, WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID) as { user_id?: string; credential_id?: string } | null;
        if (!row?.user_id) return null;
        const principal = db.query("SELECT 1 FROM rm_workspace_service_principals WHERE user_id = ?").get(row.user_id);
        return principal && row.credential_id ? { serviceAccountId: row.user_id, credentialId: row.credential_id } : null;
      } finally { db.close(); }
    },
  };
}

export function resolveMcpWorkspaceCompany(context: McpSecurityContext, raw: unknown): { slug: string; root: string } | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  const company = isValidSlug(value) ? findWorkspaceCompany(context.workspaceRoot, value) : null;
  if (company) return { slug: company.slug, root: realpathSync(resolve(context.workspaceRoot, company.slug)) };
  try {
    const candidate = realpathSync(resolve(value));
    const rel = relative(context.workspaceRoot, candidate);
    if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || resolve(context.workspaceRoot, rel) !== candidate) return null;
    const byPath = findWorkspaceCompany(context.workspaceRoot, rel);
    return byPath ? { slug: byPath.slug, root: candidate } : null;
  } catch { return null; }
}

export async function authorizeMcpTool(context: McpSecurityContext, name: string, args: Record<string, unknown>): Promise<{ root?: string; principal: McpAuthenticatedPrincipal } | null> {
  const permission = MCP_TOOL_PERMISSIONS[name];
  if (!permission) return null;
  const principal = await context.verify();
  if (!principal) return null;
  const authenticated = { kind: "service-account" as const, subjectId: principal.serviceAccountId, credentialId: principal.credentialId };
  if (permission === "public.read") return { principal: authenticated };
  const db = openWorkspaceControlReadOnlyDb(context.workspaceRoot);
  try {
    if (permission.startsWith("workspace.")) {
      if (args.workspace !== undefined && args.workspace !== context.workspaceRoot) return null;
      return authorizeWorkspaceRoute(db, context.workspaceRoot, { userId: principal.serviceAccountId, permission }).allowed ? { principal: authenticated } : null;
    }
    // Workspace fan-out tools are not a single-company operation.  Authorize
    // the complete active manifest before their handler opens the first
    // ledger.  This prevents a partially-authorized key from learning about
    // or mutating a later company through a best-effort loop.
    if (name === "efaktura_modtag_workspace" || name === "recurring_invoice_run_workspace") {
      if (args.workspace !== context.workspaceRoot) return null;
      const active = listWorkspaceCompanies(context.workspaceRoot).filter((company) => !company.archived);
      return active.every((company) => authorizeWorkspaceRoute(db, context.workspaceRoot, {
        userId: principal.serviceAccountId, permission, companySlug: company.slug,
      }).allowed) ? { principal: authenticated } : null;
    }
    const company = resolveMcpWorkspaceCompany(context, args.company);
    if (!company) return null;
    return authorizeWorkspaceRoute(db, context.workspaceRoot, { userId: principal.serviceAccountId, permission, companySlug: company.slug }).allowed ? { root: company.root, principal: authenticated } : null;
  } finally { db.close(); }
}

export async function runWithMcpAuthenticatedPrincipal<T>(principal: McpAuthenticatedPrincipal, run: () => Promise<T>): Promise<T> { return requestPrincipal.run(principal, run); }
