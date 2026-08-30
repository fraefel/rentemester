import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryCfoAnalytics } from "../../core/cfo-analytics";
import { getWorkspaceSessionContext } from "../../core/workspace-access";
import { openWorkspaceControlReadOnlyDb } from "../../core/workspace-control";
import { envelopeShape, envelopeToCallResult, errorEnvelope, successEnvelope } from "../envelope";
import { currentMcpAuthenticatedPrincipal } from "../security";

/** Workspace-scoped read: service membership is re-read before opening a ledger. */
export function registerCfoAnalyticsTools(server: McpServer): void {
  server.registerTool("cfo_analytics_query", {
    title: "Query source-linked CFO analytics",
    description: "Read-only, versioned historical journal/archive analytics. Portfolio is explicitly non-consolidated; group delegates only to an approved consolidation profile.",
    inputSchema: {
      workspace:z.string().min(1), scope:z.enum(["company","portfolio","group"]), companySlug:z.string().optional(), companySlugs:z.array(z.string()).max(100).optional(), groupProfileId:z.string().optional(),
      from:z.string(), to:z.string(), account:z.string().optional(), party:z.string().optional().describe("Exact canonical workspace party ID; names and document text are not identity filters."), dimension:z.string().optional(), currency:z.string().optional(), aggregate:z.enum(["none","sum"]).optional(), cursor:z.string().optional(), limit:z.number().int().min(1).max(200).optional(),
    }, outputSchema:envelopeShape, annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  }, (args:any) => {
    const principal=currentMcpAuthenticatedPrincipal();
    if (!principal) return envelopeToCallResult(errorEnvelope("missing or invalid credentials",{code:"UNAUTHORIZED"}));
    const control=openWorkspaceControlReadOnlyDb(args.workspace);
    try {
      const context=getWorkspaceSessionContext(control,args.workspace,principal.subjectId);
      if (!context) return envelopeToCallResult(errorEnvelope("missing or invalid credentials",{code:"UNAUTHORIZED"}));
      return envelopeToCallResult(successEnvelope(queryCfoAnalytics(args.workspace,args,context.companies.map(company=>company.slug))));
    } catch (error) { return envelopeToCallResult(errorEnvelope(error instanceof Error?error.message:String(error),{code:"ANALYTICS_QUERY_REJECTED"})); }
    finally { control.close(); }
  });
}
