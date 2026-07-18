import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeThenCleanup, retryTransientCleanup } from "../../src/core/fs-cleanup";
import { resolveManifestPath } from "../../src/core/system-restore";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { createSystemBackup } from "../../src/core/system-backups";
import { restoreSystemBackup } from "../../src/core/system-restore";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("Windows filesystem safety", () => {
  test("contains Windows separator paths under drive and UNC backup roots", () => {
    expect(resolveManifestPath("C:\\backups\\backup-1", "data/ledger.sqlite"))
      .toBe("C:\\backups\\backup-1\\data\\ledger.sqlite");
    expect(resolveManifestPath("\\\\server\\share\\backups\\backup-1", "config\\settings.json"))
      .toBe("\\\\server\\share\\backups\\backup-1\\config\\settings.json");
  });

  test("rejects traversal, drive and UNC manifest paths", () => {
    const root = "C:\\backups\\backup-1";
    expect(resolveManifestPath(root, "..\\other\\ledger.sqlite")).toBeNull();
    expect(resolveManifestPath(root, "..//other/ledger.sqlite")).toBeNull();
    expect(resolveManifestPath(root, "D:\\other\\ledger.sqlite")).toBeNull();
    expect(resolveManifestPath(root, "\\\\server\\share\\other\\ledger.sqlite")).toBeNull();
  });

  test("rejects a manifest file symlink that escapes the backup root", () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "rentemester-restore-symlink-src-"));
    const targetRoot = mkdtempSync(join(tmpdir(), "rentemester-restore-symlink-target-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "rentemester-restore-symlink-outside-"));
    try {
      const paths = ensureCompanyDirs(sourceRoot);
      const db = openDb(paths.db);
      migrate(db);
      const backup = createSystemBackup(db, sourceRoot, { createdAt: "2026-07-18T00:00:00.000Z" });
      db.close();
      const outsideLedger = join(outsideRoot, "ledger.sqlite");
      copyFileSync(join(backup.backupDir!, "ledger.sqlite"), outsideLedger);
      rmSync(join(backup.backupDir!, "ledger.sqlite"));
      symlinkSync(outsideLedger, join(backup.backupDir!, "ledger.sqlite"));

      const restored = restoreSystemBackup({ backupDir: backup.backupDir!, targetCompanyRoot: targetRoot });
      expect(restored.ok).toBe(false);
      expect(restored.errors.join(" ")).toContain("through symlink");
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("retries only transient Windows cleanup failures with bounded backoff", () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = retryTransientCleanup(() => {
      attempts += 1;
      if (attempts < 3) throw errno("EBUSY");
      return "removed";
    }, { sleep: (delay) => delays.push(delay) });
    expect(result).toBe("removed");
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 25]);
  });

  test("does not swallow retry exhaustion or permanent cleanup failures", () => {
    let busyAttempts = 0;
    expect(() => retryTransientCleanup(() => {
      busyAttempts += 1;
      throw errno("EPERM");
    }, { maxAttempts: 2, sleep: () => {} })).toThrow("EPERM");
    expect(busyAttempts).toBe(2);
    let permanentAttempts = 0;
    expect(() => retryTransientCleanup(() => {
      permanentAttempts += 1;
      throw errno("EACCES");
    }, { sleep: () => {} })).toThrow("EACCES");
    expect(permanentAttempts).toBe(1);
  });

  test("closes SQLite-like resources before cleanup", () => {
    const events: string[] = [];
    closeThenCleanup({ close: () => events.push("close") }, () => events.push("delete"));
    expect(events).toEqual(["close", "delete"]);
  });
});
