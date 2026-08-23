import { describe, expect, test } from "bun:test";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { activateWorkspaceUser, grantCompanyMembership } from "../../src/core/workspace-access";
import {
  issueWorkspaceInvitation,
  recordWorkspaceInvitationDelivery,
} from "../../src/core/workspace-invitations";
import { createFakeAuthEmailSender } from "../../src/server/auth-email";
import type { BetterAuthRequestProvider } from "../../src/server/better-auth";
import type { ServerConfig } from "../../src/server/config";
import { config, get, makeWorkspace, rmSync } from "./server-api/_shared";

const secret = "synthetic-hosted-invitation-secret-material-0001";
const origin = "https://cockpit.example.test";

function addReadyOwner(
  workspace: string,
  input: { userId?: string; companySlug?: string; email?: string } = {},
) {
  const db = openWorkspaceControlDb(workspace);
  const userId = input.userId ?? "synthetic-owner";
  const companySlug = input.companySlug ?? "synthetic-company";
  const email = input.email ?? "owner@example.test";
  const sessionId = userId === "synthetic-owner" ? "owner-session" : `${userId}-session`;
  const createdAt = new Date();
  db.query(`INSERT INTO "user"
    (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
    VALUES (?,?,?,?,?,?,?)`).run(
    userId, "Synthetic Owner", email, 1,
    createdAt.toISOString(), createdAt.toISOString(), 1,
  );
  db.query(`INSERT INTO "session"
    (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)`).run(
    sessionId, new Date(createdAt.getTime() + 86_400_000).toISOString(),
    `opaque-${userId}-session`, createdAt.toISOString(), createdAt.toISOString(), userId,
  );
  activateWorkspaceUser(db, {
    userId, workspaceRole: "workspace_owner",
    createdBy: "agent:test", createdByProgram: "unit-test",
  });
  grantCompanyMembership(db, workspace, {
    userId, companySlug, role: "owner",
    createdBy: "agent:test", createdByProgram: "unit-test",
  });
  db.close();
  return { userId, sessionId, createdAt };
}

function provider(userId: string, sessionId: string, createdAt: Date): BetterAuthRequestProvider {
  return {
    async getSession() {
      return { user: { id: userId }, session: { id: sessionId, createdAt } };
    },
    async handle() { return new Response(null, { status: 404 }); },
  };
}

function hosted(workspace: string, authProvider: BetterAuthRequestProvider): ServerConfig {
  return config({
    workspaceRoot: workspace,
    deploymentProfile: "hosted",
    hostedBetterAuth: {
      secret,
      secrets: [{ version: 1, value: secret }],
      baseURL: origin,
      trustedOrigins: [origin],
      authEmail: {
        provider: "http-json-v1",
        url: "https://mailer.example.test/send",
        bearerToken: "synthetic-mail-token",
        from: "auth@example.test",
      },
      rateLimitIpHeader: "x-real-ip",
    },
    betterAuthProvider: authProvider,
  });
}

describe("hosted workspace invitation routes", () => {
  test("owner invitation creates no session, claim is single-use and company access stays MFA-gated", async () => {
    const workspace = makeWorkspace("workspace-invite-http", ["Synthetic Company"]);
    try {
      const owner = addReadyOwner(workspace);
      const sender = createFakeAuthEmailSender();
      const ownerConfig = hosted(workspace, provider(owner.userId, "owner-session", owner.createdAt));
      ownerConfig.authEmailSender = sender;
      ownerConfig.invitationIdentityService = {
        async createIdentity(input) {
          expect(input.email).toBe("invitee@example.test");
          const db = openWorkspaceControlDb(workspace);
          const existing = db.query('SELECT id FROM "user" WHERE email=?').get(input.email) as { id: string } | null;
          if (!existing) db.query(`INSERT INTO "user"
            (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
            VALUES (?,?,?,?,?,?,?)`).run(
            "invited-user", input.name, input.email, 0,
            new Date().toISOString(), new Date().toISOString(), 0,
          );
          db.close();
          return { userId: existing?.id ?? "invited-user", created: !existing };
        },
        async resendVerification() {},
      };
      const headers = { "content-type": "application/json", origin };
      const created = await get(ownerConfig, "/api/workspace/invitations", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "invitee@example.test",
          workspaceRole: "member",
          companySlug: "synthetic-company",
          companyRole: "bookkeeper",
        }),
      });
      expect(created.status).toBe(201);
      expect(sender.messages).toHaveLength(1);
      expect(sender.messages[0]?.kind).toBe("workspace-invitation");
      const token = new URL(sender.messages[0]!.url).hash.slice("#token=".length);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const forged = await get(ownerConfig, "/api/invitations/claim", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://forged.example.test" },
        body: JSON.stringify({ token, name: "Invited User", password: "not-stored-password" }),
      });
      expect(forged.status).toBe(401);

      const claimed = await get(ownerConfig, "/api/invitations/claim", {
        method: "POST",
        headers,
        body: JSON.stringify({ token, name: "Invited User", password: "not-stored-password" }),
      });
      expect(claimed.status).toBe(200);
      expect(claimed.body).toMatchObject({
        accepted: true,
        accessReady: false,
        nextStep: "verify-email-and-enable-mfa",
      });
      const db = openWorkspaceControlDb(workspace);
      expect(db.query('SELECT COUNT(*) AS count FROM "session" WHERE "userId"=?').get("invited-user"))
        .toEqual({ count: 0 });
      expect(JSON.stringify(db.query("SELECT * FROM workspace_audit").all()))
        .not.toContain("invitee@example.test");
      db.close();
      expect((await get(ownerConfig, "/api/invitations/claim", {
        method: "POST", headers,
        body: JSON.stringify({ token, name: "Invited User", password: "not-stored-password" }),
      })).status).toBe(400);

      const invitedDb = openWorkspaceControlDb(workspace);
      const sessionCreated = new Date();
      invitedDb.query(`INSERT INTO "session"
        (id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)`).run(
        "invited-session", new Date(sessionCreated.getTime() + 86_400_000).toISOString(),
        "opaque-invited", sessionCreated.toISOString(), sessionCreated.toISOString(), "invited-user",
      );
      invitedDb.close();
      const invitedConfig = hosted(
        workspace,
        provider("invited-user", "invited-session", sessionCreated),
      );
      expect((await get(invitedConfig, "/api/companies/synthetic-company/dashboard")).status)
        .toBe(401);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("a non-owner cannot list, create or cancel invitations", async () => {
    const workspace = makeWorkspace("workspace-invite-denial", ["Synthetic Company"]);
    try {
      const owner = addReadyOwner(workspace);
      const db = openWorkspaceControlDb(workspace);
      db.query(`INSERT INTO "user"
        (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
        VALUES ('member','Member','member@example.test',1,?,?,1)`).run(
        owner.createdAt.toISOString(), owner.createdAt.toISOString(),
      );
      db.query(`INSERT INTO "session"
        (id,expiresAt,token,createdAt,updatedAt,userId) VALUES ('member-session',?,?,?,?, 'member')`).run(
        new Date(owner.createdAt.getTime() + 86_400_000).toISOString(),
        "opaque-member", owner.createdAt.toISOString(), owner.createdAt.toISOString(),
      );
      activateWorkspaceUser(db, {
        userId: "member", workspaceRole: "member",
        createdBy: "agent:test", createdByProgram: "unit-test",
      });
      db.close();
      const member = hosted(workspace, provider("member", "member-session", owner.createdAt));
      expect((await get(member, "/api/workspace/invitations")).status).toBe(401);
      for (const [path, body] of [
        ["/api/workspace/invitations", { email: "x@example.test", workspaceRole: "member", companySlug: "synthetic-company", companyRole: "reader" }],
        ["/api/workspace/invitations/cancel", { invitationId: "00000000-0000-4000-8000-000000000000" }],
      ] as const) {
        expect((await get(member, path, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(body),
        })).status).toBe(401);
      }
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("a workspace owner only manages invitations for companies they own", async () => {
    const workspace = makeWorkspace("workspace-invite-company-scope", ["Alpha Company", "Beta Company"]);
    try {
      const alphaOwner = addReadyOwner(workspace, {
        userId: "alpha-owner", companySlug: "alpha-company", email: "alpha-owner@example.test",
      });
      const db = openWorkspaceControlDb(workspace);
      const alphaInvitation = issueWorkspaceInvitation(db, workspace, {
        email: "alpha-reader@example.test", workspaceRole: "member",
        companySlug: "alpha-company", companyRole: "reader",
        key: { version: 1, value: secret },
        createdBy: "agent:test", createdByProgram: "unit-test",
      });
      recordWorkspaceInvitationDelivery(db, {
        invitationId: alphaInvitation.invitation.invitationId, delivered: true,
        createdBy: "agent:test", createdByProgram: "unit-test",
      });
      const betaInvitation = issueWorkspaceInvitation(db, workspace, {
        email: "beta-reader@example.test", workspaceRole: "member",
        companySlug: "beta-company", companyRole: "reader",
        key: { version: 1, value: secret },
        createdBy: "agent:test", createdByProgram: "unit-test",
      });
      recordWorkspaceInvitationDelivery(db, {
        invitationId: betaInvitation.invitation.invitationId, delivered: true,
        createdBy: "agent:test", createdByProgram: "unit-test",
      });
      db.close();

      const alpha = hosted(
        workspace,
        provider(alphaOwner.userId, alphaOwner.sessionId, alphaOwner.createdAt),
      );
      const listed = await get(alpha, "/api/workspace/invitations");
      expect(listed.status).toBe(200);
      expect(listed.body.invitations).toHaveLength(1);
      expect(listed.body.invitations[0]).toMatchObject({ companySlug: "alpha-company" });

      const headers = { "content-type": "application/json", origin };
      expect((await get(alpha, "/api/workspace/invitations", {
        method: "POST", headers,
        body: JSON.stringify({
          email: "forbidden@example.test", workspaceRole: "member",
          companySlug: "beta-company", companyRole: "reader",
        }),
      })).status).toBe(401);
      expect((await get(alpha, "/api/workspace/invitations/cancel", {
        method: "POST", headers,
        body: JSON.stringify({ invitationId: betaInvitation.invitation.invitationId }),
      })).status).toBe(401);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
