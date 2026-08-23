// Tests: GET /api/companies/:slug/documents/:id/file — the cockpit's
// read route that serves the stored bilag file so a human can open it.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";
import { createCompany } from "../../src/core/company";
import { initWorkspace, companyRootForSlug } from "../../src/core/workspace";
import { companyPaths } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { activateWorkspaceUser, grantCompanyMembership } from "../../src/core/workspace-access";
import type { BetterAuthRequestProvider } from "../../src/server/better-auth";

function makeWorkspace(label: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-${label}-`));
  initWorkspace(root);
  const created = createCompany(root, { name: "Acme ApS" });
  return { root, slug: created.slug };
}

function config(workspaceRoot: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authRequired: false,
    authToken: null,
    workspaceRoot,
  };
}

/** Ingests examples/vendor-invoice.txt into the company; returns its id. */
function ingestSample(ws: string, slug: string): number {
  const companyRoot = companyRootForSlug(ws, slug);
  const db = openDb(companyPaths(companyRoot).db);
  try {
    migrate(db);
    const metadata = JSON.parse(
      readFileSync("examples/vendor-invoice.metadata.json", "utf8"),
    );
    const res = ingestDocument(
      db,
      companyRoot,
      "examples/vendor-invoice.txt",
      metadata,
    );
    if (!res.ok) {
      throw new Error(`ingest failed: ${(res.errors ?? []).join("; ")}`);
    }
    return Number(res.documentId);
  } finally {
    db.close();
  }
}

async function getRaw(cfg: ServerConfig, path: string): Promise<Response> {
  return handleRequest(
    new Request(`http://localhost${path}`, { headers: { host: "127.0.0.1" } }),
    cfg,
  );
}

function digest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function addHostedReader(workspace: string, slug: string) {
  const userId = "document-reader";
  const sessionId = "document-reader-session";
  const createdAt = new Date();
  const control = openWorkspaceControlDb(workspace);
  control.run(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
               VALUES (?, 'Reader', 'reader@example.test', 1, ?, ?, 1)`, [userId, createdAt.toISOString(), createdAt.toISOString()]);
  control.run(`INSERT INTO "session" (id,expiresAt,token,createdAt,updatedAt,userId)
               VALUES (?, ?, 'opaque', ?, ?, ?)`, [sessionId, new Date(createdAt.getTime() + 86_400_000).toISOString(), createdAt.toISOString(), createdAt.toISOString(), userId]);
  activateWorkspaceUser(control, { userId, workspaceRole: "member", createdBy: "agent:test", createdByProgram: "unit-test" });
  grantCompanyMembership(control, workspace, { userId, companySlug: slug, role: "reader", createdBy: "agent:test", createdByProgram: "unit-test" });
  control.close();
  const provider: BetterAuthRequestProvider = {
    async getSession() { return { user: { id: userId }, session: { id: sessionId, createdAt } }; },
    async handle() { return new Response(null, { status: 404 }); },
  };
  return {
    ...config(workspace), deploymentProfile: "hosted" as const, betterAuthProvider: provider,
    requestId: "document-request-42",
  };
}

describe("cockpit API — document file (GET .../documents/:id/file)", () => {
  test("serves the stored bilag file with its content type", async () => {
    const { root: ws, slug } = makeWorkspace("docfile-ok");
    try {
      const id = ingestSample(ws, slug);
      const res = await getRaw(
        config(ws),
        `/api/companies/${slug}/documents/${id}/file`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const body = await res.text();
      expect(body).toBe(readFileSync("examples/vendor-invoice.txt", "utf8"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an unknown document id is a safe 404", async () => {
    const { root: ws, slug } = makeWorkspace("docfile-404");
    try {
      const res = await getRaw(
        config(ws),
        `/api/companies/${slug}/documents/9999/file`,
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an unknown company is a safe 404", async () => {
    const { root: ws } = makeWorkspace("docfile-co404");
    try {
      const res = await getRaw(
        config(ws),
        "/api/companies/ghost/documents/1/file",
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a non-GET method is rejected", async () => {
    const { root: ws, slug } = makeWorkspace("docfile-method");
    try {
      const res = await handleRequest(
        new Request(
          `http://localhost/api/companies/${slug}/documents/1/file`,
          { method: "POST", headers: { host: "127.0.0.1" } },
        ),
        config(ws),
      );
      expect(res.status).toBe(405);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a text bilag is served as a download, not rendered inline", async () => {
    const { root: ws, slug } = makeWorkspace("docfile-disp");
    try {
      const id = ingestSample(ws, slug);
      const res = await getRaw(
        config(ws),
        `/api/companies/${slug}/documents/${id}/file`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("snapshots only the existing hashed regular file and never changes evidence on GET", async () => {
    const { root: ws, slug } = makeWorkspace("docfile-snapshot");
    try {
      const id = ingestSample(ws, slug);
      const companyRoot = companyRootForSlug(ws, slug);
      const dbPath = companyPaths(companyRoot).db;
      const db = openDb(dbPath);
      const row = db.query("SELECT stored_path AS storedPath FROM documents WHERE id = ?").get(id) as { storedPath: string };
      db.close();
      const stored = join(companyPaths(companyRoot).documentsOriginals, row.storedPath.split("/").at(-1)!);
      const before = { db: digest(dbPath), file: digest(stored), bytes: readFileSync(stored) };
      const response = await getRaw(config(ws), `/api/companies/${slug}/documents/${id}/file`);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(before.bytes);
      expect(digest(dbPath)).toBe(before.db);
      expect(digest(stored)).toBe(before.file);

      writeFileSync(stored, "tampered");
      expect((await getRaw(config(ws), `/api/companies/${slug}/documents/${id}/file`)).status).toBe(404);
      unlinkSync(stored);
      symlinkSync("/etc/hosts", stored);
      expect((await getRaw(config(ws), `/api/companies/${slug}/documents/${id}/file`)).status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("hosted success and membership denial append bounded access evidence without an oracle", async () => {
    const { root: ws, slug } = makeWorkspace("docfile-hosted-audit");
    try {
      const id = ingestSample(ws, slug);
      const deniedSlug = createCompany(ws, { name: "Denied ApS" }).slug;
      const cfg = addHostedReader(ws, slug);
      expect((await getRaw(cfg, `/api/companies/${slug}/documents/${id}/file`)).status).toBe(200);
      const denied = await getRaw(cfg, `/api/companies/${deniedSlug}/documents/${id}/file`);
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({ ok: false, errors: ["missing or invalid credentials"], code: "unauthorized" });
      const control = openWorkspaceControlDb(ws);
      const events = control.query(`SELECT actor, company_slug, resource_type, resource_id, outcome, reason_code, request_id
                                      FROM rm_workspace_document_access_events ORDER BY id`).all();
      control.close();
      expect(events).toEqual([
        { actor: "user:document-reader", company_slug: slug, resource_type: "document_file", resource_id: id, outcome: "served", reason_code: "authorized", request_id: "document-request-42" },
        { actor: "user:document-reader", company_slug: deniedSlug, resource_type: "document_file", resource_id: id, outcome: "denied", reason_code: "authorization_denied", request_id: "document-request-42" },
      ]);
      expect(JSON.stringify(events)).not.toContain("example.test");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
