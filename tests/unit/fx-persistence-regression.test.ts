import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportAuthorityPackage } from "../../src/core/authority-export";
import { openDb, migrate } from "../../src/core/db";
import { postJournalEntry, seedAccounts } from "../../src/core/ledger";
import { ensureCompanyDirs } from "../../src/core/paths";

describe("#531 FX persistence — reopen, read, and authority export", () => {
  test("retains the original currency, amount, rate, and DKK amount across every read boundary", () => {
    const companyRoot = mkdtempSync(join(tmpdir(), "rentemester-fx-persistence-"));
    const outputDir = mkdtempSync(join(tmpdir(), "rentemester-fx-export-"));
    try {
      let db = openDb(ensureCompanyDirs(companyRoot).db);
      migrate(db);
      seedAccounts(db);
      const posted = postJournalEntry(db, {
        transactionDate: "2026-05-19",
        text: "EUR software purchase",
        currency: "EUR",
        amountForeign: 100,
        amountDkk: 746,
        fxRateToDkk: 7.46,
        lines: [
          { accountNo: "1100", debitAmount: 746 },
          { accountNo: "2000", creditAmount: 746 },
        ],
      });
      expect(posted.ok).toBe(true);
      db.close();

      // Reopen from disk: no in-memory object may be carrying this evidence.
      db = openDb(ensureCompanyDirs(companyRoot).db);
      migrate(db);
      const stored = db.query(
        "SELECT currency, amount_foreign, fx_rate_to_dkk, amount_dkk FROM journal_entries WHERE id = ?",
      ).get(posted.entryId!) as Record<string, number | string>;
      expect(stored).toEqual({ currency: "EUR", amount_foreign: 100, fx_rate_to_dkk: 7.46, amount_dkk: 746 });

      const exported = exportAuthorityPackage(db, companyRoot, {
        periodStart: "2026-05-01",
        periodEnd: "2026-05-31",
        outputDir,
        generatedAt: "2026-06-01T00:00:00.000Z",
      });
      expect(exported.ok).toBe(true);
      const rows = JSON.parse(readFileSync(join(exported.exportDir!, "machine-readable", "journal-entries.json"), "utf8"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ currency: "EUR", amountForeign: 100, fxRateToDkk: 7.46, amountDkk: 746 });
      const csv = readFileSync(join(exported.exportDir!, "machine-readable", "journal-entries.csv"), "utf8");
      expect(csv.split("\r\n")[0]).toContain("amount_foreign");
      expect(csv.split("\r\n")[0]).toContain("fx_rate_to_dkk");
      expect(csv).toContain(",EUR,100.00,746.00,7.46,");
      db.close();
    } finally {
      rmSync(companyRoot, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
