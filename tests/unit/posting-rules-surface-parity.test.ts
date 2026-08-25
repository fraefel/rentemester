import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("posting-rule lifecycle and dry-run actions are present on every adapter", () => {
  const cli = readFileSync("src/cli/posting-rules.ts", "utf8");
  const mcp = readFileSync("src/mcp/tools/posting-rules.ts", "utf8");
  const http = readFileSync("src/server/write-handlers/posting-rules.ts", "utf8");
  for (const action of ["propose", "approve", "disable", "supersede"]) {
    expect(cli).toContain(`"${action}"`);
    expect(mcp).toContain(`posting_rule_${action}`);
    expect(http).toContain(`"${action}"`);
  }
  expect(cli).toContain("evaluatePostingRules");
  expect(mcp).toContain("evaluatePostingRules");
  expect(readFileSync("src/server/router/posting-rules.ts", "utf8")).toContain("evaluatePostingRules");
});
