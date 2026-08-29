import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  validateAgentDiscoveryCoverage,
  type AgentCapability,
  type AgentDiscoveryCoverageInput,
  type AgentWorkflow,
} from "../../src/agent-discovery-catalog";

const capability: AgentCapability = {
  id: "known-capability", title: "Known capability", purpose: "Synthetic gate fixture", domain: "synthetic",
  outcomes: ["verify coverage"], keywords: ["known"], scope: "company", supportStatus: "supported", maturity: "stable",
  workflowIds: ["known-workflow"], canonicalState: ["synthetic record"], unsupportedBoundaries: [],
};

const workflow: AgentWorkflow = {
  id: "known-workflow", capabilityId: capability.id, title: "Known workflow", intendedOutcome: "Verify the synthetic operation",
  nonGoals: ["No mutation"], prerequisites: ["Live operation"], blockers: [{ code: "BLOCKED", meaning: "Synthetic blocker" }],
  recovery: ["Stop"], stopConditions: ["Operation unavailable"], relatedWorkflowIds: [], alternatives: [], unsupportedBoundaries: [],
  steps: [{
    id: "read-known", dependsOn: [], boundary: "read", operation: { surface: "mcp", name: "known" }, purpose: "Read known state",
    prerequisites: [], inputIdentities: [], outputIdentities: [], expectedSafety: "read", expectedIdempotent: true,
    requiresActor: false, requiresConfirmation: false, retryClass: "safe-read", canonicalRecords: ["synthetic record"],
  }],
};

function fixture(overrides: Partial<AgentDiscoveryCoverageInput> = {}): AgentDiscoveryCoverageInput {
  return {
    tools: [{ name: "known", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }],
    commands: [{ key: "known", allowedFlags: [], mutating: false, sideEffecting: false }],
    routes: [{ method: "GET", pattern: "/known", effect: "read" }], workflows: [workflow], capabilities: [capability],
    expectedOperationIds: ["mcp:known", "cli:known", "http:GET /known"], classifyOperation: () => [capability.id], ...overrides,
  };
}

describe("agent discovery coverage gate (#585)", () => {
  test("the real registries pass deterministically", () => {
    const first = spawnSync("bun", ["run", "src/agent-discovery-coverage-cli.ts"], { encoding: "utf8" });
    const second = spawnSync("bun", ["run", "src/agent-discovery-coverage-cli.ts"], { encoding: "utf8" });
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const report = JSON.parse(first.stdout) as { ok: boolean; counts: { bindings: number }; coverageHash: string };
    expect(report.ok).toBe(true);
    expect(report.counts.bindings).toBeGreaterThan(400);
    expect(report.coverageHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects a new MCP tool, CLI subcommand and HTTP route with exact actionable names", () => {
    const base = fixture();
    const result = validateAgentDiscoveryCoverage(fixture({
      tools: [...base.tools, { name: "new_tool", annotations: { readOnlyHint: true, idempotentHint: true } }],
      commands: [...base.commands, { key: "new command" }], routes: [...base.routes, { method: "POST", pattern: "/new", effect: "write" }],
    }));
    const errors = result.errors.join("\n");
    expect(result.ok).toBe(false);
    expect(errors).toContain("mcp:new_tool: new public operation");
    expect(errors).toContain("cli:new command: new public operation");
    expect(errors).toContain("http:POST /new: new public operation");
  });

  test("rejects missing capability bindings and blanket standalone classifications", () => {
    const missing = validateAgentDiscoveryCoverage(fixture({ classifyOperation: () => [] }));
    expect(missing.errors.join("\n")).toContain("mcp:known: no live, machine-readable capability binding");
    const standalone = validateAgentDiscoveryCoverage(fixture({ standaloneOperationIds: ["mcp:known"] }));
    expect(standalone.errors.join("\n")).toContain("standalone classifications are not accepted: mcp:known");
  });

  test("rejects dangling workflow operations and dependencies", () => {
    const broken: AgentWorkflow = { ...workflow, steps: [{ ...workflow.steps[0]!, dependsOn: ["missing-step"], operation: { surface: "mcp", name: "missing-operation" } }] };
    const result = validateAgentDiscoveryCoverage(fixture({ workflows: [broken] }));
    expect(result.errors.join("\n")).toContain("dangling dependency 'missing-step'");
    expect(result.errors.join("\n")).toContain("mcp:missing-operation is not live and capability-bound");
  });

  test("rejects false surface safety, idempotency, actor and confirmation claims", () => {
    const falseClaims: AgentWorkflow = { ...workflow, steps: [{ ...workflow.steps[0]!, expectedSafety: "write", expectedIdempotent: false, requiresActor: true, requiresConfirmation: true, retryClass: "unsafe-read-back" }] };
    const errors = validateAgentDiscoveryCoverage(fixture({ workflows: [falseClaims] })).errors.join("\n");
    expect(errors).toContain("safety claim 'write' contradicts live 'read'");
    expect(errors).toContain("idempotency claim 'false' contradicts live 'true'");
    expect(errors).toContain("actor requirement contradicts the live surface");
    expect(errors).toContain("confirmation requirement contradicts the live surface");
    expect(errors).toContain("read operation must use safe-read retry semantics");
  });

  test("rejects a false retry class and exposes only the canonical classes", () => {
    const falseRetry: AgentWorkflow = { ...workflow, steps: [{ ...workflow.steps[0]!, retryClass: "unsafe-read-back" }] };
    const errors = validateAgentDiscoveryCoverage(fixture({ workflows: [falseRetry] })).errors.join("\n");
    expect(errors).toContain("retry class 'unsafe-read-back' contradicts live 'safe-read'");
    const catalogue = JSON.stringify(validateAgentDiscoveryCoverage(fixture()).bindings);
    expect(catalogue).not.toContain("read-back-before-retry");
    expect(catalogue).not.toContain("stable-key-resume");
    expect(catalogue).not.toContain("never-automatic");
  });

  test("rejects an unreviewed natural-idempotent hint instead of inferring a retry promise", () => {
    const result = validateAgentDiscoveryCoverage(fixture({
      tools: [{ name: "known", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } }],
      workflows: [],
    }));
    expect(result.errors.join("\n")).toContain("mcp:known: live idempotentHint has no explicit retry classification");
  });
});
