/**
 * MCP-tools for kontoplanen.
 *
 *  - `accounts_list` (read)
 *  - `accounts_add` (write-reversible)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  createAccount,
  type CreateAccountInput,
} from "../../core/chart-of-accounts";
import { envelopeShape, successEnvelope, wrapCoreResult } from "../envelope";
import { withCompanyDb, withCompanyDbConfirmed, confirmField } from "../tool-runtime";

const inputSchema = {
  company: z.string().min(1, "company path is required"),
};

export function registerAccountsTools(server: McpServer): void {
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
        "write-reversible.",
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
