// Tests: scripts/seed-vies-validation.ts (unsafe offline fixture boundary)
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initialiseCompanyVolume } from "../../src/core/company";
import { openDb, migrate } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";

const SEED = resolve(fileURLToPath(new URL("../../scripts/seed-vies-validation.ts", import.meta.url)));
const DEMO_VIES_MARKER_FILENAME = ".rentemester-agent-demo-vies-seed-v1.json";
const roots: string[] = [];

function markDemoLedger(root: string) {
  const canonicalRoot = realpathSync(root);
  const ledger = lstatSync(companyPaths(canonicalRoot).db);
  const marker = join(canonicalRoot, DEMO_VIES_MARKER_FILENAME);
  const db = openDb(companyPaths(canonicalRoot).db);
  let auditTrailSha256: string;
  try {
    const auditRows = db.query(
      "SELECT id, event_type, entity_type, entity_id, message, actor FROM audit_log ORDER BY id",
    ).all();
    auditTrailSha256 = createHash("sha256").update(JSON.stringify(auditRows)).digest("hex");
  } finally {
    db.close();
  }
  writeFileSync(marker, `${JSON.stringify({
    format: "rentemester-agent-demo-vies-seed/v1",
    purpose: "offline-vies-seed",
    companyRoot: canonicalRoot,
    ledger: { dev: ledger.dev, ino: ledger.ino },
    auditTrailSha256,
    nonce: crypto.randomUUID(),
  })}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(marker, 0o400);
}

function disposableRoot(prefix = "rentemester-smoke-", marked = true) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  initialiseCompanyVolume(root);
  if (marked) markDemoLedger(root);
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

  test("rejects an otherwise fresh synthetic ledger without the explicit demo marker", async () => {
    const result = await seed(disposableRoot("rentemester-smoke-", false), "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("demo marker");
  });

  test("rejects a marker that does not bind the current ledger identity", async () => {
    const root = disposableRoot();
    const marker = join(root, DEMO_VIES_MARKER_FILENAME);
    chmodSync(marker, 0o600);
    const parsed = JSON.parse(readFileSync(marker, "utf8")) as any;
    parsed.ledger.ino += 1;
    writeFileSync(marker, `${JSON.stringify(parsed)}\n`);
    chmodSync(marker, 0o400);
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("does not bind");
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

  test("rejects a symlinked inner data directory", async () => {
    const root = disposableRoot();
    const outside = mkdtempSync(join(tmpdir(), "rentemester-vies-outside-"));
    roots.push(outside);
    const data = companyPaths(root).data;
    renameSync(data, `${data}-original`);
    symlinkSync(outside, data);
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("data directory");
    expect(result.stderr).toContain("symlink");
  });

  test("rejects a symlinked ledger file", async () => {
    const root = disposableRoot();
    const outside = join(mkdtempSync(join(tmpdir(), "rentemester-vies-outside-")), "ledger.sqlite");
    roots.push(resolve(outside, ".."));
    const ledger = companyPaths(root).db;
    renameSync(ledger, `${ledger}-original`);
    symlinkSync(`${ledger}-original`, ledger);
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ledger file");
    expect(result.stderr).toContain("symlink");
  });

  test("rejects a hard-linked ledger file", async () => {
    const root = disposableRoot();
    const hardLink = join(tmpdir(), `rentemester-vies-hard-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    linkSync(companyPaths(root).db, hardLink);
    roots.push(hardLink);
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("hard links");
  });

  test("rejects a wrong ledger identity in a smoke-named directory", async () => {
    const root = disposableRoot();
    const db = openDb(companyPaths(root).db);
    try {
      db.run("UPDATE companies SET name = ? WHERE id = 1", ["Different synthetic company"]);
    } finally {
      db.close();
    }
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ledger identity");
  });

  test("rejects a registered or otherwise active ledger in a smoke-named directory", async () => {
    const root = disposableRoot();
    const db = openDb(companyPaths(root).db);
    try {
      db.run("UPDATE companies SET cvr = ? WHERE id = 1", ["12345678"]);
    } finally {
      db.close();
    }
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("ledger identity");
  });

  test("rejects a marked, default-identity ledger with a bank transaction", async () => {
    const root = disposableRoot();
    const db = openDb(companyPaths(root).db);
    try {
      db.run(
        "INSERT INTO bank_transactions (transaction_date, text, amount, transaction_hash) VALUES (?, ?, ?, ?)",
        ["2026-01-02", "real-looking payment", -100, "unsafe-demo-activity-bank-transaction"],
      );
    } finally {
      db.close();
    }
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("business activity in bank_transactions");
  });

  test("rejects a marked, default-identity ledger with a non-init audit event", async () => {
    const root = disposableRoot();
    const db = openDb(companyPaths(root).db);
    try {
      db.run("INSERT INTO audit_log (event_type, entity_type, message) VALUES (?, ?, ?)", [
        "bank_import", "bank_transaction", "real-looking activity",
      ]);
    } finally {
      db.close();
    }
    const result = await seed(root, "--unsafe-demo");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("init audit trail");
  });
});
