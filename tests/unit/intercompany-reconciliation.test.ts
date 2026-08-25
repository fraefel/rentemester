import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompany } from "../../src/core/company";
import { openDb } from "../../src/core/db";
import { applyGroupManifest } from "../../src/core/group-manifest";
import {
  approveIntercompanyMapping,
  buildIntercompanyReconciliation,
  parseIntercompanyMapping,
  proposeIntercompanyMapping,
  revokeIntercompanyMapping,
} from "../../src/core/intercompany-reconciliation";
import { postJournalEntry } from "../../src/core/ledger";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "rentemester-intercompany-"));
  initWorkspace(workspace);
  const left = createCompany(workspace, { name: "Synthetic Left", onboardingActor: "agent:test" }).slug;
  const right = createCompany(workspace, { name: "Synthetic Right", onboardingActor: "agent:test" }).slug;
  const control = openWorkspaceControlDb(workspace);
  const manifest = { version: 1, groups: [{ id: "synthetic-group", name: "Synthetic group", memberships: [
    { id: "left-member", companySlug: left, validFrom: "2026-01-01" },
    { id: "right-member", companySlug: right, validFrom: "2026-01-01" },
  ], ownership: [] }] };
  applyGroupManifest(control, workspace, manifest, { createdBy: "agent:structure", createdByProgram: "unit-test" });
  const mapping = { id: "reciprocal-main", groupId: "synthetic-group", leftCompanySlug: left, rightCompanySlug: right, leftAccountNos: ["1100"], rightAccountNos: ["7000"], leftPosition: "receivable", rightPosition: "payable", evidenceRefs: ["synthetic-contract"], validFrom: "2026-01-01" };
  return { workspace, left, right, control, manifest, mapping };
}

function post(workspace: string, slug: string, lines: Array<{ accountNo: string; debitAmount?: number; creditAmount?: number }>) {
  const db = openDb(companyPaths(companyRootForSlug(workspace, slug)).db);
  try {
    const result = postJournalEntry(db, { transactionDate: "2026-02-01", text: "Synthetic reciprocal position", createdBy: "agent:test", createdByProgram: "unit-test", lines });
    expect(result.ok).toBe(true);
  } finally { db.close(); }
}

function approve(control: ReturnType<typeof openWorkspaceControlDb>, workspace: string, mapping: unknown) {
  const proposal = proposeIntercompanyMapping(control, workspace, mapping, { createdBy: "agent:proposer", createdByProgram: "unit-test" });
  return approveIntercompanyMapping(control, workspace, proposal.mappingId, proposal.mappingHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" });
}

/**
 * A completed writer may leave committed frames in a WAL until a later reader
 * happens to checkpoint them. Fold those frames into the main file before the
 * byte-level read-only proof, so reconciliation cannot be blamed for that
 * unrelated deferred checkpoint.
 */
function checkpointLedger(path: string) {
  const db = new Database(path);
  try {
    db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    db.close();
  }
}

describe("append-only intercompany mapping and read-only reconciliation", () => {
  test("requires a distinct reviewer, reconciles exact same-currency balances and leaves both ledgers byte-identical", () => {
    const { workspace, left, right, control, mapping } = setup();
    try {
      post(workspace, left, [{ accountNo: "1100", debitAmount: 1250 }, { accountNo: "5000", creditAmount: 1250 }]);
      post(workspace, right, [{ accountNo: "7000", creditAmount: 1250 }, { accountNo: "5000", debitAmount: 1250 }]);
      const proposal = proposeIntercompanyMapping(control, workspace, mapping, { createdBy: "agent:proposer", createdByProgram: "unit-test" });
      expect(() => approveIntercompanyMapping(control, workspace, proposal.mappingId, proposal.mappingHash, { createdBy: "agent:proposer", createdByProgram: "unit-test" })).toThrow("distinct reviewer");
      approveIntercompanyMapping(control, workspace, proposal.mappingId, proposal.mappingHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" });
      const paths = [left, right].map((slug) => companyPaths(companyRootForSlug(workspace, slug)).db);
      paths.forEach(checkpointLedger);
      const before = paths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"));
      const result = buildIntercompanyReconciliation(control, workspace, new Set([left, right]), "2026-12-31");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ mappingId: "reciprocal-main", status: "matched", difference: 0, left: { balance: 1250, currency: "DKK" }, right: { balance: 1250, currency: "DKK" } });
      expect(result.rows[0]).toHaveProperty("left.sourceRefs.0.entryId");
      expect(paths.map((path) => createHash("sha256").update(readFileSync(path)).digest("hex"))).toEqual(before);
      expect(() => control.run("UPDATE rm_intercompany_mapping_events SET actor='agent:changed'")).toThrow("append-only");
    } finally { control.close(); rmSync(workspace, { recursive: true, force: true }); }
  });

  test("reports an exact mismatch, refuses currency inference and hides both sides from a partial member", () => {
    const { workspace, left, right, control, mapping } = setup();
    try {
      post(workspace, left, [{ accountNo: "1100", debitAmount: 100 }, { accountNo: "5000", creditAmount: 100 }]);
      post(workspace, right, [{ accountNo: "7000", creditAmount: 90 }, { accountNo: "5000", debitAmount: 90 }]);
      approve(control, workspace, mapping);
      expect(buildIntercompanyReconciliation(control, workspace, new Set([left, right]), "2026-12-31").rows[0]).toMatchObject({ status: "mismatch", difference: 10 });
      const rightDb = openDb(companyPaths(companyRootForSlug(workspace, right)).db);
      rightDb.run("UPDATE companies SET currency='EUR' WHERE id=1");
      rightDb.close();
      expect(buildIntercompanyReconciliation(control, workspace, new Set([left, right]), "2026-12-31").rows[0]).toMatchObject({ status: "not-comparable", reason: "currency-mismatch" });
      const partial = buildIntercompanyReconciliation(control, workspace, new Set([left]), "2026-12-31").rows[0]!;
      expect(partial).toEqual({ status: "not-comparable", reason: "blocked", blockers: ["both mapped companies must be visible"] });
      expect(JSON.stringify(partial)).not.toContain(right);
      expect(JSON.stringify(partial)).not.toContain("7000");
    } finally { control.close(); rmSync(workspace, { recursive: true, force: true }); }
  });

  test("validates structure intervals, blocks overlapping accounts and makes revocation effective immediately", () => {
    const { workspace, left, right, control, manifest, mapping } = setup();
    try {
      const samePosition = { ...mapping, rightPosition: "receivable" };
      expect(() => parseIntercompanyMapping(samePosition, manifest as any)).toThrow("complementary");
      approve(control, workspace, mapping);
      const overlap = { ...mapping, id: "overlap", rightAccountNos: ["2100"] };
      const proposed = proposeIntercompanyMapping(control, workspace, overlap, { createdBy: "agent:other", createdByProgram: "unit-test" });
      expect(() => approveIntercompanyMapping(control, workspace, proposed.mappingId, proposed.mappingHash, { createdBy: "agent:reviewer", createdByProgram: "unit-test" })).toThrow("overlapping");
      expect(revokeIntercompanyMapping(control, workspace, mapping.id, { createdBy: "agent:reviewer", createdByProgram: "unit-test" })).toEqual({ mappingId: mapping.id, status: "revoked" });
      expect(buildIntercompanyReconciliation(control, workspace, new Set([left, right]), "2026-12-31").rows).toEqual([]);
    } finally { control.close(); rmSync(workspace, { recursive: true, force: true }); }
  });
});
