import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse } from "./_shared";
import { companyRootForSlug } from "../../core/workspace";
import { companyPaths } from "../../core/paths";
import { Database } from "bun:sqlite";
import { buildBookkeepingWorkbench, type WorkbenchStatus } from "../../core/bookkeeping-workbench";

const statuses = new Set<WorkbenchStatus>(["ready","suggestedMatch","missingDocument","partyUnresolved","accountingDecisionRequired","vatEvidenceRequired","stalePlan","applyFailed"]);
const positive=(raw:string|null,name:string)=>{const value=raw===null?undefined:Number(raw);if(value!==undefined&&(!Number.isInteger(value)||value<0))throw ApiError.badRequest(`${name} must be a non-negative integer`);return value;};
/** GET is snapshot-only: it neither migrates nor persists a dry-run. */
export function handleBookkeepingWorkbench(config:ServerConfig,slug:string,url:URL):Response {
  const from=url.searchParams.get("from"); const to=url.searchParams.get("to");
  if(!from||!to)throw ApiError.badRequest("from and to are required ISO dates");
  const status=url.searchParams.get("status")??undefined;if(status&&!statuses.has(status as WorkbenchStatus))throw ApiError.badRequest("unknown workbench status");
  const db=new Database(companyPaths(companyRootForSlug(config.workspaceRoot,slug)).db,{readonly:true});
  try{return okResponse({workbench:buildBookkeepingWorkbench(db,{from,to,status:status as WorkbenchStatus|undefined,bankAccountId:positive(url.searchParams.get("bankAccountId"),"bankAccountId"),cursor:positive(url.searchParams.get("cursor"),"cursor"),limit:positive(url.searchParams.get("limit"),"limit"),search:url.searchParams.get("search")??undefined})});}finally{db.close();}
}
