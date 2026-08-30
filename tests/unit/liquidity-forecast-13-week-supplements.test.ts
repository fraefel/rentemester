import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntry } from "../../src/core/ledger";
import { setBudget } from "../../src/core/budget";
import { initWorkspace } from "../../src/core/workspace";
import { createCompany } from "../../src/core/company";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { createParty } from "../../src/core/party-registry";
import { ingestCorporateRecord } from "../../src/core/corporate-records";
import { approveIntercompanyDisposition, proposeIntercompanyDisposition } from "../../src/core/intercompany-dispositions";
import { reviewedIntercompanyLiquiditySupplements } from "../../src/core/intercompany-liquidity";
import {
  buildThirteenWeekLiquidityForecast,
  type ReviewedLiquiditySupplement,
} from "../../src/core/liquidity-forecast";

function fixture() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "rm-liquidity-supplements-")), "ledger.sqlite"));
  migrate(db);
  db.run("INSERT INTO companies (id, name, country, currency) VALUES (1, 'Synthetic company', 'DK', 'DKK')");
  db.run("UPDATE companies SET vat_period_type = 'quarter' WHERE id = 1");
  seedAccounts(db);
  return db;
}

function reviewed(
  kind: ReviewedLiquiditySupplement["kind"],
  dueDate: string,
  amount: number,
  direction: ReviewedLiquiditySupplement["direction"] = "outflow",
): ReviewedLiquiditySupplement {
  return {
    kind,
    companyId: 1,
    dueDate,
    amount,
    currency: "DKK",
    direction,
    reference: `${kind}:${dueDate}:${amount}`,
    approvalReference: "review:synthetic",
  };
}

describe("13-week liquidity forecast reviewed supplements (#590)", () => {
  test("resolves only the selected company side of an approved workspace disposition", () => {
    const workspace = mkdtempSync(join(tmpdir(), "rm-liquidity-workspace-"));
    initWorkspace(workspace);
    const left = createCompany(workspace, { name: "Synthetic left", onboardingActor: "user:maker" });
    const right = createCompany(workspace, { name: "Synthetic right", onboardingActor: "user:maker" });
    const control = openWorkspaceControlDb(workspace);
    try {
      const party = createParty(control, { partyId: "party-liquidity", kind: "organization", name: "Synthetic party", source: "synthetic", observedAt: "2026-01-01T00:00:00Z", reviewAssertion: "synthetic", actor: "user:maker" });
      const record = ingestCorporateRecord(control, { recordId: "record-liquidity", type: "intercompany_agreement", bytes: new TextEncoder().encode("synthetic"), filename: "synthetic.txt", source: "synthetic", receivedAt: "2026-01-01T00:00:00Z", uploader: "user:maker", actor: "user:maker" });
      const input = { dispositionId: "disp-liquidity", type: "loan" as const, economicDate: "2026-01-01", settlementDueDate: "2026-01-09", amount: 75, currency: "DKK", partyIds: [party.partyId], evidenceRecordIds: [record.recordId], left: { companySlug: left.slug, role: "lender", expectedSide: "receivable" as const }, right: { companySlug: right.slug, role: "borrower", expectedSide: "payable" as const } };
      const proposed = proposeIntercompanyDisposition(control, input, { actor: "user:maker", principal: { kind: "user", id: "maker" } });
      approveIntercompanyDisposition(control, input.dispositionId, proposed.payloadHash, { actor: "user:review", principal: { kind: "user", id: "review" } });
      const foreign = { ...input, dispositionId: "disp-liquidity-eur", amount: 50, currency: "EUR" };
      const foreignProposal = proposeIntercompanyDisposition(control, foreign, { actor: "user:maker", principal: { kind: "user", id: "maker" } });
      approveIntercompanyDisposition(control, foreign.dispositionId, foreignProposal.payloadHash, { actor: "user:review", principal: { kind: "user", id: "review" } });
      expect(reviewedIntercompanyLiquiditySupplements(control, left.slug, 1, "2026-01-01", "2026-01-15")).toEqual(expect.arrayContaining([
        expect.objectContaining({ direction: "inflow", amount: 75, currency: "DKK", companyId: 1 }),
        expect.objectContaining({ direction: "inflow", amount: 50, currency: "EUR", companyId: 1 }),
      ]));
      expect(reviewedIntercompanyLiquiditySupplements(control, right.slug, 1, "2026-01-01", "2026-01-15")).toEqual(expect.arrayContaining([
        expect.objectContaining({ direction: "outflow", amount: 75, currency: "DKK", companyId: 1 }),
      ]));
      expect(reviewedIntercompanyLiquiditySupplements(control, "other", 1, "2026-01-01", "2026-01-15")).toEqual([]);
    } finally { control.close(); }
  });

  test("reads the effective ledger budget revision with account-level provenance", () => {
    const db = fixture();
    try {
      expect(setBudget(db, { accountNo: "3000", period: "2026-01", amount: 80 }).ok).toBe(true);
      expect(setBudget(db, { accountNo: "3000", period: "2026-01", amount: 90 }).ok).toBe(true);
      const forecast = buildThirteenWeekLiquidityForecast(db, { startDate: "2026-01-01" });
      expect(forecast.periods[0]).toMatchObject({ budgets: -90, closingCash: -90 });
      expect(forecast.periods[0]!.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "effective_budget_assumption", amount: -90, reference: "budget-revision:2:account:3000", assumption: true }),
      ]));
      expect(forecast.completeness.included.join(" ")).toContain("account-level budget assumptions");
      const midMonth = buildThirteenWeekLiquidityForecast(db, { startDate: "2026-01-15" });
      expect(midMonth.periods[0]).toMatchObject({ budgets: -90, closingCash: -90 });
    } finally { db.close(); }
  });

  test("includes a filing-safe canonical VAT obligation on its statutory due week", () => {
    const db = fixture();
    try {
      db.run(
        "INSERT INTO documents (document_no, source, sha256_hash, invoice_date, amount_inc_vat, currency) VALUES (?, ?, ?, ?, ?, ?)",
        "synthetic-vat-source", "synthetic", "a".repeat(64), "2025-12-15", 125, "DKK",
      );
      expect(postJournalEntry(db, {
        transactionDate: "2025-12-15",
        text: "Synthetic taxable sale",
        documentId: 1,
        lines: [
          { accountNo: "2000", debitAmount: 125 },
          { accountNo: "1000", creditAmount: 100, vatCode: "DK_SALE_25" },
          { accountNo: "1200", creditAmount: 25 },
        ],
      }).ok).toBe(true);
      const forecast = buildThirteenWeekLiquidityForecast(db, { startDate: "2026-02-01" });
      const vatWeek = forecast.periods.find((period) => period.sources.some((source) => source.source === "canonical_vat_obligation"));
      expect(vatWeek).toMatchObject({ obligations: 25 });
      expect(vatWeek!.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "canonical_vat_obligation", amount: -25, reference: "vat:2025-10-01:2025-12-31" }),
      ]));
    } finally { db.close(); }
  });

  test("keeps approved budgets and scenarios visibly distinct from booked facts", () => {
    const db = fixture();
    try {
      const forecast = buildThirteenWeekLiquidityForecast(db, {
        startDate: "2026-01-01",
        supplements: [
          reviewed("approved_budget_assumption", "2026-01-02", 120),
          reviewed("approved_scenario_assumption", "2026-01-03", 30, "inflow"),
        ],
      });
      expect(forecast.ok).toBe(true);
      expect(forecast.periods[0]).toMatchObject({
        budgets: -120,
        scenarios: 30,
        closingCash: -90,
      });
      expect(forecast.periods[0]!.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "approved_budget_assumption", amount: -120, assumption: true }),
        expect.objectContaining({ source: "approved_scenario_assumption", amount: 30, assumption: true }),
      ]));
    } finally { db.close(); }
  });

  test("includes reviewed tax and intercompany amounts only for the same legal company", () => {
    const db = fixture();
    try {
      const wrongCompany = { ...reviewed("approved_intercompany_disposition", "2026-01-04", 999), companyId: 2, reference: "intercompany:wrong-company" };
      const forecast = buildThirteenWeekLiquidityForecast(db, {
        startDate: "2026-01-01",
        supplements: [
          reviewed("legally_due_obligation", "2026-01-04", 40),
          reviewed("approved_intercompany_disposition", "2026-01-05", 15, "inflow"),
          wrongCompany,
        ],
      });
      expect(forecast.periods[0]).toMatchObject({ obligations: 40, intercompany: 15, closingCash: -25 });
      expect(forecast.periods[0]!.excluded).toEqual([
        expect.objectContaining({ source: "intercompany:wrong-company", reason: "company_scope_mismatch" }),
      ]);
    } finally { db.close(); }
  });

  test("does not silently convert foreign currency or accept an unreviewed supplement", () => {
    const db = fixture();
    try {
      const eur = { ...reviewed("legally_due_obligation", "2026-01-04", 40), currency: "EUR", reference: "tax:eur" };
      const noReview = { ...reviewed("approved_budget_assumption", "2026-01-04", 50), approvalReference: "", reference: "budget:no-review" };
      const forecast = buildThirteenWeekLiquidityForecast(db, { startDate: "2026-01-01", supplements: [eur, noReview] });
      expect(forecast.periods[0]).toMatchObject({ obligations: 0, budgets: 0, closingCash: 0 });
      expect(forecast.periods[0]!.excluded).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: "tax:eur", reason: "dated_fx_required", currency: "EUR" }),
        expect.objectContaining({ source: "budget:no-review", reason: "missing_review_or_invalid_canonical_reference" }),
      ]));
    } finally { db.close(); }
  });

  test("weekly closing cash reconciles exactly to every included source", () => {
    const db = fixture();
    try {
      const forecast = buildThirteenWeekLiquidityForecast(db, {
        startDate: "2026-01-01",
        supplements: [
          reviewed("approved_budget_assumption", "2026-01-02", 100),
          reviewed("legally_due_obligation", "2026-01-03", 70),
          reviewed("approved_intercompany_disposition", "2026-01-04", 25, "inflow"),
        ],
      });
      const first = forecast.periods[0]!;
      expect(first.closingCash).toBe(
        first.openingCash + first.receivables - first.payables - first.commitments +
        first.budgets + first.scenarios - first.obligations + first.intercompany,
      );
    } finally { db.close(); }
  });
});
