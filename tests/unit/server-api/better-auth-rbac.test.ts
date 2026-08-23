import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  activateWorkspaceUser,
  disableWorkspaceUser,
  grantCompanyMembership,
  invalidateWorkspaceSessions,
  invalidateUserSessions,
  revokeCompanyMembership,
} from "../../../src/core/workspace-access";
import { openWorkspaceControlDb } from "../../../src/core/workspace-control";
import { applyGroupManifest } from "../../../src/core/group-manifest";
import { approveIntercompanyMapping, proposeIntercompanyMapping } from "../../../src/core/intercompany-reconciliation";
import { initialiseCompanyVolume } from "../../../src/core/company";
import { ROUTE_CATALOG } from "../../../src/server/router";
import type { BetterAuthRequestProvider } from "../../../src/server/better-auth";
import {
  companyRootForSlug,
  companyPaths,
  config,
  get,
  handleRequest,
  loadWorkspaceManifest,
  makeWorkspace,
  migrate,
  openDb,
  postPnlEntry,
  recordException,
  rmSync,
} from "./_shared";

const SESSION_CREATED_AT = new Date("2025-01-01T00:00:00.000Z");

function actor() {
  return { createdBy: "agent:test", createdByProgram: "unit-test" };
}

function addUser(workspace: string, id = "synthetic-user") {
  const db = openWorkspaceControlDb(workspace);
  db.query(
    `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled)
     VALUES (?, ?, ?, 0, ?, ?, 0)`,
  ).run(id, "Synthetic User", `${id}@example.test`, SESSION_CREATED_AT.toISOString(), SESSION_CREATED_AT.toISOString());
  db.close();
  return id;
}

function addSession(db: ReturnType<typeof openWorkspaceControlDb>, userId: string, options?: {
  id?: string;
  createdAt?: Date;
}) {
  const id = options?.id ?? "synthetic-session";
  const createdAt = options?.createdAt ?? SESSION_CREATED_AT;
  db.query(
    `INSERT INTO "session" (id, expiresAt, token, createdAt, updatedAt, userId)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    new Date(createdAt.getTime() + 86_400_000).toISOString(),
    `opaque-${id}`,
    createdAt.toISOString(),
    createdAt.toISOString(),
    userId,
  );
}

function provider(
  userId: string,
  calls: { getSession: number },
  options?: { sessionId?: string; createdAt?: Date },
): BetterAuthRequestProvider {
  const sessionId = options?.sessionId ?? "synthetic-session";
  const createdAt = options?.createdAt ?? SESSION_CREATED_AT;
  return {
    async getSession() {
      calls.getSession += 1;
      return { user: { id: userId }, session: { id: sessionId, createdAt } };
    },
    async handle() {
      return new Response("not mounted in this synthetic provider", { status: 404 });
    },
  };
}

function hostedConfig(
  workspace: string,
  userId: string,
  calls: { getSession: number },
  options?: { sessionId?: string; createdAt?: Date },
) {
  return config({
    workspaceRoot: workspace,
    deploymentProfile: "hosted",
    hostedBetterAuth: {
      secret: "test-only-secret",
      secrets: [{ version: 1, value: "test-only-secret" }],
      baseURL: "https://cockpit.example.test",
      trustedOrigins: ["https://cockpit.example.test", "https://alternate.example.test"],
      authEmail: {
        provider: "http-json-v1",
        url: "https://mailer.example.test/send",
        bearerToken: "test-only-token",
        from: "noreply@example.test",
      },
      rateLimitIpHeader: "x-real-ip",
    },
    betterAuthProvider: provider(userId, calls, options),
  });
}

describe("cockpit Better Auth + RBAC boundary", () => {
  test("never mounts public Better Auth sign-up, even when a provider is configured", async () => {
    const workspace = makeWorkspace("better-auth-signup");
    try {
      let handled = 0;
      const cfg = config({
        workspaceRoot: workspace,
        betterAuthProvider: {
          async getSession() { return null; },
          async handle() { handled += 1; return new Response("{}", { headers: { "content-type": "application/json" } }); },
        },
      });
      expect((await get(cfg, "/api/auth/sign-up/email", { method: "POST" })).status).toBe(404);
      expect(handled).toBe(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("keeps public routes anonymous and denies an unready user before a company handler", async () => {
    const workspace = makeWorkspace("better-auth-rbac", ["Allowed ApS", "Other ApS"]);
    try {
      const userId = addUser(workspace);
      const calls = { getSession: 0 };
      const cfg = config({ workspaceRoot: workspace, betterAuthProvider: provider(userId, calls) });

      expect((await get(cfg, "/api/health")).status).toBe(200);
      expect(calls.getSession).toBe(0);
      const denied = await get(cfg, "/api/companies/allowed-aps/dashboard");
      expect(denied.status).toBe(401);
      expect(calls.getSession).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("authorizes verified MFA membership once, applies roles, denies slug swaps and honors invalidation", async () => {
    const workspace = makeWorkspace("better-auth-rbac-policy", ["Allowed ApS", "Other ApS"]);
    try {
      const userId = addUser(workspace);
      const db = openWorkspaceControlDb(workspace);
      db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      const freshSession = new Date();
      addSession(db, userId, { createdAt: freshSession });
      activateWorkspaceUser(db, { userId, workspaceRole: "member", ...actor() });
      grantCompanyMembership(db, workspace, { userId, companySlug: "allowed-aps", role: "bookkeeper", ...actor() });
      db.close();

      const calls = { getSession: 0 };
      const cfg = hostedConfig(workspace, userId, calls, { createdAt: freshSession });
      expect((await get(cfg, "/api/companies/allowed-aps/dashboard")).status).toBe(200);
      expect(calls.getSession).toBe(1);
      expect((await get(cfg, "/api/companies/other-aps/dashboard")).status).toBe(401);
      // An encoded slash is rejected by catalog matching before a handler can
      // reinterpret it as a company selection.
      expect((await get(cfg, "/api/companies/allowed-aps%2Fother-aps/dashboard")).status).toBe(404);
      expect((await get(cfg, "/api/companies/allowed-aps/periods/close", {
        method: "POST", headers: { "content-type": "application/json", origin: "https://cockpit.example.test" }, body: "{}",
      })).status).toBe(401);
      const denialDb = openWorkspaceControlDb(workspace);
      expect(denialDb.query(`SELECT actor, method, route_template, permission,
        company_slug, outcome, reason_code FROM rm_workspace_authorization_events ORDER BY id`).all()).toEqual([
        {
          actor: `user:${userId}`, method: "GET",
          route_template: "/api/companies/:slug/dashboard", permission: "company.read",
          company_slug: "other-aps", outcome: "denied", reason_code: "authorization_denied",
        },
        {
          actor: `user:${userId}`, method: "POST",
          route_template: "/api/companies/:slug/periods/close", permission: "company.review",
          company_slug: "allowed-aps", outcome: "denied", reason_code: "authorization_denied",
        },
      ]);
      expect(JSON.stringify(denialDb.query("SELECT * FROM rm_workspace_authorization_events").all())).not.toContain("allowed-aps%2Fother-aps");
      denialDb.close();

      // The same authenticated identity receives a new append-only role event.
      // A reviewer may reach a review endpoint (it then fails only because the
      // synthetic target does not exist); a reader may not.
      const roleDb = openWorkspaceControlDb(workspace);
      grantCompanyMembership(roleDb, workspace, { userId, companySlug: "allowed-aps", role: "reviewer", ...actor() });
      roleDb.close();
      const reviewer = await get(cfg, "/api/companies/allowed-aps/exceptions/999/resolve", {
        method: "POST", headers: { "content-type": "application/json", origin: "https://cockpit.example.test" }, body: "{}",
      });
      expect(reviewer.status).not.toBe(401);
      const readerDb = openWorkspaceControlDb(workspace);
      grantCompanyMembership(readerDb, workspace, { userId, companySlug: "allowed-aps", role: "reader", ...actor() });
      readerDb.close();
      expect((await get(cfg, "/api/companies/allowed-aps/dashboard")).status).toBe(200);
      expect((await get(cfg, "/api/companies/allowed-aps/periods/close", {
        method: "POST", headers: { "content-type": "application/json", origin: "https://cockpit.example.test" }, body: "{}",
      })).status).toBe(401);

      const revokeDb = openWorkspaceControlDb(workspace);
      invalidateUserSessions(revokeDb, { userId, ...actor() });
      revokeDb.close();
      expect((await get(cfg, "/api/companies/allowed-aps/dashboard")).status).toBe(401);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("separates accounting-draft authors from reviewers across company boundaries", async () => {
    const workspace = makeWorkspace("better-auth-accounting-drafts", ["Allowed ApS", "Other ApS"]);
    try {
      const bookkeeperId = addUser(workspace, "synthetic-bookkeeper");
      const reviewerId = addUser(workspace, "synthetic-reviewer");
      const freshSession = new Date();
      const db = openWorkspaceControlDb(workspace);
      for (const [userId, sessionId, role] of [
        [bookkeeperId, "bookkeeper-session", "bookkeeper"],
        [reviewerId, "reviewer-session", "reviewer"],
      ] as const) {
        db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
        addSession(db, userId, { id: sessionId, createdAt: freshSession });
        activateWorkspaceUser(db, { userId, workspaceRole: "member", ...actor() });
        grantCompanyMembership(db, workspace, { userId, companySlug: "allowed-aps", role, ...actor() });
      }
      db.close();

      const bookkeeper = hostedConfig(workspace, bookkeeperId, { getSession: 0 }, {
        sessionId: "bookkeeper-session",
        createdAt: freshSession,
      });
      const reviewer = hostedConfig(workspace, reviewerId, { getSession: 0 }, {
        sessionId: "reviewer-session",
        createdAt: freshSession,
      });
      const headers = { "content-type": "application/json", origin: "https://cockpit.example.test" };
      const payload = {
        transactionDate: "2026-08-23",
        text: "Synthetic draft",
        lines: [
          { accountNo: "1100", debitAmount: 100 },
          { accountNo: "2000", creditAmount: 100 },
        ],
      };
      const created = await get(bookkeeper, "/api/companies/allowed-aps/accounting-drafts", {
        method: "POST",
        headers,
        body: JSON.stringify({ draftId: "synthetic-draft", payload }),
      });
      expect(created.status).toBe(200);
      const createdHash = String((created.body.accountingDraft as { eventHash: string }).eventHash);
      const submitted = await get(bookkeeper, "/api/companies/allowed-aps/accounting-drafts/synthetic-draft/submit", {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedEventHash: createdHash }),
      });
      expect(submitted.status).toBe(200);
      const submittedHash = String((submitted.body.accountingDraft as { eventHash: string }).eventHash);

      expect((await get(bookkeeper, "/api/companies/allowed-aps/accounting-drafts/synthetic-draft/approve-and-post", {
        method: "POST", headers, body: JSON.stringify({ expectedEventHash: submittedHash, confirm: true }),
      })).status).toBe(401);
      expect((await get(reviewer, "/api/companies/allowed-aps/accounting-drafts", {
        method: "POST", headers, body: JSON.stringify({ draftId: "reviewer-draft", payload }),
      })).status).toBe(401);
      expect((await get(reviewer, "/api/companies/other-aps/accounting-drafts", {
        method: "GET",
      })).status).toBe(401);

      const missingConfirm = await get(reviewer, "/api/companies/allowed-aps/accounting-drafts/synthetic-draft/approve-and-post", {
        method: "POST", headers, body: JSON.stringify({ expectedEventHash: submittedHash }),
      });
      expect(missingConfirm.body).toMatchObject({ subcode: "CONFIRM_REQUIRED" });
      const approved = await get(reviewer, "/api/companies/allowed-aps/accounting-drafts/synthetic-draft/approve-and-post", {
        method: "POST", headers, body: JSON.stringify({ expectedEventHash: submittedHash, confirm: true }),
      });
      expect(approved.status).toBe(200);
      expect(approved.body.accountingDraft).toMatchObject({ status: "approved_posted", journal: { ok: true } });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("central hosted custom-route origin and session freshness gates run before mutation handlers", async () => {
    const workspace = makeWorkspace("better-auth-rbac-route-security", ["Allowed ApS"]);
    try {
      const userId = addUser(workspace);
      const freshCreatedAt = new Date();
      const staleCreatedAt = new Date(Date.now() - 10 * 60 * 1000 - 1);
      const db = openWorkspaceControlDb(workspace);
      db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      addSession(db, userId, { id: "fresh-session", createdAt: freshCreatedAt });
      addSession(db, userId, { id: "stale-session", createdAt: staleCreatedAt });
      activateWorkspaceUser(db, { userId, workspaceRole: "workspace_owner", ...actor() });
      grantCompanyMembership(db, workspace, { userId, companySlug: "allowed-aps", role: "owner", ...actor() });
      db.close();

      const fresh = hostedConfig(workspace, userId, { getSession: 0 }, {
        sessionId: "fresh-session", createdAt: freshCreatedAt,
      });
      const stale = hostedConfig(workspace, userId, { getSession: 0 }, {
        sessionId: "stale-session", createdAt: staleCreatedAt,
      });
      const json = { "content-type": "application/json", origin: "https://cockpit.example.test" };

      // A hosted cookie session has no headerless non-browser mutation path.
      expect((await get(fresh, "/api/companies/allowed-aps/exceptions/999/resolve", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      })).body).toMatchObject({ code: "unauthorized", subcode: "FORBIDDEN_ORIGIN" });
      expect((await get(fresh, "/api/companies/allowed-aps/exceptions/999/resolve", {
        method: "POST", headers: { ...json, origin: "https://forged.example.test" }, body: "{}",
      })).body).toMatchObject({ code: "unauthorized", subcode: "FORBIDDEN_ORIGIN" });
      // A second configured origin and Referer fallback are both accepted.
      expect((await get(fresh, "/api/companies/allowed-aps/exceptions/999/resolve", {
        method: "POST", headers: { ...json, origin: "https://alternate.example.test" }, body: "{}",
      })).status).not.toBe(401);
      expect((await get(fresh, "/api/companies/allowed-aps/exceptions/999/resolve", {
        method: "POST", headers: { "content-type": "application/json", referer: "https://cockpit.example.test/settings" }, body: "{}",
      })).status).not.toBe(401);

      // The one freshness limit covers financial draft writes, external sends,
      // and company administration; all reject before opening a ledger.
      for (const request of [
        new Request("http://localhost/api/companies/allowed-aps/recurring-invoices", { method: "POST", headers: json, body: "{}" }),
        new Request("http://localhost/api/companies/allowed-aps/invoices/send-email", { method: "POST", headers: json, body: "{}" }),
        new Request("http://localhost/api/companies/allowed-aps/company", { method: "PATCH", headers: json, body: "{}" }),
      ]) {
        const response = await handleRequest(request, stale);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ subcode: "SESSION_REAUTH_REQUIRED" });
      }
      // Stale sessions may still perform normal reads; no client clock is used.
      expect((await get(stale, "/api/companies/allowed-aps/dashboard")).status).toBe(200);
      for (const [path, method] of [
        ["/api/companies/allowed-aps/recurring-invoices", "POST"],
        ["/api/companies/allowed-aps/invoices/send-email", "POST"],
        ["/api/companies/allowed-aps/company", "PATCH"],
      ] as const) {
        expect((await get(fresh, path, { method, headers: json, body: "{}" })).status).not.toBe(401);
      }

      // Local legacy keeps its explicit headerless CLI/Cockpit write contract.
      const local = config({ workspaceRoot: workspace });
      expect((await get(local, "/api/companies", {
        method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: '{"name":"Local Contract ApS"}',
      })).status).not.toBe(401);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("disabled users are rejected immediately despite a still-valid provider session", async () => {
    const workspace = makeWorkspace("better-auth-rbac-disable", ["Allowed ApS"]);
    try {
      const userId = addUser(workspace);
      const db = openWorkspaceControlDb(workspace);
      db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      addSession(db, userId);
      activateWorkspaceUser(db, { userId, workspaceRole: "member", ...actor() });
      grantCompanyMembership(db, workspace, { userId, companySlug: "allowed-aps", role: "reader", ...actor() });
      db.close();
      const cfg = config({ workspaceRoot: workspace, betterAuthProvider: provider(userId, { getSession: 0 }) });
      expect((await get(cfg, "/api/companies/allowed-aps/dashboard")).status).toBe(200);
      const disableDb = openWorkspaceControlDb(workspace);
      disableWorkspaceUser(disableDb, { userId, ...actor() });
      disableDb.close();
      expect((await get(cfg, "/api/companies/allowed-aps/dashboard")).status).toBe(401);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("hosted mutation records the authenticated user in the core payload evidence", async () => {
    const workspace = makeWorkspace("better-auth-rbac-actor", ["Allowed ApS"]);
    try {
      const userId = addUser(workspace, "synthetic_actor-42");
      const freshSession = new Date();
      const control = openWorkspaceControlDb(workspace);
      control.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      addSession(control, userId, { createdAt: freshSession });
      activateWorkspaceUser(control, { userId, workspaceRole: "member", ...actor() });
      grantCompanyMembership(control, workspace, { userId, companySlug: "allowed-aps", role: "reviewer", ...actor() });
      control.close();

      const ledger = openDb(companyPaths(companyRootForSlug(workspace, "allowed-aps")).db);
      let exceptionId: number;
      try {
        migrate(ledger);
        const recorded = recordException(ledger, {
          type: "synthetic-review", severity: "low", message: "Synthetic actor evidence",
        });
        expect(recorded.ok).toBe(true);
        exceptionId = recorded.exceptionId!;
      } finally {
        ledger.close();
      }

      const cfg = hostedConfig(workspace, userId, { getSession: 0 }, { createdAt: freshSession });
      const response = await get(cfg, `/api/companies/allowed-aps/exceptions/${exceptionId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://cockpit.example.test" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      const evidence = openDb(companyPaths(companyRootForSlug(workspace, "allowed-aps")).db);
      try {
        expect(evidence.query("SELECT resolved_by FROM exceptions WHERE id = ?").get(exceptionId)).toEqual({
          resolved_by: `user:${userId}`,
        });
      } finally {
        evidence.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("hosted company list and portfolio expose only current company memberships", async () => {
    const workspace = makeWorkspace("better-auth-rbac-portfolio", ["Allowed Figures ApS", "Hidden Figures ApS"]);
    try {
      // Deliberately distinct synthetic figures make a leaked portfolio rollup
      // observable even if a name filter were accidentally applied only at the
      // response edge.
      postPnlEntry(workspace, "allowed-figures-aps", "2026-05-15", 100, 0);
      postPnlEntry(workspace, "hidden-figures-aps", "2026-05-15", 900, 0);
      const hiddenDb = openDb(companyPaths(companyRootForSlug(workspace, "hidden-figures-aps")).db);
      try {
        migrate(hiddenDb);
        expect(recordException(hiddenDb, {
          type: "hidden-only-task", severity: "high", message: "Synthetic hidden task",
        }).ok).toBe(true);
      } finally {
        hiddenDb.close();
      }
      // A real company volume which is intentionally absent from workspace.json.
      // Hosted reads must not discover-and-adopt it as a side effect.
      initialiseCompanyVolume(companyRootForSlug(workspace, "unlisted-aps"), {
        name: "Unlisted Hidden ApS",
      });
      const userId = addUser(workspace);
      const db = openWorkspaceControlDb(workspace);
      db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      addSession(db, userId);
      // Workspace ownership permits workspace administration, not implicit
      // access to every company ledger.
      activateWorkspaceUser(db, { userId, workspaceRole: "workspace_owner", ...actor() });
      grantCompanyMembership(db, workspace, {
        userId, companySlug: "allowed-figures-aps", role: "reader", ...actor(),
      });
      db.close();

      const cfg = config({ workspaceRoot: workspace, betterAuthProvider: provider(userId, { getSession: 0 }) });
      const list = await get(cfg, "/api/companies");
      expect(list.status).toBe(200);
      expect(list.body).toMatchObject({ count: 1 });
      expect(list.body.companies).toEqual([expect.objectContaining({ slug: "allowed-figures-aps" })]);
      expect(JSON.stringify(list.body)).not.toContain("Hidden Figures ApS");
      expect(loadWorkspaceManifest(workspace).companies.map((company) => company.slug)).not.toContain("unlisted-aps");

      const portfolio = await get(cfg, "/api/portfolio?asOf=2026-05-31");
      expect(portfolio.status).toBe(200);
      expect(portfolio.body.portfolio).toMatchObject({ companyCount: 1 });
      expect(portfolio.body.portfolio.companies).toEqual([
        expect.objectContaining({ slug: "allowed-figures-aps" }),
      ]);
      expect(portfolio.body.portfolio.rollup.resultat).toBe(
        portfolio.body.portfolio.companies[0].resultat,
      );
      expect(portfolio.body.portfolio.totals.openExceptionCount).toBe(
        portfolio.body.portfolio.companies[0].openExceptionCount,
      );
      expect(JSON.stringify(portfolio.body)).not.toContain("Hidden Figures ApS");

      const revokeDb = openWorkspaceControlDb(workspace);
      revokeCompanyMembership(revokeDb, workspace, {
        userId, companySlug: "allowed-figures-aps", ...actor(),
      });
      revokeDb.close();
      expect((await get(cfg, "/api/companies")).body).toMatchObject({ count: 0, companies: [] });
      expect((await get(cfg, "/api/portfolio?asOf=2026-05-31")).body.portfolio).toMatchObject({
        companyCount: 0,
        companies: [],
        rollup: { resultat: 0, liquidity: 0, vatPayable: 0, openTaskCount: 0 },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GET /api/me returns exactly safe hosted context in manifest order and never touches ledgers", async () => {
    const workspace = makeWorkspace("better-auth-rbac-me", ["Visible ApS", "Hidden ApS"]);
    try {
      const userId = addUser(workspace);
      const db = openWorkspaceControlDb(workspace);
      db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      addSession(db, userId);
      activateWorkspaceUser(db, { userId, workspaceRole: "member", ...actor() });
      grantCompanyMembership(db, workspace, {
        userId, companySlug: "visible-aps", role: "reviewer", ...actor(),
      });
      grantCompanyMembership(db, workspace, {
        userId, companySlug: "hidden-aps", role: "bookkeeper", ...actor(),
      });
      revokeCompanyMembership(db, workspace, {
        userId, companySlug: "hidden-aps", ...actor(),
      });
      db.close();

      const ledgerPath = companyPaths(companyRootForSlug(workspace, "visible-aps")).db;
      const before = createHash("sha256").update(readFileSync(ledgerPath)).digest("hex");
      const cfg = config({ workspaceRoot: workspace, betterAuthProvider: provider(userId, { getSession: 0 }) });
      const response = await get(cfg, "/api/me");
      expect(response.status).toBe(200);
      expect(Object.keys(response.body).sort()).toEqual(["companies", "ok", "user", "workspaceRole"]);
      expect(Object.keys(response.body.user).sort()).toEqual([
        "email", "emailVerified", "id", "twoFactorEnabled",
      ]);
      expect(response.body).toEqual({
        ok: true,
        user: {
          id: userId,
          email: `${userId}@example.test`,
          emailVerified: true,
          twoFactorEnabled: true,
        },
        workspaceRole: "member",
        companies: [{
          slug: "visible-aps",
          name: "Visible ApS",
          role: "reviewer",
          archived: false,
        }],
      });
      expect(JSON.stringify(response.body)).not.toMatch(/password|token|session|secret/i);
      expect(createHash("sha256").update(readFileSync(ledgerPath)).digest("hex")).toBe(before);

      const revokeDb = openWorkspaceControlDb(workspace);
      revokeCompanyMembership(revokeDb, workspace, {
        userId, companySlug: "visible-aps", ...actor(),
      });
      revokeDb.close();
      expect((await get(cfg, "/api/me")).body).toMatchObject({ ok: true, companies: [] });

      expect(ROUTE_CATALOG).toContainEqual(expect.objectContaining({
        method: "GET", pattern: "/api/me", scope: "workspace", effect: "read", permission: "workspace.read",
      }));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("GET /api/group-overview is membership-filtered structure only and does not require ledgers", async () => {
    const workspace = makeWorkspace("better-auth-group", ["Visible Entity", "Hidden Entity"]);
    try {
      const userId = addUser(workspace, "group-user");
      const control = openWorkspaceControlDb(workspace);
      control.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      addSession(control, userId);
      activateWorkspaceUser(control, { userId, workspaceRole: "workspace_owner", ...actor() });
      grantCompanyMembership(control, workspace, { userId, companySlug: "visible-entity", role: "reader", ...actor() });
      applyGroupManifest(control, workspace, {
        version: 1, groups: [{ id: "test-group", name: "Test group", memberships: [
          { id: "visible", companySlug: "visible-entity", validFrom: "2026-01-01" },
          { id: "hidden", companySlug: "hidden-entity", validFrom: "2026-01-01" },
        ], ownership: [] }],
      }, actor());
      const proposal = proposeIntercompanyMapping(control, workspace, {
        id: "hidden-reciprocal", groupId: "test-group",
        leftCompanySlug: "visible-entity", rightCompanySlug: "hidden-entity",
        leftAccountNos: ["1100"], rightAccountNos: ["7000"],
        leftPosition: "receivable", rightPosition: "payable",
        evidenceRefs: ["synthetic-evidence"], validFrom: "2026-01-01",
      }, actor());
      approveIntercompanyMapping(control, workspace, proposal.mappingId, proposal.mappingHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" });
      control.close();
      // This route is not a portfolio alias: a missing company ledger cannot
      // make a structure/status response open, migrate, or inspect it; it is
      // reported as unavailable from an exact path check only.
      rmSync(companyRootForSlug(workspace, "hidden-entity"), { recursive: true, force: true });
      expect((await get(hostedConfig(workspace, userId, { getSession: 0 }), "/api/group-overview")).status).toBe(400);
      const response = await get(hostedConfig(workspace, userId, { getSession: 0 }), "/api/group-overview?asOf=2026-01-01");
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        scope: "structure-status-only", consolidationStatus: "not-available",
        consolidatedFigures: null, rawCompanySums: null, manifestStatus: "blocked",
      });
      expect(JSON.stringify(response.body)).toContain("visible-entity");
      expect(JSON.stringify(response.body)).not.toContain("hidden-entity");
      expect(response.body.groups[0]).toMatchObject({ partial: true, readiness: "blocked" });
      expect(response.body.groups[0]).not.toHaveProperty("id");
      expect(response.body.groups[0]).not.toHaveProperty("hiddenMembershipCount");
      const reconciliation = await get(hostedConfig(workspace, userId, { getSession: 0 }), "/api/group-reconciliation?asOf=2026-01-01");
      expect(reconciliation.status).toBe(200);
      expect(reconciliation.body.rows).toEqual([{ status: "not-comparable", reason: "blocked", blockers: ["both mapped companies must be visible"] }]);
      expect(JSON.stringify(reconciliation.body)).not.toContain("hidden-entity");
      expect(JSON.stringify(reconciliation.body)).not.toContain("7000");
      expect((await get(hostedConfig(workspace, userId, { getSession: 0 }), "/api/group-overview?asOf=2026-01-01&asOf=2026-01-02")).status).toBe(400);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("GET /api/me is hosted-only and denies absent Better Auth sessions", async () => {
    const workspace = makeWorkspace("better-auth-rbac-me-deny", ["Visible ApS"]);
    try {
      expect((await get(config({ workspaceRoot: workspace }), "/api/me")).status).toBe(401);
      const hosted = config({
        workspaceRoot: workspace,
        betterAuthProvider: {
          async getSession() { return null; },
          async handle() { return new Response("not used", { status: 404 }); },
        },
      });
      expect((await get(hosted, "/api/me")).status).toBe(401);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("verified first MFA enrollment atomically revokes every password-only session", async () => {
    const workspace = makeWorkspace("better-auth-rbac-first-mfa", ["Allowed ApS"]);
    try {
      const userId = addUser(workspace);
      const db = openWorkspaceControlDb(workspace);
      // These simulate two devices which both signed in using password only
      // before verified TOTP enrollment. They intentionally share the same
      // millisecond to exercise the boundary without timestamp comparisons.
      const sameMillisecond = new Date("2026-08-23T10:00:00.000Z");
      addSession(db, userId, { id: "password-device-a", createdAt: sameMillisecond });
      addSession(db, userId, { id: "password-device-b", createdAt: sameMillisecond });
      activateWorkspaceUser(db, { userId, workspaceRole: "member", ...actor() });
      grantCompanyMembership(db, workspace, { userId, companySlug: "allowed-aps", role: "reader", ...actor() });
      db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      expect(db.query('SELECT COUNT(*) AS count FROM "session" WHERE "userId" = ?').get(userId)).toEqual({ count: 0 });
      expect(db.query(
        "SELECT event_type, actor FROM rm_workspace_mfa_events WHERE user_id = ?",
      ).get(userId)).toEqual({ event_type: "mfa_enabled", actor: "system:better-auth" });
      // A fresh session exists only after the enrollment-trigger transaction.
      addSession(db, userId, { id: "mfa-device", createdAt: new Date("2026-08-23T10:00:00.000Z") });
      db.close();

      expect((await get(config({
        workspaceRoot: workspace,
        betterAuthProvider: provider(userId, { getSession: 0 }, { sessionId: "password-device-a", createdAt: sameMillisecond }),
      }), "/api/companies/allowed-aps/dashboard")).status).toBe(401);
      expect((await get(config({
        workspaceRoot: workspace,
        betterAuthProvider: provider(userId, { getSession: 0 }, { sessionId: "password-device-b", createdAt: sameMillisecond }),
      }), "/api/companies/allowed-aps/dashboard")).status).toBe(401);
      // Even a fresh session with the same timestamp as the invalidated ones
      // is allowed only because it has its own surviving Better Auth row.
      expect((await get(config({
        workspaceRoot: workspace,
        betterAuthProvider: provider(userId, { getSession: 0 }, { sessionId: "mfa-device", createdAt: sameMillisecond }),
      }), "/api/companies/allowed-aps/dashboard")).status).toBe(200);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("emergency user and workspace invalidation reject same-millisecond stale sessions", async () => {
    const workspace = makeWorkspace("better-auth-rbac-emergency", ["Allowed ApS"]);
    try {
      const userId = addUser(workspace);
      const createdAt = new Date("2026-08-23T11:00:00.000Z");
      const db = openWorkspaceControlDb(workspace);
      db.run('UPDATE "user" SET emailVerified = 1, twoFactorEnabled = 1 WHERE id = ?', [userId]);
      addSession(db, userId, { id: "same-millisecond-user", createdAt });
      activateWorkspaceUser(db, { userId, workspaceRole: "member", ...actor() });
      grantCompanyMembership(db, workspace, { userId, companySlug: "allowed-aps", role: "reader", ...actor() });
      db.close();
      const cfg = config({
        workspaceRoot: workspace,
        betterAuthProvider: provider(userId, { getSession: 0 }, { sessionId: "same-millisecond-user", createdAt }),
      });
      expect((await get(cfg, "/api/companies/allowed-aps/dashboard")).status).toBe(200);
      const userInvalidate = openWorkspaceControlDb(workspace);
      invalidateUserSessions(userInvalidate, { userId, ...actor() });
      userInvalidate.close();
      expect((await get(cfg, "/api/companies/allowed-aps/dashboard")).status).toBe(401);

      const afterUser = openWorkspaceControlDb(workspace);
      addSession(afterUser, userId, { id: "same-millisecond-workspace", createdAt });
      afterUser.close();
      const workspaceCfg = config({
        workspaceRoot: workspace,
        betterAuthProvider: provider(userId, { getSession: 0 }, { sessionId: "same-millisecond-workspace", createdAt }),
      });
      expect((await get(workspaceCfg, "/api/companies/allowed-aps/dashboard")).status).toBe(200);
      const workspaceInvalidate = openWorkspaceControlDb(workspace);
      invalidateWorkspaceSessions(workspaceInvalidate, actor());
      workspaceInvalidate.close();
      expect((await get(workspaceCfg, "/api/companies/allowed-aps/dashboard")).status).toBe(401);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
