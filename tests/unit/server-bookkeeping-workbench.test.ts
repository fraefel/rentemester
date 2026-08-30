import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCompany } from "../../src/core/company";
import { migrate, openDb } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { handleRequest, ROUTE_CATALOG } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";

const config = (workspaceRoot: string): ServerConfig => ({ host: "127.0.0.1", port: 0, authRequired: false, authToken: null, workspaceRoot });

function seed(root: string, slug: string, id: number, text: string) {
  const db = openDb(companyPaths(companyRootForSlug(root, slug)).db);
  try {
    migrate(db);
    db.query("INSERT INTO bank_transactions(id,transaction_date,text,amount,currency,transaction_hash) VALUES(?,?,?,?,?,?)").run(id, "2026-01-10", text, -125, "DKK", `hash-${slug}`);
  } finally { db.close(); }
}

describe("bookkeeping workbench HTTP contract", () => {
  test("returns the same deterministic company-scoped row contract without leaking another company", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-workbench-http-"));
    try {
      initWorkspace(root);
      createCompany(root, { name: "Alpha Synthetic" });
      createCompany(root, { name: "Beta Synthetic" });
      seed(root, "alpha-synthetic", 1, "ALPHA-ONLY");
      seed(root, "beta-synthetic", 1, "BETA-ONLY");
      const path = "/api/companies/alpha-synthetic/bookkeeping-workbench?from=2026-01-01&to=2026-01-31&search=-125%20DKK";
      const first = await handleRequest(new Request(`http://localhost${path}`), config(root));
      const second = await handleRequest(new Request(`http://localhost${path}`), config(root));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const one = await first.json() as any;
      const two = await second.json() as any;
      expect(two).toEqual(one);
      expect(one.workbench.rows).toHaveLength(1);
      expect(one.workbench.rows[0]).toMatchObject({ bankTransactionId: 1, text: "ALPHA-ONLY", status: "missingDocument", nextAction: expect.any(String), sourceHash: expect.any(String) });
      expect(JSON.stringify(one)).not.toContain("BETA-ONLY");
      expect(one.workbench.selection).toEqual({ total: 1, ready: 0, blockers: 1 });
      expect(one.workbench.plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("route catalogue publishes the read-only workbench endpoint", () => {
    expect(ROUTE_CATALOG).toContainEqual(expect.objectContaining({ method: "GET", pattern: "/api/companies/:slug/bookkeeping-workbench" }));
  });
});
