import { approvePostingRuleVersion, createPostingRuleProposal, disablePostingRuleVersion, supersedePostingRuleVersion } from "../../core/posting-rules";
import type { ServerConfig } from "../config";
import { withCompanyMutation } from "../mutations";
import { okResponse } from "../router/_shared";

export async function handlePostingRuleMutation(config: ServerConfig, request: Request, slug: string, action: "propose" | "approve" | "disable" | "supersede"): Promise<Response> {
  const result = await withCompanyMutation(request, config, slug, (ctx, body) => {
    const companyId = (ctx.db.query("SELECT id FROM companies ORDER BY id LIMIT 1").get() as { id: number }).id;
    if (action === "propose") return createPostingRuleProposal(ctx.db, { ...(body.proposal as Record<string, unknown>), companyId, conditions: { ...((body.proposal as any)?.conditions ?? {}), company: companyId }, creator: ctx.actor.createdBy } as any);
    const input = { companyId, ruleId: body.ruleId, version: body.version, expectedPayloadHash: body.expectedPayloadHash, rationale: body.rationale, provenance: body.provenance, effectiveAt: body.effectiveAt, actor: ctx.actor.createdBy } as any;
    return action === "approve" ? approvePostingRuleVersion(ctx.db, input) : action === "disable" ? disablePostingRuleVersion(ctx.db, input) : supersedePostingRuleVersion(ctx.db, input);
  }, { requireConfirm: true });
  return okResponse({ postingRule: result });
}
