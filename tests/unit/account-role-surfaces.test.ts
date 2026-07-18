// Tests: #544 account-role confirmation across CLI and MCP boundaries.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { persistAccountRoleProposals } from "../../src/core/account-roles";
import { startMcpFixture, stopMcpFixture } from "./mcp-tool-schemas/_shared";

function addAlternativeBankProposal(companyRoot: string, accountNo: string): void {
  const db = openDb(ensureCompanyDirs(companyRoot).db);
  migrate(db);
  db.run(
    "INSERT INTO accounts (account_no, name, type, normal_balance) VALUES (?, 'Imported bank', 'asset', 'debit')",
    accountNo,
  );
  expect(persistAccountRoleProposals(db, [
    { role: "bank", accountNo, source: "dinero:chart:name-bank" },
  ])).toMatchObject({ stored: 1, reviewRequired: ["bank"] });
  db.close();
}

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stdout, stderr };
}

describe("#544 account-role surfaces", () => {
  test("CLI status is read-only and explicit confirmation preserves the canonical actor", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-role-cli-"));
    const company = join(root, "company");
    try {
      const initialized = await runCli(["init", "--company", company, "--actor", "user:role-tester"]);
      expect(initialized.exitCode).toBe(0);
      addAlternativeBankProposal(company, "9910");

      const status = await runCli(["accounts", "roles-status", "--company", company, "--format", "json"]);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        ok: true,
        status: "incomplete",
        proposals: [expect.objectContaining({ role: "bank", accountNo: "9910", compatible: true })],
      });

      const confirmed = await runCli([
        "accounts", "role-confirm", "--company", company,
        "--role", "bank", "--account", "9910",
        "--actor", "user:role-tester", "--format", "json",
      ]);
      expect({ exitCode: confirmed.exitCode, stderr: confirmed.stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(confirmed.stdout)).toMatchObject({
        ok: true,
        resolution: { accountNo: "9910", confirmedBy: "user:role-tester", confirmationSource: "explicit" },
      });

      const db = openDb(ensureCompanyDirs(company).db);
      expect(db.query("SELECT actor FROM audit_log WHERE event_type = 'account_role_confirmed' AND entity_id = 'bank' ORDER BY id DESC LIMIT 1").get())
        .toEqual({ actor: "user:role-tester via rentemester-cli" });
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MCP exposes normal confirm envelopes and attributes the client actor", async () => {
    const { companyRoot, client } = await startMcpFixture();
    try {
      addAlternativeBankProposal(companyRoot, "9920");
      const omitted = await client.send("tools/call", {
        name: "accounts_role_confirm",
        arguments: { company: companyRoot, role: "bank", accountNo: "9920" },
      });
      expect(omitted.error).toBeUndefined();
      expect(omitted.result?.structuredContent).toMatchObject({ ok: false, errors: [expect.stringContaining("confirm: true")] });

      const confirmed = await client.send("tools/call", {
        name: "accounts_role_confirm",
        arguments: { company: companyRoot, role: "bank", accountNo: "9920", confirm: true },
      });
      expect(confirmed.error).toBeUndefined();
      expect(confirmed.result?.structuredContent).toMatchObject({
        ok: true,
        data: { resolution: { accountNo: "9920", confirmationSource: "explicit" } },
      });
      const actor = confirmed.result?.structuredContent?.data?.resolution?.confirmedBy;
      expect(actor).toMatch(/^agent:/);
    } finally {
      await stopMcpFixture(companyRoot, client);
    }
  });
});
