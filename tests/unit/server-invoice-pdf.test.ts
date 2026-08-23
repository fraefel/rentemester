// Tests: GET /api/companies/:slug/invoices/:id/pdf — the cockpit's read route
// that serves already-issued immutable PDF evidence so an owner can download
// it without opening the CLI. The route never renders or repairs the PDF.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";
import { createCompany } from "../../src/core/company";
import { initWorkspace, companyRootForSlug } from "../../src/core/workspace";
import { companyPaths } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { issueInvoice } from "../../src/core/issued-invoices";
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

/** Issues a single invoice into the company; returns its document id. */
function issueSample(ws: string, slug: string): number {
  const companyRoot = companyRootForSlug(ws, slug);
  const db = openDb(companyPaths(companyRoot).db);
  try {
    migrate(db);
    const result = issueInvoice(db, companyRoot, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: "2026-05-16",
      invoiceNumber: "2026-0001",
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [
        {
          description: "Bogføring",
          quantity: 1,
          unitPriceExVat: 1000,
          lineTotalExVat: 1000,
        },
      ],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK",
    });
    if (!result.ok || !result.documentId) {
      throw new Error(`issue failed: ${(result.errors ?? []).join("; ")}`);
    }
    return result.documentId;
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

function hostedReaderConfig(workspace: string, slug: string): ServerConfig {
  const userId = "invoice-reader";
  const sessionId = "invoice-reader-session";
  const createdAt = new Date();
  const control = openWorkspaceControlDb(workspace);
  control.run(`INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
               VALUES (?, 'Reader', 'invoice-reader@example.test', 1, ?, ?, 1)`, [userId, createdAt.toISOString(), createdAt.toISOString()]);
  control.run(`INSERT INTO "session" (id,expiresAt,token,createdAt,updatedAt,userId)
               VALUES (?, ?, 'opaque', ?, ?, ?)`, [sessionId, new Date(createdAt.getTime() + 86_400_000).toISOString(), createdAt.toISOString(), createdAt.toISOString(), userId]);
  activateWorkspaceUser(control, { userId, workspaceRole: "member", createdBy: "agent:test", createdByProgram: "unit-test" });
  grantCompanyMembership(control, workspace, { userId, companySlug: slug, role: "reader", createdBy: "agent:test", createdByProgram: "unit-test" });
  control.close();
  const provider: BetterAuthRequestProvider = {
    async getSession() { return { user: { id: userId }, session: { id: sessionId, createdAt } }; },
    async handle() { return new Response(null, { status: 404 }); },
  };
  return { ...config(workspace), deploymentProfile: "hosted", betterAuthProvider: provider, requestId: "invoice-request-42" };
}

describe("cockpit API — issued invoice PDF (GET .../invoices/:id/pdf)", () => {
  test("serves the issued-invoice PDF inline as application/pdf", async () => {
    const { root: ws, slug } = makeWorkspace("invpdf-ok");
    try {
      const id = issueSample(ws, slug);
      const res = await getRaw(
        config(ws),
        `/api/companies/${slug}/invoices/${id}/pdf`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain("inline");
      expect(res.headers.get("content-disposition")).toContain("rentemester-evidence-");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = new Uint8Array(await res.arrayBuffer());
      const head = new TextDecoder("latin1").decode(body.subarray(0, 5));
      expect(head).toBe("%PDF-");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an unknown invoice id is a safe 404", async () => {
    const { root: ws, slug } = makeWorkspace("invpdf-404");
    try {
      const res = await getRaw(
        config(ws),
        `/api/companies/${slug}/invoices/9999/pdf`,
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an unknown company is a safe 404", async () => {
    const { root: ws } = makeWorkspace("invpdf-co404");
    try {
      const res = await getRaw(
        config(ws),
        "/api/companies/ghost/invoices/1/pdf",
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a non-GET method is rejected", async () => {
    const { root: ws, slug } = makeWorkspace("invpdf-method");
    try {
      const res = await handleRequest(
        new Request(
          `http://localhost/api/companies/${slug}/invoices/1/pdf`,
          { method: "POST", headers: { host: "127.0.0.1" } },
        ),
        config(ws),
      );
      expect(res.status).toBe(405);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("GET uses only existing immutable PDF evidence and never re-renders or updates the ledger", async () => {
    const { root: ws, slug } = makeWorkspace("invpdf-immutable-read");
    try {
      const id = issueSample(ws, slug);
      const companyRoot = companyRootForSlug(ws, slug);
      const dbPath = companyPaths(companyRoot).db;
      const db = openDb(dbPath);
      const row = db.query(`SELECT stored_path AS storedPath FROM documents
                             WHERE document_type = 'issued_invoice_pdf'`).get() as { storedPath: string };
      db.close();
      const pdf = join(companyPaths(companyRoot).invoicesIssued, row.storedPath.split("/").at(-1)!);
      const before = { db: digest(dbPath), pdf: digest(pdf), bytes: readFileSync(pdf) };
      const response = await getRaw(config(ws), `/api/companies/${slug}/invoices/${id}/pdf`);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(before.bytes);
      expect(digest(dbPath)).toBe(before.db);
      expect(digest(pdf)).toBe(before.pdf);

      writeFileSync(pdf, "tampered PDF evidence");
      expect((await getRaw(config(ws), `/api/companies/${slug}/invoices/${id}/pdf`)).status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("fails closed when legacy evidence has no unique PDF identity for the invoice", async () => {
    const { root: ws, slug } = makeWorkspace("invpdf-ambiguous-read");
    try {
      const id = issueSample(ws, slug);
      const companyRoot = companyRootForSlug(ws, slug);
      const db = openDb(companyPaths(companyRoot).db);
      const invoice = db.query("SELECT payload_json AS payloadJson FROM documents WHERE id = ?").get(id) as { payloadJson: string };
      db.run(`INSERT INTO documents
                (document_no, source, original_filename, stored_path, mime_type, sha256_hash,
                 invoice_no, currency, status, document_type, payload_json)
              VALUES ('synthetic-duplicate-pdf', 'test', 'other.pdf', 'other.pdf', 'application/pdf', ?, '2026-0001', 'DKK', 'issued', 'issued_invoice_pdf', ?)`,
        ["a".repeat(64), invoice.payloadJson]);
      db.close();
      expect((await getRaw(config(ws), `/api/companies/${slug}/invoices/${id}/pdf`)).status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("hosted PDF success and cross-company denial append non-disclosing access evidence", async () => {
    const { root: ws, slug } = makeWorkspace("invpdf-hosted-audit");
    try {
      const id = issueSample(ws, slug);
      const deniedSlug = createCompany(ws, { name: "Denied Invoice ApS" }).slug;
      const cfg = hostedReaderConfig(ws, slug);
      expect((await getRaw(cfg, `/api/companies/${slug}/invoices/${id}/pdf`)).status).toBe(200);
      expect((await getRaw(cfg, `/api/companies/${deniedSlug}/invoices/${id}/pdf`)).status).toBe(401);
      const control = openWorkspaceControlDb(ws);
      const events = control.query(`SELECT actor, company_slug, resource_type, resource_id, outcome, reason_code, request_id
                                      FROM rm_workspace_document_access_events ORDER BY id`).all();
      control.close();
      expect(events).toEqual([
        { actor: "user:invoice-reader", company_slug: slug, resource_type: "issued_invoice_pdf", resource_id: id, outcome: "served", reason_code: "authorized", request_id: "invoice-request-42" },
        { actor: "user:invoice-reader", company_slug: deniedSlug, resource_type: "issued_invoice_pdf", resource_id: id, outcome: "denied", reason_code: "authorization_denied", request_id: "invoice-request-42" },
      ]);
      expect(JSON.stringify(events)).not.toContain("invoice-reader@example.test");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
