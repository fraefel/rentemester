// Tests: src/mcp/tools/vat.ts (vat_eu_sales_list, vat_oss_report MCP tools)
//
// Drives the registered tool callbacks in-process through a McpServer — the
// same surface the JSON-RPC `tools/call` path invokes after schema validation
// (the pattern from mcp-portfolio.test.ts). The stdio JSON-RPC protocol layer
// itself is covered end-to-end by mcp-server.test.ts; spawning a second child
// server here added no coverage but made the test sensitive to load/shared
// process state in the full suite (structuredContent intermittently missing).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntry } from "../../src/core/ledger";
import { ingestDocument } from "../../src/core/documents";
import { initialiseCompanyVolume } from "../../src/core/company";
import { registerVatTools } from "../../src/mcp/tools/vat";

/**
 * Fresh McpServer with the VAT tools registered, exposing a `call(name, args)`
 * that drives a tool's registered callback and returns its structuredContent
 * envelope — mirroring how the JSON-RPC `tools/call` path invokes it.
 */
function harness() {
  const server = new McpServer({ name: "vat-tools-test", version: "0.0.0" });
  registerVatTools(server);
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<{ structuredContent: unknown }> }
  >;
  return {
    toolNames: () => Object.keys(tools),
    async call(name: string, args: unknown) {
      const tool = tools[name];
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const result = await tool.handler(args, { signal: new AbortController().signal });
      return result.structuredContent as { ok: boolean; data?: any; errors: string[] };
    },
  };
}

let companyRoot: string;

beforeAll(async () => {
  companyRoot = mkdtempSync(join(tmpdir(), "mcp-vat-eulist-"));
  const inbox = mkdtempSync(join(tmpdir(), "mcp-vat-eulist-inbox-"));
  const paths = ensureCompanyDirs(companyRoot);
  const db = openDb(paths.db);
  migrate(db);
  seedAccounts(db);
  // An OSS consumer sale so vat_oss_report has real data to surface.
  const sourceFile = join(inbox, "oss.txt");
  await Bun.write(sourceFile, "Invoice\n2000 DKK\n");
  const doc = ingestDocument(db, companyRoot, sourceFile, {
    source: "email",
    issueDate: "2026-03-15",
    invoiceNo: "MCP-OSS-1",
    deliveryDescription: "Digital ydelse",
    amountIncVat: 2000,
    currency: "DKK",
    sender: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
    recipient: { name: "EU forbruger", address: "EU-vej 1", vatOrCvr: "DK99887766" },
    vatAmount: 0,
    paymentDetails: "Kort",
  });
  expect(doc.ok).toBe(true);
  const posted = postJournalEntry(db, {
    transactionDate: "2026-03-12",
    text: "OSS salg",
    documentId: doc.documentId!,
    lines: [
      { accountNo: "2000", debitAmount: 2000 },
      { accountNo: "1000", creditAmount: 2000, vatCode: "OSS_EU_CONSUMER" },
    ],
  });
  expect(posted.ok).toBe(true);
  db.close();
  rmSync(inbox, { recursive: true, force: true });
});

afterAll(() => {
  if (companyRoot && existsSync(companyRoot)) {
    rmSync(companyRoot, { recursive: true, force: true });
  }
});

describe("vat_eu_sales_list MCP tool", () => {
  test("registerVatTools exposes vat_eu_sales_list and vat_oss_report", () => {
    const h = harness();
    const names = h.toolNames();
    expect(names).toContain("vat_eu_sales_list");
    expect(names).toContain("vat_oss_report");
  });

  test("vat_eu_sales_list returns an ok envelope on a company with no EU B2B sales", async () => {
    const h = harness();
    const env = await h.call("vat_eu_sales_list", {
      company: companyRoot,
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(env.ok, JSON.stringify(env)).toBe(true);
    expect(env.data?.customers).toEqual([]);
    expect(env.data?.totalValue).toBe(0);
  });

  test("vat_oss_report surfaces the OSS consumer-sales base", async () => {
    const h = harness();
    const env = await h.call("vat_oss_report", {
      company: companyRoot,
      from: "2026-01-01",
      to: "2026-03-31",
    });
    expect(env.ok, JSON.stringify(env)).toBe(true);
    expect(env.data?.ossConsumerSalesBase).toBe(2000);
    expect(env.data?.submission).toBe(false);
  });
});

// The report-class MCP tools must mirror the CLI gate: a NOT VAT-registered
// company (vat_period_type = null) gets an { ok:false } refusal, never an
// empty-rubrikker report (DK-VAT-REGISTRATION-001). Without the gate in
// src/mcp/tools/vat.ts these tools would build a report straight from core.
describe("VAT report MCP tools refuse a non-registered company", () => {
  let nonVatRoot: string;
  beforeAll(() => {
    nonVatRoot = mkdtempSync(join(tmpdir(), "mcp-vat-no-reg-"));
    initialiseCompanyVolume(nonVatRoot, { name: "Holding ApS", vatPeriodType: null });
  });
  afterAll(() => {
    if (nonVatRoot && existsSync(nonVatRoot)) {
      rmSync(nonVatRoot, { recursive: true, force: true });
    }
  });

  for (const name of ["vat_report", "vat_eu_sales_list", "vat_oss_report"]) {
    test(`${name} refuses with 'ikke momsregistreret'`, async () => {
      const h = harness();
      const env = await h.call(name, {
        company: nonVatRoot,
        from: "2026-01-01",
        to: "2026-03-31",
      });
      expect(env.ok, JSON.stringify(env)).toBe(false);
      expect(env.errors.join(" ")).toContain("ikke momsregistreret");
    });
  }
});
