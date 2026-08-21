import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRecurringInvoiceTools } from "../../src/mcp/tools/recurring-invoice";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";
import { createCompany } from "../../src/core/company";
import { companyPaths } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { createRecurringInvoiceTemplate } from "../../src/core/recurring-invoices";

function harness() {
  const server = new McpServer({ name: "recurring-workspace-test", version: "0.0.0" });
  registerRecurringInvoiceTools(server);
  const tools = (server as any)._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<{ structuredContent: any }> }
  >;
  return {
    names: Object.keys(tools),
    call: async (args: unknown) => (await tools.recurring_invoice_run_workspace!.handler(
      args, { signal: new AbortController().signal },
    )).structuredContent,
  };
}

describe("recurring_invoice_run_workspace MCP", () => {
  test("is registered and requires explicit confirmation", async () => {
    const h = harness();
    expect(h.names).toContain("recurring_invoice_run_workspace");
    const result = await h.call({ workspace: "/does/not/matter", asOfDate: "2026-01-01" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("confirm");
  });

  test("runs a workspace without a per-company argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-recurring-mcp-workspace-"));
    try {
      initWorkspace(root);
      const company = createCompany(root, { name: "Alpha ApS", onboardingActor: "agent:unknown-mcp-client" });
      const companyRoot = companyRootForSlug(root, company.slug);
      const db = openDb(companyPaths(companyRoot).db);
      migrate(db);
      createRecurringInvoiceTemplate(db, {
        name: "Monthly",
        interval: "monthly",
        firstIssueDate: "2026-01-01",
        invoice: {
          invoiceType: "full", vatTreatment: "standard",
          seller: { name: "S", address: "A", vatOrCvr: "DK12345678" },
          buyer: { name: "B", address: "C" },
          lines: [{ description: "x", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }],
          totals: { netAmount: 100, vatRate: 0.25, vatAmount: 25, grossAmount: 125 }, currency: "DKK",
        },
      });
      db.close();
      const result = await harness().call({
        workspace: root,
        asOfDate: "2026-03-01",
        maxGenerations: 1,
        confirm: true,
      });
      expect(result.ok).toBe(true);
      expect(result.data.hasMore).toBe(true);
      expect(result.data.remainingGenerations).toBe(2);
      expect(result.data.continuation.companies).toEqual([{ slug: "alpha-aps", remainingGenerations: 2 }]);
      expect(result.data.companies).toEqual([
        expect.objectContaining({ slug: "alpha-aps", status: "processed", generated: 1, hasMore: true, remainingGenerations: 2 }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
