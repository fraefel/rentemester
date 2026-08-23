import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeWorkspaceRoute } from "../../src/core/workspace-access";
import {
  acceptWorkspaceInvitation,
  cancelWorkspaceInvitation,
  issueWorkspaceInvitation,
  listWorkspaceInvitations,
  readClaimableWorkspaceInvitation,
  recordWorkspaceInvitationDelivery,
  WORKSPACE_INVITATION_TTL_MS,
} from "../../src/core/workspace-invitations";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { initWorkspace, registerWorkspaceCompany, setWorkspaceCompanyArchived } from "../../src/core/workspace";

const key = { version: 1, value: "synthetic-invitation-key-material-32-bytes-minimum" };
const now = new Date("2026-08-23T10:00:00.000Z");

function actor() {
  return { createdBy: "user:synthetic-owner", createdByProgram: "unit-test" };
}

function tempWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "rentemester-invitations-"));
  initWorkspace(workspace);
  registerWorkspaceCompany(workspace, {
    slug: "synthetic-company",
    name: "Synthetic Company",
    createdAt: "2026-01-01T00:00:00.000Z",
    archived: false,
  });
  return workspace;
}

function addUser(
  db: Database,
  id: string,
  email: string,
  options: { verified?: boolean; twoFactor?: boolean } = {},
) {
  db.query(`INSERT INTO "user"
    (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
    VALUES (?,?,?,?,?,?,?)`).run(
    id,
    `Synthetic ${id}`,
    email,
    options.verified === false ? 0 : 1,
    now.toISOString(),
    now.toISOString(),
    options.twoFactor === false ? 0 : 1,
  );
}

function issue(db: Database, workspace: string) {
  return issueWorkspaceInvitation(db, workspace, {
    email: "Invited.Owner@Example.test",
    workspaceRole: "workspace_owner",
    companySlug: "synthetic-company",
    companyRole: "owner",
    key,
    now,
    ...actor(),
  });
}

describe("workspace invitations", () => {
  test("issues a seven-day, email-bound token without persisting the raw token or leaking identity to audit", () => {
    const workspace = tempWorkspace();
    try {
      const db = openWorkspaceControlDb(workspace);
      const result = issue(db, workspace);
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(result.invitation).toMatchObject({
        email: "invited.owner@example.test",
        workspaceRole: "workspace_owner",
        companyRole: "owner",
        status: "issued",
      });
      expect(Date.parse(result.invitation.expiresAt) - now.getTime()).toBe(WORKSPACE_INVITATION_TTL_MS);
      expect(listWorkspaceInvitations(db)).toEqual([result.invitation]);

      const persisted = JSON.stringify({
        invitations: db.query("SELECT * FROM rm_workspace_invitation_events").all(),
        audit: db.query("SELECT * FROM workspace_audit").all(),
      });
      expect(persisted).not.toContain(result.token);
      const audit = JSON.stringify(db.query("SELECT * FROM workspace_audit").all());
      expect(audit).not.toContain("invited.owner@example.test");
      expect(audit).not.toContain(key.value);
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("activates requested roles once while effective access remains closed until e-mail and TOTP are ready", () => {
    const workspace = tempWorkspace();
    try {
      const db = openWorkspaceControlDb(workspace);
      addUser(db, "invited-user", "invited.owner@example.test", { verified: false, twoFactor: false });
      const result = issue(db, workspace);
      expect(() => readClaimableWorkspaceInvitation(db, {
        token: result.token, key, now,
      })).toThrow("invalid or expired");
      recordWorkspaceInvitationDelivery(db, {
        invitationId: result.invitation.invitationId,
        delivered: true,
        ...actor(),
      });
      expect(readClaimableWorkspaceInvitation(db, { token: result.token, key, now }).status)
        .toBe("delivery_confirmed");

      const accepted = acceptWorkspaceInvitation(db, workspace, {
        token: result.token,
        key,
        userId: "invited-user",
        now,
        createdBy: "user:invited-user",
        createdByProgram: "invite-claim",
      });
      expect(accepted.accessReady).toBe(false);
      expect(accepted.invitation.status).toBe("accepted");
      expect(authorizeWorkspaceRoute(db, workspace, {
        userId: "invited-user",
        companySlug: "synthetic-company",
        permission: "company.read",
      })).toEqual({ allowed: false });
      expect(() => acceptWorkspaceInvitation(db, workspace, {
        token: result.token, key, userId: "invited-user", now, ...actor(),
      })).toThrow("invalid or expired");
      expect(db.query(
        "SELECT COUNT(*) AS count FROM rm_workspace_invitation_events WHERE event_type='accepted'",
      ).get()).toEqual({ count: 1 });

      db.run('UPDATE "user" SET emailVerified=1,twoFactorEnabled=1 WHERE id=?', ["invited-user"]);
      expect(authorizeWorkspaceRoute(db, workspace, {
        userId: "invited-user",
        companySlug: "synthetic-company",
        permission: "company.read",
      })).toEqual({ allowed: true });
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("rejects wrong identities, expiry, cancellation, failed delivery and an archived target without touching its ledger", () => {
    const workspace = tempWorkspace();
    const ledgerPath = join(workspace, "synthetic-company", "data", "ledger.sqlite");
    try {
      mkdirSync(join(workspace, "synthetic-company", "data"), { recursive: true });
      const ledger = new Database(ledgerPath, { create: true });
      ledger.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('unchanged')");
      ledger.close();
      const before = createHash("sha256").update(readFileSync(ledgerPath)).digest("hex");
      const db = openWorkspaceControlDb(workspace);
      addUser(db, "wrong-user", "wrong@example.test");

      const wrong = issue(db, workspace);
      recordWorkspaceInvitationDelivery(db, { invitationId: wrong.invitation.invitationId, delivered: true, ...actor() });
      expect(() => acceptWorkspaceInvitation(db, workspace, {
        token: wrong.token, key, userId: "wrong-user", now, ...actor(),
      })).toThrow("identity does not match");
      expect(() => readClaimableWorkspaceInvitation(db, {
        token: wrong.token,
        key,
        now: new Date(now.getTime() + WORKSPACE_INVITATION_TTL_MS),
      })).toThrow("invalid or expired");

      const cancelled = issue(db, workspace);
      recordWorkspaceInvitationDelivery(db, { invitationId: cancelled.invitation.invitationId, delivered: true, ...actor() });
      expect(cancelWorkspaceInvitation(db, {
        invitationId: cancelled.invitation.invitationId, ...actor(),
      }).status).toBe("cancelled");
      expect(() => readClaimableWorkspaceInvitation(db, { token: cancelled.token, key, now }))
        .toThrow("invalid or expired");

      const failed = issue(db, workspace);
      recordWorkspaceInvitationDelivery(db, { invitationId: failed.invitation.invitationId, delivered: false, ...actor() });
      expect(() => readClaimableWorkspaceInvitation(db, { token: failed.token, key, now }))
        .toThrow("invalid or expired");

      const archived = issue(db, workspace);
      recordWorkspaceInvitationDelivery(db, { invitationId: archived.invitation.invitationId, delivered: true, ...actor() });
      setWorkspaceCompanyArchived(workspace, "synthetic-company", true);
      expect(() => acceptWorkspaceInvitation(db, workspace, {
        token: archived.token, key, userId: "wrong-user", now, ...actor(),
      })).toThrow("company is unavailable");
      db.close();
      expect(createHash("sha256").update(readFileSync(ledgerPath)).digest("hex")).toBe(before);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
