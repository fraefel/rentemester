import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompany } from "../../src/core/company";
import { openDb } from "../../src/core/db";
import { postJournalEntry } from "../../src/core/ledger";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { openWorkspaceControlReadOnlyDb } from "../../src/core/workspace-control";

function manifest(holding: string, operating: string) {
  return JSON.stringify({ version: 1, groups: [{ id: "synthetic-group", name: "Synthetic group", memberships: [
    { id: "holding-member", companySlug: holding, validFrom: "2026-01-01" },
    { id: "operating-member", companySlug: operating, validFrom: "2026-01-01" },
  ], ownership: [{ id: "holding-owns-operating", parentCompanySlug: holding, childCompanySlug: operating, basisPoints: 10000, evidenceRefs: ["evidence"], validFrom: "2026-01-01" }] }] });
}

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, RENTEMESTER_ACTOR: "" } });
  const stdout = await new Response(proc.stdout).text();
  return { exit: await proc.exited, result: JSON.parse(stdout) as { ok: boolean; errors?: string[]; status?: string; mappingId?: string; mappingHash?: string; eliminationId?: string; payloadHash?: string; profileId?: string; profileHash?: string; consolidatedFigures?: unknown[] | null; rows?: unknown[] } };
}

describe("group CLI workspace-wide authorization", () => {
  test("fails closed until every referenced active company explicitly allowlists the actor", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rentemester-group-cli-"));
    try {
      initWorkspace(workspace);
      const holding = createCompany(workspace, { name: "Holding", onboardingActor: "agent:group-test" });
      const operating = createCompany(workspace, { name: "Operating", onboardingActor: "agent:other" });
      const path = join(workspace, "manifest.json");
      writeFileSync(path, manifest(holding.slug, operating.slug));
      const base = ["group", "apply-manifest", "--workspace", workspace, "--manifest", path, "--policy-company", holding.slug, "--confirm", "yes", "--actor", "agent:group-test", "--format", "json"];
      const denied = await run(base);
      expect(denied.exit).toBe(1);
      expect(denied.result).toMatchObject({ ok: false });
      expect(denied.result.errors?.join(" ")).toContain(operating.slug);

      writeFileSync(join(workspace, operating.slug, "config", "policy.yaml"), "actor_allowlist:\n  agents:\n    - agent:group-test\n");
      const applied = await run(base);
      expect(applied.exit).toBe(0);
      expect(applied.result).toMatchObject({ ok: true, status: "applied" });
      const db = openWorkspaceControlReadOnlyDb(workspace);
      expect(db.query("SELECT count(*) AS count FROM rm_group_manifest_events").get()).toMatchObject({ count: 1 });
      db.close();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }, 15000);

  test("proposes, independently approves and reconciles an explicit mapping", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rentemester-group-mapping-cli-"));
    try {
      initWorkspace(workspace);
      const holding = createCompany(workspace, { name: "Synthetic Holding", onboardingActor: "agent:proposer" });
      const operating = createCompany(workspace, { name: "Synthetic Operating", onboardingActor: "agent:proposer" });
      for (const slug of [holding.slug, operating.slug]) writeFileSync(join(workspace, slug, "config", "policy.yaml"), "actor_allowlist:\n  agents:\n    - agent:proposer\n    - agent:reviewer\n");
      const structurePath = join(workspace, "manifest.json");
      writeFileSync(structurePath, manifest(holding.slug, operating.slug));
      const structure = await run(["group", "apply-manifest", "--workspace", workspace, "--manifest", structurePath, "--policy-company", holding.slug, "--confirm", "yes", "--actor", "agent:proposer", "--format", "json"]);
      expect(structure.exit).toBe(0);
      const mappingPath = join(workspace, "mapping.json");
      writeFileSync(mappingPath, JSON.stringify({ id: "synthetic-reciprocal", groupId: "synthetic-group", leftCompanySlug: holding.slug, rightCompanySlug: operating.slug, leftAccountNos: ["1100"], rightAccountNos: ["7000"], leftPosition: "receivable", rightPosition: "payable", evidenceRefs: ["synthetic-contract"], validFrom: "2026-01-01" }));
      const proposed = await run(["group", "propose-mapping", "--workspace", workspace, "--mapping", mappingPath, "--confirm", "yes", "--actor", "agent:proposer", "--format", "json"]);
      expect(proposed.result).toMatchObject({ ok: true, status: "proposed", mappingId: "synthetic-reciprocal" });
      const selfApproval = await run(["group", "approve-mapping", "--workspace", workspace, "--mapping-id", proposed.result.mappingId!, "--mapping-hash", proposed.result.mappingHash!, "--confirm", "yes", "--actor", "agent:proposer", "--format", "json"]);
      expect(selfApproval.result.errors?.join(" ")).toContain("distinct reviewer");
      const approved = await run(["group", "approve-mapping", "--workspace", workspace, "--mapping-id", proposed.result.mappingId!, "--mapping-hash", proposed.result.mappingHash!, "--confirm", "yes", "--actor", "agent:reviewer", "--format", "json"]);
      expect(approved.result).toMatchObject({ ok: true, status: "approved" });
      for (const [slug, lines] of [[holding.slug, [{ accountNo: "1100", debitAmount: 100 }, { accountNo: "5000", creditAmount: 100 }]], [operating.slug, [{ accountNo: "7000", creditAmount: 100 }, { accountNo: "5000", debitAmount: 100 }]]] as const) {
        const ledger = openDb(companyPaths(companyRootForSlug(workspace, slug)).db);
        expect(postJournalEntry(ledger, { transactionDate: "2026-02-01", text: "Synthetic reciprocal", createdBy: "agent:test", createdByProgram: "unit-test", lines: [...lines] }).ok).toBe(true);
        ledger.close();
      }
      const reconciled = await run(["group", "reconcile", "--workspace", workspace, "--as-of", "2026-12-31", "--format", "json"]);
      expect(reconciled.result).toMatchObject({ ok: true, rows: [{ mappingId: "synthetic-reciprocal", status: "matched", difference: 0 }] });
      const eliminationPath = join(workspace, "elimination.json");
      writeFileSync(eliminationPath, JSON.stringify({ id: "synthetic-elimination", mappingId: "synthetic-reciprocal", asOf: "2026-12-31", evidenceRefs: ["synthetic-review-pack"] }));
      const elimination = await run(["group", "propose-elimination", "--workspace", workspace, "--elimination", eliminationPath, "--confirm", "yes", "--actor", "agent:proposer", "--format", "json"]);
      expect(elimination.result).toMatchObject({ ok: true, status: "proposed" });
      const eliminationApproved = await run(["group", "approve-elimination", "--workspace", workspace, "--elimination-id", elimination.result.eliminationId!, "--payload-hash", elimination.result.payloadHash!, "--confirm", "yes", "--actor", "agent:reviewer", "--format", "json"]);
      expect(eliminationApproved.result).toMatchObject({ ok: true, status: "approved" });
      const eliminationApplied = await run(["group", "apply-elimination", "--workspace", workspace, "--elimination-id", elimination.result.eliminationId!, "--payload-hash", elimination.result.payloadHash!, "--confirm", "yes", "--actor", "agent:reviewer", "--format", "json"]);
      expect(eliminationApplied.result).toMatchObject({ ok: true, status: "applied" });
      const profilePath = join(workspace, "consolidation-profile.json");
      writeFileSync(profilePath, JSON.stringify({ version: 1, id: "synthetic-profile", groupId: "synthetic-group", currency: "DKK", validFrom: "2026-01-01", evidenceRefs: ["synthetic-reporting-policy"], reportingLines: [
        { id: "assets", label: "Assets", section: "asset", displayOrder: 10 }, { id: "liabilities", label: "Liabilities", section: "liability", displayOrder: 20 }, { id: "equity", label: "Equity", section: "equity", displayOrder: 30 }, { id: "current-result", label: "Current result", section: "equity", role: "current-result", displayOrder: 40 }, { id: "income", label: "Income", section: "income", displayOrder: 50 }, { id: "expenses", label: "Expenses", section: "expense", displayOrder: 60 },
      ], accountMappings: [
        { id: "holding-receivable", companySlug: holding.slug, accountNo: "1100", reportingLineId: "assets", validFrom: "2026-01-01" }, { id: "holding-equity", companySlug: holding.slug, accountNo: "5000", reportingLineId: "equity", validFrom: "2026-01-01" }, { id: "operating-payable", companySlug: operating.slug, accountNo: "7000", reportingLineId: "liabilities", validFrom: "2026-01-01" }, { id: "operating-equity", companySlug: operating.slug, accountNo: "5000", reportingLineId: "equity", validFrom: "2026-01-01" },
      ] }));
      const profile = await run(["group", "propose-profile", "--workspace", workspace, "--profile", profilePath, "--confirm", "yes", "--actor", "agent:proposer", "--format", "json"]);
      expect(profile.result).toMatchObject({ ok: true, status: "proposed", profileId: "synthetic-profile" });
      const profileApproved = await run(["group", "approve-profile", "--workspace", workspace, "--profile-id", profile.result.profileId!, "--profile-hash", profile.result.profileHash!, "--confirm", "yes", "--actor", "agent:reviewer", "--format", "json"]);
      expect(profileApproved.result).toMatchObject({ ok: true, status: "approved" });
      const report = await run(["group", "consolidated-report", "--workspace", workspace, "--profile-id", "synthetic-profile", "--from", "2026-01-01", "--as-of", "2026-12-31", "--format", "json"]);
      expect(report.result).toMatchObject({ ok: true, status: "ready" });
      expect(report.result.consolidatedFigures).not.toBeNull();
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }, 30000);
});
