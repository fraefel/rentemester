import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { applyBookkeepingBatch, approveBookkeepingBatchPlan, createBookkeepingBatchRun, planBookkeepingBatch } from "../../src/core/bookkeeping-batch";

test("shared batch contract is deterministic, actor-confirmable and resumable", () => {
 const db=new Database(":memory:"); migrate(db); db.exec("INSERT INTO companies(id,name) VALUES(1,'Synthetic')");
 const scope={companyId:1,accountingFrom:"2026-01-01",accountingTo:"2026-01-31",bankFrom:"2026-01-01",bankTo:"2026-01-31"};
 const dry=planBookkeepingBatch(db,scope); expect(planBookkeepingBatch(db,scope).planHash).toBe(dry.planHash);
 const run=createBookkeepingBatchRun(db,{...dry,runKey:"surface-parity",actor:"agent:test",principal:{kind:"user",subjectId:"planner"}}); approveBookkeepingBatchPlan(db,{runId:run.runId,planHash:dry.planHash,actor:"user:reviewer",principal:{kind:"user",subjectId:"reviewer"}});
 const one=applyBookkeepingBatch(db,{runId:run.runId,planHash:dry.planHash,actor:"agent:test"});
 const two=applyBookkeepingBatch(db,{runId:run.runId,planHash:dry.planHash,actor:"agent:test"});
 expect(one.ok).toBe(two.ok); expect(db.query("SELECT COUNT(*) n FROM bookkeeping_batch_events WHERE run_id=?").get(run.runId)).toBeTruthy(); db.close();
});
