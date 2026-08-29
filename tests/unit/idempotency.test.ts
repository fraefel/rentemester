import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeLocalIdempotentMutation, IdempotencyError, canonicalPayloadHash, pruneExpiredIdempotencyOutcomes } from "../../src/core/idempotency";
import { migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntryInCurrentTransaction } from "../../src/core/ledger";
import { ensureCompanyDirs } from "../../src/core/paths";
import { ingestDocument } from "../../src/core/documents";
import { importBankCsv } from "../../src/core/bank";
import { registerPayable, registerPayableInCurrentTransaction, payPayableFromBankInCurrentTransaction } from "../../src/core/payables";
import { bookExpenseFromBankInCurrentTransaction } from "../../src/core/expense-booking";

const actor = { createdBy: "agent:synthetic", createdByProgram: "test" };
const input = (key: string, payload: Record<string, unknown>, execute: () => unknown, principal = { kind: "service-account" as const, subjectId: "svc-a" }, now = new Date("2026-01-01T00:00:00.000Z")) =>
  ({ key, operation: "journal_post" as const, workspaceScope: "workspace-a", companyScope: "company-a", principal, payload, actor, execute, now });

/** A deliberately tiny, on-disk fixture: the same SQLite shape production handlers use. */
function payableFixture(label: string, amount = 100) {
  const company = mkdtempSync(join(tmpdir(), `rentemester-idempotency-${label}-`));
  const db = openCompany(company);
  const source = join(company, "source.txt");
  writeFileSync(source, `synthetic invoice ${label}`);
  const document = ingestDocument(db, company, source, {
    source: "email", issueDate: "2026-01-10", invoiceNo: `INV-${label}`,
    deliveryDescription: "synthetic service", amountIncVat: amount, currency: "DKK",
    sender: { name: "Synthetic supplier", address: "Road 1", vatOrCvr: "DK11223344" },
    recipient: { name: "Synthetic buyer", address: "Road 2", vatOrCvr: "DK12345678" },
    vatAmount: 0, paymentDetails: "bank",
  });
  expect(document.ok).toBe(true);
  return { company, db, documentId: document.documentId! };
}
function openCompany(company: string) {
  const db = new Database(ensureCompanyDirs(company).db);
  migrate(db); seedAccounts(db); return db;
}
function count(db: Database, table: string) { return Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n); }
function registerInput(documentId: number) { return { documentId, billDate: "2026-01-10", dueDate: "2026-02-10", expenseAccountNo: "3000", vatTreatment: "exempt" as const, ...actor }; }
function idem<T>(db: Database, operation: "expense_book" | "payable_register" | "payable_pay", key: string, payload: Record<string, unknown>, execute: () => T, principal = { kind: "service-account" as const, subjectId: "svc-a" }) {
  return executeLocalIdempotentMutation(db, { key, operation, principal, payload, actor, execute });
}

describe("#583 local idempotency tombstones", () => {
  test("canonical payload replay is principal-scoped, not actor- or credential-scoped", () => {
    const db = new Database(":memory:"); migrate(db); let calls = 0;
    const first = executeLocalIdempotentMutation(db, input("key-1", { b: 2, a: 1 }, () => ({ ok: true, value: ++calls })));
    const replay = executeLocalIdempotentMutation(db, { ...input("key-1", { a: 1, b: 2 }, () => ({ ok: true, value: ++calls })), workspaceScope: "/moved/workspace", companyScope: "/moved/workspace/company", actor: { createdBy: "agent:rotated-token", createdByProgram: "other" } });
    expect(canonicalPayloadHash({ a: 1, b: 2 })).toBe(canonicalPayloadHash({ b: 2, a: 1 }));
    expect(replay.result).toEqual(first.result); expect(replay.receipt?.replayed).toBe(true); expect(calls).toBe(1);
    const separate = executeLocalIdempotentMutation(db, input("key-1", { a: 1, b: 2 }, () => ({ ok: true, value: ++calls }), { kind: "service-account", subjectId: "svc-b" }));
    expect(separate.receipt?.replayed).toBe(false); expect(calls).toBe(2); db.close();
  });
  test("conflict, unauthenticated key, rollback and expiry all fail closed", () => {
    const db = new Database(":memory:"); migrate(db);
    executeLocalIdempotentMutation(db, input("key-2", { amount: 10 }, () => ({ ok: true })));
    expect(() => executeLocalIdempotentMutation(db, input("key-2", { amount: 11 }, () => ({ ok: true })))).toThrow("idempotency key was already used");
    expect(() => executeLocalIdempotentMutation(db, { ...input("key-x", {}, () => ({ ok: true })), principal: undefined })).toThrow("authenticated user");
    const crash = () => { db.query("INSERT INTO accounts (account_no,name,type,normal_balance,active) VALUES ('9999','x','asset','debit',1)").run(); throw new Error("fault"); };
    expect(() => executeLocalIdempotentMutation(db, input("crash", {}, crash))).toThrow("fault");
    expect(db.query("SELECT COUNT(*) AS n FROM mutation_idempotency_tombstones WHERE operation = 'journal_post'").get()).toEqual({ n: 1 });
    pruneExpiredIdempotencyOutcomes(db, new Date("2026-02-01T00:00:00.000Z"));
    expect(() => executeLocalIdempotentMutation(db, { ...input("key-2", { amount: 10 }, () => ({ ok: true })), now: new Date("2026-02-01T00:00:00.000Z") })).toThrow("outcome has expired");
    expect(() => executeLocalIdempotentMutation(db, { ...input("key-2", { amount: 12 }, () => ({ ok: true })), now: new Date("2026-02-01T00:00:00.000Z") })).toThrow("different validated payload");
    db.close();
  });

  test("does not poison a key on a result-shaped business rejection and audits original, replay, conflict and expired outcomes", () => {
    const db = new Database(":memory:"); migrate(db); let effects = 0;
    const rejected = executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 1 }, () => ({ ok: false, errors: ["business precondition"] })));
    expect(rejected).toEqual({ result: { ok: false, errors: ["business precondition"] } });
    expect(db.query("SELECT COUNT(*) AS n FROM mutation_idempotency_tombstones").get()).toEqual({ n: 0 });
    const accepted = executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 1 }, () => ({ ok: true, effect: ++effects })));
    expect(accepted.receipt?.replayed).toBe(false);
    executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 1 }, () => ({ ok: true, effect: ++effects })));
    expect(() => executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 2 }, () => ({ ok: true })))).toThrow(IdempotencyError);
    pruneExpiredIdempotencyOutcomes(db, new Date("2026-02-01T00:00:00.000Z"));
    expect(() => executeLocalIdempotentMutation(db, { ...input("retryable-rejection", { amount: 1 }, () => ({ ok: true })), now: new Date("2026-02-01T00:00:00.000Z") })).toThrow("outcome has expired");
    const events = (db.query("SELECT event_type FROM audit_log WHERE event_type LIKE 'idempotency_%' ORDER BY id").all() as Array<{ event_type: string }>).map((row) => row.event_type);
    expect(events).toEqual(["idempotency_original", "idempotency_replay", "idempotency_conflict", "idempotency_outcome_expired"]);
    expect(effects).toBe(1); db.close();
  });

  test("keeps the singleton and tombstone immutable while pruning only replay material", () => {
    const db = new Database(":memory:"); migrate(db);
    executeLocalIdempotentMutation(db, input("immutable", { amount: 1 }, () => ({ ok: true })));
    expect(() => db.exec("UPDATE ledger_identity SET ledger_uuid = lower(hex(randomblob(16))) WHERE id = 1")).toThrow("ledger identity is immutable");
    expect(() => db.exec("DELETE FROM mutation_idempotency_tombstones")).toThrow("idempotency tombstones are append-only");
    expect(pruneExpiredIdempotencyOutcomes(db, new Date("2026-02-01T00:00:00.000Z"))).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM mutation_idempotency_tombstones").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM mutation_idempotency_outcomes").get()).toEqual({ n: 0 });
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutation_idempotency_receipts'").get()).toBeNull();
    db.close();
  });

  test("replays one real journal post without duplicate ledger effects", () => {
    const db = new Database(":memory:"); migrate(db); seedAccounts(db);
    const execute = () => postJournalEntryInCurrentTransaction(db, {
      transactionDate: "2026-05-18", text: "synthetic idempotent journal",
      createdBy: actor.createdBy, createdByProgram: actor.createdByProgram,
      lines: [{ accountNo: "2000", debitAmount: 100 }, { accountNo: "5000", creditAmount: 100 }],
    });
    const first = executeLocalIdempotentMutation(db, input("real-journal", { transactionDate: "2026-05-18", text: "synthetic idempotent journal", lines: [{ accountNo: "2000", debitAmount: 100 }, { accountNo: "5000", creditAmount: 100 }] }, execute));
    const replay = executeLocalIdempotentMutation(db, input("real-journal", { lines: [{ debitAmount: 100, accountNo: "2000" }, { creditAmount: 100, accountNo: "5000" }], text: "synthetic idempotent journal", transactionDate: "2026-05-18" }, execute));
    expect(first.result.ok, JSON.stringify(first.result)).toBe(true);
    expect(replay.receipt?.replayed).toBe(true);
    expect(db.query("SELECT COUNT(*) AS n FROM journal_entries WHERE text = ?").get("synthetic idempotent journal")).toEqual({ n: 1 });
    db.close();
  });
});

describe("#583 real bookkeeping handlers", () => {
  test("payable registration replays, conflicts, and rolls back an after-journal failure without a tombstone", () => {
    const { company, db, documentId } = payableFixture("register");
    try {
      const payload = { documentId, billDate: "2026-01-10", dueDate: "2026-02-10", expenseAccountNo: "3000", vatTreatment: "exempt" };
      const first = idem(db, "payable_register", "register-key", payload, () => registerPayableInCurrentTransaction(db, registerInput(documentId)));
      const replay = idem(db, "payable_register", "register-key", { ...payload }, () => registerPayableInCurrentTransaction(db, registerInput(documentId)));
      expect(first.result.ok).toBe(true); expect(replay.receipt?.replayed).toBe(true); expect(count(db, "payables")).toBe(1);
      expect(() => idem(db, "payable_register", "register-key", { ...payload, dueDate: "2026-02-11" }, () => registerPayableInCurrentTransaction(db, registerInput(documentId)))).toThrow(IdempotencyError);

      const failed = payableFixture("register-fault");
      try {
        failed.db.exec("CREATE TRIGGER fail_payable_insert BEFORE INSERT ON payables BEGIN SELECT RAISE(ABORT, 'synthetic after-journal failure'); END");
        expect(() => idem(failed.db, "payable_register", "register-fault-key", { documentId: failed.documentId }, () => registerPayableInCurrentTransaction(failed.db, registerInput(failed.documentId)))).toThrow("synthetic after-journal failure");
        expect(count(failed.db, "journal_entries")).toBe(0); expect(count(failed.db, "payables")).toBe(0);
        expect(count(failed.db, "mutation_idempotency_tombstones")).toBe(0);
      } finally { failed.db.close(); rmSync(failed.company, { recursive: true, force: true }); }
    } finally { db.close(); rmSync(company, { recursive: true, force: true }); }
  });

  test("payable payment replays, conflicts, and rolls back all post-journal effects", () => {
    const { company, db, documentId } = payableFixture("pay");
    try {
      const registered = registerPayable(db, registerInput(documentId));
      expect(registered.ok).toBe(true);
      const csv = join(company, "payment.csv");
      writeFileSync(csv, "transaction_date,booking_date,text,amount,currency,reference\n2026-02-10,2026-02-10,Synthetic supplier,-100,DKK,PAY-1\n");
      expect(importBankCsv(db, company, csv).ok).toBe(true);
      const bankId = Number((db.query("SELECT id FROM bank_transactions WHERE reference = 'PAY-1'").get() as { id: number }).id);
      const payload = { payableId: registered.payableId!, bankTransactionId: bankId, amount: null, date: null, paymentAccount: null, note: null };
      const first = idem(db, "payable_pay", "pay-key", payload, () => payPayableFromBankInCurrentTransaction(db, { payableId: registered.payableId!, bankTransactionId: bankId, ...actor }));
      const replay = idem(db, "payable_pay", "pay-key", { ...payload }, () => payPayableFromBankInCurrentTransaction(db, { payableId: registered.payableId!, bankTransactionId: bankId, ...actor }));
      expect(first.result.ok).toBe(true); expect(replay.receipt?.replayed).toBe(true); expect(count(db, "payable_payments")).toBe(1);
      expect(() => idem(db, "payable_pay", "pay-key", { ...payload, note: "different" }, () => payPayableFromBankInCurrentTransaction(db, { payableId: registered.payableId!, bankTransactionId: bankId, note: "different", ...actor }))).toThrow(IdempotencyError);

      const fault = payableFixture("pay-fault");
      try {
        const payable = registerPayable(fault.db, registerInput(fault.documentId)); expect(payable.ok).toBe(true);
        const faultCsv = join(fault.company, "payment.csv");
        writeFileSync(faultCsv, "transaction_date,booking_date,text,amount,currency,reference\n2026-02-10,2026-02-10,Synthetic supplier,-100,DKK,PAY-FAULT\n");
        expect(importBankCsv(fault.db, fault.company, faultCsv).ok).toBe(true);
        const faultBank = Number((fault.db.query("SELECT id FROM bank_transactions WHERE reference = 'PAY-FAULT'").get() as { id: number }).id);
        fault.db.exec("CREATE TRIGGER fail_payment_insert BEFORE INSERT ON payable_payments BEGIN SELECT RAISE(ABORT, 'synthetic after-journal failure'); END");
        expect(() => idem(fault.db, "payable_pay", "pay-fault-key", { payableId: payable.payableId, bankTransactionId: faultBank }, () => payPayableFromBankInCurrentTransaction(fault.db, { payableId: payable.payableId!, bankTransactionId: faultBank, ...actor }))).toThrow("synthetic after-journal failure");
        expect(count(fault.db, "payable_payments")).toBe(0); expect(count(fault.db, "bank_journal_reconciliations")).toBe(0);
        // The payable-recognition entry is the fixture. No payment entry survived.
        expect(count(fault.db, "journal_entries")).toBe(1); expect(count(fault.db, "mutation_idempotency_tombstones")).toBe(0);
      } finally { fault.db.close(); rmSync(fault.company, { recursive: true, force: true }); }
    } finally { db.close(); rmSync(company, { recursive: true, force: true }); }
  });

  test("expense booking has the same receipt semantics and a late failure rolls back its journal and reconciliation", () => {
    const { company, db, documentId } = payableFixture("expense");
    try {
      const csv = join(company, "expense.csv");
      writeFileSync(csv, "transaction_date,booking_date,text,amount,currency,reference\n2026-01-10,2026-01-10,Synthetic supplier,-100,DKK,EXP-1\n");
      expect(importBankCsv(db, company, csv).ok).toBe(true);
      const bankId = Number((db.query("SELECT id FROM bank_transactions WHERE reference = 'EXP-1'").get() as { id: number }).id);
      const payload = { documentId, bankTransactionId: bankId, expenseAccountNo: "3000", vatTreatment: "exempt" };
      const first = idem(db, "expense_book", "expense-key", payload, () => bookExpenseFromBankInCurrentTransaction(db, { documentId, bankTransactionId: bankId, expenseAccountNo: "3000", vatTreatment: "exempt", ...actor }));
      const replay = idem(db, "expense_book", "expense-key", { ...payload }, () => bookExpenseFromBankInCurrentTransaction(db, { documentId, bankTransactionId: bankId, expenseAccountNo: "3000", vatTreatment: "exempt", ...actor }));
      expect(first.result.ok).toBe(true); expect(replay.receipt?.replayed).toBe(true); expect(count(db, "journal_entries")).toBe(1);
      expect(() => idem(db, "expense_book", "expense-key", { ...payload, expenseAccountNo: "3010" }, () => bookExpenseFromBankInCurrentTransaction(db, { documentId, bankTransactionId: bankId, expenseAccountNo: "3010", vatTreatment: "exempt", ...actor }))).toThrow(IdempotencyError);

      const fault = payableFixture("expense-fault");
      try {
        const faultCsv = join(fault.company, "expense.csv");
        writeFileSync(faultCsv, "transaction_date,booking_date,text,amount,currency,reference\n2026-01-10,2026-01-10,Synthetic supplier,-100,DKK,EXP-FAULT\n");
        expect(importBankCsv(fault.db, fault.company, faultCsv).ok).toBe(true);
        const faultBank = Number((fault.db.query("SELECT id FROM bank_transactions WHERE reference = 'EXP-FAULT'").get() as { id: number }).id);
        // journal_entries and the bank reconciliation are already written by
        // this point; an audit failure must still leave zero partial effects.
        fault.db.exec("CREATE TRIGGER fail_expense_audit BEFORE INSERT ON audit_log WHEN NEW.event_type = 'journal_post' BEGIN SELECT RAISE(ABORT, 'synthetic late expense failure'); END");
        expect(() => idem(fault.db, "expense_book", "expense-fault-key", { documentId: fault.documentId, bankTransactionId: faultBank }, () => bookExpenseFromBankInCurrentTransaction(fault.db, { documentId: fault.documentId, bankTransactionId: faultBank, expenseAccountNo: "3000", vatTreatment: "exempt", ...actor }))).toThrow("synthetic late expense failure");
        expect(count(fault.db, "journal_entries")).toBe(0); expect(count(fault.db, "bank_journal_reconciliations")).toBe(0);
        expect(count(fault.db, "mutation_idempotency_tombstones")).toBe(0);
      } finally { fault.db.close(); rmSync(fault.company, { recursive: true, force: true }); }
    } finally { db.close(); rmSync(company, { recursive: true, force: true }); }
  });

  test("separate SQLite connections elect one receipt, keep conflicts stable, and recover after a lost response", () => {
    const company = mkdtempSync(join(tmpdir(), "rentemester-idempotency-connections-"));
    const firstDb = openCompany(company);
    const secondDb = new Database(ensureCompanyDirs(company).db);
    try {
      let effects = 0;
      // This represents process A committing successfully while its HTTP/MCP
      // response is lost before the caller receives it.
      const original = idem(firstDb, "journal_post", "connection-key", { amount: 100 }, () => ({ ok: true, effect: ++effects }));
      expect(original.receipt?.replayed).toBe(false);
      const retry = idem(secondDb, "journal_post", "connection-key", { amount: 100 }, () => ({ ok: true, effect: ++effects }));
      expect(retry.receipt?.replayed).toBe(true); expect(retry.result).toEqual(original.result); expect(effects).toBe(1);
      expect(() => idem(secondDb, "journal_post", "connection-key", { amount: 101 }, () => ({ ok: true, effect: ++effects }))).toThrow(IdempotencyError);
      expect(effects).toBe(1); expect(count(firstDb, "mutation_idempotency_tombstones")).toBe(1); expect(count(secondDb, "mutation_idempotency_outcomes")).toBe(1);
    } finally { firstDb.close(); secondDb.close(); rmSync(company, { recursive: true, force: true }); }
  });
});
