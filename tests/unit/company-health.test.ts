import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { inspectLedger } from "../../src/core/ledger-inspection";

describe("ledger health inspection", () => {
  test("distinguishes current, pending, missing, and symlink ledgers without writing", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-company-health-"));
    const dbPath = join(root, "ledger.sqlite");
    try {
      const db = openDb(dbPath);
      migrate(db);
      db.close();
      expect(inspectLedger(dbPath)).toMatchObject({ status: "current" });

      const pending = openDb(join(root, "pending.sqlite"));
      migrate(pending);
      pending.run("DELETE FROM schema_migrations WHERE id = (SELECT MAX(id) FROM schema_migrations)");
      pending.close();
      expect(inspectLedger(join(root, "pending.sqlite"))).toMatchObject({ status: "pending", currentVersion: 15, requiredVersion: 16 });

      expect(inspectLedger(join(root, "missing.sqlite"))).toMatchObject({ status: "unavailable" });
      symlinkSync(dbPath, join(root, "linked.sqlite"));
      expect(inspectLedger(join(root, "linked.sqlite"))).toMatchObject({ status: "unavailable" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
