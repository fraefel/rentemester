// VAT period selection and position computation for the cockpit (#320).
//
// Split out of `server/data.ts` by #320. Every cockpit surface that shows a
// VAT figure — the portfolio card, the per-company Overblik, the dedicated
// Moms view, the Forpligtelser list — reads the same period selection and the
// same booked-VAT-account position from here, so they never disagree.
// Behaviour is unchanged from the pre-split `server/data.ts`.

import type { Database } from "bun:sqlite";
import { buildVatReport } from "../../core/vat";
import { percentOfDkk } from "../../core/money";
import { emptyVatRubric, type VatRubric } from "../../core/vat-rubric";
import {
  vatPeriodWindowFor,
  vatPeriodsForYear,
  vatPeriodLabel,
  effectivePeriodState,
  type VatPeriodType,
  type EffectivePeriodState,
} from "../../core/periods";
import { roundKroner, todayIsoDate } from "./shared";

export type VatPosition = {
  periodStart: string;
  periodEnd: string;
  /**
   * Output VAT (salgsmoms) for the period — the genuine VAT on sales, kroner.
   *
   * This is the *gross* figure: it does NOT have the bad-debt (debitortab)
   * output-VAT relief netted into it. A bad-debt write-off books a debit on
   * the output-VAT account, so a chart-of-accounts-level sum would let a large
   * write-off turn salgsmoms negative — a nonsensical headline for an owner
   * (#271). The relief is surfaced separately as `outputVatAdjustment`.
   */
  outputVat: number;
  /**
   * The bad-debt (debitortab) output-VAT adjustment for the period, kroner —
   * a value ≤ 0, the negative of the VAT relief claimed on written-off
   * receivables. Zero when no write-off falls in the period. Kept on its own
   * clearly-labelled line so it never silently drags salgsmoms negative.
   */
  outputVatAdjustment: number;
  /** Input VAT (købsmoms) booked for the period, kroner. */
  inputVat: number;
  /** outputVat + outputVatAdjustment − inputVat; positive is payable, kroner. */
  payable: number;
};

/**
 * The standard SKAT TastSelv momsangivelse rubrics for a VAT period — the
 * shape `core/vat-filing.ts#VatFilingRubrikker` produces, surfaced so the
 * cockpit shows the same numbers an owner files. All amounts are kroner.
 */
export type VatRubrikker = VatRubric;

/** Whether a VAT position carries any booked activity at all. */
function vatQuarterHasActivity(pos: VatPosition): boolean {
  return (
    pos.payable !== 0 ||
    pos.outputVat !== 0 ||
    pos.outputVatAdjustment !== 0 ||
    pos.inputVat !== 0
  );
}

/**
 * The VAT position for a period, computed from the VAT *amounts booked on the
 * VAT accounts themselves* — the truthful obligation regardless of how the
 * chart of accounts numbers them.
 *
 * A VAT account is any account that is `type = 'vat'` (the native-Rentemester
 * chart: `1200` Salgsmoms, `4000` Købsmoms) OR sits in the standard Danish VAT
 * block `64000`–`64099` (a Dinero-imported chart, where the VAT accounts are
 * typed `liability`). The `64100` settlement account is excluded — it only
 * moves money between the VAT accounts and the bank and is not itself an
 * obligation.
 *
 * Output VAT is the credit-signed movement of output-side VAT accounts; input
 * VAT the credit-signed movement of input-side ones. An account is input-side
 * when it is debit-normal (the native-Rentemester `4000` Købsmoms) or carries
 * a standard Danish input-VAT account number (`64060` Købsmoms; `64080`/
 * `64085`/`64090` afgift-reclaim). The net payable is output − input —
 * arithmetically the credit-signed net of every VAT account, so it is correct
 * regardless of how cleanly the input/output split lands. Money is kroner.
 */
const INPUT_VAT_ACCOUNT_NOS = new Set(["64060", "64080", "64085", "64090"]);

export function vatPositionForPeriod(
  db: Database,
  periodStart: string,
  periodEnd: string,
): VatPosition {
  const rows = db
    .query(
      `SELECT a.account_no     AS accountNo,
              a.normal_balance AS normalBalance,
              jl.debit_amount  AS debit,
              jl.credit_amount AS credit
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
         JOIN accounts a       ON a.id = jl.account_id
        WHERE je.status = 'posted'
          AND je.transaction_date >= ? AND je.transaction_date <= ?
          AND (a.type = 'vat'
               OR (a.account_no >= '64000' AND a.account_no < '64100'))`,
    )
    .all(periodStart, periodEnd) as Array<{
    accountNo: string;
    normalBalance: "debit" | "credit";
    debit: number;
    credit: number;
  }>;

  let bookedOutputVat = 0;
  let inputVat = 0;
  for (const row of rows) {
    const debit = Number(row.debit ?? 0);
    const credit = Number(row.credit ?? 0);
    const isInput =
      row.normalBalance === "debit" || INPUT_VAT_ACCOUNT_NOS.has(row.accountNo);
    if (isInput) {
      inputVat += debit - credit;
    } else {
      bookedOutputVat += credit - debit;
    }
  }

  bookedOutputVat = roundKroner(bookedOutputVat);
  inputVat = roundKroner(inputVat);

  // A bad-debt write-off (debitortab) books a debit on the output-VAT account
  // to claim back the VAT on a receivable that will never be paid. The booked
  // output-VAT total above therefore already has that relief netted in — a
  // large write-off can drive it negative. Split the relief back out so the
  // headline salgsmoms shows the genuine VAT on sales and the adjustment sits
  // on its own clearly-labelled line (#271). `buildVatReport` keys the relief
  // off the `DK_BAD_DEBT_25` vat-code base, the same source the CLI uses.
  const report = buildVatReport(db, periodStart, periodEnd);
  const outputVatAdjustment = roundKroner(
    -percentOfDkk(report.badDebtReliefBase25, 25),
  );
  // Genuine salgsmoms = booked output VAT with the relief added back in.
  const outputVat = roundKroner(bookedOutputVat - outputVatAdjustment);

  return {
    periodStart,
    periodEnd,
    outputVat,
    outputVatAdjustment,
    inputVat,
    payable: roundKroner(outputVat + outputVatAdjustment - inputVat),
  };
}

/**
 * The VAT period the cockpit surfaces — generalised over the company's VAT
 * cadence (#299).
 *
 * Selection mirrors the historical quarterly logic, period-type-agnostic: for
 * the current calendar year, prefer the period today falls in, falling back to
 * the latest active period when it (and every earlier one) is empty; for a past
 * year, the latest active period, or the year's first period when nothing has
 * activity. A monthly company picks among 12 periods, a quarterly company among
 * 4, a half-yearly company among 2 — but a `quarter` company gets the exact
 * same period the old `selectVatQuarter` did, so nothing observable changes.
 *
 * Returns the chosen period's window, its booked VAT position, a Danish label
 * and the statutory filing deadline so callers do not recompute any of it.
 */
export function selectVatPeriod(
  db: Database,
  year: number,
  vatType: VatPeriodType,
): {
  start: string;
  end: string;
  label: string;
  deadline: string;
  position: VatPosition;
} {
  const windows = vatPeriodsForYear(year, vatType);
  const positions = windows.map((w) => vatPositionForPeriod(db, w.start, w.end));

  const today = todayIsoDate();
  const currentYear = parseInt(today.slice(0, 4), 10);

  // The latest period index at or before `cap` that carries activity, or null.
  const latestActiveUpTo = (cap: number): number | null => {
    for (let i = windows.length - 1; i >= 0; i -= 1) {
      if (i <= cap && vatQuarterHasActivity(positions[i]!)) return i;
    }
    return null;
  };

  // The index of the period that contains today (clamped into the year).
  const indexOfDate = (iso: string): number => {
    const target = vatPeriodWindowFor(iso, vatType).start;
    const idx = windows.findIndex((w) => w.start === target);
    return idx >= 0 ? idx : windows.length - 1;
  };

  let selected: number;
  if (year === currentYear) {
    const currentIndex = indexOfDate(today);
    selected =
      latestActiveUpTo(currentIndex) ??
      latestActiveUpTo(windows.length - 1) ??
      currentIndex;
  } else {
    selected = latestActiveUpTo(windows.length - 1) ?? 0;
  }

  const window = windows[selected]!;
  return {
    start: window.start,
    end: window.end,
    label: vatPeriodLabel(window),
    deadline: window.filingDeadline,
    position: positions[selected]!,
  };
}

/**
 * The effective lifecycle state of the VAT period `start`..`end` — `open`,
 * `closed` or `reported` (#303). A momsangivelse may only be filed for a
 * closed or reported period; for an open period the cockpit must mark the
 * figures as provisional. Replays the append-only `period reopen`/`close`
 * audit lifecycle, so a period that was closed-then-reopened reads `open`.
 */
export function vatPeriodEffectiveStatus(
  db: Database,
  start: string,
  end: string,
): EffectivePeriodState {
  const row = db
    .query(
      `SELECT id, status
         FROM accounting_periods
        WHERE kind IN ('vat_period', 'vat_quarter')
          AND period_start = ? AND period_end = ?
        ORDER BY CASE kind WHEN 'vat_period' THEN 0 ELSE 1 END, id DESC
        LIMIT 1`,
    )
    .get(start, end) as
    | { id: number; status: "open" | "closed" | "reported" }
    | undefined;
  if (!row) return "open";
  return effectivePeriodState(db, row.id, row.status);
}

/**
 * The standard SKAT TastSelv momsangivelse rubrics for a VAT period.
 *
 * This is the SAME mapping `core/vat-filing.ts#buildVatFiling` applies, run
 * directly off `core/vat.ts#buildVatReport` so the cockpit can show the
 * rubrics for an *open* (not yet closed) period too — `buildVatFiling` itself
 * only produces a return for a closed `vat_quarter` accounting period. The
 * numbers are identical to what the CLI's `vat momsangivelse` reports once the
 * period is closed; the cockpit surface and the terminal therefore agree.
 */
export function vatRubrikkerForPeriod(
  db: Database,
  periodStart: string,
  periodEnd: string,
): VatRubrikker {
  return buildVatReport(db, periodStart, periodEnd).rubrikker;
}

/** A VatRubrikker with every rubric zeroed — used for an archived year. */
export function emptyVatRubrikker(): VatRubrikker {
  return emptyVatRubric();
}
