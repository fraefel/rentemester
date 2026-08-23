import { describe, expect, test } from "bun:test";
import { ROUTE_CATALOG, validateRouteCatalog, type RouteCatalogEntry } from "../../src/server/router";
import { config, get, makeWorkspace, rmSync } from "./server-api/_shared";

describe("cockpit route authorization catalog", () => {
  test("every published route declares scope, effect and future permission", () => {
    expect(ROUTE_CATALOG.length).toBeGreaterThan(0);
    for (const route of ROUTE_CATALOG) {
      expect(["public", "workspace", "company"]).toContain(route.scope);
      expect(["read", "write", "external"]).toContain(route.effect);
      expect(route.permission.length).toBeGreaterThan(0);
    }
  });

  test("rejects an unclassified route rather than silently publishing it", () => {
    expect(() => validateRouteCatalog([{
      method: "GET",
      pattern: "/api/future",
      summary: "synthetic",
    } as RouteCatalogEntry])).toThrow(/metadata missing/);
  });

  test("rejects contradictory scope and permission metadata", () => {
    expect(() => validateRouteCatalog([{
      method: "POST", pattern: "/api/companies/:slug/future", summary: "synthetic",
      scope: "company", effect: "write", permission: "workspace.manage",
    }])).toThrow(/wrong permission scope/);
  });

  test("rejects an external effect without an external permission", () => {
    expect(() => validateRouteCatalog([{
      method: "GET", pattern: "/api/companies/:slug/future", summary: "synthetic",
      scope: "company", effect: "external", permission: "company.read",
    }])).toThrow(/non-external permission/);
  });

  test("makes the catalog a runtime gate while preserving 405 for known paths", async () => {
    const workspace = makeWorkspace("route-runtime-gate", ["Synthetic Company"]);
    try {
      const cfg = config({ workspaceRoot: workspace });
      expect((await get(cfg, "/api/future-imperative-handler")).status).toBe(404);
      expect((await get(cfg, "/api/companies/synthetic-company/dashboard", {
        method: "POST",
      })).status).toBe(405);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
