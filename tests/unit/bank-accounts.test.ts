// Tests: src/core/bank.ts (bank accounts as a first-class entity, #187)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { addBankAccount, listBankAccounts, importBankCsv, resolveBankAccount, updateBankAccount } from "../../src/core/bank";
import { listBankTransactions, buildBankReconciliationReport } from "../../src/core/reconciliation";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-bankacct-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

function writeCsv(root: string, name: string, lines: string[]) {
  const path = join(root, name);
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("bank accounts (#187)", () => {
  test("adds a bank account and lists it", () => {
    const { root, db } = setup();
    const result = addBankAccount(db, { name: "Driftskonto DKK", bankName: "Danske Bank" });
    expect(result.ok).toBe(true);
    expect(result.account?.slug).toBe("driftskonto-dkk");
    expect(result.account?.currency).toBe("DKK");

    const listed = listBankAccounts(db);
    expect(listed.count).toBe(1);
    expect(listed.accounts[0].name).toBe("Driftskonto DKK");

    expect(resolveBankAccount(db, "driftskonto-dkk")?.id).toBe(result.account!.id);
    expect(resolveBankAccount(db, result.account!.id)?.slug).toBe("driftskonto-dkk");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects duplicate slugs", () => {
    const { root, db } = setup();
    expect(addBankAccount(db, { name: "Drift" }).ok).toBe(true);
    const dup = addBankAccount(db, { name: "Drift" });
    expect(dup.ok).toBe(false);
    expect(dup.errors.some((e) => e.includes("already exists"))).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("migrates and round-trips the non-secret payment profile losslessly", () => {
    const { root, db } = setup();
    const created = addBankAccount(db, { name: "Drift", iban: "DK5000400440116243", bic: "DABADKKK", accountOwner: "Acme ApS", customerNo: "C-42" });
    expect(created.ok).toBe(true);
    const updated = updateBankAccount(db, { idOrSlug: created.account!.slug, bic: "DABADKKKXXX", accountOwner: "Acme Holding ApS", customerNo: "C-43" });
    expect(updated.ok).toBe(true);
    expect(resolveBankAccount(db, created.account!.id)).toMatchObject({ bic: "DABADKKKXXX", accountOwner: "Acme Holding ApS", customerNo: "C-43", iban: "DK5000400440116243" });
    migrate(db); // guarded ALTERs and replacement trigger remain idempotent.
    expect(resolveBankAccount(db, created.account!.id)?.customerNo).toBe("C-43");
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("migrate upgrades a pre-payment-profile bank_accounts fixture without changing immutable schema.sql", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bankacct-legacy-"));
    const db = openDb(join(root, "legacy.db"));
    db.exec(`CREATE TABLE bank_accounts (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      bank_name TEXT, registration_no TEXT, account_no TEXT, iban TEXT,
      currency TEXT NOT NULL DEFAULT 'DKK', ledger_account_no TEXT,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
    db.run("INSERT INTO bank_accounts (slug, name, iban) VALUES (?, ?, ?)", "legacy", "Legacy account", "DK5000400440116243");

    migrate(db);
    const updated = updateBankAccount(db, {
      idOrSlug: "legacy", bic: "DABADKKK", accountOwner: "Legacy ApS", customerNo: "C-99",
    });
    expect(updated.ok).toBe(true);
    migrate(db);
    expect(resolveBankAccount(db, "legacy")).toMatchObject({
      iban: "DK5000400440116243", bic: "DABADKKK", accountOwner: "Legacy ApS", customerNo: "C-99",
    });
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("importing into two accounts keeps rows separated", () => {
    const { root, db } = setup();
    const drift = addBankAccount(db, { name: "Drift" }).account!;
    const opspar = addBankAccount(db, { name: "Opsparing" }).account!;

    const csv = writeCsv(root, "tx.csv", [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-16,Card payment,-1250,DKK,REF-1",
    ]);

    const a = importBankCsv(db, root, csv, { account: drift.id });
    const b = importBankCsv(db, root, csv, { account: opspar.slug });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.imported).toBe(1);
    // Identical transaction in a DIFFERENT account is not a duplicate.
    expect(b.imported).toBe(1);
    expect(b.skippedDuplicates).toBe(0);

    const driftRows = listBankTransactions(db, { bankAccountId: drift.id });
    const opsparRows = listBankTransactions(db, { bankAccountId: opspar.id });
    expect(driftRows.count).toBe(1);
    expect(opsparRows.count).toBe(1);
    expect(driftRows.rows[0].bankAccountId).toBe(drift.id);
    expect(opsparRows.rows[0].bankAccountId).toBe(opspar.id);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("re-import into the same account is still deduplicated", () => {
    const { root, db } = setup();
    const drift = addBankAccount(db, { name: "Drift" }).account!;
    const csv = writeCsv(root, "tx.csv", [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-16,Card payment,-1250,DKK,REF-1",
    ]);
    expect(importBankCsv(db, root, csv, { account: drift.id }).imported).toBe(1);
    const second = importBankCsv(db, root, csv, { account: drift.id });
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(1);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects imports into an inactive bank account before reading the CSV", () => {
    const { root, db } = setup();
    const account = addBankAccount(db, { name: "Closed account" }).account!;
    expect(updateBankAccount(db, { idOrSlug: account.id, active: false }).ok).toBe(true);
    const result = importBankCsv(db, root, join(root, "missing.csv"), { account: account.slug });
    expect(result).toMatchObject({ ok: false });
    expect(result.errors.join(" ")).toContain("inactive and cannot receive imports");
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("--account filter scopes list and reconcile bank", () => {
    const { root, db } = setup();
    const drift = addBankAccount(db, { name: "Drift" }).account!;
    const opspar = addBankAccount(db, { name: "Opsparing" }).account!;
    importBankCsv(db, root, writeCsv(root, "d.csv", [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-16,Drift payment,-1250,DKK,D-1",
    ]), { account: drift.id });
    importBankCsv(db, root, writeCsv(root, "o.csv", [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-17,2026-05-17,Opspar deposit,500,DKK,O-1",
    ]), { account: opspar.id });

    expect(listBankTransactions(db, {}).count).toBe(2);
    expect(listBankTransactions(db, { bankAccountId: drift.id }).count).toBe(1);

    const report = buildBankReconciliationReport(db, "2026-05-01", "2026-05-31", { bankAccountId: opspar.id });
    expect(report.unmatchedCount).toBe(1);
    expect(report.unmatched[0].text).toBe("Opspar deposit");
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("import rejects an unknown account", () => {
    const { root, db } = setup();
    const csv = writeCsv(root, "tx.csv", [
      "transaction_date,booking_date,text,amount,currency,reference",
      "2026-05-16,2026-05-16,Card payment,-1250,DKK,REF-1",
    ]);
    const result = importBankCsv(db, root, csv, { account: "no-such-account" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("does not exist"))).toBe(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
