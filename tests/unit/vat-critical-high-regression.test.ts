import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { seedAccounts, postJournalEntry } from "../../src/core/ledger";
import { createTrustedHistoricalImportProvenance } from "../../src/core/import-provenance";
import { buildVatReport } from "../../src/core/vat";
import { buildVatFiling } from "../../src/core/vat-filing";
import { closeAccountingPeriod } from "../../src/core/periods";
import { vatRubrikkerForPeriod } from "../../src/server/data/vat";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-vat-critical-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

test("historical import alone may use an account default; manual JSON provenance cannot", () => {
  const { root, db } = freshDb();
  const trusted = postJournalEntry(db, {
    transactionDate: "2026-05-01", text: "trusted import", importedHistorical: true,
    historicalImportProvenance: createTrustedHistoricalImportProvenance(),
    lines: [{ accountNo: "3000", debitAmount: 100 }, { accountNo: "2000", creditAmount: 100 }],
  });
  expect(trusted.ok).toBe(true);
  expect((db.query("SELECT vat_code FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.account_no = '3000'").get() as { vat_code: string }).vat_code).toBe("DK_PURCHASE_25");

  const forged = postJournalEntry(db, {
    transactionDate: "2026-05-02", text: "manual JSON", importedHistorical: true,
    historicalImportProvenance: JSON.parse("{}"),
    lines: [{ accountNo: "3000", debitAmount: 50 }, { accountNo: "2000", creditAmount: 50 }],
  });
  expect(forged.ok).toBe(true);
  const report = buildVatReport(db, "2026-05-01", "2026-05-31");
  expect(report.ok).toBe(false);
  expect(report.errors.join(" ")).toContain("no explicit vat_code");
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("Dinero VAT accounts are recognised while account number 1200 is not inferred as VAT", () => {
  const { root, db } = freshDb();
  db.run("INSERT INTO accounts (account_no,name,type,normal_balance,default_vat_code) VALUES ('64000','Dinero output','liability','credit',NULL),('64040','Dinero reverse','liability','credit',NULL),('64060','Dinero input','liability','debit',NULL)");
  for (const [accountNo, debitAmount, creditAmount] of [["64000", 0, 25], ["64040", 0, 25], ["64060", 20, 0]] as const) {
    const posted = postJournalEntry(db, { transactionDate: "2026-05-03", text: accountNo, lines: [debitAmount ? { accountNo: "2000", creditAmount: debitAmount } : { accountNo: "2000", debitAmount: creditAmount }, debitAmount ? { accountNo, debitAmount } : { accountNo, creditAmount }] });
    expect(posted.errors).toEqual([]);
    expect(posted.ok).toBe(true);
  }
  db.run("UPDATE accounts SET type = 'income', name = 'Imported income 1200' WHERE account_no = '1200'");
  expect(postJournalEntry(db, { transactionDate: "2026-05-04", text: "not VAT", importedHistorical: true, lines: [{ accountNo: "2000", debitAmount: 99 }, { accountNo: "1200", creditAmount: 99 }] }).ok).toBe(true);
  const report = buildVatReport(db, "2026-05-01", "2026-05-31");
  expect(report.outputVat).toBe(50);
  expect(report.inputVat).toBe(20);
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("cadence-neutral VAT periods file with the same shared rubric as cockpit", () => {
  const { root, db } = freshDb();
  expect(postJournalEntry(db, { transactionDate: "2026-06-01", text: "sale", importedHistorical: true, lines: [{ accountNo: "2000", debitAmount: 125 }, { accountNo: "1000", creditAmount: 100, vatCode: "DK_SALE_25" }, { accountNo: "1200", creditAmount: 25 }] }).ok).toBe(true);
  expect(closeAccountingPeriod(db, { periodStart: "2026-06-01", periodEnd: "2026-06-30", kind: "vat_period", force: true }).ok).toBe(true);
  const filing = buildVatFiling(db, "2026-06-01", "2026-06-30");
  expect(filing.ok).toBe(true);
  expect(filing.filingDeadline).toBe("2026-09-01");
  expect(buildVatReport(db, "2026-06-01", "2026-06-30").rubrikker).toEqual(filing.rubrikker);
  expect(filing.rubrikker).toEqual(vatRubrikkerForPeriod(db, "2026-06-01", "2026-06-30"));
  db.close(); rmSync(root, { recursive: true, force: true });
});

test("legacy VAT-period migration preserves ids and fails closed on filed overlaps", () => {
  const root = mkdtempSync(join(tmpdir(), "rentemester-vat-legacy-"));
  const db = openDb(ensureCompanyDirs(root).db);
  const legacySchema = readFileSync(join(import.meta.dir, "../../src/core/schema.sql"), "utf8")
    .replace("('vat_period','vat_quarter','fiscal_year','custom')", "('vat_quarter','fiscal_year','custom')");
  db.exec(legacySchema);
  db.run("INSERT INTO accounting_periods (id,period_start,period_end,kind,status,reference) VALUES (41,'2026-01-01','2026-03-31','vat_quarter','closed','legacy')");
  migrate(db);
  expect(db.query("SELECT id, kind, status, reference FROM accounting_periods").get()).toEqual({ id: 41, kind: "vat_period", status: "closed", reference: "legacy" });
  db.close(); rmSync(root, { recursive: true, force: true });

  const conflictRoot = mkdtempSync(join(tmpdir(), "rentemester-vat-legacy-conflict-"));
  const conflictDb = openDb(ensureCompanyDirs(conflictRoot).db);
  conflictDb.exec(legacySchema);
  conflictDb.run("INSERT INTO accounting_periods (period_start,period_end,kind,status) VALUES ('2026-01-01','2026-03-31','vat_quarter','reported'),('2026-03-01','2026-04-30','vat_quarter','reported')");
  expect(() => migrate(conflictDb)).toThrow("reported legacy periods");
  conflictDb.close(); rmSync(conflictRoot, { recursive: true, force: true });
});
