/** Transport adapter for the shared bookkeeping-batch core. */
import { migrate } from "../core/db";
import { applyBookkeepingBatch, approveBookkeepingBatchPlan, createBookkeepingBatchRun, getBookkeepingBatchState, planBookkeepingBatch } from "../core/bookkeeping-batch";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

const scope = (ctx: Parameters<CommandDispatch["on"]>[2] extends (ctx: infer C) => unknown ? C : never) => ({
  companyId: Number(ctx.arg("--company-id") ?? 1), accountingFrom: ctx.arg("--accounting-from")!, accountingTo: ctx.arg("--accounting-to")!, bankFrom: ctx.arg("--bank-from")!, bankTo: ctx.arg("--bank-to")!,
});
const actor = (ctx: any) => ctx.cliActor ?? process.env.RENTEMESTER_ACTOR ?? ctx.inferredMutationActor() ?? "";
const runState = getBookkeepingBatchState;
export function register(dispatch: CommandDispatch): void {
  // Pure planning is intentionally separate from durable review state. It
  // opens/migrates through the normal CLI adapter today, but performs no batch
  // writes; hosted HTTP/MCP use their read-only route/tool for this operation.
  dispatch.on("bookkeeping-batch", "plan", (ctx) => { const db=openCommandDb(ctx); try { migrate(db); ctx.emitResult({ok:true,dryRun:true,plan:planBookkeepingBatch(db,scope(ctx as any))}); } finally { db.close(); } });
  dispatch.on("bookkeeping-batch", "persist", (ctx) => { const runKey=ctx.arg("--run-key"); if(!runKey)ctx.fatal("--run-key is required"); const db=openCommandDb(ctx); try { migrate(db); const plan=planBookkeepingBatch(db,scope(ctx as any)); const run=createBookkeepingBatchRun(db,{...plan,runKey,actor:actor(ctx)}); ctx.emitResult({ok:true,runId:run.runId,duplicate:run.duplicate,plan:run.plan,state:runState(db,run.runId)}); } finally { db.close(); } });
  dispatch.on("bookkeeping-batch", "dry-run", (ctx) => { const runKey = ctx.arg("--run-key"); if (!runKey) ctx.fatal("--run-key is required to persist a reviewable dry-run"); const db = openCommandDb(ctx); try { migrate(db); const plan = planBookkeepingBatch(db, scope(ctx as any)); const run = createBookkeepingBatchRun(db, { ...plan, runKey, actor: actor(ctx) }); ctx.emitResult({ ok: true, dryRun: true, runId: run.runId, duplicate: run.duplicate, plan: run.plan, state: runState(db, run.runId) }); } finally { db.close(); } });
  dispatch.on("bookkeeping-batch", "approve", (ctx) => { const runId = Number(ctx.arg("--run-id")); const planHash = ctx.arg("--plan-hash"); if (!Number.isInteger(runId) || !planHash) ctx.fatal("--run-id and --plan-hash are required"); const db = openCommandDb(ctx); try { migrate(db); ctx.emitResult({ ...approveBookkeepingBatchPlan(db, { runId, planHash: planHash!, actor: actor(ctx) }), state: runState(db, runId) }); } finally { db.close(); } });
  dispatch.on("bookkeeping-batch", "apply", (ctx) => {
    if (!ctx.hasFlag("--confirm")) ctx.fatal("--confirm is required for apply");
    const runId = Number(ctx.arg("--run-id")); const planHash = ctx.arg("--plan-hash"); if (!Number.isInteger(runId) || !planHash) ctx.fatal("--run-id and --plan-hash are required for apply");
    const db = openCommandDb(ctx); try { migrate(db); const applied = applyBookkeepingBatch(db, { runId, planHash: planHash!, actor: actor(ctx) }); ctx.emitResult({ ...applied, runId, planHash, state: runState(db, runId) }); } finally { db.close(); }
  });
  dispatch.on("bookkeeping-batch", "status", (ctx) => { const runId = Number(ctx.arg("--run-id")); if (!Number.isInteger(runId) || runId <= 0) ctx.fatal("--run-id is required"); const db = openCommandDb(ctx); try { migrate(db); ctx.emitResult({ ok: true, state: runState(db, runId) }); } finally { db.close(); } });
}
