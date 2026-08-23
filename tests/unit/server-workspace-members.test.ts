import { describe, expect, test } from "bun:test";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { activateWorkspaceUser, grantCompanyMembership } from "../../src/core/workspace-access";
import type { BetterAuthRequestProvider } from "../../src/server/better-auth";
import type { ServerConfig } from "../../src/server/config";
import { config, get, makeWorkspace, rmSync } from "./server-api/_shared";

const origin = "https://cockpit.example.test";
const secret = "synthetic-hosted-member-admin-secret-0001";

function addReadyUser(
  workspace: string,
  input: {
    userId: string;
    email: string;
    workspaceRole: "workspace_owner" | "member";
    companySlug: string;
    companyRole: "owner" | "bookkeeper" | "reviewer" | "reader";
  },
) {
  const db = openWorkspaceControlDb(workspace);
  const createdAt = new Date();
  const sessionId = `${input.userId}-session`;
  db.query(`INSERT INTO "user"
    (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
    VALUES (?,?,?,?,?,?,1)`).run(
    input.userId, input.userId, input.email, 1,
    createdAt.toISOString(), createdAt.toISOString(),
  );
  db.query(`INSERT INTO "session"
    (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)`).run(
    sessionId, new Date(createdAt.getTime() + 86_400_000).toISOString(),
    `opaque-${sessionId}`, createdAt.toISOString(), createdAt.toISOString(), input.userId,
  );
  activateWorkspaceUser(db, {
    userId: input.userId, workspaceRole: input.workspaceRole,
    createdBy: "agent:test", createdByProgram: "unit-test",
  });
  grantCompanyMembership(db, workspace, {
    userId: input.userId, companySlug: input.companySlug, role: input.companyRole,
    createdBy: "agent:test", createdByProgram: "unit-test",
  });
  db.close();
  return { ...input, createdAt, sessionId };
}

function provider(userId: string, sessionId: string, createdAt: Date): BetterAuthRequestProvider {
  return {
    async getSession() { return { user: { id: userId }, session: { id: sessionId, createdAt } }; },
    async handle() { return new Response(null, { status: 404 }); },
  };
}

function hosted(workspace: string, user: ReturnType<typeof addReadyUser>): ServerConfig {
  return config({
    workspaceRoot: workspace,
    deploymentProfile: "hosted",
    hostedBetterAuth: {
      secret,
      secrets: [{ version: 1, value: secret }],
      baseURL: origin,
      trustedOrigins: [origin],
      authEmail: {
        provider: "http-json-v1", url: "https://mailer.example.test/send",
        bearerToken: "synthetic-mail-token", from: "auth@example.test",
      },
      rateLimitIpHeader: "x-real-ip",
    },
    betterAuthProvider: provider(user.userId, user.sessionId, user.createdAt),
  });
}

const headers = { "content-type": "application/json", origin };

describe("hosted workspace member administration", () => {
  test("lists identities but only exposes memberships in companies the caller owns", async () => {
    const workspace = makeWorkspace("workspace-members-list", ["Alpha Company", "Beta Company"]);
    try {
      const alphaOwner = addReadyUser(workspace, {
        userId: "alpha-owner", email: "alpha@example.test", workspaceRole: "workspace_owner",
        companySlug: "alpha-company", companyRole: "owner",
      });
      addReadyUser(workspace, {
        userId: "beta-owner", email: "beta@example.test", workspaceRole: "workspace_owner",
        companySlug: "beta-company", companyRole: "owner",
      });
      const response = await get(hosted(workspace, alphaOwner), "/api/workspace/members");
      expect(response.status).toBe(200);
      expect(response.body.members).toHaveLength(2);
      expect(response.body.members.find((member: { userId: string }) => member.userId === "alpha-owner"))
        .toMatchObject({ memberships: [{ companySlug: "alpha-company", role: "owner" }] });
      expect(response.body.members.find((member: { userId: string }) => member.userId === "beta-owner"))
        .toMatchObject({ memberships: [] });
      expect(JSON.stringify(response.body)).not.toContain("beta-company");
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("changes and revokes one company role but rejects an unrelated company", async () => {
    const workspace = makeWorkspace("workspace-members-company", ["Alpha Company", "Beta Company"]);
    try {
      const owner = addReadyUser(workspace, {
        userId: "owner", email: "owner@example.test", workspaceRole: "workspace_owner",
        companySlug: "alpha-company", companyRole: "owner",
      });
      addReadyUser(workspace, {
        userId: "beta-owner", email: "beta@example.test", workspaceRole: "workspace_owner",
        companySlug: "beta-company", companyRole: "owner",
      });
      addReadyUser(workspace, {
        userId: "member", email: "member@example.test", workspaceRole: "member",
        companySlug: "alpha-company", companyRole: "reader",
      });
      const cfg = hosted(workspace, owner);
      const changed = await get(cfg, "/api/workspace/members/company", {
        method: "POST", headers,
        body: JSON.stringify({
          action: "grant", userId: "member", companySlug: "alpha-company", role: "bookkeeper",
        }),
      });
      expect(changed.status).toBe(200);
      expect(changed.body.membership).toMatchObject({ active: true, role: "bookkeeper" });
      const revoked = await get(cfg, "/api/workspace/members/company", {
        method: "POST", headers,
        body: JSON.stringify({ action: "revoke", userId: "member", companySlug: "alpha-company" }),
      });
      expect(revoked.status).toBe(200);
      expect(revoked.body.membership).toMatchObject({ active: false, role: null });
      expect((await get(cfg, "/api/workspace/members/company", {
        method: "POST", headers,
        body: JSON.stringify({
          action: "grant", userId: "member", companySlug: "beta-company", role: "reader",
        }),
      })).status).toBe(401);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("cannot disable an owner while that would orphan a company, then revokes all sessions on safe disable", async () => {
    const workspace = makeWorkspace("workspace-members-owner", ["Alpha Company", "Beta Company"]);
    try {
      const alphaOwner = addReadyUser(workspace, {
        userId: "alpha-owner", email: "alpha@example.test", workspaceRole: "workspace_owner",
        companySlug: "alpha-company", companyRole: "owner",
      });
      const betaOwner = addReadyUser(workspace, {
        userId: "beta-owner", email: "beta@example.test", workspaceRole: "workspace_owner",
        companySlug: "beta-company", companyRole: "owner",
      });
      const cfg = hosted(workspace, alphaOwner);
      const disableBody = JSON.stringify({ action: "disable", userId: "alpha-owner" });
      expect((await get(cfg, "/api/workspace/members/access", {
        method: "POST", headers, body: disableBody,
      })).status).toBe(400);

      const db = openWorkspaceControlDb(workspace);
      grantCompanyMembership(db, workspace, {
        userId: betaOwner.userId, companySlug: "alpha-company", role: "owner",
        createdBy: "agent:test", createdByProgram: "unit-test",
      });
      db.close();
      const disabled = await get(cfg, "/api/workspace/members/access", {
        method: "POST", headers, body: disableBody,
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body.access).toMatchObject({ active: false, workspaceRole: null });
      const verified = openWorkspaceControlDb(workspace);
      expect(verified.query('SELECT COUNT(*) AS count FROM "session" WHERE "userId"=?')
        .get(alphaOwner.userId)).toEqual({ count: 0 });
      expect(verified.query(
        `SELECT event_type FROM rm_workspace_security_events
          WHERE scope='user' AND user_id=? ORDER BY id DESC LIMIT 1`,
      ).get(alphaOwner.userId)).toEqual({ event_type: "session_invalidate" });
      verified.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
