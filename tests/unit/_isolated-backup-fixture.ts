import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { createSystemBackup } from "../../src/core/system-backups";

// Fixture creation takes 5–8 seconds on GitHub's native Windows runner. Bun's
// default per-test timeout is 5 seconds and kills dangling child processes, so
// every test that uses this process boundary must opt into a realistic budget.
export const ISOLATED_BACKUP_TIMEOUT_MS = 30_000;

/**
 * Creates a real signed backup in a short-lived Bun process. Bun's SQLite
 * statement cache can keep a closed file-backed database alive until process
 * exit on Windows; isolating fixture creation keeps cleanup assertions about
 * the restore code instead of the test runner's own cached statements.
 */
export function createBackupInIsolatedProcess(sourceRoot: string, createdAt: string) {
  // Use Bun's native subprocess API and execute this file as a script. A real
  // worker file avoids --eval quoting and preserves explicit exit diagnostics.
  const result = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, sourceRoot, createdAt],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = result.stderr.toString().trim();
  if (!result.success) {
    const signal = result.signalCode ? `, signal ${result.signalCode}` : "";
    throw new Error(`isolated backup fixture failed (exit ${result.exitCode}${signal}): ${stderr}`);
  }
  const parsed = JSON.parse(result.stdout.toString()) as { backupDir?: string };
  if (!parsed.backupDir) throw new Error("isolated backup fixture returned no backupDir");
  return parsed.backupDir;
}

function runBackupWorker() {
  const sourceRoot = process.argv[2];
  const createdAt = process.argv[3];
  if (!sourceRoot || !createdAt) throw new Error("isolated backup fixture requires sourceRoot and createdAt");

  const db = openDb(ensureCompanyDirs(sourceRoot).db, { journalMode: "DELETE" });
  try {
    migrate(db);
    const backup = createSystemBackup(db, sourceRoot, { createdAt });
    if (!backup.ok || !backup.backupDir) {
      throw new Error(backup.errors.join("; ") || "backup fixture failed");
    }
    process.stdout.write(JSON.stringify({ backupDir: backup.backupDir }));
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    runBackupWorker();
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}
