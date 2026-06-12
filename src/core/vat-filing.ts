import type { Database } from "bun:sqlite";
import { buildVatReport, vatFilingDeadline, type VatPeriodReport } from "./vat";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { addDkk, subtractDkk } from "./money";

/**
 * Filing-ready momsangivelse (Danish VAT return).
 *
 * Maps the raw VAT data from {@link buildVatReport} into the standard SKAT
 * rubrikker a user submits via TastSelv. Conservative by design: Rentemester
 * produces the numbers, the user files them. No direct SKAT submission, no
 * OSS/MOSS one-stop-shop.
 *
 * A momsangivelse can only be produced for a VAT period that has been closed
 * (or marked reported) as a vat_quarter accounting period — an open or
 * incomplete period fails clearly. All amounts are integer-øre-deterministic
 * via the money helpers; 25% is the only Danish standard rate.
 */
export type VatFilingRubrikker = {
  /** Salgsmoms — output VAT on domestic sales (net of bad-debt relief). */
  salgsmoms: number;
  /** Moms af varekøb i udlandet — VAT on goods purchased abroad. */
  momsAfVarekobUdland: number;
  /** Moms af ydelseskøb i udlandet — VAT on services purchased abroad (reverse charge). */
  momsAfYdelseskobUdland: number;
  /** Købsmoms — total deductible input VAT. */
  kobsmoms: number;
  /** Momstilsvar — salgsmoms + udenlandsk moms − købsmoms. Positive = owed to SKAT. */
  momstilsvar: number;
  /** Rubrik A — value of goods/services purchased abroad without Danish VAT. */
  rubrikA: number;
  /** Rubrik B — value of goods/services sold abroad without Danish VAT. */
  rubrikB: number;
  /** Rubrik C — value of other sales exempt from VAT. */
  rubrikC: number;
};

export type VatFilingReport = {
  ok: boolean;
  appliedRules: string[];
  periodStart: string;
  periodEnd: string;
  /** Status of the matching accounting period: "open" when no closed/reported vat_quarter covers it exactly. */
  periodStatus: "open" | "closed" | "reported";
  /** Reference recorded on the closed accounting period, if any. */
  periodReference: string | null;
  /**
   * SKAT filing/payment deadline (YYYY-MM-DD) — the 1st of the third month
   * after the period ends. `null` only when periodEnd is not a valid date.
   */
  filingDeadline: string | null;
  rubrikker: VatFilingRubrikker;
  /** The underlying raw VAT report, for traceability. */
  vatReport: VatPeriodReport;
  warnings: string[];
  errors: string[];
};

const FILING_RULE_ID = "DK-VAT-FILING-001";

/**
 * The standard calendar quarters Rentemester's deadline formula assumes
 * (vatFilingDeadline = 1st of the third month after period-end). Only a
 * quarterly afregningsperiode is supported; monthly/half-yearly cadences have
 * different deadlines and are out of scope.
 *
 * The deadline is NOT shifted off weekends/holidays here: SKAT moves a due date
 * that lands on a non-banking day to the next banking day, which is purely in
 * the taxpayer's favour (later, never earlier). Surfacing the un-shifted,
 * conservative (earliest-possible) date is therefore safe — paying by it can
 * never be late — so the shift is deliberately omitted as cosmetic.
 */
const STANDARD_QUARTER_SPANS: ReadonlyArray<{ start: string; end: string }> = [
  { start: "01-01", end: "03-31" },
  { start: "04-01", end: "06-30" },
  { start: "07-01", end: "09-30" },
  { start: "10-01", end: "12-31" },
];

/** True when [periodStart, periodEnd] spans exactly one standard calendar quarter. */
function isStandardCalendarQuarter(periodStart: string, periodEnd: string): boolean {
  const [startYear] = periodStart.split("-");
  const [endYear] = periodEnd.split("-");
  if (startYear !== endYear) return false;
  const startMd = periodStart.slice(5);
  const endMd = periodEnd.slice(5);
  return STANDARD_QUARTER_SPANS.some((q) => q.start === startMd && q.end === endMd);
}

function emptyRubrikker(): VatFilingRubrikker {
  return {
    salgsmoms: 0,
    momsAfVarekobUdland: 0,
    momsAfYdelseskobUdland: 0,
    kobsmoms: 0,
    momstilsvar: 0,
    rubrikA: 0,
    rubrikB: 0,
    rubrikC: 0,
  };
}

function failure(periodStart: string, periodEnd: string, periodStatus: VatFilingReport["periodStatus"], errors: string[], vatReport: VatPeriodReport): VatFilingReport {
  return {
    ok: false,
    appliedRules: [FILING_RULE_ID],
    periodStart,
    periodEnd,
    periodStatus,
    periodReference: null,
    filingDeadline: vatFilingDeadline(periodEnd),
    rubrikker: emptyRubrikker(),
    vatReport,
    warnings: [],
    errors,
  };
}

/**
 * Build a filing-ready momsangivelse for a VAT period.
 *
 * The period must exactly match a closed or reported `vat_quarter`
 * accounting period — otherwise the filing fails (an open period is not yet
 * final and must not be submitted).
 */
export function buildVatFiling(db: Database, periodStart: string, periodEnd: string): VatFilingReport {
  const vatReport = buildVatReport(db, periodStart, periodEnd);

  // Surface date-validation errors from the underlying report verbatim.
  if (!vatReport.ok) {
    return failure(periodStart, periodEnd, "open", [...vatReport.errors], vatReport);
  }

  if (!looksLikeIsoDate(periodStart) || !looksLikeIsoDate(periodEnd)) {
    return failure(periodStart, periodEnd, "open", ["periodStart and periodEnd must be YYYY-MM-DD"], vatReport);
  }

  // A momsangivelse may only be produced for a finalised VAT period. The
  // period bounds must exactly match a closed or reported vat_quarter
  // accounting period; anything else means the period is still open or
  // incomplete and must not be filed.
  const period = db.query(
    `SELECT status, reference
       FROM accounting_periods
      WHERE period_start = ? AND period_end = ? AND kind = 'vat_quarter'
        AND status IN ('closed', 'reported')
      ORDER BY id DESC
      LIMIT 1`
  ).get(periodStart, periodEnd) as { status: "closed" | "reported"; reference: string | null } | null;

  if (!period) {
    return failure(
      periodStart,
      periodEnd,
      "open",
      [
        `VAT period ${periodStart}..${periodEnd} is not closed: a momsangivelse requires a closed or reported vat_quarter accounting period covering exactly this period — run 'period close' first`,
      ],
      vatReport,
    );
  }

  // Moms af ydelseskøb i udlandet: reverse charge on EU service purchases.
  // Use the VAT *actually booked* on account 1200 per purchase, not
  // percentOfDkk(summed base, 25). Each purchase's VAT is øre-rounded when
  // booked, so the booked total can differ from 25%-of-aggregate by up to 1
  // øre per purchase. Using the booked figure keeps this rubrik equal to what
  // hit the ledger AND lets salgsmoms below come out as the exact own-sale VAT.
  const momsAfYdelseskobUdland = vatReport.reverseChargePurchaseOutputVat;

  // Salgsmoms: output VAT on own sales only. buildVatReport.outputVat is
  // account-based (1200) and therefore includes the reverse-charge output VAT
  // booked by postEuServiceReverseChargePurchase — but on TastSelv that VAT
  // belongs exclusively in "Moms af ydelseskøb i udlandet" (momsloven §46 jf.
  // §37). Subtract the exact same ydelseskøb figure so the two rubrikker never
  // double-count and momstilsvar stays equal to the raw report's netVatPayable.
  // buildVatReport.outputVat already nets bad-debt relief out of output VAT.
  const salgsmoms = subtractDkk(vatReport.outputVat, momsAfYdelseskobUdland);

  // Moms af varekøb i udlandet: there is no separate EU goods-acquisition VAT
  // code in the ledger today (momsloven §11 erhvervelsesmoms is NOT modelled),
  // so foreign-goods VAT is always 0. Kept as an explicit rubrik so the
  // momsangivelse shape matches the SKAT form.
  //
  // LIMITATION / GUARD: the only EU-purchase mechanism Rentemester books is
  // EU_SERVICE_REVERSE_CHARGE (ydelseskøb, momsloven §46). An EU *goods*
  // purchase (varekøb, §11) belongs in "Moms af varekøb i udlandet" + rubrik A
  // and is NOT supported. If such a purchase were booked as a service it would
  // silently land in ydelseskøb instead of varekøb — wrong rubrik, even though
  // the total momstilsvar would coincide. So whenever the period contains EU
  // reverse-charge purchases, warn loudly that the user must confirm none of
  // them are GOODS. This is a warning only; it never changes any amount and
  // never breaks the momstilsvar == netVatPayable invariant.
  const momsAfVarekobUdland = 0;
  const filingWarnings: string[] = [];

  // Cadence guard (JUR-12): the deadline formula assumes a quarterly
  // afregningsperiode. If the closed period is not a standard calendar quarter,
  // the registered cadence is likely monthly or half-yearly — which have
  // different deadlines Rentemester does not compute. Warn so the user verifies
  // the filing deadline manually. Warning only: the (conservative, un-shifted)
  // deadline is still surfaced and the amounts are untouched.
  if (!isStandardCalendarQuarter(periodStart, periodEnd)) {
    filingWarnings.push(
      "Afregningsperioden er ikke et standard-kvartal: Rentemester understøtter " +
        "kun kvartalsvis momsafregning, og angivelsesfristen (1. i tredje måned " +
        "efter periodens udløb) er beregnet ud fra denne kadence. Bekræft selskabets " +
        "registrerede afregningsperiode og den korrekte frist hos SKAT — månedlig " +
        "eller halvårlig afregning har andre frister.",
    );
  }

  const euGoodsWarnings: string[] = [];
  if (vatReport.reverseChargePurchaseBase > 0) {
    euGoodsWarnings.push(
      "EU-varekøb (momsloven §11, erhvervelsesmoms) understøttes ikke: perioden " +
        "indeholder EU reverse-charge-køb, som alle bogføres som ydelseskøb " +
        '("Moms af ydelseskøb i udlandet"). "Moms af varekøb i udlandet" er derfor 0. ' +
        "Bekræft at INGEN af disse køb er varer — et varekøb bogført som ydelse " +
        "havner i forkert rubrik og skal i stedet føres som varekøb i udlandet + rubrik A.",
    );
  }

  // Købsmoms: total deductible input VAT (domestic + reverse-charge +
  // representation), already aggregated by buildVatReport.
  const kobsmoms = vatReport.inputVat;

  // Momstilsvar = salgsmoms + udenlandsk moms − købsmoms.
  // Positive = payable to SKAT; negative = refund (negativt momstilsvar).
  const momstilsvar = subtractDkk(addDkk(salgsmoms, momsAfVarekobUdland, momsAfYdelseskobUdland), kobsmoms);

  // Rubrik A: value of goods/services purchased abroad without Danish VAT.
  const rubrikA = vatReport.reverseChargePurchaseBase;
  // Rubrik B (JUR-2/KODE-2): value of goods/services SOLD ABROAD without Danish
  // VAT — cross-border EU B2B reverse-charge sales ONLY. This is the figure
  // cross-checked against the EU sales list (VIES), so only the FOREIGN reverse-
  // charge base belongs here. Domestic §46 omvendt betalingspligt is explicitly
  // excluded (it would otherwise inflate rubrik B and break the VIES reconciliation).
  const rubrikB = vatReport.foreignReverseChargeSalesBase;
  // Rubrik C: value of other VAT-exempt sales. Two sources, both derived from
  // real ledger data:
  //   1. §13-exempt domestic sales (DK_SALE_EXEMPT), and
  //   2. domestic §46 omvendt betalingspligt sales (DOMESTIC_REVERSE_CHARGE_EXEMPT,
  //      e.g. mobiltelefoner, CPU'er, metalskrot). SKAT Den juridiske vejledning
  //      A.B.3.3.1.5 places these in rubrik C ("værdi af andet salg uden moms"),
  //      NOT rubrik B.
  // OSS consumer sales (OSS_EU_CONSUMER) are deliberately NOT part of rubrik C:
  // they belong on the separate OSS return, so buildVatReport keeps them in their
  // own base and they never reach this momsangivelse.
  const rubrikC = addDkk(vatReport.exemptSalesBase, vatReport.domesticReverseChargeSalesBase);

  return {
    ok: true,
    appliedRules: [FILING_RULE_ID],
    periodStart,
    periodEnd,
    periodStatus: period.status,
    periodReference: period.reference,
    filingDeadline: vatFilingDeadline(periodEnd),
    rubrikker: {
      salgsmoms,
      momsAfVarekobUdland,
      momsAfYdelseskobUdland,
      kobsmoms,
      momstilsvar,
      rubrikA,
      rubrikB,
      rubrikC,
    },
    vatReport,
    warnings: [...vatReport.warnings, ...filingWarnings, ...euGoodsWarnings],
    errors: [],
  };
}
