/**
 * MCP-tool: `accounts_list` (read).
 *
 * 1:1-mapping af CLI-kommandoen `accounts list`. Lister kontoplanen.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { envelopeShape, successEnvelope } from "../envelope";
import { withCompanyDb } from "../tool-runtime";
import { accountRoleStatus, resolveAccountRole, ACCOUNT_ROLES } from "../../core/account-roles";

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
}
