// Tests: src/cli/efaktura.ts, src/cli/invoice/issuance.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function runCli(args: string[]) {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  return { exitCode: await process.exited, stdout, stderr };
}

describe("Digisense CLI safety gates", () => {
  test("configuration requires confirmation and writes no secret without it", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-digisense-cli-config-"));
    const company = join(root, "company");
    try {
      expect((await runCli(["init", "--company", company])).exitCode).toBe(0);
      const result = await runCli([
        "efaktura", "konfigurer", "--company", company,
        "--api-license-key", "must-not-be-written",
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).errors.join(" ")).toContain("--confirm yes");
      expect(existsSync(join(company, "config", "digisense.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("live send and queued-status resume reject before network access without confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-digisense-cli-send-"));
    const company = join(root, "company");
    try {
      expect((await runCli(["init", "--company", company])).exitCode).toBe(0);
      for (const args of [
        ["invoice", "transmit-digisense", "--company", company, "--document-id", "1"],
        ["efaktura", "status", "--company", company, "--document-id", "1"],
      ]) {
        const result = await runCli(args);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout).errors.join(" ")).toContain("--confirm yes");
        expect(result.stderr).toBe("");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
