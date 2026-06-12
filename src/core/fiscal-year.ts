import type { FiscalYearLabelStrategy } from "./company";
import { isValidIsoDate } from "./dates";

export type FiscalYear = {
  startYear: number;
  endYear: number;
  start: string;
  end: string;
  displayLabel: string;
  identifierLabel: string;
};

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Statutory årsrapport filing deadline for a regnskabsklasse-B company
 * (ÅRL § 138): no later than 6 MONTHS after the fiscal year ends.
 *
 * Month arithmetic preserves "last day of month": a fiscal year ending
 * 31/12 files by 30/6 the following year; one ending 30/6 files by 31/12.
 * A day with no counterpart in the target month clamps to that month's last
 * day (31/8 → 28/2, or 29/2 in a leap year).
 */
export function annualReportDeadline(fiscalYearEnd: string): string {
  if (!isValidIsoDate(fiscalYearEnd)) throw new Error(`invalid ISO date: ${fiscalYearEnd}`);
  const year = Number(fiscalYearEnd.slice(0, 4));
  const month = Number(fiscalYearEnd.slice(5, 7));
  const day = Number(fiscalYearEnd.slice(8, 10));
  const monthIndex = month - 1 + 6;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  const lastDayTarget = lastDayOfMonth(targetYear, targetMonth);
  const endsOnLastDay = fiscalYearEnd === lastDayOfMonth(year, month);
  if (endsOnLastDay) return lastDayTarget;
  const clampedDay = Math.min(day, Number(lastDayTarget.slice(8, 10)));
  return `${targetYear}-${pad2(targetMonth)}-${pad2(clampedDay)}`;
}

export function fiscalYearForDate(
  dateText: string,
  startMonth: number,
  strategy: FiscalYearLabelStrategy,
): FiscalYear {
  if (!isValidIsoDate(dateText)) throw new Error(`invalid ISO date: ${dateText}`);
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(5, 7));
  const normalizedStartMonth = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
  const startYear = normalizedStartMonth === 1 || month >= normalizedStartMonth ? year : year - 1;
  const endYear = normalizedStartMonth === 1 ? startYear : startYear + 1;
  const displayLabel = strategy === "start-year"
    ? `${startYear}`
    : strategy === "span" && normalizedStartMonth !== 1
      ? `${startYear}/${String(endYear).slice(-2)}`
      : `${endYear}`;

  return {
    startYear,
    endYear,
    start: `${startYear}-${pad2(normalizedStartMonth)}-01`,
    end: normalizedStartMonth === 1
      ? `${endYear}-12-31`
      : lastDayOfMonth(endYear, normalizedStartMonth - 1),
    displayLabel,
    identifierLabel: displayLabel.replaceAll("/", "-"),
  };
}
