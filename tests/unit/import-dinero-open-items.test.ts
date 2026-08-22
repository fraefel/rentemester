import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { resolveSource } from "../../src/core/import/source";
import { dineroParser } from "../../src/core/import/dinero";
import { runImportFromSource } from "../../src/core/import/framework";
import { getMigrationOpenItems } from "../../src/core/migration-open-items";

const FIXTURE = join(import.meta.dir, "../../examples/import-dinero");

function exportWithReceivable(amount = "24500,000000") {
  const root = mkdtempSync(join(tmpdir(), "rentemester-dinero-open-items-source-"));
  cpSync(FIXTURE, root, { recursive: true });
  writeFileSync(
    join(root, "2025", "SaldoBalance.csv"),
    `Konto;Kontonavn;Beløb\n5520;Tilgodehavender fra salg;${amount}\n`,
  );
  return root;
}

function company() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-dinero-open-items-company-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

describe("Dinero aggregate open-item controls", () => {
  test("parses the latest-year SaldoBalance without claiming item-level evidence", () => {
    const sourceRoot = exportWithReceivable();
    try {
      const parsed = dineroParser.parseSource!(resolveSource(sourceRoot));
      expect(parsed.errors).toEqual([]);
      expect(parsed.source?.openItemControlBalances).toEqual([{
        accountNo: "5520",
        kind: "receivable",
        amount: 24_500,
        sourceReference: "2025/SaldoBalance.csv",
      }]);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  test("previews without mutation, then atomically preserves one unallocated control batch", () => {
    const sourceRoot = exportWithReceivable();
    const c = company();
    try {
      const dry = runImportFromSource(c.db, dineroParser, sourceRoot, {
        createdBy: "agent:test",
        companyRoot: c.root,
        dryRun: true,
      });
      expect(dry).toMatchObject({
        ok: true,
        dryRun: true,
        migrationOpenItems: { batchCount: 1, receivableAmount: 24_500, payableAmount: 0 },
      });
      expect(c.db.query("SELECT COUNT(*) AS count FROM migration_open_item_batches").get()).toEqual({ count: 0 });

      const landed = runImportFromSource(c.db, dineroParser, sourceRoot, {
        createdBy: "agent:test",
        companyRoot: c.root,
      });
      expect(landed).toMatchObject({
        ok: true,
        migrationOpenItems: { batchCount: 1, receivableAmount: 24_500, payableAmount: 0 },
      });
      expect(getMigrationOpenItems(c.db).rows).toEqual([
        expect.objectContaining({
          externalRef: "UNALLOCATED:5520",
          counterpartyName: null,
          issueDate: null,
          openBalance: 24_500,
          sourceKind: "control_balance",
          resolutionStatus: "unallocated",
        }),
      ]);
      expect(verifyAuditChain(c.db).ok).toBe(true);
    } finally {
      c.db.close();
      rmSync(c.root, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });

  test("fails closed and rolls ledger data back when SaldoBalance differs by one øre", () => {
    const sourceRoot = exportWithReceivable("24500,010000");
    const c = company();
    try {
      const landed = runImportFromSource(c.db, dineroParser, sourceRoot, {
        createdBy: "agent:test",
        companyRoot: c.root,
      });
      expect(landed.ok).toBe(false);
      expect(landed.errors.join(" ")).toContain("does not reconcile to the imported ledger in øre");
      expect(c.db.query("SELECT COUNT(*) AS count FROM journal_entries").get()).toEqual({ count: 0 });
      expect(c.db.query("SELECT COUNT(*) AS count FROM migration_open_item_batches").get()).toEqual({ count: 0 });
      expect(c.db.query("SELECT outcome FROM dinero_import_attempts").get()).toEqual({ outcome: "rejected" });
    } finally {
      c.db.close();
      rmSync(c.root, { recursive: true, force: true });
      rmSync(sourceRoot, { recursive: true, force: true });
    }
  });
});
