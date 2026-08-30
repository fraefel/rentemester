import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createParty, linkPartyRole } from "../../src/core/party-registry";
import { ingestCorporateRecord, linkCorporateRecord } from "../../src/core/corporate-records";
import { activateWorkspaceUser, grantCompanyMembership } from "../../src/core/workspace-access";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { createWorkspaceServicePrincipal } from "../../src/core/workspace-service-principals";
import { createBetterAuthRequestProvider, openWorkspaceBetterAuth, WORKSPACE_SERVICE_PRINCIPAL_HEADER } from "../../src/server/better-auth";
import { config, get, makeWorkspace } from "./server-api/_shared";

const SECRET = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
const ORIGIN = "http://127.0.0.1:4319";
const at = "2026-08-30T10:00:00.000Z";

function party(db: ReturnType<typeof openWorkspaceControlDb>, partyId: string, name: string, companySlug: string) {
  createParty(db, { partyId, kind: "organization", name, source: "synthetic-test", observedAt: at, reviewAssertion: "synthetic evidence", actor: "user:owner" });
  linkPartyRole(db, { partyId, companySlug, role: "vendor", actor: "user:owner", observedAt: at });
}

function record(db: ReturnType<typeof openWorkspaceControlDb>, recordId: string, companySlug: string) {
  return ingestCorporateRecord(db, { recordId, type: "articles", bytes: new TextEncoder().encode(recordId), filename: `${recordId}.pdf`, source: "synthetic-test", receivedAt: at, uploader: "synthetic-user", actor: "user:owner", links: [{ type: "company", id: companySlug }] });
}

describe("workspace registry HTTP access projection", () => {
  test("uses the live service-principal membership before pagination and requires every corporate company scope", async () => {
    const workspace = makeWorkspace("workspace-registry-http", ["Allowed ApS", "Hidden ApS"]);
    const runtime = openWorkspaceBetterAuth(workspace, { secret: SECRET, trustedOrigins: [ORIGIN], baseURL: ORIGIN });
    const db = openWorkspaceControlDb(workspace);
    try {
      const service = await createWorkspaceServicePrincipal(db, runtime.auth, { displayName: "Synthetic registry reader", actor: "user:owner" });
      activateWorkspaceUser(db, { userId: service.serviceAccountId, workspaceRole: "member", actor: "user:owner" });
      grantCompanyMembership(db, workspace, { userId: service.serviceAccountId, companySlug: "allowed-aps", role: "reader", actor: "user:owner" });

      // The hidden party sorts first. A response containing the visible party
      // at limit=1 proves that authorization filtering happens before paging.
      party(db, "party-a-hidden", "Hidden first", "hidden-aps");
      party(db, "party-z-visible", "Visible after hidden", "allowed-aps");
      record(db, "record-allowed", "allowed-aps");
      record(db, "record-shared", "allowed-aps");
      linkCorporateRecord(db, { recordId: "record-shared", type: "company", id: "hidden-aps", actor: "user:owner", at });

      const hosted = config({ workspaceRoot: workspace, deploymentProfile: "hosted", betterAuthProvider: createBetterAuthRequestProvider(runtime.auth) });
      const headers = { [WORKSPACE_SERVICE_PRINCIPAL_HEADER]: service.secret };
      const parties = await get(hosted, "/api/companies/allowed-aps/workspace-parties?limit=1", { headers });
      expect(parties.status).toBe(200);
      expect(parties.body).toMatchObject({ ok: true, count: 1, rows: [{ partyId: "party-z-visible", name: "Visible after hidden" }] });
      expect(JSON.stringify(parties.body)).not.toContain("party-a-hidden");

      const records = await get(hosted, "/api/companies/allowed-aps/corporate-records", { headers });
      expect(records.status).toBe(200);
      expect(records.body).toMatchObject({ ok: true, count: 1, rows: [{ recordId: "record-allowed" }] });
      expect(JSON.stringify(records.body)).not.toContain("record-shared");
      const deniedInspection = await get(hosted, "/api/companies/allowed-aps/corporate-records/record-shared", { headers });
      expect(deniedInspection.status).toBe(404);
      expect(JSON.stringify(deniedInspection.body)).not.toContain("record-shared");
    } finally {
      db.close();
      runtime.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
