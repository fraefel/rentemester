import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCompany } from "../../src/core/company";
import { initWorkspace, loadWorkspaceManifest, saveWorkspaceManifest } from "../../src/core/workspace";
import { pollWorkspaceDigisenseInbound } from "../../src/core/efaktura/digisense-workspace";
import { companyPaths } from "../../src/core/paths";
import { openDb } from "../../src/core/db";
import { configureBackupLock } from "../../src/core/backup-governance";

const actor = { createdBy: "agent:test", createdByProgram: "unit-test" };

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-digisense-workspace-"));
  initWorkspace(root);
  return root;
}

describe("workspace DigiSense inbound governance", () => {
  test("skips archived companies and continues after one company poll fails", async () => {
    const root = workspace();
    try {
      createCompany(root, { slug: "alpha", name: "Alpha ApS", cvr: "DK12345678", onboardingActor: actor.createdBy });
      createCompany(root, { slug: "beta", name: "Beta ApS", cvr: "DK87654321", onboardingActor: actor.createdBy });
      createCompany(root, { slug: "archive", name: "Archive ApS", cvr: "DK11111111", onboardingActor: actor.createdBy });
      const manifest = loadWorkspaceManifest(root);
      manifest.companies.find((entry) => entry.slug === "archive")!.archived = true;
      saveWorkspaceManifest(root, manifest);
      const seen: string[] = [];
      const result = await pollWorkspaceDigisenseInbound(root, { actor, async pollCompany(_db, companyRoot) {
        const slug = companyRoot.split("/").at(-1)!;
        seen.push(slug);
        if (slug === "alpha") throw new Error("synthetic failure");
        return { ok: true, documentsIngested: 2 };
      } });
      expect(seen.sort()).toEqual(["alpha", "beta"]);
      expect(result.companies.find((entry) => entry.slug === "alpha")?.status).toBe("failed");
      expect(result.companies.find((entry) => entry.slug === "beta")?.documentsIngested).toBe(2);
      expect(result.companies.find((entry) => entry.slug === "archive")?.reason).toBe("archived");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects an unauthorized later target before polling any company", async () => {
    const root = workspace();
    try {
      createCompany(root, { slug: "allowed", name: "Allowed ApS", cvr: "DK12345678", onboardingActor: actor.createdBy });
      createCompany(root, { slug: "denied", name: "Denied ApS", cvr: "DK87654321", onboardingActor: "agent:someone-else" });
      let calls = 0;
      await expect(pollWorkspaceDigisenseInbound(root, { actor, async pollCompany() { calls += 1; return { ok: true, documentsIngested: 0 }; } })).rejects.toThrow("denied");
      expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects an overdue backup lock before polling any company", async () => {
    const root = workspace();
    try {
      const first = createCompany(root, { slug: "first", name: "First ApS", cvr: "DK12345678", onboardingActor: actor.createdBy });
      const locked = createCompany(root, { slug: "locked", name: "Locked ApS", cvr: "DK87654321", onboardingActor: actor.createdBy });
      const db = openDb(companyPaths(locked.companyRoot).db);
      db.run("INSERT INTO bank_transactions (transaction_date, booking_date, text, amount, currency, reference, import_batch_id, source_file_hash, transaction_hash) VALUES (?, ?, 'Activity', 500, 'DKK', 'late', 'batch-late', 'hash-late', 'tx-late')", "2020-01-01", "2020-01-01");
      configureBackupLock(db, locked.companyRoot, { enforced: true, graceDays: 0, actor: actor.createdBy });
      db.close();
      const firstDbBefore = readFileSync(companyPaths(first.companyRoot).db);
      const firstDataFilesBefore = readdirSync(companyPaths(first.companyRoot).data).sort();
      let calls = 0;
      await expect(pollWorkspaceDigisenseInbound(root, { actor, async pollCompany() { calls += 1; return { ok: true, documentsIngested: 0 }; } })).rejects.toThrow("locked");
      expect(calls).toBe(0);
      expect(readFileSync(companyPaths(first.companyRoot).db)).toEqual(firstDbBefore);
      expect(readdirSync(companyPaths(first.companyRoot).data).sort()).toEqual(firstDataFilesBefore);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects a non-canonical actor before polling even without an allowlist", async () => {
    const root = workspace();
    try {
      createCompany(root, { slug: "legacy", name: "Legacy ApS", cvr: "DK12345678", onboardingActor: actor.createdBy });
      let calls = 0;
      await expect(pollWorkspaceDigisenseInbound(root, {
        actor: { createdBy: "not-canonical", createdByProgram: "unit-test" },
        async pollCompany() { calls += 1; return { ok: true, documentsIngested: 0 }; },
      })).rejects.toThrow("canonical actor");
      expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("fails closed when backup status cannot be evaluated", async () => {
    const root = workspace();
    try {
      const broken = createCompany(root, { slug: "broken", name: "Broken ApS", cvr: "DK12345678", onboardingActor: actor.createdBy });
      const db = openDb(companyPaths(broken.companyRoot).db);
      db.run("DROP TABLE journal_entries");
      db.close();
      let calls = 0;
      await expect(pollWorkspaceDigisenseInbound(root, {
        actor,
        async pollCompany() { calls += 1; return { ok: true, documentsIngested: 0 }; },
      })).rejects.toThrow("broken");
      expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
