// Critical import-integrity regressions for #540/#541.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/core/db";
import { dineroParser } from "../../src/core/import/dinero";
import { runImportFromSource } from "../../src/core/import/framework";
import { syntheticCsvParser } from "../../src/core/import/synthetic-csv";
import { ensureCompanyDirs } from "../../src/core/paths";
import { seedAccounts } from "../../src/core/ledger";

const DINERO_FIXTURE = join(import.meta.dir, "../../examples/import-dinero");

function freshCompany(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

describe("import archive integrity (#540/#541)", () => {
  test("fails closed when ZIP extraction reports a checksum failure, before posting", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "rentemester-import-integrity-src-"));
    const zipDir = mkdtempSync(join(tmpdir(), "rentemester-import-integrity-zip-"));
    const zipPath = join(zipDir, "source.zip");
    const { root, db } = freshCompany("rentemester-import-integrity-db-");
    try {
      writeFileSync(
        join(sourceDir, "import.csv"),
        "# source: synthetic-csv\n# cutOverDate: 2025-01-01\nsection,accountNo,name,debit,credit\naccount,2000,Bank,,\naccount,5000,Egenkapital,,\nopening,2000,,80000,\nopening,5000,,,80000\n",
      );
      expect(spawnSync("zip", ["-0", "-q", "-r", zipPath, "."], { cwd: sourceDir }).status).toBe(0);
      const bytes = readFileSync(zipPath);
      const needle = Buffer.from("80000");
      const offset = bytes.indexOf(needle);
      expect(offset).toBeGreaterThanOrEqual(0);
      bytes[offset] = "9".charCodeAt(0);
      writeFileSync(zipPath, bytes);

      const result = runImportFromSource(db, syntheticCsvParser, zipPath, { createdBy: "user:tester" });
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("unzip failed");
      expect((db.query("SELECT COUNT(*) AS count FROM journal_entries").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(zipDir, { recursive: true, force: true });
    }
  });

  test("blocks a nonzero roll-forward difference before archive or ledger mutation", () => {
    const exportDir = mkdtempSync(join(tmpdir(), "rentemester-roll-forward-integrity-"));
    const { root, db } = freshCompany("rentemester-roll-forward-db-");
    try {
      cpSync(DINERO_FIXTURE, exportDir, { recursive: true });
      writeFileSync(
        join(exportDir, "2024", "SaldoBalance.csv"),
        [
          "Konto;Kontonavn;Beløb",
          "5500;Driftsmidler;65000,00",
          "5510;Bankkonto;99999,00",
          "5520;Tilgodehavender fra salg;42000,00",
          "55000;Skyldig moms;-31000,00",
          "55010;Anden gæld;-12000,00",
          "60000;Registreret kapital mv.;-40000,00",
          "60010;Overført resultat fra tidligere år;-87200,50",
          "60040;Udbytte;-25000,00",
          "",
        ].join("\n"),
      );

      const result = runImportFromSource(db, dineroParser, exportDir, { createdBy: "user:tester" });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain(
        "roll-forward integrity failure: account 5510 2024->2025 closing 99999 != opening 88200.5",
      );
      expect((db.query("SELECT COUNT(*) AS count FROM journal_entries").get() as { count: number }).count).toBe(0);
      expect((db.query("SELECT COUNT(*) AS count FROM import_archive_years").get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(exportDir, { recursive: true, force: true });
    }
  });
});
