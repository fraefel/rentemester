// Tests: src/core/ledger.ts nextEntryNo + verifyAuditChain tail-truncation
// guard — KODE-12.
//
// Both used a FIXED 5-digit assumption: `substr(entry_no, -5)` and a GLOB of
// exactly five `[0-9]`. Once a fiscal scope exceeds 99 999 entries the numbers
// grow to six digits, at which point the fixed-width GLOB stops matching them
// and `substr(-5)` reads the wrong number — so the next number could collide
// and the tail-truncation guard would falsely report "entries are missing".
// The matcher must be robust to a variable suffix width.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { nextEntryNo, seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { fiscalYearLabelFromDate } from "../../src/core/sequences";
import { issueInvoice } from "../../src/core/issued-invoices";

function freshDb(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  seedAccounts(db);
  return { root, db };
}

// Insert a raw journal row with an arbitrary entry_no width — append-only
// triggers block UPDATE/DELETE, not INSERT, so this models the >99 999-entry
// state without posting a hundred thousand entries.
function insertRawEntry(db: any, entryNo: string, date: string) {
  db.run(
    `INSERT INTO journal_entries (entry_no, transaction_date, text, rule_version, entry_hash)
     VALUES (?, ?, ?, 'test', 'deadbeef')`,
    entryNo,
    date,
    "raw wide-width entry",
  );
}

describe("variable-width entry_no (KODE-12)", () => {
  test("nextEntryNo continues past the 99 999 -> 100 000 width boundary", () => {
    const { root, db } = freshDb("rentemester-entryno-width-");
    const date = "2026-05-15";
    const scope = fiscalYearLabelFromDate(db, date);

    // The fiscal scope already reached a six-digit entry number.
    insertRawEntry(db, `${scope}-100000`, date);
    // The next allocated number must be 100001, not a fixed-width regression to
    // a 5-digit number that re-reads "00000".
    const next = nextEntryNo(db, date);
    expect(next).toBe(`${scope}-100001`);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("the tail-truncation guard reads six-digit suffixes instead of truncating them", () => {
    const { root, db } = freshDb("rentemester-entryno-guard-");
    const date = "2026-05-15";
    const scope = fiscalYearLabelFromDate(db, date);

    // A six-digit highest entry with a sequence value at that same number. The
    // width bug truncated `100001` -> `00001`, so MAX read as 1 (< 100001) and
    // the guard falsely cried "highest journal entry 2026-00001 is below issued
    // sequence value". A width-robust read sees MAX = 100001, so that specific
    // false positive must be gone. (The separate COUNT check still legitimately
    // notes only a handful of rows are physically present — not the bug here.)
    insertRawEntry(db, `${scope}-100000`, date);
    insertRawEntry(db, `${scope}-100001`, date);
    db.run(
      `INSERT INTO sequences (kind, scope, value) VALUES ('journal_entry', ?, 100001)`,
      `cvr-unknown:${scope}`,
    );

    const result = verifyAuditChain(db);
    const highestBelowErrors = result.errors.filter((e) => e.includes("is below issued sequence value"));
    expect(highestBelowErrors).toEqual([]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("auto issued-invoice number continues past the 9 999 -> 10 000 width boundary", () => {
    const { root, db } = freshDb("rentemester-invno-width-");
    const date = "2026-05-16";
    const scope = fiscalYearLabelFromDate(db, date);

    // A prior invoice already pushed the scope to a five-digit number. Model it
    // as a raw issued_invoice documents row (the documents table accepts the
    // insert; only issued invoices are mutation-locked, not insert-locked).
    db.run(
      `INSERT INTO documents (document_no, source, mime_type, sha256_hash, invoice_no, invoice_date, currency, status, document_type)
       VALUES (?, 'rentemester', 'application/json', 'rawhash', ?, ?, 'DKK', 'issued', 'issued_invoice')`,
      `${scope}-10000`,
      `${scope}-10000`,
      date,
    );

    const issued = issueInvoice(db, root, {
      invoiceType: "full",
      vatTreatment: "standard",
      issueDate: date,
      seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      buyer: { name: "Kunde A/S", address: "Købervej 9" },
      lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
      totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
      currency: "DKK",
    });
    expect(issued.errors).toEqual([]);
    expect(issued.ok).toBe(true);
    // The next auto number must be 10001 — a width-blind substr(-4) would have
    // read "0000" and tried to re-issue 0001.
    expect(issued.invoiceNumber).toBe(`${scope}-10001`);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
