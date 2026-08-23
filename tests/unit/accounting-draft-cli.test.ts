import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCompany } from "../../src/core/company";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";

type CliResult = {
  ok: boolean;
  errors?: string[];
  accountingDraft?: { eventHash: string; status: string; journal?: { entryId?: number } };
};

async function run(args: string[]): Promise<{ exit: number; result: CliResult }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args, "--format", "json"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RENTEMESTER_ACTOR: "", RENTEMESTER_ACTOR_VIA: "" },
  });
  const stdout = await new Response(proc.stdout).text();
  return { exit: await proc.exited, result: JSON.parse(stdout) as CliResult };
}

describe("accounting-draft CLI", () => {
  test("requires independent allowlisted actors and retries an exact approved submission without reposting", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-accounting-draft-cli-"));
    try {
      initWorkspace(root);
      const company = createCompany(root, { name: "Synthetic Example", onboardingActor: "agent:author" });
      const companyRoot = companyRootForSlug(root, company.slug);
      writeFileSync(
        join(companyPaths(companyRoot).config, "policy.yaml"),
        "actor_allowlist:\n  agents:\n    - agent:author\n    - agent:reviewer\n",
      );
      const input = join(companyRoot, "draft.json");
      writeFileSync(input, JSON.stringify({
        transactionDate: "2026-08-23",
        text: "Synthetic draft",
        lines: [
          { accountNo: "1100", debitAmount: 100 },
          { accountNo: "2000", creditAmount: 100 },
        ],
      }));
      const common = ["--company", companyRoot];
      const created = await run(["accounting-draft", "create", ...common, "--draft-id", "synthetic-draft", "--input", input, "--actor", "agent:author"]);
      expect(created).toMatchObject({ exit: 0, result: { ok: true, accountingDraft: { status: "created" } } });
      const submitted = await run(["accounting-draft", "submit", ...common, "--draft-id", "synthetic-draft", "--expected-event-hash", created.result.accountingDraft!.eventHash, "--actor", "agent:author"]);
      expect(submitted).toMatchObject({ exit: 0, result: { ok: true, accountingDraft: { status: "submitted" } } });

      const selfApproval = await run(["accounting-draft", "approve-and-post", ...common, "--draft-id", "synthetic-draft", "--expected-event-hash", submitted.result.accountingDraft!.eventHash, "--confirm", "yes", "--actor", "agent:author"]);
      expect(selfApproval.exit).toBe(1);
      expect(selfApproval.result.errors?.join(" ")).toContain("distinct");

      const approved = await run(["accounting-draft", "approve-and-post", ...common, "--draft-id", "synthetic-draft", "--expected-event-hash", submitted.result.accountingDraft!.eventHash, "--confirm", "yes", "--actor", "agent:reviewer"]);
      expect(approved).toMatchObject({ exit: 0, result: { ok: true, accountingDraft: { status: "approved_posted" } } });
      const retried = await run(["accounting-draft", "approve-and-post", ...common, "--draft-id", "synthetic-draft", "--expected-event-hash", submitted.result.accountingDraft!.eventHash, "--confirm", "yes", "--actor", "agent:reviewer"]);
      expect(retried.result.accountingDraft?.journal?.entryId).toBe(approved.result.accountingDraft?.journal?.entryId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
