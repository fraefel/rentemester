import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, RENTEMESTER_COMPANY: "" },
  });
  return { stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text(), exitCode: await proc.exited };
}

describe("system healthcheck CLI contract", () => {
  test("emits a stable JSON inspection without mutating a current ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-health-cli-"));
    const company = join(root, "company");
    try {
      expect((await run(["init", "--company", company])).exitCode).toBe(0);
      const result = await run(["system", "healthcheck", "--company", company, "--json"]);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout) as { ok: boolean; schema_outdated: boolean; schema: { status: string; currentVersion: number; requiredVersion: number; pending: unknown[] } };
      expect(body.ok).toBe(true);
      expect(body.schema_outdated).toBe(false);
      expect(body.schema).toMatchObject({ status: "current", pending: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects non-exact migration apply values before company access", async () => {
    const result = await run(["system", "migrate", "--company", "/definitely/not/a/company", "--apply", "true"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--apply must be exactly yes");
  });
});
