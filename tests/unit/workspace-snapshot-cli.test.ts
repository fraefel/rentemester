import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompany } from "../../src/core/company";
import { initWorkspace } from "../../src/core/workspace";

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: process.env,
  });
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    exitCode: await proc.exited,
  };
}

describe("workspace snapshot CLI", () => {
  test("requires confirmation before reading a workspace or writing an artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-workspace-snapshot-cli-gate-"));
    const out = join(root, "must-not-exist.tar");
    try {
      const result = await run([
        "workspace", "snapshot", "--workspace", join(root, "missing"), "--out", out,
        "--actor", "agent:codex", "--json",
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
      expect(existsSync(out)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("creates and restores one portable artifact through the public CLI contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-workspace-snapshot-cli-"));
    const workspace = join(root, "source");
    const snapshot = join(root, "workspace.tar");
    const target = join(root, "target");
    try {
      initWorkspace(workspace);
      createCompany(workspace, { name: "Alpha Company", onboardingActor: "agent:codex" });
      createCompany(workspace, { name: "Beta Company", onboardingActor: "agent:codex" });
      const created = await run([
        "workspace", "snapshot", "--workspace", workspace, "--out", snapshot,
        "--at", "2026-08-23T13:00:00.000Z", "--confirm", "yes",
        "--actor", "agent:codex", "--json",
      ]);
      expect(created.exitCode).toBe(0);
      expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, companyCount: 2 });
      const restored = await run([
        "workspace", "restore", "--snapshot", snapshot, "--target-workspace", target,
        "--confirm", "yes", "--actor", "agent:codex", "--json",
      ]);
      expect(restored.exitCode).toBe(0);
      expect(JSON.parse(restored.stdout)).toMatchObject({
        ok: true, companyCount: 2, nextStep: "bootstrap-owner-then-reinvite",
      });
      expect(existsSync(join(target, "alpha-company", "data", "ledger.sqlite"))).toBe(true);
      expect(existsSync(join(target, "beta-company", "data", "ledger.sqlite"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
