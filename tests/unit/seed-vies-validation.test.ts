// Tests: scripts/seed-vies-validation.ts (unsafe offline fixture boundary)
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialiseCompanyVolume } from "../../src/core/company";
import { openDb, migrate } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";

const SEED = resolve(fileURLToPath(new URL("../../scripts/seed-vies-validation.ts", import.meta.url)));
const roots: string[] = [];

function disposableRoot(prefix = "rentemester-smoke-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  initialiseCompanyVolume(root);
  return root;
}

async function seed(root: string, acknowledgement?: string) {
  const args = ["bun", SEED, root, "DE123456789"];
  if (acknowledgement) args.push(acknowledgement);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
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

describe("offline VIES seed boundary", () => {
  test("writes fresh evidence only to an acknowledged synthetic smoke ledger", async () => {
    const root = disposableRoot();
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(0);

    const db = openDb(companyPaths(root).db);
    try {
      migrate(db);
      const row = db.query("SELECT validated_at, expires_at FROM vies_validations WHERE vat_number = '123456789'").get() as { validated_at: string; expires_at: string };
      expect(Date.parse(row.validated_at)).toBeGreaterThan(Date.now() - 60_000);
      expect(Date.parse(row.expires_at)).toBeGreaterThan(Date.now());
    } finally {
      db.close();
    }
  });

  test("fails closed without the unsafe-demo acknowledgement", async () => {
    const result = await seed(disposableRoot());
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--unsafe-demo");
  });

  test("rejects an arbitrary company root", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-unrelated-"));
    roots.push(root);
    initialiseCompanyVolume(root);
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("disposable");
  });

  test("rejects a symlink even when it points at a disposable ledger", async () => {
    const target = disposableRoot();
    const link = join(tmpdir(), `rentemester-smoke-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    symlinkSync(target, link);
    roots.push(link);
    const result = await seed(link, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("symlink");
  });

  test("rejects a production-like ledger identity in a smoke-named directory", async () => {
    const root = disposableRoot();
    const db = openDb(companyPaths(root).db);
    try {
      db.run("UPDATE companies SET name = ?, cvr = ? WHERE id = 1", ["Production ApS", "DK12345678"]);
    } finally {
      db.close();
    }
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ledger identity");
  });
});
