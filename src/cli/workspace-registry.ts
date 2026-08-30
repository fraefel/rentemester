/** Workspace-scoped party and corporate-record lifecycle (#573/#575).
 *
 * These commands deliberately open only the workspace control database: they
 * never open or mutate a company ledger.  `--actor` is enforced centrally for
 * every write and `--confirm yes` makes the append-only boundary explicit.
 */
import { readFileSync } from "node:fs";
import { resolveWorkspaceRoot } from "../core/workspace";
import { openWorkspaceControlDb, openWorkspaceControlReadOnlyDb } from "../core/workspace-control";
import { approvePartyMerge, createParty, inspectParty, linkPartyRole, proposePartyMerge, searchParties } from "../core/party-registry";
import { enrichCorporateRecord, ingestCorporateRecord, inspectCorporateRecord, linkCorporateRecord, listCorporateRecords, readCorporateRecordBytes, supersedeCorporateRecord } from "../core/corporate-records";
import type { CommandContext, CommandDispatch } from "../cli-dispatch";

const need = (ctx: CommandContext, flag: string) => { const v = ctx.trimToNull(ctx.arg(flag)); if (!v) ctx.fatal(`${flag} is required`); return v!; };
const actor = (ctx: CommandContext) => ctx.cliActor ?? process.env.RENTEMESTER_ACTOR ?? ctx.inferredMutationActor() ?? (() => { ctx.fatal("actor required for mutations"); })();
const confirm = (ctx: CommandContext) => { if (ctx.arg("--confirm") !== "yes") ctx.fatal("--confirm must be exactly yes"); };
const json = (ctx: CommandContext, flag: string): Record<string, unknown> => { try { const v = JSON.parse(readFileSync(need(ctx, flag), "utf8")); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("must be an object"); return v as Record<string, unknown>; } catch (e) { ctx.fatal(`${flag} must be a readable JSON object: ${e instanceof Error ? e.message : String(e)}`); } };
const workspace = (ctx: CommandContext) => resolveWorkspaceRoot(need(ctx, "--workspace"));

export function register(dispatch: CommandDispatch): void {
  dispatch.on("party", "create", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { const input=json(ctx,"--input"); ctx.emitResult({ok:true,party:createParty(db,{...input, actor:actor(ctx) } as any)}); } finally { db.close(); } });
  dispatch.on("party", "search", (ctx) => { const db=openWorkspaceControlReadOnlyDb(workspace(ctx)); try { ctx.emitResult({ok:true,...searchParties(db,{query:ctx.arg("--query"),companySlugs:new Set([need(ctx,"--company")]),cursor:Number(ctx.arg("--cursor")??0),limit:Number(ctx.arg("--limit")??25)})}); } finally {db.close();} });
  dispatch.on("party", "inspect", (ctx) => { const db=openWorkspaceControlReadOnlyDb(workspace(ctx)); try { const party=inspectParty(db,need(ctx,"--party-id")); ctx.emitResult(party?{ok:true,party}:{ok:false,errors:["party not found"]}); } finally {db.close();} });
  dispatch.on("party", "link-role", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { ctx.emitResult({ok:true,party:linkPartyRole(db,{partyId:need(ctx,"--party-id"),companySlug:need(ctx,"--company"),role:need(ctx,"--role") as any,defaults:ctx.arg("--defaults")?json(ctx,"--defaults") as any:undefined,actor:actor(ctx)})}); } finally {db.close();} });
  dispatch.on("party", "propose-merge", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { ctx.emitResult({ok:true,proposalHash:proposePartyMerge(db,{fromPartyId:need(ctx,"--from-party-id"),intoPartyId:need(ctx,"--into-party-id"),reviewAssertion:need(ctx,"--review-assertion"),actor:actor(ctx)})}); } finally {db.close();} });
  dispatch.on("party", "approve-merge", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { ctx.emitResult({ok:true,party:approvePartyMerge(db,{fromPartyId:need(ctx,"--from-party-id"),proposalHash:need(ctx,"--proposal-hash"),actor:actor(ctx)})}); } finally {db.close();} });

  dispatch.on("corporate-record", "ingest", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { const input=json(ctx,"--input"); const bytes=readFileSync(need(ctx,"--file")); ctx.emitResult({ok:true,record:ingestCorporateRecord(db,{...input,bytes,actor:actor(ctx)} as any)}); } finally {db.close();} });
  dispatch.on("corporate-record", "list", (ctx) => { const db=openWorkspaceControlReadOnlyDb(workspace(ctx)); try { ctx.emitResult({ok:true,...listCorporateRecords(db,{companySlugs:new Set([need(ctx,"--company")]),cursor:Number(ctx.arg("--cursor")??0),limit:Number(ctx.arg("--limit")??25)})}); } finally {db.close();} });
  dispatch.on("corporate-record", "inspect", (ctx) => { const db=openWorkspaceControlReadOnlyDb(workspace(ctx)); try { const record=inspectCorporateRecord(db,need(ctx,"--record-id")); ctx.emitResult(record?{ok:true,record}:{ok:false,errors:["corporate record not found"]}); } finally {db.close();} });
  dispatch.on("corporate-record", "download", (ctx) => { const db=openWorkspaceControlReadOnlyDb(workspace(ctx)); try { const bytes=readCorporateRecordBytes(db,need(ctx,"--record-id")); ctx.emitResult({ok:true,bytesBase64:Buffer.from(bytes).toString("base64"),sha256:inspectCorporateRecord(db,need(ctx,"--record-id"))?.sha256}); } finally {db.close();} });
  dispatch.on("corporate-record", "link", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { ctx.emitResult({ok:true,record:linkCorporateRecord(db,{recordId:need(ctx,"--record-id"),type:need(ctx,"--link-type") as any,id:need(ctx,"--link-id"),actor:actor(ctx)})}); } finally {db.close();} });
  dispatch.on("corporate-record", "enrich", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { ctx.emitResult({ok:true,payloadHash:enrichCorporateRecord(db,{recordId:need(ctx,"--record-id"),assertion:need(ctx,"--assertion"),actor:actor(ctx)})}); } finally {db.close();} });
  dispatch.on("corporate-record", "supersede", (ctx) => { confirm(ctx); const db=openWorkspaceControlDb(workspace(ctx)); try { ctx.emitResult({ok:true,payloadHash:supersedeCorporateRecord(db,{recordId:need(ctx,"--record-id"),replacementRecordId:need(ctx,"--replacement-record-id"),reason:need(ctx,"--reason"),actor:actor(ctx)})}); } finally {db.close();} });
}
