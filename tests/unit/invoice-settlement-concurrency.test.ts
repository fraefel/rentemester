import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { importBankCsv } from "../../src/core/bank";
import { issueInvoice } from "../../src/core/issued-invoices";
import { postIssuedInvoiceToLedger } from "../../src/core/invoice-booking";
import { applyInvoicePayment } from "../../src/core/invoice-payments";
import { issueCreditNote } from "../../src/core/credit-notes";
import { postInvoiceReminderToLedger, registerInvoiceReminder } from "../../src/core/invoice-reminders";
import { seedAccounts } from "../../src/core/ledger";

function issueHundredDkk(db: ReturnType<typeof openDb>, root: string) {
  const issued = issueInvoice(db, root, {
    invoiceType: "full",
    vatTreatment: "standard",
    issueDate: "2026-05-16",
    dueDate: "2026-06-15",
    invoiceNumber: "2026-0001",
    seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    buyer: { name: "Kunde A/S", address: "Købervej 9", vatOrCvr: "DK87654321" },
    lines: [{ description: "Service", quantity: 1, unitPriceExVat: 80, lineTotalExVat: 80 }],
    totals: { netAmount: 80, vatRate: 0.25, vatAmount: 20, grossAmount: 100 },
    currency: "DKK",
  });
  expect(issued.ok).toBe(true);
  expect(postIssuedInvoiceToLedger(db, { invoiceDocumentId: issued.documentId! }).ok).toBe(true);
  return issued.documentId!;
}

function workerSource() {
  const core = (name: string) => pathToFileURL(join(import.meta.dir, `../../src/core/${name}.ts`)).href;
  return `
import { existsSync, writeFileSync } from "node:fs";
import { openDb } from ${JSON.stringify(core("db"))};
import { settleInvoiceFromBank } from ${JSON.stringify(core("invoice-settlement"))};
import { refundInvoiceToBank } from ${JSON.stringify(core("invoice-refunds"))};
import { settleInvoiceClaimsFromBank } from ${JSON.stringify(core("invoice-claim-settlement"))};

const [dbPath, ownReady, peerReady, mode, invoiceIdRaw, bankIdRaw] = process.argv.slice(2);
const raw = openDb(dbPath);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
let barrierPassed = false;
const db = new Proxy(raw, {
  get(target, property) {
    if (property === "transaction") {
      return (...args) => {
        if (!barrierPassed) {
          writeFileSync(ownReady, "ready");
          const deadline = Date.now() + 10_000;
          while (!existsSync(peerReady)) {
            if (Date.now() > deadline) throw new Error("concurrency barrier timed out");
            Atomics.wait(waitCell, 0, 0, 5);
          }
          barrierPassed = true;
        }
        return target.transaction(...args);
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const invoiceDocumentId = Number(invoiceIdRaw);
const bankTransactionId = Number(bankIdRaw);
let result;
if (mode === "payment") result = settleInvoiceFromBank(db, { invoiceDocumentId, bankTransactionId });
else if (mode === "refund") result = refundInvoiceToBank(db, { invoiceDocumentId, bankTransactionId });
else result = settleInvoiceClaimsFromBank(db, { invoiceDocumentId, bankTransactionId });
console.log(JSON.stringify(result));
raw.close();
`;
}

function creditWorkerSource() {
  const core = (name: string) => pathToFileURL(join(import.meta.dir, `../../src/core/${name}.ts`)).href;
  return `
import { existsSync, writeFileSync } from "node:fs";
import { openDb } from ${JSON.stringify(core("db"))};
import { issueCreditNote } from ${JSON.stringify(core("credit-notes"))};

const [dbPath, companyRoot, ownReady, peerReady, invoiceIdRaw] = process.argv.slice(2);
const raw = openDb(dbPath);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
let barrierPassed = false;
const db = new Proxy(raw, {
  get(target, property) {
    if (property === "transaction") {
      return (...args) => {
        if (!barrierPassed) {
          writeFileSync(ownReady, "ready");
          const deadline = Date.now() + 10_000;
          while (!existsSync(peerReady)) {
            if (Date.now() > deadline) throw new Error("concurrency barrier timed out");
            Atomics.wait(waitCell, 0, 0, 5);
          }
          barrierPassed = true;
        }
        return target.transaction(...args);
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const result = issueCreditNote(db, companyRoot, {
  originalInvoiceDocumentId: Number(invoiceIdRaw),
  issueDate: "2026-06-20",
  reason: "Concurrent partial credit",
  grossAmount: 80,
});
console.log(JSON.stringify(result));
raw.close();
`;
}

async function raceSettlements(args: {
  root: string;
  dbPath: string;
  mode: "payment" | "refund" | "claim";
  invoiceDocumentId: number;
  bankTransactionIds: [number, number];
}) {
  const workerPath = join(args.root, "settlement-race-worker.mjs");
  const readyA = join(args.root, "race-a.ready");
  const readyB = join(args.root, "race-b.ready");
  writeFileSync(workerPath, workerSource());
  const spawn = (own: string, peer: string, bankId: number) => Bun.spawn([
    process.execPath,
    workerPath,
    args.dbPath,
    own,
    peer,
    args.mode,
    String(args.invoiceDocumentId),
    String(bankId),
  ], { stdout: "pipe", stderr: "pipe" });
  const first = spawn(readyA, readyB, args.bankTransactionIds[0]);
  const second = spawn(readyB, readyA, args.bankTransactionIds[1]);
  const [firstStdout, secondStdout, firstStderr, secondStderr, firstExit, secondExit] = await Promise.all([
    new Response(first.stdout).text(),
    new Response(second.stdout).text(),
    new Response(first.stderr).text(),
    new Response(second.stderr).text(),
    first.exited,
    second.exited,
  ]);
  expect([firstExit, secondExit]).toEqual([0, 0]);
  expect(firstStderr + secondStderr).toBe("");
  return [JSON.parse(firstStdout), JSON.parse(secondStdout)] as Array<{ ok: boolean; errors: string[] }>;
}

async function raceCreditNotes(args: {
  root: string;
  dbPath: string;
  invoiceDocumentId: number;
}) {
  const workerPath = join(args.root, "credit-race-worker.mjs");
  const readyA = join(args.root, "credit-race-a.ready");
  const readyB = join(args.root, "credit-race-b.ready");
  writeFileSync(workerPath, creditWorkerSource());
  const spawn = (own: string, peer: string) => Bun.spawn([
    process.execPath,
    workerPath,
    args.dbPath,
    args.root,
    own,
    peer,
    String(args.invoiceDocumentId),
  ], { stdout: "pipe", stderr: "pipe" });
  const first = spawn(readyA, readyB);
  const second = spawn(readyB, readyA);
  const [firstStdout, secondStdout, firstStderr, secondStderr, firstExit, secondExit] = await Promise.all([
    new Response(first.stdout).text(),
    new Response(second.stdout).text(),
    new Response(first.stderr).text(),
    new Response(second.stderr).text(),
    first.exited,
    second.exited,
  ]);
  expect([firstExit, secondExit]).toEqual([0, 0]);
  expect(firstStderr + secondStderr).toBe("");
  return [JSON.parse(firstStdout), JSON.parse(secondStdout)] as Array<{ ok: boolean; errors: string[] }>;
}

function importedTransactionIds(db: ReturnType<typeof openDb>, references: [string, string]) {
  return references.map((reference) => (
    db.query("SELECT id FROM bank_transactions WHERE reference = ?").get(reference) as { id: number }
  ).id) as [number, number];
}

describe("invoice settlement concurrency", () => {
  test("serializes credit-note caps and rejects the stale second issuer", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-credit-race-"));
    const dbPath = ensureCompanyDirs(root).db;
    const db = openDb(dbPath);
    migrate(db);
    seedAccounts(db);
    const invoiceId = issueHundredDkk(db, root);
    db.close();

    const results = await raceCreditNotes({ root, dbPath, invoiceDocumentId: invoiceId });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)!.errors.join(" ")).toMatch(/exceeds remaining creditable amount 20|database is locked/);
    const verify = openDb(dbPath);
    expect(verify.query("SELECT COUNT(*) AS n FROM credit_note_postings").get()).toEqual({ n: 1 });
    expect(verify.query("SELECT SUM(booked_gross_dkk) AS n FROM credit_note_postings").get()).toEqual({ n: 80 });
    verify.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("serializes principal caps and rejects the stale second payment", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-payment-race-"));
    const dbPath = ensureCompanyDirs(root).db;
    const db = openDb(dbPath);
    migrate(db);
    seedAccounts(db);
    const invoiceId = issueHundredDkk(db, root);
    const csv = join(root, "payment-race.csv");
    writeFileSync(csv, "transaction_date,booking_date,text,amount,currency,reference\n2026-06-20,2026-06-20,Payment A,80,DKK,RACE-PAY-A\n2026-06-20,2026-06-20,Payment B,80,DKK,RACE-PAY-B\n");
    expect(importBankCsv(db, root, csv).ok).toBe(true);
    const ids = importedTransactionIds(db, ["RACE-PAY-A", "RACE-PAY-B"]);
    db.close();

    const results = await raceSettlements({ root, dbPath, mode: "payment", invoiceDocumentId: invoiceId, bankTransactionIds: ids });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)!.errors.join(" ")).toMatch(/exceeds invoice claim open balance 20|database is locked/);
    const verify = openDb(dbPath);
    expect(verify.query("SELECT COUNT(*) AS n FROM invoice_payments").get()).toEqual({ n: 1 });
    verify.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("serializes refund caps and rejects the stale second refund", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-refund-race-"));
    const dbPath = ensureCompanyDirs(root).db;
    const db = openDb(dbPath);
    migrate(db);
    seedAccounts(db);
    const invoiceId = issueHundredDkk(db, root);
    expect(applyInvoicePayment(db, { invoiceDocumentId: invoiceId, paymentDate: "2026-06-18", amount: 100 }).ok).toBe(true);
    expect(issueCreditNote(db, root, { originalInvoiceDocumentId: invoiceId, issueDate: "2026-06-19", reason: "Full credit", grossAmount: 100 }).ok).toBe(true);
    const csv = join(root, "refund-race.csv");
    writeFileSync(csv, "transaction_date,booking_date,text,amount,currency,reference\n2026-06-20,2026-06-20,Refund A,-80,DKK,RACE-REF-A\n2026-06-20,2026-06-20,Refund B,-80,DKK,RACE-REF-B\n");
    expect(importBankCsv(db, root, csv).ok).toBe(true);
    const ids = importedTransactionIds(db, ["RACE-REF-A", "RACE-REF-B"]);
    db.close();

    const results = await raceSettlements({ root, dbPath, mode: "refund", invoiceDocumentId: invoiceId, bankTransactionIds: ids });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)!.errors.join(" ")).toMatch(/exceeds refundable credit balance 20|database is locked/);
    const verify = openDb(dbPath);
    expect(verify.query("SELECT COUNT(*) AS n FROM invoice_refunds").get()).toEqual({ n: 1 });
    verify.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("serializes claim caps and rejects the stale second claim receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-claim-race-"));
    const dbPath = ensureCompanyDirs(root).db;
    const db = openDb(dbPath);
    migrate(db);
    seedAccounts(db);
    const invoiceId = issueHundredDkk(db, root);
    expect(registerInvoiceReminder(db, { invoiceDocumentId: invoiceId, reminderDate: "2026-06-26" }).ok).toBe(true);
    expect(postInvoiceReminderToLedger(db, { invoiceDocumentId: invoiceId }).ok).toBe(true);
    expect(applyInvoicePayment(db, { invoiceDocumentId: invoiceId, paymentDate: "2026-06-18", amount: 100 }).ok).toBe(true);
    const csv = join(root, "claim-race.csv");
    writeFileSync(csv, "transaction_date,booking_date,text,amount,currency,reference\n2026-06-28,2026-06-28,Claim A,80,DKK,RACE-CLAIM-A\n2026-06-28,2026-06-28,Claim B,80,DKK,RACE-CLAIM-B\n");
    expect(importBankCsv(db, root, csv).ok).toBe(true);
    const ids = importedTransactionIds(db, ["RACE-CLAIM-A", "RACE-CLAIM-B"]);
    db.close();

    const results = await raceSettlements({ root, dbPath, mode: "claim", invoiceDocumentId: invoiceId, bankTransactionIds: ids });
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)!.errors.join(" ")).toMatch(/exceeds (claim open|ledger-backed claim) balance 20|database is locked/);
    const verify = openDb(dbPath);
    expect(verify.query("SELECT COUNT(*) AS n FROM invoice_claim_payments").get()).toEqual({ n: 1 });
    verify.close();
    rmSync(root, { recursive: true, force: true });
  });
});
