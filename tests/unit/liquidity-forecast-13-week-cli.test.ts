import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createCompany } from "../../src/core/company";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";

test("budget forecast-13-week is read-only and resolves a workspace slug", () => {
  const root = mkdtempSync(join(tmpdir(), "rm-liquidity-cli-"));
  try {
    initWorkspace(root);
    const company = createCompany(root, { name: "Synthetic Liquidity" });
    const path = companyPaths(companyRootForSlug(root, company.slug)).db;
    const before = createHash("sha256").update(readFileSync(path)).digest("hex");
    const child = Bun.spawnSync(["bun", "run", "src/cli.ts", "budget", "forecast-13-week", "--company", company.slug, "--start", "2026-01-01", "--json"], { cwd: process.cwd(), env: { ...process.env, RENTEMESTER_WORKSPACE: root } });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toMatchObject({ ok: true, startDate: "2026-01-01" });
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
