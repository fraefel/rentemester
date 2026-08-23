import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeFirstWorkspaceBootstrap,
  createOrResumeBootstrapIdentity,
  reserveFirstWorkspaceBootstrap,
  runFirstWorkspaceBootstrap,
  type WorkspaceBootstrapIdentityService,
  WorkspaceBootstrapError,
} from "../../src/core/workspace-bootstrap";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { initWorkspace, registerWorkspaceCompany, setWorkspaceCompanyArchived } from "../../src/core/workspace";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function tempWorkspace() { return mkdtempSync(join(tmpdir(), "rentemester-bootstrap-")); }
function actor() { return { createdBy: "agent:test", createdByProgram: "unit-test" }; }

function prepareWorkspace(workspace: string) {
  initWorkspace(workspace);
  registerWorkspaceCompany(workspace, { slug: "first-company", name: "First Company", createdAt: "2026-01-01T00:00:00.000Z", archived: false });
  registerWorkspaceCompany(workspace, { slug: "archived-company", name: "Archived Company", createdAt: "2026-01-01T00:00:00.000Z", archived: false });
  setWorkspaceCompanyArchived(workspace, "archived-company", true);
}

function service(db: Database, options: { failAfterUserCreate?: boolean } = {}): WorkspaceBootstrapIdentityService & { resent: number } {
  let sequence = 0;
  let fail = options.failAfterUserCreate === true;
  return {
    resent: 0,
    canonicalEmailHash(email) { return email.toLowerCase() === "first@example.test" ? HASH_A : HASH_B; },
    async findIdentityByCanonicalEmail(email) {
      const row = db.query('SELECT id FROM "user" WHERE email = ?').get(email.toLowerCase()) as { id: string } | null;
      return row ? { userId: row.id } : null;
    },
    async createFirstIdentity(input) {
      const existing = await this.findIdentityByCanonicalEmail(input.email);
      if (existing) return { ...existing, created: false };
      const id = `user-${++sequence}`;
      db.query(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled)
        VALUES (?, ?, ?, 0, ?, ?, 0)`).run(id, input.name, input.email.toLowerCase(), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      if (fail) { fail = false; throw new Error("simulated mail callback failure"); }
      return { userId: id, created: true };
    },
    async resendVerification() { this.resent += 1; },
  };
}

describe("workspace first-identity bootstrap saga", () => {
  test("serializes concurrent first reservations and permits same-email actor-independent resume", () => {
    const workspace = tempWorkspace();
    try {
      prepareWorkspace(workspace);
      const db = openWorkspaceControlDb(workspace);
      const first = reserveFirstWorkspaceBootstrap(db, { reservationHash: HASH_A, companySlug: "first-company", ...actor() });
      const resumed = reserveFirstWorkspaceBootstrap(db, {
        reservationHash: HASH_A, companySlug: "first-company", createdBy: "user:other", createdByProgram: "recovery",
      });
      expect(resumed).toEqual(first);
      expect(() => reserveFirstWorkspaceBootstrap(db, { reservationHash: HASH_B, companySlug: "first-company", ...actor() })).toThrow(WorkspaceBootstrapError);
      expect(db.query("SELECT reservation_hash FROM rm_workspace_bootstrap_events WHERE event_type = 'reserved'").all()).toEqual([{ reservation_hash: HASH_A }]);
      expect(db.query("SELECT actor FROM workspace_audit ORDER BY id").all()).toEqual([
        { actor: "agent:test via unit-test" },
      ]);
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("recovers a persisted Better Auth user after uncertain mail failure without duplicate identity or access events", async () => {
    const workspace = tempWorkspace();
    try {
      prepareWorkspace(workspace);
      const db = openWorkspaceControlDb(workspace);
      const identities = service(db, { failAfterUserCreate: true });
      await expect(createOrResumeBootstrapIdentity(db, workspace, identities, {
        email: "first@example.test", name: "First", password: "not-persisted", companySlug: "first-company", ...actor(),
      })).rejects.toThrow("retry the same identity");
      expect(db.query('SELECT id FROM "user"').all()).toEqual([{ id: "user-1" }]);
      const resumed = await createOrResumeBootstrapIdentity(db, workspace, identities, {
        email: "FIRST@example.test", name: "First", password: "not-persisted", companySlug: "first-company", createdBy: "user:recovery", createdByProgram: "cli",
      });
      expect(resumed).toMatchObject({ phase: "mail_confirmed", userId: "user-1" });
      expect(identities.resent).toBe(1);
      const complete = completeFirstWorkspaceBootstrap(db, workspace, { reservationHash: HASH_A, ...actor() });
      expect(complete).toMatchObject({ phase: "access_completed", userId: "user-1", companySlug: "first-company" });
      const retry = await runFirstWorkspaceBootstrap(db, workspace, identities, {
        email: "first@example.test", name: "First", password: "ignored", companySlug: "first-company", createdBy: "agent:retry", createdByProgram: "cli",
      });
      expect(retry.phase).toBe("access_completed");
      expect(db.query('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 1 });
      expect(db.query("SELECT event_type, workspace_role FROM rm_workspace_user_access_events").all()).toEqual([{ event_type: "activate", workspace_role: "workspace_owner" }]);
      expect(db.query("SELECT event_type, company_role, company_slug FROM rm_company_membership_events").all()).toEqual([{ event_type: "grant", company_role: "owner", company_slug: "first-company" }]);
      expect(db.query("SELECT event_type FROM rm_workspace_bootstrap_events ORDER BY id").all()).toEqual([
        { event_type: "reserved" }, { event_type: "identity_created" }, { event_type: "mail_confirmed" }, { event_type: "access_completed" },
      ]);
      expect(db.query("SELECT event_type FROM workspace_audit ORDER BY id").all()).toEqual([
        { event_type: "workspace_identity_bootstrap_reserved" },
        { event_type: "workspace_identity_bootstrap_identity_created" },
        { event_type: "workspace_identity_bootstrap_mail_confirmed" },
        { event_type: "workspace_identity_bootstrap_access_completed" },
      ]);
      const persistedBootstrapData = JSON.stringify({
        events: db.query("SELECT * FROM rm_workspace_bootstrap_events").all(),
        audit: db.query("SELECT * FROM workspace_audit").all(),
      });
      expect(persistedBootstrapData).not.toContain("first@example.test");
      expect(persistedBootstrapData).not.toContain("not-persisted");
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("fails closed before identity creation for unregistered or archived initial company and never touches a ledger", async () => {
    const workspace = tempWorkspace();
    const ledger = join(workspace, "first-company", "data", "ledger.sqlite");
    try {
      prepareWorkspace(workspace);
      mkdirSync(join(workspace, "first-company", "data"), { recursive: true });
      const ledgerDb = new Database(ledger, { create: true }); ledgerDb.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('unchanged')"); ledgerDb.close();
      const before = createHash("sha256").update(readFileSync(ledger)).digest("hex");
      const db = openWorkspaceControlDb(workspace);
      const identities = service(db);
      await expect(createOrResumeBootstrapIdentity(db, workspace, identities, {
        email: "first@example.test", name: "First", password: "x", companySlug: "missing", ...actor(),
      })).rejects.toThrow("not registered");
      await expect(createOrResumeBootstrapIdentity(db, workspace, identities, {
        email: "first@example.test", name: "First", password: "x", companySlug: "archived-company", ...actor(),
      })).rejects.toThrow("archived");
      expect(db.query('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 0 });
      reserveFirstWorkspaceBootstrap(db, { reservationHash: HASH_A, companySlug: "first-company", ...actor() });
      expect(() => db.run("UPDATE rm_workspace_bootstrap_events SET company_slug = 'x'")).toThrow("append-only");
      expect(() => db.run("DELETE FROM rm_workspace_bootstrap_events")).toThrow("append-only");
      db.close();
      expect(createHash("sha256").update(readFileSync(ledger)).digest("hex")).toBe(before);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("an archived registered company is rejected before any Better Auth user is created", async () => {
    const workspace = tempWorkspace();
    try {
      prepareWorkspace(workspace);
      const db = openWorkspaceControlDb(workspace);
      const identities = service(db);
      await expect(createOrResumeBootstrapIdentity(db, workspace, identities, {
        email: "first@example.test", name: "First", password: "x", companySlug: "archived-company", ...actor(),
      })).rejects.toThrow("archived");
      expect(db.query('SELECT COUNT(*) AS count FROM "user"').get()).toEqual({ count: 0 });
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("fails closed if a Better Auth identity exists before the first reservation", () => {
    const workspace = tempWorkspace();
    try {
      prepareWorkspace(workspace);
      const db = openWorkspaceControlDb(workspace);
      db.query(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled)
        VALUES ('preexisting', 'Preexisting', 'preexisting@example.test', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)`).run();
      expect(() => reserveFirstWorkspaceBootstrap(db, {
        reservationHash: HASH_A, companySlug: "first-company", ...actor(),
      })).toThrow("after an identity exists");
      expect(db.query("SELECT COUNT(*) AS count FROM rm_workspace_bootstrap_events").get()).toEqual({ count: 0 });
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
