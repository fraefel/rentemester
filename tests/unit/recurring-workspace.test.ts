import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCompany } from "../../src/core/company";
import { companyRootForSlug, initWorkspace, saveWorkspaceManifest } from "../../src/core/workspace";
import { runWorkspaceRecurringInvoices } from "../../src/core/recurring-workspace";
import { companyPaths } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { createRecurringInvoiceTemplate } from "../../src/core/recurring-invoices";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-recurring-workspace-"));
  initWorkspace(root);
  createCompany(root, { name: "Zulu ApS", onboardingActor: "agent:codex" });
  createCompany(root, { name: "Alpha ApS", onboardingActor: "agent:codex" });
  saveWorkspaceManifest(root, {
    version: 1,
    companies: [
      { slug: "zulu-aps", name: "Zulu ApS", createdAt: "2026-01-01T00:00:00.000Z", archived: false },
      { slug: "alpha-aps", name: "Alpha ApS", createdAt: "2026-01-01T00:00:00.000Z", archived: false },
      { slug: "archived", name: "Archived", createdAt: "2026-01-01T00:00:00.000Z", archived: true },
      { slug: "uninitialized", name: "Uninitialized", createdAt: "2026-01-01T00:00:00.000Z", archived: false },
    ],
  });
  mkdirSync(join(root, "uninitialized"), { recursive: true });
  return root;
}

describe("workspace recurring runner", () => {
  test("uses stable manifest order, skips archived/uninitialized and continues after a company failure", async () => {
    const root = setup();
    try {
      const seen: string[] = [];
      const result = await runWorkspaceRecurringInvoices(root, {
        asOfDate: "2026-01-01",
        actor: { createdBy: "agent:codex", createdByProgram: "test" },
        runCompany: ({ slug }) => {
          seen.push(slug);
          return slug === "alpha-aps"
            ? { ok: false, generated: 0, attempted: 0 }
            : { ok: true, generated: 2, attempted: 0, hasMore: true, remainingGenerations: 3, continuation: { remainingGenerations: 3 } };
        },
      });
      expect(seen).toEqual(["alpha-aps", "zulu-aps"]);
      expect(result).toEqual({ ok: false, errors: ["recurring run failed for company alpha-aps"], hasMore: true, remainingGenerations: 3, continuation: { remainingGenerations: 3, companies: [{ slug: "zulu-aps", remainingGenerations: 3 }] }, companies: [
        { slug: "archived", status: "skipped", reason: "archived" },
        { slug: "uninitialized", status: "skipped", reason: "not initialized" },
        { slug: "alpha-aps", status: "failed", reason: "run failed", generated: 0, attempted: 0, hasMore: false, remainingGenerations: 0 },
        { slug: "zulu-aps", status: "processed", generated: 2, attempted: 0, hasMore: true, remainingGenerations: 3, continuation: { remainingGenerations: 3 } },
      ] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("turns a post-attempt non-acknowledgement into a company and aggregate failure", async () => {
    const root = setup();
    try {
      const alphaRoot = companyRootForSlug(root, "alpha-aps");
      const db = openDb(companyPaths(alphaRoot).db); migrate(db);
      createRecurringInvoiceTemplate(db, {
        name: "Email", interval: "monthly", deliveryChannel: "email", firstIssueDate: "2026-01-01",
        invoice: {
          invoiceType: "full", vatTreatment: "standard",
          seller: { name: "S", address: "A", vatOrCvr: "DK12345678" }, buyer: { name: "B", address: "C" },
          lines: [{ description: "x", quantity: 1, unitPriceExVat: 100, lineTotalExVat: 100 }],
          totals: { netAmount: 100, vatRate: 0.25, vatAmount: 25, grossAmount: 125 }, currency: "DKK",
        },
      });
      db.close();
      const result = await runWorkspaceRecurringInvoices(root, {
        asOfDate: "2026-01-01",
        actor: { createdBy: "agent:codex", createdByProgram: "test" },
        adapterForCompany: () => ({
          preflight: async () => ({ ok: true }),
          deliver: async () => ({ status: "uncertain", message: "transport timed out" }),
        }),
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(["recurring run failed for company alpha-aps"]);
      expect(result.companies).toContainEqual(expect.objectContaining({ slug: "alpha-aps", status: "failed", attempted: 1 }));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
