// Tests: src/core/issued-invoices.ts issueInvoice — EJER-6 (issue-time warning).
//
// Issuing an invoice dated inside an already-closed (or reported) accounting
// period is not blocked — the invoice document itself is not a ledger posting —
// but the journal entry that books it WILL be rejected by the period lock, and
// a fortløbende-nummer hole or a stuck invoice results. issueInvoice now returns
// a non-blocking WARNING so the owner is told the date lands in a locked period.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { closeAccountingPeriod } from "../helpers/close-period";
import { issueInvoice } from "../../src/core/issued-invoices";

function freshDb(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

const PAYLOAD = {
  invoiceType: "full" as const,
  vatTreatment: "standard" as const,
  seller: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
  buyer: { name: "Kunde A/S", address: "Købervej 9" },
  lines: [{ description: "Bogføring", quantity: 1, unitPriceExVat: 1000, lineTotalExVat: 1000 }],
  totals: { netAmount: 1000, vatRate: 0.25, vatAmount: 250, grossAmount: 1250 },
  currency: "DKK",
};

describe("issue-time closed-period warning (EJER-6)", () => {
  test("issuing an invoice dated in a closed period succeeds but warns", () => {
    const { root, db } = freshDb("rentemester-issue-closed-");

    // Close Q1 2025 (a fully past period, no force needed).
    expect(
      closeAccountingPeriod(db, {
        periodStart: "2025-01-01",
        periodEnd: "2025-03-31",
        kind: "vat_quarter",
      }).ok,
    ).toBe(true);

    const result = issueInvoice(db, root, {
      ...PAYLOAD,
      issueDate: "2025-02-15",
      invoiceNumber: "2025-0001",
    });

    // The invoice is still issued (the document is not a ledger posting)...
    expect(result.ok).toBe(true);
    // ...but the owner is warned the date falls in a locked period.
    expect(result.warnings ?? []).not.toEqual([]);
    expect((result.warnings ?? []).join(" ").toLowerCase()).toMatch(/closed|lukket|period/);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("issuing an invoice in an open period carries no period warning", () => {
    const { root, db } = freshDb("rentemester-issue-open-");
    const result = issueInvoice(db, root, {
      ...PAYLOAD,
      issueDate: "2025-02-15",
      invoiceNumber: "2025-0001",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings ?? []).toEqual([]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
