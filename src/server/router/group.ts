import { getWorkspaceSessionContext } from "../../core/workspace-access";
import { getGroupStructureOverview } from "../../core/group-manifest";
import { buildIntercompanyReconciliation } from "../../core/intercompany-reconciliation";
import { buildEliminationOverview } from "../../core/consolidation-eliminations";
import { buildConsolidatedReport, listAvailableConsolidationProfiles } from "../../core/consolidated-reports";
import { openWorkspaceControlReadOnlyDb } from "../../core/workspace-control";
import { openWorkspaceControlDb } from "../../core/workspace-control";
import { authorizeWorkspaceRoute } from "../../core/workspace-access";
import { approveIntercompanyDisposition, inspectIntercompanyDisposition, intercompanyDispositionStatus, linkIntercompanyDispositionJournal, planIntercompanyDisposition, proposeIntercompanyDisposition, reopenIntercompanyDisposition, settleIntercompanyDisposition, supersedeIntercompanyDisposition } from "../../core/intercompany-dispositions";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse } from "./_shared";
import { withCompanyMutation } from "../mutations";

/**
 * Structure/status only. This route deliberately does not resolve or open a
 * company ledger, call portfolio code, or perform a migration.
 */
export function handleGroupOverview(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth" && config.requestPrincipal?.via !== "service-principal") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.userId ?? "";
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(getGroupStructureOverview(db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), asOf));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("asOf ")) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}

/** Membership-filtered, exact, read-only reciprocal balances. */
export function handleGroupReconciliation(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth" && config.requestPrincipal?.via !== "service-principal") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.userId ?? "";
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(buildIntercompanyReconciliation(db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), asOf));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("asOf ")) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}

export function handleGroupEliminations(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth" && config.requestPrincipal?.via !== "service-principal") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.userId ?? "";
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    return okResponse(buildEliminationOverview(db, new Set(context.companies.map((company) => company.slug)), asOf));
  } finally { db.close(); }
}

export function handleGroupReportProfiles(config: ServerConfig, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth" && config.requestPrincipal?.via !== "service-principal") throw ApiError.unauthorized("missing or invalid credentials");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.userId ?? "";
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(listAvailableConsolidationProfiles(
        db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), asOf,
      ));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("asOf ")) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}

/** A report is returned only when every active group company is visible. */
export function handleGroupConsolidatedReport(config: ServerConfig, profileId: string | null, from: string | null, asOf: string | null): Response {
  if (config.requestPrincipal?.via !== "better-auth" && config.requestPrincipal?.via !== "service-principal") throw ApiError.unauthorized("missing or invalid credentials");
  if (!profileId) throw ApiError.badRequest("profileId is required");
  if (!from) throw ApiError.badRequest("from is required as YYYY-MM-DD");
  if (!asOf) throw ApiError.badRequest("asOf is required as YYYY-MM-DD");
  const userId = config.requestPrincipal.userId ?? "";
  const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try {
    const context = getWorkspaceSessionContext(db, config.workspaceRoot, userId);
    if (!context) throw ApiError.unauthorized("missing or invalid credentials");
    try {
      return okResponse(buildConsolidatedReport(db, config.workspaceRoot, new Set(context.companies.map((company) => company.slug)), profileId, from, asOf));
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("asOf ") || error.message.startsWith("report period "))) throw ApiError.badRequest(error.message);
      throw error;
    }
  } finally { db.close(); }
}

function dispositionEndpoints(value:any):string[]{const sides=[value?.left?.companySlug,value?.right?.companySlug];if(sides.length!==2||sides.some((slug)=>typeof slug!=="string")||sides[0]===sides[1])throw ApiError.badRequest("disposition requires two distinct legal-company endpoints");return sides as string[];}
function assertDispositionEndpoints(config:ServerConfig,principal:any,endpoints:string[],permission:"company.ownership.read"|"company.ownership.manage"){const userId=principal?.userId;if(!userId)throw ApiError.unauthorized("missing or invalid credentials");const db=openWorkspaceControlReadOnlyDb(config.workspaceRoot);try{for(const slug of endpoints)if(!authorizeWorkspaceRoute(db,config.workspaceRoot,{userId,companySlug:slug,permission}).allowed)throw ApiError.unauthorized("missing or invalid credentials");}finally{db.close();}}
function dispositionPrincipal(principal:any){return principal?.serviceAccountId?{kind:"service" as const,id:principal.serviceAccountId}:{kind:"user" as const,id:principal?.userId??"local-operator"};}
/** KISS HTTP adapter: one explicit status endpoint and one confirmed action
 * endpoint. It delegates all lifecycle work to core and checks both legal
 * company memberships at call time. */
export function handleGroupDispositionStatus(config:ServerConfig,id:string,asOf:string|undefined):Response{const db=openWorkspaceControlReadOnlyDb(config.workspaceRoot);try{const current=inspectIntercompanyDisposition(db,id);if(!current)throw ApiError.notFound("disposition not found");assertDispositionEndpoints(config,config.requestPrincipal,dispositionEndpoints(current.disposition),"company.ownership.read");return okResponse(intercompanyDispositionStatus(db,config.workspaceRoot,id,asOf)!);}finally{db.close();}}
export async function handleGroupDispositionAction(config:ServerConfig,anchor:string,request:Request,action:"plan"|"propose"|"approve"|"link"|"settle"|"supersede"|"reopen"):Promise<Response>{if(action==="plan"){const body=await request.json() as any;const db=openWorkspaceControlReadOnlyDb(config.workspaceRoot);try{const planned=planIntercompanyDisposition(db,body.disposition);assertDispositionEndpoints(config,config.requestPrincipal,dispositionEndpoints(planned.disposition),"company.ownership.read");return okResponse(planned);}finally{db.close();}}
const result=await withCompanyMutation(request,config,anchor,(ctx,rawBody)=>{const body=rawBody as any;const control=openWorkspaceControlDb(config.workspaceRoot);try{let existing:any=null;if(typeof body.dispositionId==="string")existing=inspectIntercompanyDisposition(control,body.dispositionId);const disposition=action==="propose"?planIntercompanyDisposition(control,body.disposition).disposition:existing?.disposition;if(!disposition)throw ApiError.notFound("disposition not found");assertDispositionEndpoints(config,ctx.principal,dispositionEndpoints(disposition),"company.ownership.manage");const audit={actor:ctx.actor.createdBy,principal:dispositionPrincipal(ctx.principal)};if(action==="propose")return {ok:true,...proposeIntercompanyDisposition(control,body.disposition,audit)};if(action==="approve")return {ok:true,...approveIntercompanyDisposition(control,body.dispositionId,body.payloadHash,audit)};if(action==="link")return {ok:true,...linkIntercompanyDispositionJournal(control,config.workspaceRoot,{dispositionId:body.dispositionId,payloadHash:body.payloadHash,side:body.side,journalEntryId:body.journalEntryId,expectedLedgerHeadHash:body.ledgerHeadHash??null,...audit})};if(action==="settle")return {ok:true,...settleIntercompanyDisposition(control,config.workspaceRoot,{dispositionId:body.dispositionId,payloadHash:body.payloadHash,settlementEvidenceRecordIds:body.settlementEvidenceRecordIds,...audit})};if(action==="supersede")return {ok:true,...supersedeIntercompanyDisposition(control,{dispositionId:body.dispositionId,payloadHash:body.payloadHash,replacementDispositionId:body.replacementDispositionId,reason:body.reason,...audit})};return {ok:true,...reopenIntercompanyDisposition(control,config.workspaceRoot,{dispositionId:body.dispositionId,payloadHash:body.payloadHash,reason:body.reason,...audit})};}finally{control.close();}},{requireConfirm:true});return okResponse(result);}
