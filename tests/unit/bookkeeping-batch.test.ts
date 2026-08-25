import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { approveBookkeepingBatchPlan, createBookkeepingBatchRun, planBookkeepingBatch } from "../../src/core/bookkeeping-batch";

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
    const run = createBookkeepingBatchRun(db, { ...one, runKey: "batch-one", actor: "agent:test" });
    expect(run.duplicate).toBe(false);
    expect(approveBookkeepingBatchPlan(db, { runId: run.runId, planHash: one.planHash, actor: "user:reviewer" }).ok).toBe(true);
    expect(() => approveBookkeepingBatchPlan(db, { runId: run.runId, planHash: "0".repeat(64), actor: "user:reviewer" })).toThrow("exact pending plan");
    db.close();
  });
});
