import { queryCfoAnalytics } from "../../core/cfo-analytics";
import { getWorkspaceSessionContext } from "../../core/workspace-access";
import { openWorkspaceControlReadOnlyDb } from "../../core/workspace-control";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse } from "./_shared";

function one(url:URL,name:string,required=false):string|undefined { const values=url.searchParams.getAll(name); if(values.length>1) throw ApiError.badRequest(`${name} must appear at most once`); const value=values[0]?.trim(); if(required&&!value) throw ApiError.badRequest(`${name} is required`); return value||undefined; }
export function handleCfoAnalytics(config:ServerConfig,url:URL):Response {
  if(config.requestPrincipal?.via!=="better-auth"&&config.requestPrincipal?.via!=="service-principal") throw ApiError.unauthorized("missing or invalid credentials");
  const scope=one(url,"scope",true); if(scope!=="company"&&scope!=="portfolio"&&scope!=="group") throw ApiError.badRequest("scope must be company, portfolio or group");
  const rawLimit=one(url,"limit"); const limit=rawLimit===undefined?undefined:Number(rawLimit); if(limit!==undefined&&(!Number.isInteger(limit)||limit<1||limit>200)) throw ApiError.badRequest("limit must be an integer from 1 through 200");
  const control=openWorkspaceControlReadOnlyDb(config.workspaceRoot);
  try { const context=getWorkspaceSessionContext(control,config.workspaceRoot,config.requestPrincipal.userId??""); if(!context) throw ApiError.unauthorized("missing or invalid credentials");
    const aggregate=one(url,"aggregate"); if(aggregate!==undefined&&aggregate!=="none"&&aggregate!=="sum")throw ApiError.badRequest("aggregate must be none or sum");
    return okResponse(queryCfoAnalytics(config.workspaceRoot,{scope,companySlug:scope==="company"?one(url,"companySlug"):undefined,companySlugs:scope==="company"?undefined:url.searchParams.getAll("companySlug").filter(Boolean),groupProfileId:one(url,"groupProfileId"),from:one(url,"from",true)!,to:one(url,"to",true)!,account:one(url,"account"),party:one(url,"party"),dimension:one(url,"dimension"),currency:one(url,"currency"),aggregate,cursor:one(url,"cursor"),limit},context.companies.map(company=>company.slug)));
  } catch(error) { if(error instanceof ApiError) throw error; throw ApiError.badRequest(error instanceof Error?error.message:String(error)); } finally { control.close(); }
}
