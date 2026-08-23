import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompany } from "../../src/core/company";
import { applyGroupManifest, getGroupStructureOverview, parseGroupManifest, readCurrentGroupManifest } from "../../src/core/group-manifest";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { initWorkspace, loadWorkspaceManifest, saveWorkspaceManifest } from "../../src/core/workspace";

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "rentemester-group-"));
  initWorkspace(workspace);
  const holding = createCompany(workspace, { name: "Synthetic Holding", onboardingActor: "agent:test" });
  const operating = createCompany(workspace, { name: "Synthetic Operating", onboardingActor: "agent:test" });
  const secondHolding = createCompany(workspace, { name: "Synthetic Second Holding", onboardingActor: "agent:test" });
  return { workspace, holding: holding.slug, operating: operating.slug, secondHolding: secondHolding.slug };
}
function valid(holding: string, operating: string) {
  return { version: 1, groups: [{ id: "synthetic-group", name: "Synthetic group", memberships: [
    { id: "holding-member", companySlug: holding, validFrom: "2026-01-01" },
    { id: "operating-member", companySlug: operating, validFrom: "2026-01-01" },
  ], ownership: [{ id: "holding-owns-operating", parentCompanySlug: holding, childCompanySlug: operating, basisPoints: 10000, evidenceRefs: ["ownership-evidence-b", "ownership-evidence-a"], validFrom: "2026-01-01" }] }] };
}

describe("effective-dated read-only group structure", () => {
  test("stores a canonical append-only manifest chain and never writes a company ledger", () => {
    const { workspace, holding, operating } = setup();
    try {
      const db = openWorkspaceControlDb(workspace);
      const first = applyGroupManifest(db, workspace, valid(holding, operating), { createdBy: "agent:test", createdByProgram: "unit-test" });
      expect(first.status).toBe("applied");
      const reorderedEvidence = valid(holding, operating); reorderedEvidence.groups[0]!.ownership[0]!.evidenceRefs.reverse();
      expect(applyGroupManifest(db, workspace, reorderedEvidence, { createdBy: "agent:test", createdByProgram: "unit-test" })).toEqual({ status: "unchanged", manifestHash: first.manifestHash });
      expect(() => db.run("UPDATE rm_group_manifest_events SET actor = 'changed'")).toThrow("append-only");
      expect(readCurrentGroupManifest(db, workspace)?.manifest.groups[0]?.id).toBe("synthetic-group");
      const overview = getGroupStructureOverview(db, workspace, new Set([holding]), "2026-01-01");
      expect(overview).toMatchObject({ scope: "structure-status-only", consolidationStatus: "not-available", consolidatedFigures: null, rawCompanySums: null, manifestStatus: "blocked" });
      expect(overview.groups[0]).toMatchObject({ partial: true, readiness: "blocked" });
      expect(overview.groups[0]).not.toHaveProperty("id");
      expect(overview.groups[0]).not.toHaveProperty("name");
      expect(overview.groups[0]).not.toHaveProperty("hiddenMembershipCount");
      expect(overview.groups[0]).not.toHaveProperty("hiddenOwnershipCount");
      expect(JSON.stringify(overview)).not.toContain(operating);
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("filters historical/future intervals at an explicit half-open asOf boundary", () => {
    const { workspace, holding, operating } = setup();
    try {
      const db = openWorkspaceControlDb(workspace);
      const manifest = valid(holding, operating);
      manifest.groups[0]!.memberships.forEach((membership) => { membership.validToExclusive = "2026-06-01"; });
      manifest.groups[0]!.ownership[0]!.validToExclusive = "2026-06-01";
      applyGroupManifest(db, workspace, manifest, { createdBy: "agent:test", createdByProgram: "unit-test" });
      expect(getGroupStructureOverview(db, workspace, new Set([holding, operating]), "2025-12-31").groups).toEqual([]);
      expect(getGroupStructureOverview(db, workspace, new Set([holding, operating]), "2026-05-31").groups[0]?.visibleOwnership).toHaveLength(1);
      expect(getGroupStructureOverview(db, workspace, new Set([holding, operating]), "2026-06-01").groups).toEqual([]);
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("blocks active archived members without opening ledgers", () => {
    const { workspace, holding, operating } = setup();
    try {
      const db = openWorkspaceControlDb(workspace);
      applyGroupManifest(db, workspace, valid(holding, operating), { createdBy: "agent:test", createdByProgram: "unit-test" });
      const workspaceManifest = loadWorkspaceManifest(workspace);
      saveWorkspaceManifest(workspace, { ...workspaceManifest, companies: workspaceManifest.companies.map((company) => company.slug === operating ? { ...company, archived: true } : company) });
      const overview = getGroupStructureOverview(db, workspace, new Set([holding, operating]), "2026-01-01");
      expect(overview.groups[0]).toMatchObject({ readiness: "blocked", visibleMemberships: expect.arrayContaining([expect.objectContaining({ companySlug: operating, archived: true })]) });
      expect(overview.groups[0]?.blockers).toContain("one or more active group members are archived");
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("fails closed for invalid dates, unknown entities, overlaps, excessive ownership and cycles", () => {
    const { workspace, holding, operating, secondHolding } = setup();
    try {
      const unknown = valid(holding, operating); unknown.groups[0]!.memberships[1]!.companySlug = "not-registered";
      expect(() => parseGroupManifest(unknown, [holding, operating])).toThrow("unregistered");
      const impossibleDate = valid(holding, operating); impossibleDate.groups[0]!.memberships[0]!.validFrom = "2026-02-30";
      expect(() => parseGroupManifest(impossibleDate, [holding, operating])).toThrow("real ISO date");
      const overlap = valid(holding, operating); overlap.groups[0]!.memberships.push({ id: "other", companySlug: holding, validFrom: "2026-01-01" });
      expect(() => parseGroupManifest(overlap, [holding, operating])).toThrow("only one active membership");
      const uncovered = valid(holding, operating); uncovered.groups[0]!.ownership[0]!.validFrom = "2025-12-31";
      expect(() => parseGroupManifest(uncovered, [holding, operating])).toThrow("fully covered");
      const directOverlap = valid(holding, operating); directOverlap.groups[0]!.ownership.push({ id: "same-direct", parentCompanySlug: holding, childCompanySlug: operating, basisPoints: 1, evidenceRefs: ["other"], validFrom: "2026-01-01" });
      expect(() => parseGroupManifest(directOverlap, [holding, operating])).toThrow("must not overlap");
      const excessive = valid(holding, operating); excessive.groups[0]!.memberships.push({ id: "second-holding", companySlug: secondHolding, validFrom: "2026-01-01" }); excessive.groups[0]!.ownership.push({ id: "second-parent", parentCompanySlug: secondHolding, childCompanySlug: operating, basisPoints: 1, evidenceRefs: ["second"], validFrom: "2026-01-01" });
      expect(() => parseGroupManifest(excessive, [holding, operating, secondHolding])).toThrow("must not exceed");
      const cycle = valid(holding, operating); cycle.groups[0]!.ownership.push({ id: "back", parentCompanySlug: operating, childCompanySlug: holding, basisPoints: 1, evidenceRefs: ["back"], validFrom: "2026-01-01" });
      expect(() => parseGroupManifest(cycle, [holding, operating])).toThrow("effective cycle");
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("treats an absent end as true infinity, including the maximum real date", () => {
    const { workspace, holding, operating } = setup();
    try {
      const duplicateInfinity = valid(holding, operating);
      duplicateInfinity.groups[0]!.memberships.push({ id: "maximum-date", companySlug: holding, validFrom: "9999-12-31" });
      expect(() => parseGroupManifest(duplicateInfinity, [holding, operating])).toThrow("only one active membership");

      const falseCoverage = valid(holding, operating);
      falseCoverage.groups[0]!.memberships[0]!.validToExclusive = "9999-12-31";
      expect(() => parseGroupManifest(falseCoverage, [holding, operating])).toThrow("fully covered");

      const endAtMaximum = valid(holding, operating);
      endAtMaximum.groups[0]!.memberships.forEach((membership) => { membership.validToExclusive = "9999-12-31"; });
      endAtMaximum.groups[0]!.ownership[0]!.validToExclusive = "9999-12-31";
      expect(parseGroupManifest(endAtMaximum, [holding, operating]).groups).toHaveLength(1);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("omits fully hidden and inactive groups, and blocks a missing active ledger without opening it", () => {
    const { workspace, holding, operating } = setup();
    try {
      const db = openWorkspaceControlDb(workspace);
      applyGroupManifest(db, workspace, valid(holding, operating), { createdBy: "agent:test", createdByProgram: "unit-test" });
      const hidden = getGroupStructureOverview(db, workspace, new Set(), "2026-01-01");
      expect(hidden.groups).toEqual([]);
      expect(JSON.stringify(hidden)).not.toContain("Synthetic group");

      rmSync(join(workspace, operating, "data", "ledger.sqlite"));
      const missingLedger = getGroupStructureOverview(db, workspace, new Set([holding, operating]), "2026-01-01");
      expect(missingLedger.groups[0]).toMatchObject({ partial: false, readiness: "blocked" });
      expect(missingLedger.groups[0]?.blockers).toContain("one or more active group members have no available ledger");
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("binds every chain event to actor and timestamp", () => {
    const { workspace, holding, operating } = setup();
    try {
      const db = openWorkspaceControlDb(workspace);
      applyGroupManifest(db, workspace, valid(holding, operating), { createdBy: "agent:test", createdByProgram: "unit-test" });
      db.exec("DROP TRIGGER rm_group_manifest_events_no_update");
      db.run("UPDATE rm_group_manifest_events SET actor = 'agent:other'");
      expect(() => readCurrentGroupManifest(db, workspace)).toThrow("hash-chain");
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
