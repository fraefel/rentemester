import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Database } from "bun:sqlite";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug } from "../../src/core/workspace";
import { queryCfoAnalytics } from "../../src/core/cfo-analytics";
import { activateWorkspaceUser, grantCompanyMembership, revokeCompanyMembership } from "../../src/core/workspace-access";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { createWorkspaceServicePrincipal, revokeWorkspaceServiceCredential, rotateWorkspaceServiceCredential } from "../../src/core/workspace-service-principals";
import { createBetterAuthRequestProvider, openWorkspaceBetterAuth, WORKSPACE_SERVICE_PRINCIPAL_HEADER } from "../../src/server/better-auth";
import { authorizeMcpTool, createMcpSecurityContextFromEnv } from "../../src/mcp/security";
import { registerAllTools } from "../../src/mcp/registry";
import { config, get, makeWorkspace, postPnlEntry } from "./server-api/_shared";

const SECRET="I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
const ORIGIN="http://127.0.0.1:4319";
const digest=(path:string)=>createHash("sha256").update(readFileSync(path)).digest("hex");

function hostedMcpHarness(context: NonNullable<ReturnType<typeof createMcpSecurityContextFromEnv>>) {
  const server=new McpServer({name:"hosted-cfo-test",version:"1"}); registerAllTools(server,context);
  const tools=(server as any)._registeredTools as Record<string,{handler:(args:unknown,extra:unknown)=>Promise<{structuredContent:any}>}>;
  return { async call(name:string,args:Record<string,unknown>) { return (await tools[name]!.handler(args,{signal:new AbortController().signal})).structuredContent; } };
}

async function cliAnalytics(workspace:string) {
  const proc=Bun.spawn(["bun","src/cli.ts","report","analytics","--workspace",workspace,"--scope","company","--company-slug","allowed-aps","--from","2026-01-01","--to","2026-12-31","--format","json"],{cwd:process.cwd(),stdout:"pipe",stderr:"pipe"});
  const [exit,stdout]=await Promise.all([proc.exited,new Response(proc.stdout).text()]);
  if(exit!==0) throw new Error(`analytics CLI failed: ${stdout} ${await new Response(proc.stderr).text()}`);
  return JSON.parse(stdout) as {ok:boolean;analytics:unknown};
}

describe("#581 hosted CFO analytics acceptance",()=>{
  test("HTTP uses current service memberships before opening or aggregating ledgers; actor metadata never authorizes",async()=>{
    const workspace=makeWorkspace("cfo-hosted",["Allowed ApS","Hidden ApS"]);
    const runtime=openWorkspaceBetterAuth(workspace,{secret:SECRET,trustedOrigins:[ORIGIN],baseURL:ORIGIN});
    const control=openWorkspaceControlDb(workspace);
    try {
      postPnlEntry(workspace,"allowed-aps","2026-02-10",0,125);
      postPnlEntry(workspace,"hidden-aps","2026-02-10",0,900);
      const allowedDb=companyPaths(companyRootForSlug(workspace,"allowed-aps")).db;
      const hiddenDb=companyPaths(companyRootForSlug(workspace,"hidden-aps")).db;
      // Stabilise fixture bytes before measuring the read-only contract. Under
      // parallel load SQLite may otherwise checkpoint already-committed WAL
      // frames after the first digest, which changes container bytes without
      // any logical write from the analytics request.
      for (const path of [allowedDb,hiddenDb]) { const db=new Database(path); db.run("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); }
      const before=[digest(allowedDb),digest(hiddenDb)];
      const service=await createWorkspaceServicePrincipal(control,runtime.auth,{displayName:"CFO read-only",actor:"user:owner"});
      activateWorkspaceUser(control,{userId:service.serviceAccountId,workspaceRole:"member",actor:"user:owner"});
      grantCompanyMembership(control,workspace,{userId:service.serviceAccountId,companySlug:"allowed-aps",role:"reader",actor:"user:owner"});
      const hosted=config({workspaceRoot:workspace,deploymentProfile:"hosted",betterAuthProvider:createBetterAuthRequestProvider(runtime.auth)});
      const query="/api/cfo-analytics?scope=portfolio&companySlug=allowed-aps&companySlug=hidden-aps&from=2026-01-01&to=2026-12-31&aggregate=sum";
      expect((await get(hosted,query,{headers:{actor:"user:owner"}})).status).toBe(401);
      const initial=await get(hosted,query,{headers:{[WORKSPACE_SERVICE_PRINCIPAL_HEADER]:service.secret,actor:"user:attacker"}});
      expect(initial.status).toBe(200);
      expect(initial.body).toMatchObject({ok:true,status:"incomplete",companies:["allowed-aps"],partial:true});
      expect(initial.body.reconciliation.omitted).toContain("aggregate");
      expect(JSON.stringify(initial.body)).not.toContain("hidden-aps");
      const rotated=await rotateWorkspaceServiceCredential(control,runtime.auth,{serviceAccountId:service.serviceAccountId,credentialId:service.credentialId,actor:"user:owner"});
      expect((await get(hosted,query,{headers:{[WORKSPACE_SERVICE_PRINCIPAL_HEADER]:service.secret}})).status).toBe(401);
      expect((await get(hosted,query,{headers:{[WORKSPACE_SERVICE_PRINCIPAL_HEADER]:rotated.secret}})).status).toBe(200);
      revokeCompanyMembership(control,workspace,{userId:service.serviceAccountId,companySlug:"allowed-aps",actor:"user:owner"});
      const noCompanyAccess=await get(hosted,query,{headers:{[WORKSPACE_SERVICE_PRINCIPAL_HEADER]:rotated.secret}});
      expect(noCompanyAccess).toMatchObject({status:200,body:{ok:true,status:"incomplete",companies:[],rows:[]}});
      await revokeWorkspaceServiceCredential(control,runtime.auth,{serviceAccountId:service.serviceAccountId,credentialId:rotated.credentialId,actor:"user:owner"});
      expect((await get(hosted,query,{headers:{[WORKSPACE_SERVICE_PRINCIPAL_HEADER]:rotated.secret}})).status).toBe(401);
      expect([digest(allowedDb),digest(hiddenDb)]).toEqual(before);
    } finally { control.close();runtime.close();rmSync(workspace,{recursive:true,force:true}); }
  });

  test("hosted MCP discovery resolves the live analytics operation and queries only authorised evidence",async()=>{
    const workspace=makeWorkspace("cfo-mcp-hosted",["Allowed ApS","Hidden ApS"]);
    const runtime=openWorkspaceBetterAuth(workspace,{secret:SECRET,trustedOrigins:[ORIGIN],baseURL:ORIGIN});
    const control=openWorkspaceControlDb(workspace);
    try {
      postPnlEntry(workspace,"allowed-aps","2026-02-10",0,125);postPnlEntry(workspace,"hidden-aps","2026-02-10",0,900);
      const service=await createWorkspaceServicePrincipal(control,runtime.auth,{displayName:"MCP CFO reader",actor:"user:owner"});
      activateWorkspaceUser(control,{userId:service.serviceAccountId,workspaceRole:"member",actor:"user:owner"});
      grantCompanyMembership(control,workspace,{userId:service.serviceAccountId,companySlug:"allowed-aps",role:"reader",actor:"user:owner"});
      const context=createMcpSecurityContextFromEnv({RENTEMESTER_WORKSPACE:workspace,RENTEMESTER_SERVICE_PRINCIPAL_TOKEN:service.secret} as NodeJS.ProcessEnv)!;
      const mcp=hostedMcpHarness(context);
      const about=await mcp.call("meta_about",{});
      expect(about.data.catalogue.schemaVersion).toBe("rentemester-agent-discovery-v1");
      const search=await mcp.call("agent_capability_search",{query:"supplier spend",limit:10});
      expect(search.data.items.some((item:any)=>item.workflowIds.includes("cfo-analytics"))).toBeTrue();
      const workflow=await mcp.call("agent_workflow_describe",{id:"cfo-analytics"});
      expect(workflow.data.workflow.steps.some((step:any)=>step.operation.name==="cfo_analytics_query"&&step.operation.resolved)).toBeTrue();
      // CLI, hosted HTTP and hosted MCP deliberately project one core JSON
      // schema.  Only their outer transport envelopes differ.
      const exactInput={scope:"company" as const,companySlug:"allowed-aps",from:"2026-01-01",to:"2026-12-31"};
      const mcpCompany=await mcp.call("cfo_analytics_query",{workspace,...exactInput});
      const hosted=config({workspaceRoot:workspace,deploymentProfile:"hosted",betterAuthProvider:createBetterAuthRequestProvider(runtime.auth)});
      const httpCompany=await get(hosted,"/api/cfo-analytics?scope=company&companySlug=allowed-aps&from=2026-01-01&to=2026-12-31",{headers:{[WORKSPACE_SERVICE_PRINCIPAL_HEADER]:service.secret}});
      const canonical=queryCfoAnalytics(workspace,exactInput,["allowed-aps"]);
      expect(httpCompany).toMatchObject({status:200,body:{ok:true}});
      expect(mcpCompany).toMatchObject({ok:true,errors:[]});
      expect(mcpCompany.data).toEqual(canonical);expect(stripOk(httpCompany.body)).toEqual(canonical);
      const analytics=await mcp.call("cfo_analytics_query",{workspace,scope:"portfolio",companySlugs:["allowed-aps","hidden-aps"],from:"2026-01-01",to:"2026-12-31",aggregate:"sum"});
      const data=analytics.data;
      expect(data).toMatchObject({status:"incomplete",companies:["allowed-aps"],partial:true});
      expect(data.reconciliation.omitted).toContain("aggregate");expect(JSON.stringify(data)).not.toContain("hidden-aps");
      const cliCompany=await cliAnalytics(workspace);
      expect(cliCompany.ok).toBeTrue();expect(cliCompany.analytics).toEqual(canonical);
    } finally { control.close();runtime.close();rmSync(workspace,{recursive:true,force:true}); }
  });
});

function stripOk(body:Record<string,unknown>) { const {ok:_ok,...data}=body; return data; }
