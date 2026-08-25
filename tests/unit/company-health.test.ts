import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb } from "../../src/core/db";
import { inspectLedger } from "../../src/core/ledger-inspection";
import { CURRENT_SCHEMA_VERSION } from "../../src/core/schema-version";

function directoryIdentity(root: string): Array<{ name: string; kind: string; sha256?: string }> {
  return readdirSync(root).sort().map((name) => {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (!stat.isFile()) return { name, kind: stat.isSymbolicLink() ? "symlink" : "other" };
    // A read-only SQLite connection may update lock/co-ordination bytes in an
    // existing shared-memory sidecar. Its presence must stay stable; business
    // data lives in the main DB/WAL bytes asserted below.
    if (name.endsWith("-shm")) return { name, kind: "sqlite-shm" };
    return {
      name,
      kind: "file",
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    };
  });
}

describe("strictly read-only ledger health inspection", () => {
  test("distinguishes supported states without changing bytes or sidecars", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-company-health-"));
    const currentPath = join(root, "current.sqlite");
    try {
      const current = openDb(currentPath);
      migrate(current);
      current.run("PRAGMA wal_checkpoint(TRUNCATE)");
      current.close();

      const pendingPath = join(root, "pending.sqlite");
      copyFileSync(currentPath, pendingPath);
      const pending = new Database(pendingPath);
      pending.run("DELETE FROM schema_migrations WHERE id > 10");
      pending.run("PRAGMA wal_checkpoint(TRUNCATE)");
      pending.close();

      const corruptHistoryPath = join(root, "corrupt-history.sqlite");
      copyFileSync(currentPath, corruptHistoryPath);
      const corruptHistory = new Database(corruptHistoryPath);
      corruptHistory.run("UPDATE schema_migrations SET checksum = 'wrong' WHERE id = 1");
      corruptHistory.run("PRAGMA wal_checkpoint(TRUNCATE)");
      corruptHistory.close();

      const newerPath = join(root, "newer.sqlite");
      copyFileSync(currentPath, newerPath);
      const newer = new Database(newerPath);
      newer.query(
        "INSERT INTO schema_migrations(id,name,checksum,applied_by_version) VALUES(?,?,?,?)",
      ).run(CURRENT_SCHEMA_VERSION + 1, "future", "future-checksum", "future");
      newer.run("PRAGMA wal_checkpoint(TRUNCATE)");
      newer.close();

      const corruptFilePath = join(root, "corrupt-file.sqlite");
      writeFileSync(corruptFilePath, "not a sqlite database");
      const symlinkPath = join(root, "linked.sqlite");
      symlinkSync(currentPath, symlinkPath);

      const before = directoryIdentity(root);
      expect(inspectLedger(currentPath)).toMatchObject({
        status: "current",
        currentVersion: CURRENT_SCHEMA_VERSION,
        requiredVersion: CURRENT_SCHEMA_VERSION,
        pending: [],
      });
      expect(inspectLedger(pendingPath)).toMatchObject({
        status: "pending",
        currentVersion: 10,
        requiredVersion: CURRENT_SCHEMA_VERSION,
      });
      expect(inspectLedger(corruptHistoryPath)).toMatchObject({ status: "corrupt" });
      expect(inspectLedger(newerPath)).toMatchObject({
        status: "newer",
        currentVersion: CURRENT_SCHEMA_VERSION + 1,
      });
      expect(inspectLedger(corruptFilePath)).toMatchObject({ status: "corrupt" });
      expect(inspectLedger(join(root, "missing.sqlite"))).toMatchObject({ status: "unavailable" });
      expect(inspectLedger(symlinkPath)).toMatchObject({ status: "unavailable" });
      expect(directoryIdentity(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
