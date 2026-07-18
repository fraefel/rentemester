/**
 * MCP-tools for the chart of accounts and fail-closed account-role mapping.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  createAccount,
  type CreateAccountInput,
} from "../../core/chart-of-accounts";
import { envelopeShape, errorEnvelope, successEnvelope, wrapCoreResult } from "../envelope";
import { confirmField, withCompanyDb, withCompanyDbConfirmed } from "../tool-runtime";
import { accountRoleStatus, resolveAccountRole, ACCOUNT_ROLES, confirmAccountRole } from "../../core/account-roles";

const inputSchema = {
  company: z.string().min(1, "company path is required"),
};

export function registerAccountsTools(server: McpServer): void {
  server.registerTool(
    "accounts_roles_status",
    { title: "Account role status", description: "Read-only status and dry-run resolution for confirmed account roles; importer proposals never resolve postings.", inputSchema, outputSchema: envelopeShape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    withCompanyDb<{ company: string }>(server, ({ db }) => successEnvelope({ ...accountRoleStatus(db), roles: ACCOUNT_ROLES.map((role) => resolveAccountRole(db, role)) })),
  );
  server.registerTool(
    "accounts_role_confirm",
    { title: "Confirm account role", description: "Human/actor-confirm an imported account-role proposal. Requires confirm: true; suggestions never post automatically. write-reversible.", inputSchema: { company: z.string().min(1), role: z.enum(ACCOUNT_ROLES), accountNo: z.string().min(1), confirm: confirmField }, outputSchema: envelopeShape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    withCompanyDbConfirmed<{ company: string; role: typeof ACCOUNT_ROLES[number]; accountNo: string; confirm?: boolean }>(server, "accounts_role_confirm", ({ db, actor, args }) => {
      const result = confirmAccountRole(db, args.role, args.accountNo, actor.createdBy, actor.createdByProgram, "explicit");
      return result.ok ? successEnvelope({ ...result, ...accountRoleStatus(db), roles: ACCOUNT_ROLES.map((role) => resolveAccountRole(db, role)) }) : errorEnvelope(result.error);
    }),
  );
  server.registerTool(
    "accounts_list",
    {
      title: "List chart of accounts",
      description:
        "Lister kontoplanen for virksomheden. Read-only. " +
        "Rækkefølge: account_no ASC (deterministisk).",
      inputSchema,
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{ company: string }>(server, ({ db }) => {
      const rows = db
        .query("SELECT account_no, name, type, default_vat_code FROM accounts ORDER BY account_no")
        .all() as Array<{ account_no: string; name: string; type: string; default_vat_code: string | null }>;
      return successEnvelope({
        accounts: rows.map((row) => ({
          accountNo: row.account_no,
          name: row.name,
          type: row.type,
          defaultVatCode: row.default_vat_code,
        })),
        count: rows.length,
      });
    }),
  );
  server.registerTool(
    "accounts_add",
    {
      title: "Add account to chart of accounts",
      description:
        "Tilføjer én ny konto til kontoplanen efter init. Append-only — denne kommando kan ikke omdøbe, " +
        "ændre type eller arkivere en eksisterende konto. Kræver confirm:true. normalBalance udledes af type " +
        "hvis ikke angivet (asset/expense → debit, ellers credit). Audit-logges som event_type=accounts_add. " +
        "Creating an account never confirms an account-role proposal; use accounts_role_confirm separately. " +
        "Account creation is append-only and has no archive/undo operation. write-irreversible.",
      inputSchema: {
        company: z.string().min(1).describe("Absolute path to the company directory, or a workspace slug."),
        input: z
          .object({
            accountNo: z
              .string()
              .min(1)
              .describe("Unique account number, e.g. '1030' (must not already exist in the chart of accounts)."),
            name: z.string().min(1).describe("Account name shown in the chart of accounts."),
            type: z
              .enum(ACCOUNT_TYPES)
              .describe("Account type — controls the schema CHECK and the default normalBalance."),
            normalBalance: z
              .enum(NORMAL_BALANCES)
              .optional()
              .describe(
                "Defaults from type (asset/expense → debit, otherwise credit). Override only for contra accounts " +
                  "(e.g. an asset-typed 'Akkumulerede afskrivninger' that is credit-normal).",
              ),
            defaultVatCode: z
              .string()
              .optional()
              .describe("Optional default VAT code, e.g. 'DK_PURCHASE_25'."),
            allowDirectPosting: z
              .boolean()
              .optional()
              .describe("Defaults to true. Set false for a summary/control account that must not be posted to directly."),
          })
          .describe("Account fields. accountNo, name and type are required; normalBalance defaults from type."),
        confirm: confirmField,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      input: CreateAccountInput;
      confirm?: boolean;
    }>(server, "accounts_add", ({ db, actor, args }) => {
      const result = createAccount(db, args.input, {
        createdBy: actor.createdBy,
        createdByProgram: actor.createdByProgram,
      });
      return wrapCoreResult(result);
    }),
  );
}
