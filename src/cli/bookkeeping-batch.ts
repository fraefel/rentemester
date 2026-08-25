/** Transport adapter for the shared bookkeeping-batch core. */
import { migrate } from "../core/db";
import { applyBookkeepingBatch, approveBookkeepingBatchPlan, createBookkeepingBatchRun, planBookkeepingBatch } from "../core/bookkeeping-batch";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

const scope = (ctx: Parameters<CommandDispatch["on"]>[2] extends (ctx: infer C) => unknown ? C : never) => ({
  companyId: Number(ctx.arg("--company-id") ?? 1), accountingFrom: ctx.arg("--accounting-from")!, accountingTo: ctx.arg("--accounting-to")!, bankFrom: ctx.arg("--bank-from")!, bankTo: ctx.arg("--bank-to")!,
});
const actor = (ctx: any) => ctx.cliActor ?? process.env.RENTEMESTER_ACTOR ?? ctx.inferredMutationActor() ?? "";
function runState(db: any, runId: number) {
  return {
    run: db.query("SELECT id AS runId,run_key AS runKey,plan_hash AS planHash,created_at AS createdAt FROM bookkeeping_batch_runs WHERE id=?").get(runId),
    events: db.query("SELECT event_type AS type,actor,detail_json AS detail,created_at AS createdAt FROM bookkeeping_batch_events WHERE run_id=? ORDER BY id").all(runId),
    attempts: db.query("SELECT action_key AS actionKey,outcome,error_text AS error,created_at AS createdAt FROM bookkeeping_batch_item_attempts WHERE run_id=? ORDER BY id").all(runId),
    checks: db.query("SELECT check_name AS name,ok,detail_json AS detail FROM bookkeeping_batch_final_checks WHERE run_id=? ORDER BY check_name").all(runId),
  };
}
export function register(dispatch: CommandDispatch): void {
  dispatch.on("bookkeeping-batch", "dry-run", (ctx) => { const db = openCommandDb(ctx); try { migrate(db); ctx.emitResult({ ok: true, dryRun: true, plan: planBookkeepingBatch(db, scope(ctx as any)) }); } finally { db.close(); } });
  dispatch.on("bookkeeping-batch", "apply", (ctx) => {
    if (!ctx.hasFlag("--confirm")) ctx.fatal("--confirm is required for apply");
    const runKey = ctx.arg("--run-key"); if (!runKey) ctx.fatal("--run-key is required for apply");
    const db = openCommandDb(ctx); try { migrate(db); const plan = planBookkeepingBatch(db, scope(ctx as any)); const created = createBookkeepingBatchRun(db, { ...plan, runKey, actor: actor(ctx) }); approveBookkeepingBatchPlan(db, { runId: created.runId, planHash: created.plan.planHash, actor: actor(ctx) }); const applied = applyBookkeepingBatch(db, { runId: created.runId, planHash: created.plan.planHash, actor: actor(ctx) }); ctx.emitResult({ ...applied, runId: created.runId, plan: created.plan, state: runState(db, created.runId) }); } finally { db.close(); }
  });
  dispatch.on("bookkeeping-batch", "status", (ctx) => { const runId = Number(ctx.arg("--run-id")); if (!Number.isInteger(runId) || runId <= 0) ctx.fatal("--run-id is required"); const db = openCommandDb(ctx); try { migrate(db); ctx.emitResult({ ok: true, state: runState(db, runId) }); } finally { db.close(); } });
}
