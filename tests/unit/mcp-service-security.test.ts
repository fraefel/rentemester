import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceBetterAuth } from "../../src/server/better-auth";
import { createWorkspaceServicePrincipal, revokeWorkspaceServiceCredential } from "../../src/core/workspace-service-principals";
import { activateWorkspaceUser, grantCompanyMembership } from "../../src/core/workspace-access";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { authorizeMcpTool, createMcpSecurityContextFromEnv, MCP_TOOL_PERMISSIONS, resolveMcpWorkspaceCompany } from "../../src/mcp/security";
import { makeWorkspace } from "./server-api/_shared";

const SECRET = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
const ORIGIN = "http://127.0.0.1:4319";

describe("MCP service principal guard", () => {
  test("captures token, revalidates revocation, and confines company paths", async () => {
    const workspace = makeWorkspace("mcp-service-guard", ["Allowed ApS", "Hidden ApS"]);
    const outside = mkdtempSync(join(tmpdir(), "rentemester-mcp-outside-"));
    const runtime = openWorkspaceBetterAuth(workspace, { secret: SECRET, trustedOrigins: [ORIGIN], baseURL: ORIGIN });
    const db = openWorkspaceControlDb(workspace);
    try {
      const issued = await createWorkspaceServicePrincipal(db, runtime.auth, { displayName: "Synthetic MCP", actor: "user:owner" });
      activateWorkspaceUser(db, { userId: issued.serviceAccountId, workspaceRole: "member", actor: "user:owner" });
      grantCompanyMembership(db, workspace, { userId: issued.serviceAccountId, companySlug: "allowed-aps", role: "reader", actor: "user:owner" });
      const env: Record<string, string> = { RENTEMESTER_WORKSPACE: workspace, RENTEMESTER_SERVICE_PRINCIPAL_TOKEN: issued.secret };
      const context = createMcpSecurityContextFromEnv(env)!;
      expect(env.RENTEMESTER_SERVICE_PRINCIPAL_TOKEN).toBeUndefined();
      expect(await authorizeMcpTool(context, "accounts_list", { company: "allowed-aps" })).not.toBeNull();
      expect(await authorizeMcpTool(context, "accounts_add", { company: "allowed-aps" })).toBeNull();
      expect(await authorizeMcpTool(context, "accounts_list", { company: "hidden-aps" })).toBeNull();
      // Fan-out tools cannot use a partly authorized key.  The hidden active
      // company is denied before the handler can inspect or mutate either
      // ledger, and a caller cannot replace the canonical workspace root.
      expect(await authorizeMcpTool(context, "recurring_invoice_run_workspace", { workspace })).toBeNull();
      expect(await authorizeMcpTool(context, "efaktura_modtag_workspace", { workspace: outside })).toBeNull();
      expect(resolveMcpWorkspaceCompany(context, outside)).toBeNull();
      const link = join(workspace, "escape"); symlinkSync(outside, link);
      expect(resolveMcpWorkspaceCompany(context, link)).toBeNull();
      await revokeWorkspaceServiceCredential(db, runtime.auth, { serviceAccountId: issued.serviceAccountId, credentialId: issued.credentialId, actor: "user:owner" });
      expect(await authorizeMcpTool(context, "accounts_list", { company: "allowed-aps" })).toBeNull();
    } finally { db.close(); runtime.close(); rmSync(workspace, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test("keeps a complete, unique map for the live MCP surface", () => {
    expect(new Set(Object.keys(MCP_TOOL_PERMISSIONS)).size).toBe(Object.keys(MCP_TOOL_PERMISSIONS).length);
    expect(Object.keys(MCP_TOOL_PERMISSIONS)).toHaveLength(138);
  });
});
