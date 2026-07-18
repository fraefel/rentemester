// Tests: src/core/db.ts — legacy invoice application journal evidence columns.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { getInvoiceStatus } from "../../src/core/invoice-payments";
import { verifyAuditChain } from "../../src/core/ledger";

function createLegacyApplicationTables(db: ReturnType<typeof openDb>) {
  db.exec(`
    CREATE TABLE invoice_payments (
      id INTEGER PRIMARY KEY,
      invoice_document_id INTEGER NOT NULL,
      bank_transaction_id INTEGER,
      payment_date TEXT NOT NULL,
      amount NUMERIC NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL DEFAULT 'DKK',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
      FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
    );
    CREATE TABLE invoice_refunds (
      id INTEGER PRIMARY KEY,
      invoice_document_id INTEGER NOT NULL,
      bank_transaction_id INTEGER,
      refund_date TEXT NOT NULL,
      amount NUMERIC NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL DEFAULT 'DKK',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
      FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
    );
    CREATE TABLE invoice_claim_payments (
      id INTEGER PRIMARY KEY,
      invoice_document_id INTEGER NOT NULL,
      bank_transaction_id INTEGER,
      payment_date TEXT NOT NULL,
      amount NUMERIC NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL DEFAULT 'DKK',
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(invoice_document_id) REFERENCES documents(id),
      FOREIGN KEY(bank_transaction_id) REFERENCES bank_transactions(id)
    );
    INSERT INTO invoice_payments
      (id, invoice_document_id, payment_date, amount, currency, note, created_at)
    VALUES (7, 41, '2026-01-02', 60, 'DKK', 'legacy payment', '2026-01-02 01:02:03');
    INSERT INTO invoice_refunds
      (id, invoice_document_id, refund_date, amount, currency, note, created_at)
    VALUES (8, 41, '2026-01-03', 10, 'DKK', 'legacy refund', '2026-01-03 01:02:03');
    INSERT INTO invoice_claim_payments
      (id, invoice_document_id, payment_date, amount, currency, note, created_at)
    VALUES (9, 41, '2026-01-04', 5, 'DKK', 'legacy claim', '2026-01-04 01:02:03');
  `);
}

function journalColumn(db: ReturnType<typeof openDb>, table: string) {
  const column = (db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
  }>).find((row) => row.name === "journal_entry_id");
  return column ? { name: column.name, notnull: column.notnull } : undefined;
}

describe("invoice journal evidence migration", () => {
  test("preserves unresolved legacy rows, installs nullable links and guards idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-evidence-migration-"));
    const db = openDb(join(root, "ledger.sqlite"));
    try {
      db.exec("PRAGMA foreign_keys = OFF");
      createLegacyApplicationTables(db);

      migrate(db);
      migrate(db);

      db.run(
        `INSERT INTO documents
           (id, source, sha256_hash, invoice_no, invoice_date, amount_inc_vat, currency, status, document_type)
         VALUES (41, 'legacy', 'legacy-invoice-evidence-doc', 'LEGACY-41', '2026-01-01', 100, 'DKK', 'issued', 'issued_invoice')`,
      );
      db.exec("PRAGMA foreign_keys = ON");

      for (const table of ["invoice_payments", "invoice_refunds", "invoice_claim_payments"]) {
        expect(journalColumn(db, table)).toEqual({ name: "journal_entry_id", notnull: 0 });
      }

      expect(db.query(
        `SELECT id, invoice_document_id, payment_date, amount, currency, note, created_at, journal_entry_id
           FROM invoice_payments WHERE id = 7`,
      ).get()).toEqual({
        id: 7,
        invoice_document_id: 41,
        payment_date: "2026-01-02",
        amount: 60,
        currency: "DKK",
        note: "legacy payment",
        created_at: "2026-01-02 01:02:03",
        journal_entry_id: null,
      });
      expect(db.query(
        `SELECT id, invoice_document_id, refund_date, amount, currency, note, created_at, journal_entry_id
           FROM invoice_refunds WHERE id = 8`,
      ).get()).toEqual({
        id: 8,
        invoice_document_id: 41,
        refund_date: "2026-01-03",
        amount: 10,
        currency: "DKK",
        note: "legacy refund",
        created_at: "2026-01-03 01:02:03",
        journal_entry_id: null,
      });
      expect(db.query(
        `SELECT id, invoice_document_id, payment_date, amount, currency, note, created_at, journal_entry_id
           FROM invoice_claim_payments WHERE id = 9`,
      ).get()).toEqual({
        id: 9,
        invoice_document_id: 41,
        payment_date: "2026-01-04",
        amount: 5,
        currency: "DKK",
        note: "legacy claim",
        created_at: "2026-01-04 01:02:03",
        journal_entry_id: null,
      });

      const indexes = db.query(
        `SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_invoice_payments_journal_entry',
              'idx_invoice_refunds_journal_entry',
              'idx_invoice_claim_payments_journal_entry'
            )
          ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual([
        "idx_invoice_claim_payments_journal_entry",
        "idx_invoice_payments_journal_entry",
        "idx_invoice_refunds_journal_entry",
      ]);

      const triggers = db.query(
        `SELECT name FROM sqlite_master
          WHERE type = 'trigger'
            AND name IN (
              'invoice_payments_require_journal',
              'invoice_refunds_require_journal',
              'invoice_claim_payments_require_journal'
            )
          ORDER BY name`,
      ).all() as Array<{ name: string }>;
      expect(triggers.map((row) => row.name)).toEqual([
        "invoice_claim_payments_require_journal",
        "invoice_payments_require_journal",
        "invoice_refunds_require_journal",
      ]);

      expect(() => db.run(
        `INSERT INTO invoice_payments (invoice_document_id, payment_date, amount, currency)
         VALUES (41, '2026-02-01', 1, 'DKK')`,
      )).toThrow("invoice payments must reference a journal entry");
      expect(() => db.run(
        `INSERT INTO invoice_refunds (invoice_document_id, refund_date, amount, currency)
         VALUES (41, '2026-02-01', 1, 'DKK')`,
      )).toThrow("invoice refunds must reference a journal entry");
      expect(() => db.run(
        `INSERT INTO invoice_claim_payments (invoice_document_id, payment_date, amount, currency)
         VALUES (41, '2026-02-01', 1, 'DKK')`,
      )).toThrow("invoice claim payments must reference a journal entry");

      const status = getInvoiceStatus(db, 41);
      expect(status.ok).toBe(false);
      expect(status.errors.filter((error) => error.includes("legacy row unresolved"))).toHaveLength(3);

      const audit = verifyAuditChain(db);
      expect(audit.ok).toBe(false);
      expect(audit.errors.filter((error) => error.includes("legacy row unresolved")).length).toBeGreaterThanOrEqual(3);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fresh schema requires journal links at table level", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoice-evidence-fresh-"));
    const db = openDb(join(root, "ledger.sqlite"));
    try {
      migrate(db);
      for (const table of ["invoice_payments", "invoice_refunds", "invoice_claim_payments"]) {
        expect(journalColumn(db, table)).toEqual({ name: "journal_entry_id", notnull: 1 });
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
