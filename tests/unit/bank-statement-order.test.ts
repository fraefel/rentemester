import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { importBankCsv } from "../../src/core/bank";
import { actualBankBalanceAsOf, resolveActualBankBalanceAsOf } from "../../src/server/data/bank";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-statement-order-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

const header = "date,text,amount,currency,balance_after";

describe("authoritative bank statement order (#596)", () => {
  test("uses persisted descending source order for a same-date closing balance and replays unchanged", () => {
    const { root, db } = setup();
    const source = join(root, "reverse.csv");
    // Common newest-first export: row one is the statement closing row.
    writeFileSync(source, [header,
      "2026-08-31,final,100.00,DKK,1000.00",
      "2026-08-31,middle,100.00,DKK,900.00",
      "2026-08-31,opening,100.00,DKK,800.00",
    ].join("\n"));
    const first = importBankCsv(db, root, source, { statementOrder: "descending" });
    expect(first).toMatchObject({ ok: true, imported: 3 });
    const resolution = resolveActualBankBalanceAsOf(db, "2026-08-31");
    expect(resolution.status).toBe("known");
    expect(resolution.balance).toBe(1000);
    expect(resolution.provenance).toEqual([expect.objectContaining({ sourceOrder: "descending", transactionDate: "2026-08-31" })]);
    expect(actualBankBalanceAsOf(db, "2026-08-31")).toBe(1000);
    const replay = importBankCsv(db, root, source, { statementOrder: "ascending" });
    expect(replay).toMatchObject({ ok: true, imported: 0, skippedDuplicates: 3 });
    expect(resolveActualBankBalanceAsOf(db, "2026-08-31").balance).toBe(1000);
    expect(() => db.run("UPDATE bank_transactions SET statement_order='ascending' WHERE id=1")).toThrow("immutable");
    db.close(); rmSync(root, { recursive: true, force: true });
  });

  test("supports ascending metadata and fails closed for an unknown same-date chain or inconsistent balances", () => {
    const { root, db } = setup();
    const source = join(root, "ascending.csv");
    writeFileSync(source, [header,
      "2026-08-30,opening,100.00,DKK,800.00",
      "2026-08-30,middle,100.00,DKK,900.00",
      "2026-08-30,final,100.00,DKK,1000.00",
    ].join("\n"));
    expect(importBankCsv(db, root, source, { statementOrder: "ascending" }).ok).toBe(true);
    expect(resolveActualBankBalanceAsOf(db, "2026-08-30")).toMatchObject({ status: "known", balance: 1000 });
    db.run("INSERT INTO bank_transactions(transaction_date,text,amount,currency,balance_after,transaction_hash) VALUES('2026-08-31','unknown A',1,'DKK',1001,'u-a')");
    db.run("INSERT INTO bank_transactions(transaction_date,text,amount,currency,balance_after,transaction_hash) VALUES('2026-08-31','unknown B',1,'DKK',1002,'u-b')");
    const ambiguous = resolveActualBankBalanceAsOf(db, "2026-08-31");
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.balance).toBeNull();
    expect(ambiguous.diagnostics.join(" ")).toContain("ambiguous statement order");
    db.close(); rmSync(root, { recursive: true, force: true });
  });
});
