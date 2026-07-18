import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Creates a real signed backup in a short-lived Bun process. Bun's SQLite
 * statement cache can keep a closed file-backed database alive until process
 * exit on Windows; isolating fixture creation keeps cleanup assertions about
 * the restore code instead of the test runner's own cached statements.
 */
export function createBackupInIsolatedProcess(sourceRoot: string, createdAt: string) {
  const pathsModule = join(import.meta.dir, "../../src/core/paths.ts");
  const dbModule = join(import.meta.dir, "../../src/core/db.ts");
  const backupModule = join(import.meta.dir, "../../src/core/system-backups.ts");
  const probe = [
    `const { ensureCompanyDirs } = await import(${JSON.stringify(pathsModule)});`,
    `const { migrate, openDb } = await import(${JSON.stringify(dbModule)});`,
    `const { createSystemBackup } = await import(${JSON.stringify(backupModule)});`,
    "const sourceRoot = process.argv[1];",
    "const createdAt = process.argv[2];",
    "const db = openDb(ensureCompanyDirs(sourceRoot).db, { journalMode: 'DELETE' });",
    "try {",
    "  migrate(db);",
    "  const backup = createSystemBackup(db, sourceRoot, { createdAt });",
    "  if (!backup.ok || !backup.backupDir) {",
    "    console.error(backup.errors.join('; ') || 'backup fixture failed');",
    "    process.exitCode = 1;",
    "  } else {",
    "    process.stdout.write(JSON.stringify({ backupDir: backup.backupDir }));",
    "  }",
    "} finally {",
    "  db.close();",
    "}",
  ].join("\n");

  const result = spawnSync(process.execPath, ["--eval", probe, sourceRoot, createdAt], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`isolated backup fixture failed (${result.status}): ${result.stderr.trim()}`);
  }
  const parsed = JSON.parse(result.stdout) as { backupDir?: string };
  if (!parsed.backupDir) throw new Error("isolated backup fixture returned no backupDir");
  return parsed.backupDir;
}
