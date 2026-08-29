import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { addBankAccount } from "../../src/core/bank";
import { linkBankTransactionToJournal } from "../../src/core/bank-journal-reconciliation";
import { applyBookkeepingBatch, approveBookkeepingBatchPlan, createBookkeepingBatchRun, getBookkeepingBatchState, planBookkeepingBatch } from "../../src/core/bookkeeping-batch";
import { postJournalEntry, seedAccounts } from "../../src/core/ledger";

describe("bookkeeping batches", () => {
  test("dry planning is deterministic, read-only, and partitions unmatched work", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec("INSERT INTO companies(id,name) VALUES(1,'Synthetic'); INSERT INTO documents(id,source,sha256_hash,invoice_date) VALUES(1,'test','batch-doc','2026-01-10'); INSERT INTO bank_transactions(id,transaction_date,text,amount,transaction_hash) VALUES(1,'2026-01-11','unmatched',-10,'batch-bank');");
    const before = db.query("SELECT COUNT(*) AS n FROM bookkeeping_batch_runs").get() as { n: number };
    const input = { companyId: 1, accountingFrom: "2026-01-01", accountingTo: "2026-01-31", bankFrom: "2026-01-01", bankTo: "2026-01-31" };
    const one = planBookkeepingBatch(db, input);
    const two = planBookkeepingBatch(db, input);
    expect(two.planHash).toBe(one.planHash);
    // A document without one exact bank pair is intentionally not an action.
    expect(one.items.map(x => x.partition)).toEqual(["missingDocument"]);
    expect(db.query("SELECT COUNT(*) AS n FROM bookkeeping_batch_runs").get()).toEqual(before);
    const run = createBookkeepingBatchRun(db, { ...one, runKey: "batch-one", actor: "agent:test", principal: { kind: "user", subjectId: "planner" } });
    expect(run.duplicate).toBe(false);
    expect(approveBookkeepingBatchPlan(db, { runId: run.runId, planHash: one.planHash, actor: "user:reviewer", principal: { kind: "user", subjectId: "reviewer" } }).ok).toBe(true);
    expect(() => approveBookkeepingBatchPlan(db, { runId: run.runId, planHash: "0".repeat(64), actor: "user:reviewer" })).toThrow("exact pending plan");
    db.close();
  });

  test("excludes direct and append-only reconciliations while preserving unresolved work", () => {
    const db = new Database(":memory:");
    migrate(db);
    seedAccounts(db);
    db.exec("INSERT INTO companies(id,name) VALUES(1,'Synthetic');");
    const account = addBankAccount(db, { name: "Synthetic bank", slug: "synthetic-bank", ledgerAccountNo: "2000" });
    expect(account.ok).toBe(true);
    const bankAccountId = account.account!.id;
    db.query(`INSERT INTO documents
      (id,source,sha256_hash,invoice_no,invoice_date,amount_inc_vat,sender_name,payment_details)
      VALUES(1,'test','suggested-document','SUP-777','2026-01-10',50,'Synthetic Supplier','SUP-777')`).run();
    db.query(`INSERT INTO bank_transactions
      (id,transaction_date,text,amount,transaction_hash,bank_account_id)
      VALUES
        (1,'2026-01-11','direct reconciliation',10,'direct-bank',?),
        (2,'2026-01-12','append-only reconciliation',-20,'append-bank',?),
        (3,'2026-01-13','payment SUP-777',-50,'suggested-bank',?),
        (4,'2026-01-14','no document',-70,'missing-bank',?)`).run(bankAccountId, bankAccountId, bankAccountId, bankAccountId);

    const direct = postJournalEntry(db, {
      transactionDate: "2026-01-11",
      text: "Direct reconciliation",
      sourceBankTransactionId: 1,
      createdBy: "agent:test",
      lines: [{ accountNo: "2000", debitAmount: 10 }, { accountNo: "7000", creditAmount: 10 }],
    });
    expect(direct.ok).toBe(true);
    const historical = postJournalEntry(db, {
      transactionDate: "2026-01-12",
      text: "Historical reconciliation",
      createdBy: "agent:test",
      lines: [{ accountNo: "7000", debitAmount: 20 }, { accountNo: "2000", creditAmount: 20 }],
    });
    expect(historical.ok).toBe(true);
    const appended = linkBankTransactionToJournal(db, {
      bankTransactionId: 2,
      journalEntryId: Number(historical.entryId),
      matchMethod: "manual-review",
      createdBy: "agent:test",
    });
    expect(appended.ok).toBe(true);

    const input = { companyId: 1, accountingFrom: "2026-01-01", accountingTo: "2026-01-31", bankFrom: "2026-01-01", bankTo: "2026-01-31" };
    const one = planBookkeepingBatch(db, input);
    const two = planBookkeepingBatch(db, input);

    expect(two).toEqual(one);
    expect(one.items.map((item) => item.actionKey)).toEqual(["bank:4", "purchase:1:bank:3"]);
    expect(one.items.filter((item) => item.partition === "missingDocument").map((item) => item.bankTransactionId)).toEqual([4]);
    expect(one.items.find((item) => item.bankTransactionId === 3)).toMatchObject({ documentId: 1, partition: "humanDecision" });
    expect(one.items.some((item) => item.bankTransactionId === 1 || item.bankTransactionId === 2)).toBe(false);
    db.close();
  });

  test("binds the complete eligible candidate universe and stable principals", () => {
    const db = new Database(":memory:"); migrate(db);
    db.exec("INSERT INTO companies(id,name) VALUES(1,'Synthetic'); INSERT INTO documents(id,source,sha256_hash,document_type,currency,amount_inc_vat) VALUES(1,'test','a','purchase_sale','DKK',10);");
    const input={companyId:1,accountingFrom:"2026-01-01",accountingTo:"2026-01-31",bankFrom:"2026-01-01",bankTo:"2026-01-31"};
    const plan=planBookkeepingBatch(db,input);
    const run=createBookkeepingBatchRun(db,{...plan,runKey:"principal-plan",actor:"agent:planner",principal:{kind:"service-account",subjectId:"svc-a"}});
    expect(() => approveBookkeepingBatchPlan(db,{runId:run.runId,planHash:plan.planHash,actor:"user:another-audit-label",principal:{kind:"service-account",subjectId:"svc-a"}})).toThrow("SELF_APPROVAL_FORBIDDEN");
    approveBookkeepingBatchPlan(db,{runId:run.runId,planHash:plan.planHash,actor:"agent:reviewer",principal:{kind:"user",subjectId:"reviewer"}});
    // An undated still-open purchase participates in suggestion eligibility;
    // adding a new one after review must stale, even outside the date scope.
    db.exec("INSERT INTO documents(id,source,sha256_hash,document_type,currency,amount_inc_vat) VALUES(2,'test','b','purchase_sale','DKK',20)");
    const result=applyBookkeepingBatch(db,{runId:run.runId,planHash:plan.planHash,actor:"agent:apply",principal:{kind:"service-account",subjectId:"svc-a"}});
    expect(result).toMatchObject({ok:false,error:{code:"STALE_PLAN"}});
    expect(db.query("SELECT COUNT(*) AS n FROM bookkeeping_batch_apply_attempts_v2").get()).toEqual({n:1});
    db.close();
  });

  test("status is derived from immutable revision and attempt records", () => {
    const db = new Database(":memory:"); migrate(db);
    db.exec("INSERT INTO companies(id,name) VALUES(1,'Synthetic')");
    const input={companyId:1,accountingFrom:"2026-01-01",accountingTo:"2026-01-31",bankFrom:"2026-01-01",bankTo:"2026-01-31"};
    const plan=planBookkeepingBatch(db,input);
    const run=createBookkeepingBatchRun(db,{...plan,runKey:"status",actor:"agent:planner",principal:{kind:"user",subjectId:"planner"}});
    approveBookkeepingBatchPlan(db,{runId:run.runId,planHash:plan.planHash,actor:"agent:reviewer",principal:{kind:"user",subjectId:"reviewer"}});
    const state=getBookkeepingBatchState(db,run.runId)!;
    expect(state.revisions).toMatchObject([{planHash:plan.planHash,plannerSubjectId:"planner",approverSubjectId:"reviewer"}]);
    expect(() => db.exec("UPDATE bookkeeping_batch_revisions SET planner_actor='user:other' WHERE run_id=1")).toThrow();
    expect(() => db.exec("UPDATE bookkeeping_batch_revision_approvals SET actor='user:other' WHERE revision_id=1")).toThrow();
    db.close();
  });
});
