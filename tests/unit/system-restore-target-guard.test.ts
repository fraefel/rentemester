// Tests: src/core/system-restore.ts — KODE-8.
//
// On the final atomic swap, restore did `rmSync(target, { recursive: true })`
// whenever the target path existed but held no ledger db. A target directory
// that is NON-EMPTY but ledger-less (e.g. the user pointed restore at a
// directory holding unrelated files) would be recursively wiped. Restore must
// refuse to recursively delete a non-empty, ledger-less target unless the
// caller explicitly opts in; an empty placeholder dir is still fine.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { createSystemBackup } from "../../src/core/system-backups";
import { restoreSystemBackup } from "../../src/core/system-restore";

function makeBackup(prefix: string) {
  const sourceRoot = mkdtempSync(join(tmpdir(), `${prefix}-src-`));
  const paths = ensureCompanyDirs(sourceRoot);
  const db = openDb(paths.db, { journalMode: "DELETE" });
  migrate(db);
  const backup = createSystemBackup(db, sourceRoot, { createdAt: "2026-05-17T02:09:00.000Z" });
  db.close();
  expect(backup.ok).toBe(true);
  return { sourceRoot, backupDir: backup.backupDir! };
}

describe("restore target guard (KODE-8)", () => {
  test("refuses to recursively wipe a non-empty, ledger-less target directory", () => {
    const { sourceRoot, backupDir } = makeBackup("rentemester-restore-guard");

    // The target exists, has NO ledger db, but DOES contain unrelated files the
    // user would not want recursively deleted.
    const target = mkdtempSync(join(tmpdir(), "rentemester-restore-guard-target-"));
    const precious = join(target, "precious.txt");
    mkdirSync(join(target, "subdir"), { recursive: true });
    writeFileSync(precious, "do not delete me\n");

    const result = restoreSystemBackup({ backupDir, targetCompanyRoot: target });

    // Restore must fail rather than clobber the directory...
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ").toLowerCase()).toMatch(/not empty|non-empty|empty/);
    // ...and the user's files must be untouched.
    expect(existsSync(precious)).toBe(true);
    expect(readFileSync(precious, "utf8")).toBe("do not delete me\n");

    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  test("an empty target directory still restores cleanly", () => {
    const { sourceRoot, backupDir } = makeBackup("rentemester-restore-guard-empty");
    const target = mkdtempSync(join(tmpdir(), "rentemester-restore-guard-empty-target-"));

    const result = restoreSystemBackup({ backupDir, targetCompanyRoot: target });
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "data", "ledger.sqlite"))).toBe(true);

    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  test("a non-existent target path restores cleanly (created fresh)", () => {
    const { sourceRoot, backupDir } = makeBackup("rentemester-restore-guard-new");
    const parent = mkdtempSync(join(tmpdir(), "rentemester-restore-guard-new-parent-"));
    const target = join(parent, "company");

    const result = restoreSystemBackup({ backupDir, targetCompanyRoot: target });
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, "data", "ledger.sqlite"))).toBe(true);

    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  });
});
