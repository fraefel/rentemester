// Tests: package smoke preflight must seed offline VIES before business state.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPOSITORY = resolve(import.meta.dir, "../..");
const roots: string[] = [];

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", ...args], {
    cwd: REPOSITORY,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { exitCode: proc.exitCode, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("offline VIES smoke preflight", () => {
  test("package smoke prepares and seeds before its first business mutation", () => {
    const pkg = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { scripts: { smoke: string } };
    const smoke = pkg.scripts.smoke;
    const init = smoke.indexOf("src/cli.ts init --company /tmp/rentemester-smoke");
    const prepare = smoke.indexOf("scripts/prepare-offline-vies-demo.ts /tmp/rentemester-smoke");
    const seed = smoke.indexOf("scripts/seed-vies-validation.ts /tmp/rentemester-smoke DE123456789 --unsafe-demo");
    const firstBusinessMutation = smoke.indexOf("src/cli.ts documents ingest --company /tmp/rentemester-smoke");
    expect(init).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(init);
    expect(seed).toBeGreaterThan(prepare);
    expect(firstBusinessMutation).toBeGreaterThan(seed);
    expect(smoke.lastIndexOf("scripts/seed-vies-validation.ts")).toBe(seed);
  });

  test("the smoke preflight accepts the shared marker, then rejects reseeding after business data", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-smoke-contract-"));
    roots.push(root);

    expect((await run(["run", "src/cli.ts", "init", "--company", root])).exitCode).toBe(0);
    expect((await run(["run", "scripts/prepare-offline-vies-demo.ts", root])).exitCode).toBe(0);
    expect((await run(["run", "scripts/seed-vies-validation.ts", root, "DE123456789", "--unsafe-demo"])).exitCode).toBe(0);
    expect((await run([
      "run", "src/cli.ts", "bank", "import", "--company", root,
      "--file", "examples/bank-transactions.csv",
    ])).exitCode).toBe(0);

    const reseed = await run(["run", "scripts/seed-vies-validation.ts", root, "DE123456789", "--unsafe-demo"]);
    expect(reseed.exitCode).toBe(2);
    expect(reseed.stderr).toContain("business activity in bank_transactions");
  });
});
