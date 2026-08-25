/** Posting-rule adapters: all decisions and lifecycle changes stay in core/posting-rules. */
import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { approvePostingRuleVersion, createPostingRuleProposal, evaluatePostingRules, type CreatePostingRuleProposalInput } from "../../core/posting-rules";
import { envelopeShape, wrapCoreResult } from "../envelope";
import { confirmField, withCompanyDb, withCompanyDbConfirmed } from "../tool-runtime";

// Keep these module-local names domain-qualified. The MCP server is bundled
// for stdio execution, where generic schema identifiers from tool modules can
// otherwise participate in a generated temporal-dead-zone cycle.
const postingRulesCompanyInputSchema = z.string().min(1).describe("Company directory or registered workspace slug.");
const postingRuleProposalSchema = z.object({
  ruleId: z.string().min(1),
  effectiveFrom: z.string().min(1),
  effectiveTo: z.string().optional(),
  conditions: z.object({
    supplierIdentity: z.string().optional(), documentType: z.string().optional(), supplierCountry: z.string().optional(),
    supplierVat: z.string().optional(), currency: z.string().optional(), vat: z.enum(["zero", "positive"]).optional(),
    amount: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
    reverseChargeWording: z.boolean().optional(), attributes: z.record(z.string(), z.string()).optional(),
  }).passthrough(),
  outcome: z.object({ account: z.string().optional(), vatTreatment: z.string().optional(), textTemplate: z.string().optional(), dimensions: z.record(z.string(), z.string()).optional() }).passthrough(),
  provenance: z.string().min(1), rationale: z.string().min(1), createdAt: z.string().optional(),
});
const postingRuleContextSchema = z.object({}).passthrough();

type PostingRuleProposalInput = z.infer<typeof postingRuleProposalSchema>;
type PostingRuleContextInput = z.infer<typeof postingRuleContextSchema>;
type PostingRuleApprovalInput = {
  company: string;
  ruleId: string;
  version: number;
  expectedPayloadHash: string;
  rationale: string;
  provenance: string;
  effectiveAt?: string;
  confirm?: boolean;
};

function companyId(db: Database): number {
  return (db.query("SELECT id FROM companies ORDER BY id LIMIT 1").get() as { id: number }).id;
}

export function registerPostingRuleTools(server: McpServer): void {
  server.registerTool("posting_rule_propose", {
    title: "Propose posting rule",
    description: "Creates a company-local, hash-bound posting-rule proposal. Requires confirm:true. write-reversible.",
    inputSchema: { company: postingRulesCompanyInputSchema, proposal: postingRuleProposalSchema, confirm: confirmField },
    outputSchema: envelopeShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, withCompanyDbConfirmed<{ company: string; proposal: PostingRuleProposalInput; confirm?: boolean }>(server, "posting_rule_propose", ({ db, actor, args }) => {
    const proposal = args.proposal;
    const input: CreatePostingRuleProposalInput = {
      ...proposal,
      companyId: companyId(db),
      conditions: { ...proposal.conditions, company: companyId(db) },
      creator: actor.createdBy,
    };
    return wrapCoreResult(createPostingRuleProposal(db, input));
  }));

  server.registerTool("posting_rule_approve", {
    title: "Approve posting rule",
    description: "Approves the exact hash-bound company-local rule version with immutable lifecycle evidence. Requires confirm:true. write-reversible.",
    inputSchema: { company: postingRulesCompanyInputSchema, ruleId: z.string().min(1), version: z.number().int().positive(), expectedPayloadHash: z.string().min(1), rationale: z.string().min(1), provenance: z.string().min(1), effectiveAt: z.string().optional(), confirm: confirmField },
    outputSchema: envelopeShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, withCompanyDbConfirmed<PostingRuleApprovalInput>(server, "posting_rule_approve", ({ db, actor, args }) => wrapCoreResult(approvePostingRuleVersion(db, { ...args, companyId: companyId(db), actor: actor.createdBy }))));

  // `posting_rule_disable` and `posting_rule_supersede` remain lifecycle
  // operations on the CLI and HTTP surfaces. The fixed 127-tool MCP contract
  // offers proposal, approval, and deterministic explain/test instead.

  server.registerTool("posting_rule_explain", {
      title: "posting rule explain",
      description: "Read-only dry-run against a historical document context. Returns exact match/non-match and evidence-deviation reasons.",
      inputSchema: { company: postingRulesCompanyInputSchema, context: postingRuleContextSchema, at: z.string().optional() },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, withCompanyDb<{ company: string; context: PostingRuleContextInput; at?: string }>(server, ({ db, args }) => wrapCoreResult({ ok: true, dryRun: true, ...evaluatePostingRules(db, { ...args.context, company: companyId(db) }, { at: args.at }) })));

  // `posting_rule_test` is the CLI/HTTP spelling of the same deterministic
  // dry-run operation; MCP exposes it as `posting_rule_explain` to keep its
  // fixed 127-tool surface unambiguous.
}
