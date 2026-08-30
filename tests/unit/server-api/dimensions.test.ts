import { describe, expect, test } from "bun:test";
import { companyPaths, companyRootForSlug, config, get, makeWorkspace, migrate, openDb, rmSync } from "./_shared";
import { createDimensionDefinition, createDimensionMember } from "../../../src/core/accounting-dimensions";

describe("cockpit API — accounting dimensions", () => {
  test("reads only the requesting company's append-only dimension history", async () => {
    const ws = makeWorkspace("dimension-api", ["Synthetic One", "Synthetic Two"]);
    try {
      const first = openDb(companyPaths(companyRootForSlug(ws, "synthetic-one")).db);
      try {
        migrate(first);
        expect(createDimensionDefinition(first, { dimensionId: "project", kind: "project", name: "Projects", actor: "user:test", principal: "test", confirm: true }).ok).toBeTrue();
        expect(createDimensionMember(first, { dimensionId: "project", memberId: "a", name: "Project A", actor: "user:test", principal: "test", confirm: true }).ok).toBeTrue();
      } finally { first.close(); }
      const second = openDb(companyPaths(companyRootForSlug(ws, "synthetic-two")).db);
      try { migrate(second); } finally { second.close(); }
      const beforeDb = openDb(companyPaths(companyRootForSlug(ws, "synthetic-one")).db);
      let before: { n:number };
      try { before = beforeDb.query("SELECT count(*) AS n FROM accounting_dimension_definition_events").get() as { n:number }; } finally { beforeDb.close(); }
      const response = await get(config({ workspaceRoot: ws }), "/api/companies/synthetic-one/dimensions");
      const members = await get(config({ workspaceRoot: ws }), "/api/companies/synthetic-one/dimensions/members");
      const isolated = await get(config({ workspaceRoot: ws }), "/api/companies/synthetic-two/dimensions");
      expect(response.status).toBe(200);
      expect(response.body.definitions).toMatchObject([{ dimension_id: "project", name: "Projects" }]);
      expect(members.body.members).toMatchObject([{ dimension_id: "project", member_id: "a" }]);
      expect(isolated.body.definitions).toEqual([]);
      const afterDb = openDb(companyPaths(companyRootForSlug(ws, "synthetic-one")).db);
      try { expect(afterDb.query("SELECT count(*) AS n FROM accounting_dimension_definition_events").get()).toEqual(before); } finally { afterDb.close(); }
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });
});
