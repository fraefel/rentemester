import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { companyPaths } from "../../src/core/paths";
import { CURRENT_SCHEMA_VERSION } from "../../src/core/schema-version";

const ACTOR_ENV_KEYS = [
  "USER",
  "LOGNAME",
  "USERNAME",
  "RENTEMESTER_ACTOR",
  "RENTEMESTER_AGENT",
  "RENTEMESTER_USER",
  "OPENCLAW_AGENT",
] as const;

function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const key of ACTOR_ENV_KEYS) env[key] = "";
  return { ...env, ...extra };
}

async function run(args: string[], env: Record<string, string> = isolatedEnv()) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
    exitCode: await proc.exited,
  };
}

function ledgerIdentity(company: string) {
  const dbPath = companyPaths(company).db;
  const dataDir = dirname(dbPath);
  return {
    entries: readdirSync(dataDir).sort(),
    sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
  };
}

function makePending(company: string, version = 10): void {
  const db = new Database(companyPaths(company).db);
  db.run("DELETE FROM schema_migrations WHERE id > ?", [version]);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

describe("system healthcheck and explicit migration CLI contract", () => {
  test("healthcheck and migration plan report pending schema without changing the ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-health-cli-"));
    const company = join(root, "company");
    try {
      expect((await run(["init", "--company", company], isolatedEnv({ USER: "tester" }))).exitCode).toBe(0);
      makePending(company);
      const before = ledgerIdentity(company);

      const health = await run(["system", "healthcheck", "--company", company, "--json"]);
      expect(health.exitCode).toBe(1);
      expect(JSON.parse(health.stdout)).toMatchObject({
        ok: false,
        schema_outdated: true,
        schema: { status: "pending", currentVersion: 10, requiredVersion: CURRENT_SCHEMA_VERSION },
      });
      expect(ledgerIdentity(company)).toEqual(before);

      const plan = await run(["system", "migrate", "--company", company, "--json"]);
      expect(plan.exitCode).toBe(0);
      expect(JSON.parse(plan.stdout)).toMatchObject({
        ok: true,
        action: "migration_required",
        wouldMigrate: true,
        schema_outdated: true,
        schema: { status: "pending", currentVersion: 10, requiredVersion: CURRENT_SCHEMA_VERSION },
      });
      expect(ledgerIdentity(company)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only exact --apply yes mutates and records the canonical actor", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-migrate-cli-"));
    const company = join(root, "company");
    try {
      const actorEnv = isolatedEnv({ USER: "tester" });
      expect((await run(["init", "--company", company], actorEnv)).exitCode).toBe(0);
      makePending(company);

      const rejectedBefore = ledgerIdentity(company);
      const noActor = await run(["system", "migrate", "--company", company, "--apply", "yes"]);
      expect(noActor.exitCode).toBe(2);
      expect(noActor.stderr).toContain("actor required for mutations");
      expect(ledgerIdentity(company)).toEqual(rejectedBefore);

      const applied = await run([
        "system", "migrate", "--company", company, "--apply=yes", "--actor", "user:tester",
      ], actorEnv);
      expect(applied.exitCode).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        ok: true,
        migrated: true,
        from: 10,
        to: CURRENT_SCHEMA_VERSION,
        schema: { status: "current" },
      });

      const db = new Database(companyPaths(company).db, { readonly: true });
      const audit = db.query(
        "SELECT event_type, actor FROM audit_log WHERE event_type = 'schema_migrated' ORDER BY id",
      ).all();
      db.close();
      expect(audit).toEqual([
        { event_type: "schema_migrated", actor: "user:tester via rentemester-cli" },
      ]);

      const currentBefore = ledgerIdentity(company);
      const repeated = await run([
        "system", "migrate", "--company", company, "--apply", "yes", "--actor", "user:tester",
      ], actorEnv);
      expect(repeated.exitCode).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({ ok: true, migrated: false });
      expect(ledgerIdentity(company)).toEqual(currentBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare and non-exact apply values fail before company access", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-migrate-values-"));
    const missingCompany = join(root, "must-not-be-created");
    try {
      for (const suffix of [
        ["--apply"],
        ["--apply", "no"],
        ["--apply", "true"],
        ["--apply", "1"],
        ["--apply", "YES"],
        ["--apply", ""],
      ]) {
        const result = await run(["system", "migrate", "--company", missingCompany, ...suffix]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("--apply");
        expect(existsSync(missingCompany)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid schema states fail under the apply lock without writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-migrate-invalid-"));
    const company = join(root, "company");
    try {
      const actorEnv = isolatedEnv({ USER: "tester" });
      expect((await run(["init", "--company", company], actorEnv)).exitCode).toBe(0);
      const db = new Database(companyPaths(company).db);
      db.run("UPDATE schema_migrations SET checksum = 'wrong' WHERE id = 1");
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      const before = ledgerIdentity(company);

      const result = await run([
        "system", "migrate", "--company", company, "--apply", "yes", "--actor", "user:tester",
      ], actorEnv);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        schema: { status: "corrupt" },
      });
      expect(ledgerIdentity(company)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
