import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBetterAuthRequestProvider, openWorkspaceBetterAuth, WORKSPACE_SERVICE_PRINCIPAL_HEADER } from "../../src/server/better-auth";
import { createWorkspaceServicePrincipal, revokeWorkspaceServiceCredential, rotateWorkspaceServiceCredential } from "../../src/core/workspace-service-principals";
import { activateWorkspaceUser, authorizeWorkspaceRoute, grantCompanyMembership } from "../../src/core/workspace-access";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { config, get, makeWorkspace } from "./server-api/_shared";

const SECRET = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
const ORIGIN = "http://127.0.0.1:4319";

describe("workspace service principals", () => {
  test("issues, rotates and revokes a service credential without a browser account", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rentemester-service-principal-"));
    const runtime = openWorkspaceBetterAuth(workspace, { secret: SECRET, trustedOrigins: [ORIGIN], baseURL: ORIGIN });
    const db = openWorkspaceControlDb(workspace);
    try {
      const issued = await createWorkspaceServicePrincipal(db, runtime.auth, { displayName: "Synthetic automation", actor: "user:owner" });
      expect(issued.secret).toStartWith("rms_");
      expect(db.query('SELECT COUNT(*) AS count FROM "account" WHERE "userId" = ?').get(issued.serviceAccountId)).toEqual({ count: 0 });
      expect(db.query('SELECT key FROM "apikey" WHERE id = ?').get(issued.credentialId)).not.toEqual({ key: issued.secret });
      const provider = createBetterAuthRequestProvider(runtime.auth);
      const request = new Request(`${ORIGIN}/api/companies/demo`, { headers: { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: issued.secret } });
      expect(await provider.verifyServicePrincipal!(request)).toEqual({ state: "valid", userId: issued.serviceAccountId, credentialId: issued.credentialId });
      expect(await provider.getSession(request)).toBeNull();

      const rotated = await rotateWorkspaceServiceCredential(db, runtime.auth, { serviceAccountId: issued.serviceAccountId, credentialId: issued.credentialId, actor: "user:owner" });
      expect(await provider.verifyServicePrincipal!(request)).toEqual({ state: "invalid" });
      const rotatedRequest = new Request(`${ORIGIN}/api/companies/demo`, { headers: { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: rotated.secret } });
      expect(await provider.verifyServicePrincipal!(rotatedRequest)).toEqual({ state: "valid", userId: issued.serviceAccountId, credentialId: rotated.credentialId });
      await revokeWorkspaceServiceCredential(db, runtime.auth, { serviceAccountId: issued.serviceAccountId, credentialId: rotated.credentialId, actor: "user:owner" });
      expect(await provider.verifyServicePrincipal!(rotatedRequest)).toEqual({ state: "invalid" });
      const expiresAt = db.query('SELECT "expiresAt" FROM "apikey" WHERE id = ?').get(issued.credentialId) as { expiresAt: string };
      const days = (new Date(expiresAt.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThan(91);
      expect(db.query("SELECT COUNT(*) AS count FROM rm_workspace_service_principal_events WHERE user_id = ?").get(issued.serviceAccountId)).toEqual({ count: 5 });
    } finally {
      db.close(); runtime.close(); rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("membership roles remain the sole authority for a service account", async () => {
    const workspace = makeWorkspace("service-principal-rbac", ["Allowed ApS", "Hidden ApS"]);
    const runtime = openWorkspaceBetterAuth(workspace, { secret: SECRET, trustedOrigins: [ORIGIN], baseURL: ORIGIN });
    const db = openWorkspaceControlDb(workspace);
    try {
      const issued = await createWorkspaceServicePrincipal(db, runtime.auth, { displayName: "Synthetic reader", actor: "user:owner" });
      expect(authorizeWorkspaceRoute(db, workspace, { userId: issued.serviceAccountId, permission: "company.read", companySlug: "allowed-aps" }).allowed).toBe(false);
      activateWorkspaceUser(db, { userId: issued.serviceAccountId, workspaceRole: "member", actor: "user:owner" });
      grantCompanyMembership(db, workspace, { userId: issued.serviceAccountId, companySlug: "allowed-aps", role: "reader", actor: "user:owner" });
      expect(authorizeWorkspaceRoute(db, workspace, { userId: issued.serviceAccountId, permission: "company.read", companySlug: "allowed-aps" }).allowed).toBe(true);
      expect(authorizeWorkspaceRoute(db, workspace, { userId: issued.serviceAccountId, permission: "company.draft.write", companySlug: "allowed-aps" }).allowed).toBe(false);
      expect(authorizeWorkspaceRoute(db, workspace, { userId: issued.serviceAccountId, permission: "company.read", companySlug: "hidden-aps" }).allowed).toBe(false);
    } finally {
      db.close(); runtime.close(); rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("a verified key, never an advisory actor, reaches hosted RBAC", async () => {
    const workspace = makeWorkspace("service-principal-http", ["Allowed ApS"]);
    const runtime = openWorkspaceBetterAuth(workspace, { secret: SECRET, trustedOrigins: [ORIGIN], baseURL: ORIGIN });
    const db = openWorkspaceControlDb(workspace);
    try {
      const issued = await createWorkspaceServicePrincipal(db, runtime.auth, { displayName: "Synthetic HTTP", actor: "user:owner" });
      activateWorkspaceUser(db, { userId: issued.serviceAccountId, workspaceRole: "member", actor: "user:owner" });
      grantCompanyMembership(db, workspace, { userId: issued.serviceAccountId, companySlug: "allowed-aps", role: "reader", actor: "user:owner" });
      const hosted = config({ workspaceRoot: workspace, deploymentProfile: "hosted", betterAuthProvider: createBetterAuthRequestProvider(runtime.auth) });
      expect((await get(hosted, "/api/companies", { headers: { actor: "user:owner" } })).status).toBe(401);
      expect((await get(hosted, "/api/companies", { headers: { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: issued.secret, actor: "user:attacker" } })).status).toBe(200);
    } finally {
      db.close(); runtime.close(); rmSync(workspace, { recursive: true, force: true });
    }
  });
});
