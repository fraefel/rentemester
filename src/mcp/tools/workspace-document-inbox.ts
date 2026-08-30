/** MCP adapter for the workspace document inbox (#577).
 *
 * Sources and routing evidence live only in the workspace control database.
 * The completion operation deliberately opens a company ledger only after the
 * security layer has checked both its anchor and explicit target company.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { companyPaths } from "../../core/paths";
import { listWorkspaceCompanies, resolveConfiguredWorkspaceRoot, resolveWorkspaceSlug } from "../../core/workspace";
import { openDb, migrate } from "../../core/db";
import { openWorkspaceControlDb, openWorkspaceControlReadOnlyDb } from "../../core/workspace-control";
import { approveWorkspaceInboxAssignment, completeWorkspaceInboxAssignment, ingestWorkspaceInboxSource, inspectWorkspaceInboxSource, listWorkspaceInboxSources, WORKSPACE_INBOX_EVIDENCE_KINDS, WORKSPACE_INBOX_TRANSPORTS } from "../../core/workspace-document-inbox";
import { currentMcpAuthenticatedPrincipal } from "../security";
import { authorizeWorkspaceRoute } from "../../core/workspace-access";
import { deriveMcpActor } from "../actor";
import { confirmField } from "../tool-runtime";
import { envelopeShape, envelopeToCallResult, errorEnvelope, successEnvelope } from "../envelope";

const company = z.string().min(1);
const bytes = z.string().min(1).max(34 * 1024 * 1024).transform((value, ctx) => {
  try { return new Uint8Array(Buffer.from(value, "base64")); }
  catch { ctx.addIssue({ code: "custom", message: "bytesBase64 must be base64" }); return z.NEVER; }
});
const candidate = z.object({ companySlug: z.string().min(1), evidenceKind: z.enum(WORKSPACE_INBOX_EVIDENCE_KINDS), evidence: z.string().min(1).max(1000) });
const read = { readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false } as const;
const write = { readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false } as const;
const workspace = () => resolveConfiguredWorkspaceRoot() ?? (() => { throw new Error("RENTEMESTER_WORKSPACE is required for workspace inbox tools"); })();
const actor = (server: McpServer) => deriveMcpActor(server.server.getClientVersion()).createdBy;
const direct = (handler: (args:any)=>any) => async (args:any) => envelopeToCallResult(await handler(args));
function visibleCompanySlugs(): Set<string> {
  // `authorizeMcpTool` has already checked the anchor. For a service account,
  // its explicit target is checked there too; candidates are intentionally
  // never expanded here from hidden manifest entries.
  const principal = currentMcpAuthenticatedPrincipal();
  if (!principal) return new Set(listWorkspaceCompanies(workspace()).map(company => company.slug));
  const db=openWorkspaceControlReadOnlyDb(workspace());
  try { return new Set(listWorkspaceCompanies(workspace()).filter(company => authorizeWorkspaceRoute(db,workspace(),{userId:principal.subjectId,companySlug:company.slug,permission:"company.documents.upload"}).allowed).map(company=>company.slug)); }
  finally { db.close(); }
}
function requireConfirm(confirm: boolean | undefined, operation: string) {
  return confirm === true ? null : errorEnvelope(`confirm: true required for write tool ${operation}`, { code:"CONFIRM_REQUIRED" });
}
function sourceVisible(anchor:string, sourceId:string) {
  const db=openWorkspaceControlReadOnlyDb(workspace());
  try { return inspectWorkspaceInboxSource(db, sourceId, anchor); } finally { db.close(); }
}

export function registerWorkspaceDocumentInboxTools(server: McpServer): void {
  server.registerTool("workspace_inbox_list", { title:"List workspace inbox", description:"Lists immutable inbox sources visible through the explicitly authorised company anchor. Filtering is before count, sort and pagination.", inputSchema:{company,cursor:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional()}, outputSchema:envelopeShape, annotations:read }, direct(async ({ company:anchor, cursor, limit }) => {
    const db=openWorkspaceControlReadOnlyDb(workspace()); try { return successEnvelope(listWorkspaceInboxSources(db,{visibilityAnchorSlug:anchor,cursor,limit})); } finally { db.close(); }
  }));
  server.registerTool("workspace_inbox_inspect", { title:"Inspect workspace inbox source", description:"Reads one source, filtered by the authorized anchor. Hidden sources and candidates are indistinguishable from absent sources.", inputSchema:{company,sourceId:z.string().min(1)}, outputSchema:envelopeShape, annotations:read }, direct(async ({ company:anchor, sourceId }) => {
    const source=sourceVisible(anchor,sourceId); return source ? successEnvelope({source}) : errorEnvelope("workspace inbox source not found",{code:"WORKSPACE_INBOX_NOT_FOUND"});
  }));
  server.registerTool("workspace_inbox_status", { title:"Read workspace inbox status", description:"Reads the durable routing/assignment state. It does not open or mutate a company ledger.", inputSchema:{company,sourceId:z.string().min(1)}, outputSchema:envelopeShape, annotations:read }, direct(async ({ company:anchor, sourceId }) => {
    const source=sourceVisible(anchor,sourceId); return source ? successEnvelope({source}) : errorEnvelope("workspace inbox source not found",{code:"WORKSPACE_INBOX_NOT_FOUND"});
  }));
  server.registerTool("workspace_inbox_ingest", { title:"Ingest workspace inbox source", description:"Stores immutable source bytes and filtered routing evidence outside all ledgers. Reuse idempotencyKey only for the identical source retry.", inputSchema:{company,sourceId:z.string().min(1).optional(),idempotencyKey:z.string().min(1).max(200),bytesBase64:bytes,filename:z.string().min(1).max(512),mimeType:z.string().min(1).max(160),transport:z.enum(WORKSPACE_INBOX_TRANSPORTS),transportIdentity:z.string().min(1).max(512).optional(),receivedAt:z.string().min(1),metadata:z.record(z.string(),z.unknown()),candidates:z.array(candidate).max(128).optional(),confirm:confirmField}, outputSchema:envelopeShape, annotations:write }, direct(async (args) => {
    const missing=requireConfirm(args.confirm,"workspace_inbox_ingest"); if(missing)return missing;
    const db=openWorkspaceControlDb(workspace()); try {
      // In a secured MCP invocation the security wrapper supplies a canonical
      // anchor; untrusted candidates are intentionally not promoted here.
      return successEnvelope({source:ingestWorkspaceInboxSource(db,{...args,visibilityAnchorSlug:args.company,bytes:args.bytesBase64,visibleCompanySlugs:visibleCompanySlugs(),actor:actor(server)})});
    } finally { db.close(); }
  }));
  server.registerTool("workspace_inbox_assign", { title:"Approve workspace inbox destination", description:"Explicitly approves one already-authorized legal entity. It never routes from filename, hash or candidate order.", inputSchema:{company,sourceId:z.string().min(1),companySlug:z.string().min(1),confirm:confirmField}, outputSchema:envelopeShape, annotations:write }, direct(async (args) => {
    const missing=requireConfirm(args.confirm,"workspace_inbox_assign"); if(missing)return missing;
    if(!sourceVisible(args.company,args.sourceId))return errorEnvelope("workspace inbox source not found",{code:"WORKSPACE_INBOX_NOT_FOUND"});
    const db=openWorkspaceControlDb(workspace()); try { return successEnvelope({source:approveWorkspaceInboxAssignment(db,{sourceId:args.sourceId,companySlug:args.companySlug,actor:actor(server)})}); } finally { db.close(); }
  }));
  server.registerTool("workspace_inbox_complete", { title:"Complete workspace inbox handoff", description:"Hands an approved source exactly once to canonical company document ingestion. On a lost response, use workspace_inbox_status before retrying.", inputSchema:{company,sourceId:z.string().min(1),companySlug:z.string().min(1),confirm:confirmField}, outputSchema:envelopeShape, annotations:write }, direct(async (args) => {
    const missing=requireConfirm(args.confirm,"workspace_inbox_complete"); if(missing)return missing;
    if(!sourceVisible(args.company,args.sourceId))return errorEnvelope("workspace inbox source not found",{code:"WORKSPACE_INBOX_NOT_FOUND"});
    const root=resolveWorkspaceSlug(workspace(),args.companySlug); if(!root)return errorEnvelope("workspace inbox source not found",{code:"WORKSPACE_INBOX_NOT_FOUND"});
    const control=openWorkspaceControlDb(workspace()); let ledger: ReturnType<typeof openDb>|undefined;
    try { ledger=openDb(companyPaths(root).db); migrate(ledger); return successEnvelope({source:completeWorkspaceInboxAssignment(control,ledger,root,{sourceId:args.sourceId,companySlug:args.companySlug,actor:actor(server)})}); }
    finally { ledger?.close(); control.close(); }
  }));
}
