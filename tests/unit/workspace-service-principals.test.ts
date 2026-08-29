import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBetterAuthRequestProvider, openWorkspaceBetterAuth, WORKSPACE_SERVICE_PRINCIPAL_HEADER } from "../../src/server/better-auth";
import { createWorkspaceServicePrincipal, revokeWorkspaceServiceCredential, rotateWorkspaceServiceCredential } from "../../src/core/workspace-service-principals";
import { activateWorkspaceUser, authorizeWorkspaceRoute, grantCompanyMembership } from "../../src/core/workspace-access";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { config, get, handleRequest, makeWorkspace } from "./server-api/_shared";

const SECRET = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
const ORIGIN = "http://127.0.0.1:4319";

describe("workspace service principals", () => {
  test("issues, rotates and revokes a service credential without a browser account", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rentemester-service-principal-"));
    const runtime = openWorkspaceBetterAuth(workspace, { secret: SECRET, trustedOrigins: [ORIGIN], baseURL: ORIGIN });
    const db = openWorkspaceControlDb(workspace);
    try {
      const createOperation = "10000000-0000-4000-8000-000000000001";
      const issued = await createWorkspaceServicePrincipal(db, runtime.auth, { displayName: "Synthetic automation", actor: "user:owner", operationId: createOperation });
      expect(issued.secret).toStartWith("rms_");
      expect(db.query('SELECT COUNT(*) AS count FROM "account" WHERE "userId" = ?').get(issued.serviceAccountId)).toEqual({ count: 0 });
      expect(db.query('SELECT key FROM "apikey" WHERE id = ?').get(issued.credentialId)).not.toEqual({ key: issued.secret });
      const provider = createBetterAuthRequestProvider(runtime.auth);
      const request = new Request(`${ORIGIN}/api/companies/demo`, { headers: { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: issued.secret } });
      expect(await provider.verifyServicePrincipal!(request)).toEqual({ state: "valid", userId: issued.serviceAccountId, credentialId: issued.credentialId });
      expect(await provider.getSession(request)).toBeNull();

      await expect(createWorkspaceServicePrincipal(db, runtime.auth, { displayName: "Synthetic automation", actor: "user:owner", operationId: createOperation })).rejects.toThrow("already completed");
      const rotateOperation = "10000000-0000-4000-8000-000000000002";
      const rotated = await rotateWorkspaceServiceCredential(db, runtime.auth, { serviceAccountId: issued.serviceAccountId, credentialId: issued.credentialId, actor: "user:owner", operationId: rotateOperation });
      expect(await provider.verifyServicePrincipal!(request)).toEqual({ state: "invalid" });
      const rotatedRequest = new Request(`${ORIGIN}/api/companies/demo`, { headers: { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: rotated.secret } });
      expect(await provider.verifyServicePrincipal!(rotatedRequest)).toEqual({ state: "valid", userId: issued.serviceAccountId, credentialId: rotated.credentialId });
      const revokeOperation = "10000000-0000-4000-8000-000000000003";
      await revokeWorkspaceServiceCredential(db, runtime.auth, { serviceAccountId: issued.serviceAccountId, credentialId: rotated.credentialId, actor: "user:owner", operationId: revokeOperation });
      expect(await provider.verifyServicePrincipal!(rotatedRequest)).toEqual({ state: "invalid" });
      const expiresAt = db.query('SELECT "expiresAt" FROM "apikey" WHERE id = ?').get(issued.credentialId) as { expiresAt: string };
      const days = (new Date(expiresAt.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89);
      expect(days).toBeLessThan(91);
      expect(db.query("SELECT COUNT(*) AS count FROM rm_workspace_service_principal_events WHERE user_id = ?").get(issued.serviceAccountId)).toEqual({ count: 5 });
      expect(db.query("SELECT operation_status AS status FROM rm_workspace_service_principal_operation_events WHERE operation_id = ? ORDER BY id").all(createOperation)).toEqual([{ status: "pending" }, { status: "completed" }]);
      expect(db.query("SELECT operation_status AS status FROM rm_workspace_service_principal_operation_events WHERE operation_id = ? ORDER BY id").all(rotateOperation)).toEqual([{ status: "pending" }, { status: "completed" }]);
      expect(db.query("SELECT operation_status AS status FROM rm_workspace_service_principal_operation_events WHERE operation_id = ? ORDER BY id").all(revokeOperation)).toEqual([{ status: "pending" }, { status: "completed" }]);
      expect(() => db.run("UPDATE rm_workspace_service_principal_operation_events SET operation_status='failed' WHERE operation_id=?", createOperation)).toThrow("append-only");
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

  test("hosted owner lifecycle is confirm-gated, no-store, secret-once and live-revocable", async () => {
    const workspace = makeWorkspace("service-principal-lifecycle", ["Allowed ApS"]);
    const db = openWorkspaceControlDb(workspace);
    const createdAt = new Date();
    let closeVerifier: (() => void) | undefined;
    try {
      db.query(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
        VALUES (?,?,?,?,?,?,1)`).run("mfa-owner", "MFA owner", "owner@example.test", 1, createdAt.toISOString(), createdAt.toISOString());
      db.query(`INSERT INTO "session" (id,expiresAt,token,createdAt,updatedAt,userId)
        VALUES (?,?,?,?,?,?)`).run("fresh-mfa", new Date(createdAt.getTime() + 86_400_000).toISOString(), "opaque", createdAt.toISOString(), createdAt.toISOString(), "mfa-owner");
      activateWorkspaceUser(db, { userId: "mfa-owner", workspaceRole: "workspace_owner", createdBy: "user:mfa-owner", createdByProgram: "unit-test" });
      grantCompanyMembership(db, workspace, { userId: "mfa-owner", companySlug: "allowed-aps", role: "owner", createdBy: "user:mfa-owner", createdByProgram: "unit-test" });
      db.query(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
        VALUES (?,?,?,?,?,?,1)`).run("ordinary-member", "Member", "member@example.test", 1, createdAt.toISOString(), createdAt.toISOString());
      db.query(`INSERT INTO "session" (id,expiresAt,token,createdAt,updatedAt,userId)
        VALUES (?,?,?,?,?,?)`).run("member-session", new Date(createdAt.getTime() + 86_400_000).toISOString(), "opaque-member", createdAt.toISOString(), createdAt.toISOString(), "ordinary-member");
      activateWorkspaceUser(db, { userId: "ordinary-member", workspaceRole: "member", createdBy: "user:mfa-owner", createdByProgram: "unit-test" });
      grantCompanyMembership(db, workspace, { userId: "ordinary-member", companySlug: "allowed-aps", role: "reader", createdBy: "user:mfa-owner", createdByProgram: "unit-test" });
      const ownerProvider = {
        async getSession() { return { user: { id: "mfa-owner" }, session: { id: "fresh-mfa", createdAt } }; },
        async handle() { return new Response(null, { status: 404 }); },
      };
      const hosted = config({
        workspaceRoot: workspace, deploymentProfile: "hosted", betterAuthProvider: ownerProvider,
        hostedBetterAuth: { secret: SECRET, secrets: [{ version: 1, value: SECRET }], baseURL: ORIGIN, trustedOrigins: [ORIGIN], authEmail: { provider: "http-json-v1", url: "https://mailer.example.test/send", bearerToken: "synthetic", from: "owner@example.test" }, rateLimitIpHeader: "x-real-ip" },
      });
      const headers = { "content-type": "application/json", origin: ORIGIN };
      const memberConfig = { ...hosted, betterAuthProvider: { async getSession() { return { user: { id: "ordinary-member" }, session: { id: "member-session", createdAt } }; }, async handle() { return new Response(null, { status: 404 }); } } };
      expect((await get(memberConfig, "/api/workspace/service-principals", { method: "POST", headers, body: JSON.stringify({ displayName: "forbidden", confirm: true }) })).status).toBe(401);
      expect((await get(hosted, "/api/workspace/service-principals", { method: "POST", headers, body: JSON.stringify({ displayName: "Only automation" }) })).status).toBe(400);
      const created = await get(hosted, "/api/workspace/service-principals", { method: "POST", headers, body: JSON.stringify({ displayName: "Only automation", confirm: true, operationId: "10000000-0000-4000-8000-000000000010" }) });
      expect(created.status).toBe(201);
      expect(created.body.secret).toStartWith("rms_");
      expect(created.body.secret).not.toContain("owner");
      expect((await get(hosted, "/api/workspace/service-principals")).status).toBe(200);
      const rawList = await handleRequest(new Request(`${ORIGIN}/api/workspace/service-principals`), hosted);
      expect(rawList.headers.get("cache-control")).toBe("no-store");
      const listed = await get(hosted, "/api/workspace/service-principals");
      expect(JSON.stringify(listed.body)).not.toContain(created.body.secret);
      const beforeRotate = new Request(`${ORIGIN}/api`, { headers: { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: created.body.secret } });
      const verifierRuntime = openWorkspaceBetterAuth(workspace, { secret: SECRET, trustedOrigins: [ORIGIN], baseURL: ORIGIN });
      closeVerifier = verifierRuntime.close;
      const verifier = createBetterAuthRequestProvider(verifierRuntime.auth);
      expect((await verifier.verifyServicePrincipal!(beforeRotate)).state).toBe("valid");
      const serviceConfig = { ...hosted, betterAuthProvider: verifier };
      expect((await get(serviceConfig, "/api/workspace/service-principals", { method: "POST", headers: { ...headers, [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: created.body.secret }, body: JSON.stringify({ displayName: "forbidden", confirm: true }) })).status).toBe(401);
      const rotated = await get(hosted, "/api/workspace/service-principals/rotate", { method: "POST", headers, body: JSON.stringify({ serviceAccountId: created.body.serviceAccountId, credentialId: created.body.credentialId, confirm: true, operationId: "10000000-0000-4000-8000-000000000011" }) });
      expect(rotated.status).toBe(200);
      expect(rotated.body.secret).toStartWith("rms_");
      expect((await verifier.verifyServicePrincipal!(beforeRotate)).state).toBe("invalid");
      const afterRotate = new Request(`${ORIGIN}/api`, { headers: { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: rotated.body.secret } });
      expect((await verifier.verifyServicePrincipal!(afterRotate)).state).toBe("valid");
      expect((await get(hosted, "/api/workspace/service-principals/revoke", { method: "POST", headers, body: JSON.stringify({ serviceAccountId: created.body.serviceAccountId, credentialId: rotated.body.credentialId, confirm: true, operationId: "10000000-0000-4000-8000-000000000012" }) })).status).toBe(200);
      expect((await verifier.verifyServicePrincipal!(afterRotate)).state).toBe("invalid");
    } finally { closeVerifier?.(); db.close(); rmSync(workspace, { recursive: true, force: true }); }
  });
});
