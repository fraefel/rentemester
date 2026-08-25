import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompany } from "../../src/core/company";
import { approveBalanceElimination, applyBalanceElimination, buildEliminationOverview, proposeBalanceElimination, readAppliedBalanceEliminations, reverseBalanceElimination } from "../../src/core/consolidation-eliminations";
import { openDb } from "../../src/core/db";
import { applyGroupManifest } from "../../src/core/group-manifest";
import { approveIntercompanyMapping, proposeIntercompanyMapping } from "../../src/core/intercompany-reconciliation";
import { postJournalEntry } from "../../src/core/ledger";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "rentemester-elimination-"));
  initWorkspace(workspace);
  const left = createCompany(workspace, { name: "Synthetic Left", onboardingActor: "agent:test" }).slug;
  const right = createCompany(workspace, { name: "Synthetic Right", onboardingActor: "agent:test" }).slug;
  const control = openWorkspaceControlDb(workspace);
  applyGroupManifest(control, workspace, { version: 1, groups: [{ id: "synthetic-group", name: "Synthetic group", memberships: [
    { id: "left-member", companySlug: left, validFrom: "2026-01-01" }, { id: "right-member", companySlug: right, validFrom: "2026-01-01" },
  ], ownership: [] }] }, { createdBy: "agent:structure", createdByProgram: "unit-test" });
  const proposal = proposeIntercompanyMapping(control, workspace, { id: "reciprocal", groupId: "synthetic-group", leftCompanySlug: left, rightCompanySlug: right, leftAccountNos: ["1100"], rightAccountNos: ["7000"], leftPosition: "receivable", rightPosition: "payable", evidenceRefs: ["synthetic-contract"], validFrom: "2026-01-01" }, { createdBy: "agent:mapping-proposer", createdByProgram: "unit-test" });
  approveIntercompanyMapping(control, workspace, proposal.mappingId, proposal.mappingHash, { createdBy: "agent:mapping-reviewer", createdByProgram: "unit-test" });
  return { workspace, left, right, control };
}

function post(workspace: string, slug: string, amount: number, left: boolean) {
  const db = openDb(companyPaths(companyRootForSlug(workspace, slug)).db);
  try {
    const lines = left ? [{ accountNo: "1100", debitAmount: amount }, { accountNo: "5000", creditAmount: amount }] : [{ accountNo: "7000", creditAmount: amount }, { accountNo: "5000", debitAmount: amount }];
    expect(postJournalEntry(db, { transactionDate: "2026-02-01", text: "Synthetic reciprocal balance", createdBy: "agent:test", createdByProgram: "unit-test", lines }).ok).toBe(true);
  } finally { db.close(); }
}

function checkpointLedger(path: string) {
  const db = new Database(path);
  try {
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    db.close();
  }
}

describe("workspace-only consolidation eliminations", () => {
  test("derives a balanced elimination from matched evidence, requires four eyes, applies and reverses without ledger writes", () => {
    const { workspace, left, right, control } = setup();
    try {
      post(workspace, left, 250, true); post(workspace, right, 250, false);
      const paths = [left, right].map((slug) => companyPaths(companyRootForSlug(workspace, slug)).db);
      paths.forEach(checkpointLedger);
      const before = paths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
      const proposal = proposeBalanceElimination(control, workspace, { id: "eliminate-reciprocal", mappingId: "reciprocal", asOf: "2026-12-31", evidenceRefs: ["review-pack-1"] }, { createdBy: "agent:proposer", createdByProgram: "unit-test" });
      expect(() => approveBalanceElimination(control, workspace, proposal.eliminationId, proposal.payloadHash, { createdBy: "agent:proposer", createdByProgram: "unit-test" })).toThrow("distinct reviewer");
      approveBalanceElimination(control, workspace, proposal.eliminationId, proposal.payloadHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" });
      expect(() => applyBalanceElimination(control, workspace, proposal.eliminationId, proposal.payloadHash, { createdBy: "agent:proposer", createdByProgram: "unit-test" })).toThrow("distinct from the proposer");
      expect(applyBalanceElimination(control, workspace, proposal.eliminationId, proposal.payloadHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" })).toMatchObject({ status: "applied" });
      const applied = readAppliedBalanceEliminations(control, "2026-12-31");
      expect(applied).toHaveLength(1);
      expect(applied[0]).toMatchObject({ payload: { amountOre: "25000", currency: "DKK", left: { companySlug: left, creditOre: "25000" }, right: { companySlug: right, debitOre: "25000" } } });
      const partial = buildEliminationOverview(control, new Set([left]), "2026-12-31");
      expect(partial.rows).toEqual([{ status: "blocked", blockers: ["both elimination companies must be visible"] }]);
      expect(JSON.stringify(partial)).not.toContain(right);
      expect(JSON.stringify(partial)).not.toContain("25000");
      expect(paths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"))).toEqual(before);
      expect(reverseBalanceElimination(control, proposal.eliminationId, proposal.payloadHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" })).toEqual({ eliminationId: proposal.eliminationId, status: "reversed" });
      expect(readAppliedBalanceEliminations(control, "2026-12-31")).toEqual([]);
      expect(() => control.run("DELETE FROM rm_consolidation_elimination_events")).toThrow("append-only");
    } finally { control.close(); rmSync(workspace, { recursive: true, force: true }); }
  });

  test("refuses unmatched balances and invalidates a proposal when source evidence changes", () => {
    const { workspace, left, right, control } = setup();
    try {
      post(workspace, left, 100, true); post(workspace, right, 90, false);
      expect(() => proposeBalanceElimination(control, workspace, { id: "unmatched", mappingId: "reciprocal", asOf: "2026-12-31", evidenceRefs: ["review"] }, { createdBy: "agent:proposer", createdByProgram: "unit-test" })).toThrow("exact matched");
      post(workspace, right, 10, false);
      const proposal = proposeBalanceElimination(control, workspace, { id: "stale", mappingId: "reciprocal", asOf: "2026-12-31", evidenceRefs: ["review"] }, { createdBy: "agent:proposer", createdByProgram: "unit-test" });
      post(workspace, left, 1, true); post(workspace, right, 1, false);
      expect(() => approveBalanceElimination(control, workspace, proposal.eliminationId, proposal.payloadHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" })).toThrow("source snapshot changed");
    } finally { control.close(); rmSync(workspace, { recursive: true, force: true }); }
  });
});
