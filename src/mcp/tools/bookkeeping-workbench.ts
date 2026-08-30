import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildBookkeepingWorkbench } from "../../core/bookkeeping-workbench";
import { envelopeShape, wrapCoreResult } from "../envelope";
import { withCompanyReadOnlyDb } from "../tool-runtime";

/** Same snapshot contract as GET bookkeeping-workbench; never creates a run. */
export function registerBookkeepingWorkbenchTools(server:McpServer):void {
  server.registerTool("bookkeeping_workbench",{title:"Read bookkeeping workbench",description:"Read the deterministic unresolved bank-work population with canonical party-resolution, evidence and posting facets. Population blockers are independent of page filters; this never persists, approves or applies a batch.",inputSchema:{company:z.string().min(1),from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),status:z.enum(["ready","suggestedMatch","missingDocument","partyUnresolved","accountingDecisionRequired","vatEvidenceRequired","dimensionEvidenceRequired","stalePlan","applyFailed"]).optional(),bankAccountId:z.number().int().positive().optional(),partyId:z.string().min(3).max(64).optional(),documentQuality:z.enum(["matched","missing"]).optional(),account:z.string().min(1).max(32).optional(),vatTreatment:z.string().min(1).max(80).optional(),dimension:z.string().min(3).max(160).optional(),cursor:z.number().int().min(0).optional(),limit:z.number().int().min(1).max(100).optional(),search:z.string().max(200).optional()},outputSchema:envelopeShape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},withCompanyReadOnlyDb<any>(({db,args})=>wrapCoreResult({ok:true,workbench:buildBookkeepingWorkbench(db,args)})));
}
