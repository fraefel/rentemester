import { migrate } from "../core/db";
import { approvePostingRuleVersion, createPostingRuleProposal, disablePostingRuleVersion, evaluatePostingRules, supersedePostingRuleVersion } from "../core/posting-rules";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

function json(ctx: { arg(name: string): string | undefined }, flag: string): any {
  const raw = ctx.arg(flag); if (!raw) throw new Error(`${flag} is required`);
  try { return JSON.parse(raw); } catch { throw new Error(`${flag} must be valid JSON`); }
}
function transition(dispatch: CommandDispatch, action: "approve" | "disable" | "supersede") {
  dispatch.on("posting-rules", action, (ctx) => {
    const ruleId = ctx.arg("--rule-id"); const version = Number(ctx.arg("--version")); const expectedPayloadHash = ctx.arg("--expected-payload-hash"); const rationale = ctx.arg("--rationale"); const provenance = ctx.arg("--provenance");
    if (!ruleId || !Number.isInteger(version) || !expectedPayloadHash || !rationale || !provenance || !ctx.cliActor) return ctx.fatal("--rule-id, --version, --expected-payload-hash, --rationale, --provenance and --actor are required");
    const db = openCommandDb(ctx); migrate(db);
    const input = { companyId: (db.query("SELECT id FROM companies ORDER BY id LIMIT 1").get() as { id: number }).id, ruleId, version, actor: ctx.cliActor, rationale, provenance, expectedPayloadHash, effectiveAt: ctx.arg("--effective-at") };
    const result = action === "approve" ? approvePostingRuleVersion(db, input) : action === "disable" ? disablePostingRuleVersion(db, input) : supersedePostingRuleVersion(db, input);
    ctx.emitResult(result); db.close(); if (!result.ok) process.exit(1);
  });
}
export function register(dispatch: CommandDispatch): void {
  dispatch.on("posting-rules", "propose", (ctx) => {
    try {
      const db = openCommandDb(ctx); migrate(db);
      const input = json(ctx, "--input");
      const companyId = (db.query("SELECT id FROM companies ORDER BY id LIMIT 1").get() as { id: number }).id;
      const result = createPostingRuleProposal(db, { ...input, companyId, conditions: { ...input.conditions, company: companyId }, creator: ctx.cliActor! });
      ctx.emitResult(result); db.close(); if (!result.ok) process.exit(1);
    } catch (error) { ctx.fatal(error instanceof Error ? error.message : String(error)); }
  });
  transition(dispatch, "approve"); transition(dispatch, "disable"); transition(dispatch, "supersede");
  for (const command of ["explain", "test"] as const) dispatch.on("posting-rules", command, (ctx) => {
    try {
      const db = openCommandDb(ctx); migrate(db);
      const company = (db.query("SELECT id FROM companies ORDER BY id LIMIT 1").get() as { id: number }).id;
      const result = evaluatePostingRules(db, { ...json(ctx, "--context"), company }, { at: ctx.arg("--at") });
      ctx.emitResult({ ...result, dryRun: true }); db.close();
    } catch (error) { ctx.fatal(error instanceof Error ? error.message : String(error)); }
  });
}
