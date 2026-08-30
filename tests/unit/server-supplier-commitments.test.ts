import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { createCompany } from "../../src/core/company";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { handleRequest, ROUTE_CATALOG } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";

const sha=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const config=(workspaceRoot:string):ServerConfig=>({host:"127.0.0.1",port:0,authRequired:false,authToken:null,workspaceRoot});

describe("supplier commitment HTTP safety",()=>{
  test("the POST plan route is a byte-for-byte read-only operation",async()=>{const root=mkdtempSync(join(tmpdir(),"rm-commitment-http-"));try{initWorkspace(root);createCompany(root,{name:"Synthetic Company"});const dbPath=companyPaths(companyRootForSlug(root,"synthetic-company")).db;const before=sha(dbPath);const response=await handleRequest(new Request("http://localhost/api/companies/synthetic-company/supplier-commitments/plan",{method:"POST",headers:{host:"127.0.0.1","content-type":"application/json"},body:JSON.stringify({commitment:{commitmentId:"synthetic",vendorPartyId:"party-synthetic",type:"subscription",description:"Synthetic",businessPurpose:"Test",amount:10,currency:"DKK",frequency:"monthly",nextDate:"2026-01-01",evidenceRefs:["record:synthetic"]}})}),config(root));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({plan:{ok:true}});expect(sha(dbPath)).toBe(before);}finally{rmSync(root,{recursive:true,force:true});}});
  test("catalogues match and history with their real effects",()=>{expect(ROUTE_CATALOG).toContainEqual(expect.objectContaining({method:"POST",pattern:"/api/companies/:slug/supplier-commitments/match",effect:"write"}));expect(ROUTE_CATALOG).toContainEqual(expect.objectContaining({method:"GET",pattern:"/api/companies/:slug/supplier-commitments/matches",effect:"read"}));});
});
