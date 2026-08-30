// Budget read-side for the cockpit (#339).
//
// Two thin builders backing the per-company "Budget" view:
//
//   - `buildCompanyBudget` — the effective (latest-revision) budget lines for
//     a company, optionally filtered by year. Latest-revision-wins is handled
//     by `core/budget.ts#listBudget`; this module only opens the ledger, picks
//     the periods inside the selected fiscal year, and shapes the JSON envelope
//     the cockpit consumes.
//
//   - `buildCompanyBudgetVsActual` — calls
//     `core/budget.ts#buildBudgetVsActual` over the same calendar months and
//     returns the comparison table the cockpit renders. Every figure is
//     computed by the core report — no logic is duplicated here.
//
// Money is kroner throughout. Behaviour is deterministic: the same ledger and
// the same `year=` argument yields byte-identical output, run after run, just
// like every other server/data builder.

import {
  buildDimensionActuals,
  buildBudgetVsActual,
  listBudget,
  periodsInRange,
  type BudgetLine,
  type BudgetVsActualLine,
  type BudgetVsActualReport,
} from "../../core/budget";
import { ApiError } from "../errors";
import {
  resolveStatementContext,
  statementCompanyBlock,
  type FiscalYearEntry,
  type StatementCompanyBlock,
} from "./shared";

/** One effective (latest-revision) budget line, kroner. */
export type CompanyBudgetLine = {
  id: number;
  accountNo: string;
  accountName: string | null;
  period: string;
  amount: number;
  notes: string | null;
  createdAt: string;
};

/** The full Budget view payload for a company in one fiscal year. */
export type CompanyBudget = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompanyBlock;
  fiscalYears: FiscalYearEntry[];
  /** First and last calendar month covered by the fiscal year, `YYYY-MM`. */
  periodStart: string;
  periodEnd: string;
  /** Every calendar month inside the fiscal year, chronological. */
  periods: string[];
  /** Effective budget lines for this fiscal year, ordered period→account. */
  lines: CompanyBudgetLine[];
  /** Sum of every line's amount across the fiscal year, kroner. */
  totalBudget: number;
};

/** One row in the budget-vs-actual report. */
export type CompanyBudgetVsActualLine = BudgetVsActualLine & {
  /** Variance as a fraction of `budget`; null when `budget` is 0. */
  variancePercent: number | null;
};

/** The Budget vs. faktisk report payload for a company in one fiscal year. */
export type CompanyBudgetVsActual = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompanyBlock;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  lines: CompanyBudgetVsActualLine[];
  totalBudget: number;
  totalActual: number;
  totalVariance: number;
};

/**
 * Canonical, approved dimension classifications beside the legal account
 * budget. Budgets are intentionally NOT allocated to dimensions: a classified
 * subset is useful for review, but must never be represented as a separate
 * dimension budget unless one has been explicitly modelled and reviewed.
 */
export type CompanyBudgetDimensionActuals = {
  slug: string;
  selectedYear: string;
  archived: boolean;
  company: StatementCompanyBlock;
  fiscalYears: FiscalYearEntry[];
  periodStart: string;
  periodEnd: string;
  rows: Array<{
    dimensionId: string;
    memberId: string;
    accountNo: string;
    period: string;
    actual: number;
    journalLineId: number;
  }>;
  /** Legal whole-account actuals, included to make partial classification visible. */
  accountTotals: Array<{ accountNo: string; period: string; actual: number }>;
  /** Deterministic selector values based solely on current approved assignments. */
  dimensionOptions: Array<{ value: string; label: string }>;
  budgetScope: "account";
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Derive the `[YYYY-MM, YYYY-MM]` period range for a fiscal-year label. */
function fiscalYearPeriodRange(
  year: FiscalYearEntry | undefined,
  selectedLabel: string,
): { periodStart: string; periodEnd: string } {
  // A `live` fiscal year carries its calendar start/end on disk. Slice the
  // `YYYY-MM` prefix so the budget endpoints span EVERY month in the year.
  if (year && year.start && year.end) {
    return {
      periodStart: year.start.slice(0, 7),
      periodEnd: year.end.slice(0, 7),
    };
  }
  // Archived years carry only the calendar-year label. Treat it as a full
  // January→December span — budgets are always month-keyed, so this matches
  // a label like "2026" to its twelve calendar months without further input.
  if (/^\d{4}$/.test(selectedLabel)) {
    return { periodStart: `${selectedLabel}-01`, periodEnd: `${selectedLabel}-12` };
  }
  // Last-resort fallback (a synthetic label not on disk): use today's year.
  const y = new Date().getUTCFullYear();
  return { periodStart: `${y}-01`, periodEnd: `${y}-12` };
}

// --------------------------------------------------------------------------
// Read builders
// --------------------------------------------------------------------------

/**
 * The Budget view for a company in one fiscal year — the effective budget
 * lines, the period skeleton the grid is laid out over, and the total budget.
 *
 * `year` defaults to the company's most recent live fiscal year (the same
 * default `buildCompanyOverview` and friends pick). An archived-only year is
 * surfaced too (`archived: true`) so the cockpit can still show the historical
 * budget rows even when the ledger no longer carries the actuals.
 */
export function buildCompanyBudget(
  workspaceRoot: string,
  slug: string,
  year: number | null,
): CompanyBudget {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const selectedYear = ctx.years.find((y) => y.label === ctx.selectedLabel);
    const { periodStart, periodEnd } = fiscalYearPeriodRange(
      selectedYear,
      ctx.selectedLabel,
    );
    const periods = periodsInRange(periodStart, periodEnd);

    // Pull every effective line and clip to the fiscal-year window. A flat
    // listBudget call is fine — budgets are bounded by the number of accounts
    // × periods the owner has filled out, never the ledger volume.
    const all = listBudget(ctx.db);
    const lines: CompanyBudgetLine[] = (all.rows as BudgetLine[])
      .filter((row) => row.period >= periodStart && row.period <= periodEnd)
      .map((row) => ({
        id: row.id,
        accountNo: row.accountNo,
        accountName: row.accountName,
        period: row.period,
        amount: row.amount,
        notes: row.notes,
        createdAt: row.createdAt,
      }));
    const totalBudget = lines.reduce((sum, l) => sum + l.amount, 0);

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: ctx.isArchivedOnly,
      company: statementCompanyBlock(ctx.company),
      fiscalYears: ctx.years,
      periodStart,
      periodEnd,
      periods,
      lines,
      totalBudget,
    };
  } finally {
    ctx.db.close();
  }
}

/**
 * The Budget-vs-actual comparison for a company in one fiscal year. Third
 * caller (after the CLI report and any direct core consumer) of
 * `buildBudgetVsActual`, so the comparison is identical across every surface.
 *
 * Each row also carries a `variancePercent` — variance as a fraction of the
 * budget figure, null when the budget is zero (the only case where percent
 * has no meaningful value). The frontend then formats it with `formatPercent`.
 */
export function buildCompanyBudgetVsActual(
  workspaceRoot: string,
  slug: string,
  year: number | null,
): CompanyBudgetVsActual {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const selectedYear = ctx.years.find((y) => y.label === ctx.selectedLabel);
    const { periodStart, periodEnd } = fiscalYearPeriodRange(
      selectedYear,
      ctx.selectedLabel,
    );
    const report: BudgetVsActualReport = buildBudgetVsActual(
      ctx.db,
      periodStart,
      periodEnd,
    );
    if (!report.ok) {
      throw ApiError.badRequest(
        report.errors.length > 0
          ? report.errors.join("; ")
          : "kunne ikke bygge budget-vs-actual",
      );
    }

    const lines: CompanyBudgetVsActualLine[] = report.lines.map((line) => ({
      ...line,
      variancePercent:
        line.budget === 0 ? null : line.variance / line.budget,
    }));

    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: ctx.isArchivedOnly,
      company: statementCompanyBlock(ctx.company),
      fiscalYears: ctx.years,
      periodStart: report.periodStart,
      periodEnd: report.periodEnd,
      lines,
      totalBudget: report.totalBudget,
      totalActual: report.totalActual,
      totalVariance: report.totalVariance,
    };
  } finally {
    ctx.db.close();
  }
}

/**
 * Read-only dimension drill-down for the budget cockpit (#589). It uses the
 * same fiscal-year resolution as the normal budget report and only current,
 * approved assignment events from the ledger view.  Archive years deliberately
 * return no dimensions: imported historical posting rows have no immutable
 * journal-line identity to which an assignment can safely be attached.
 */
export function buildCompanyBudgetDimensionActuals(
  workspaceRoot: string,
  slug: string,
  year: number | null,
): CompanyBudgetDimensionActuals {
  const ctx = resolveStatementContext(workspaceRoot, slug, year);
  try {
    const selectedYear = ctx.years.find((y) => y.label === ctx.selectedLabel);
    const { periodStart, periodEnd } = fiscalYearPeriodRange(selectedYear, ctx.selectedLabel);
    let rows: CompanyBudgetDimensionActuals["rows"] = [];
    let accountTotals: CompanyBudgetDimensionActuals["accountTotals"] = [];
    if (!ctx.isArchivedOnly) {
      const raw = buildDimensionActuals(ctx.db, periodStart, periodEnd);
      if (!raw.ok) {
        throw ApiError.badRequest(raw.errors.join("; ") || "kunne ikke bygge dimensionsaktualer");
      }
      rows = raw.rows;
      // Comparison context is limited to the account/month cells that have a
      // current approved dimension assignment. Unrelated balancing accounts
      // would add noise and could be mistaken for dimension coverage.
      const comparedCells = new Set(rows.map((row) => `${row.accountNo}\u001f${row.period}`));
      accountTotals = (raw.accountTotals ?? []).filter((row) =>
        comparedCells.has(`${row.accountNo}\u001f${row.period}`),
      );
    }
    const options = new Map<string, string>();
    for (const row of rows) {
      options.set(row.dimensionId, row.dimensionId);
      options.set(`${row.dimensionId}:${row.memberId}`, `${row.dimensionId}: ${row.memberId}`);
    }
    return {
      slug: ctx.entry.slug,
      selectedYear: ctx.selectedLabel,
      archived: ctx.isArchivedOnly,
      company: statementCompanyBlock(ctx.company),
      fiscalYears: ctx.years,
      periodStart,
      periodEnd,
      rows,
      accountTotals,
      dimensionOptions: [...options.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.value.localeCompare(b.value)),
      budgetScope: "account",
    };
  } finally {
    ctx.db.close();
  }
}
