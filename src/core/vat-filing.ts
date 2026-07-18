import type { Database } from "bun:sqlite";
import { buildVatReport, type VatPeriodReport } from "./vat";
import { emptyVatRubric, type VatRubric } from "./vat-rubric";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { getCompanySettings } from "./company";
import {
  effectivePeriodState,
  vatPeriodWindowFor,
  type VatPeriodType,
} from "./periods";

/**
 * Filing-ready momsangivelse (Danish VAT return).
 *
 * Maps the raw VAT data from {@link buildVatReport} into the standard SKAT
 * rubrikker a user submits via TastSelv. Conservative by design: Rentemester
 * produces the numbers, the user files them. No direct SKAT submission, no
 * OSS/MOSS one-stop-shop.
 *
 * A momsangivelse can only be produced for an exact registered-cadence VAT
 * period that has been closed (or marked reported) as a `vat_period` — an
 * open or incomplete period fails clearly. All amounts are integer-øre-
 * deterministic via the money helpers; 25% is the Danish standard rate.
 */
export type VatFilingRubrikker = VatRubric;

export type VatFilingReport = {
  ok: boolean;
  appliedRules: string[];
  periodStart: string;
  periodEnd: string;
  /** Company's registered VAT cadence used for bounds and deadline. */
  vatPeriodType: VatPeriodType | null;
  /** Status of the matching accounting period: "open" when no final VAT period covers it exactly. */
  periodStatus: "open" | "closed" | "reported";
  /** Reference recorded on the closed accounting period, if any. */
  periodReference: string | null;
  /**
   * Cadence-aware SKAT filing/payment deadline (YYYY-MM-DD). `null` only for
   * a non-registered company or an invalid period end.
   */
  filingDeadline: string | null;
  rubrikker: VatFilingRubrikker;
  /** The underlying raw VAT report, for traceability. */
  vatReport: VatPeriodReport;
  warnings: string[];
  errors: string[];
};

const FILING_RULE_ID = "DK-VAT-FILING-001";

function emptyRubrikker(): VatFilingRubrikker { return emptyVatRubric(); }

function failure(
  periodStart: string,
  periodEnd: string,
  periodStatus: VatFilingReport["periodStatus"],
  errors: string[],
  vatReport: VatPeriodReport,
  vatPeriodType: VatPeriodType | null,
  periodReference: string | null = null,
): VatFilingReport {
  return {
    ok: false,
    appliedRules: [FILING_RULE_ID],
    periodStart,
    periodEnd,
    vatPeriodType,
    periodStatus,
    periodReference,
    filingDeadline: vatReport.filingDeadline,
    rubrikker: emptyRubrikker(),
    vatReport,
    warnings: [],
    errors,
  };
}

/**
 * Build a filing-ready momsangivelse for a VAT period.
 *
 * The period must exactly match a canonical window for the company's
 * registered cadence and a closed/reported `vat_period` accounting period.
 */
export function buildVatFiling(db: Database, periodStart: string, periodEnd: string): VatFilingReport {
  const vatReport = buildVatReport(db, periodStart, periodEnd);
  const vatPeriodType = getCompanySettings(db).vatPeriodType;

  if (!looksLikeIsoDate(periodStart) || !looksLikeIsoDate(periodEnd)) {
    return failure(periodStart, periodEnd, "open", ["periodStart and periodEnd must be YYYY-MM-DD"], vatReport, vatPeriodType);
  }

  if (vatPeriodType === null) {
    return failure(
      periodStart,
      periodEnd,
      "open",
      ["selskabet er ikke momsregistreret og har derfor ingen momsangivelsesperiode"],
      vatReport,
      null,
    );
  }

  const canonicalWindow = vatPeriodWindowFor(periodStart, vatPeriodType);
  if (
    canonicalWindow.start !== periodStart ||
    canonicalWindow.end !== periodEnd
  ) {
    return failure(
      periodStart,
      periodEnd,
      "open",
      [
        `VAT period ${periodStart}..${periodEnd} does not match the company's registered ${vatPeriodType} cadence; the canonical period containing ${periodStart} is ${canonicalWindow.start}..${canonicalWindow.end}`,
      ],
      vatReport,
      vatPeriodType,
    );
  }

  // A momsangivelse may only be produced for a finalised VAT period. The
  // period bounds must exactly match a closed or reported VAT period
  // accounting period; anything else means the period is still open or
  // incomplete and must not be filed.
  const period = db.query(
    `SELECT id, status, reference
       FROM accounting_periods
      WHERE period_start = ? AND period_end = ? AND kind IN ('vat_period', 'vat_quarter')
      ORDER BY CASE kind WHEN 'vat_period' THEN 0 ELSE 1 END, id DESC
      LIMIT 1`
  ).get(periodStart, periodEnd) as {
    id: number;
    status: "open" | "closed" | "reported";
    reference: string | null;
  } | null;

  const periodStatus = period
    ? effectivePeriodState(db, period.id, period.status)
    : "open";

  // Resolve lifecycle before surfacing report-integrity failures. A closed
  // period with malformed legacy VAT data is still closed; labelling it open
  // would send the user down the wrong recovery path. The report's own
  // canonical deadline is used, so arbitrary bounds never gain a fake date.
  if (!vatReport.ok) {
    const reportErrors = [...vatReport.errors];
    if (!period || periodStatus === "open") {
      reportErrors.push(
        `VAT period ${periodStart}..${periodEnd} is not closed: a momsangivelse requires a closed or reported vat_period accounting period covering exactly this period — run 'period close --kind vat_period' first`,
      );
    }
    return failure(
      periodStart,
      periodEnd,
      periodStatus,
      reportErrors,
      vatReport,
      vatPeriodType,
      period?.reference ?? null,
    );
  }

  if (!period || periodStatus === "open") {
    return failure(
      periodStart,
      periodEnd,
      "open",
      [
        `VAT period ${periodStart}..${periodEnd} is not closed: a momsangivelse requires a closed or reported vat_period accounting period covering exactly this period — run 'period close --kind vat_period' first`,
      ],
      vatReport,
      vatPeriodType,
    );
  }

  // The shared projection keeps CLI/MCP/report/cockpit/export figures alike.
  const rubrikker = vatReport.rubrikker;
  // Moms af ydelseskøb i udlandet: reverse charge on EU service purchases.
  // Use the VAT *actually booked* on account 1200 per purchase, not
  // percentOfDkk(summed base, 25). Each purchase's VAT is øre-rounded when
  // booked, so the booked total can differ from 25%-of-aggregate by up to 1
  // øre per purchase. Using the booked figure keeps this rubrik equal to what
  // hit the ledger AND lets salgsmoms below come out as the exact own-sale VAT.
  const momsAfYdelseskobUdland = rubrikker.momsAfYdelseskobUdland;

  // Salgsmoms: output VAT on own sales only. buildVatReport.outputVat is
  // account-based (1200) and therefore includes the reverse-charge output VAT
  // booked by postEuServiceReverseChargePurchase — but on TastSelv that VAT
  // belongs exclusively in "Moms af ydelseskøb i udlandet" (momsloven §46 jf.
  // §37). Subtract the exact same ydelseskøb figure so the two rubrikker never
  // double-count and momstilsvar stays equal to the raw report's netVatPayable.
  // buildVatReport.outputVat already nets bad-debt relief out of output VAT.
  const salgsmoms = rubrikker.salgsmoms;

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
  const momsAfVarekobUdland = rubrikker.momsAfVarekobUdland;

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
  const kobsmoms = rubrikker.kobsmoms;

  // Momstilsvar = salgsmoms + udenlandsk moms − købsmoms.
  // Positive = payable to SKAT; negative = refund (negativt momstilsvar).
  const momstilsvar = rubrikker.momstilsvar;

  // Rubrik A: value of goods/services purchased abroad without Danish VAT.
  const rubrikA = rubrikker.rubrikA;
  // Rubrik B (JUR-2/KODE-2): value of goods/services SOLD ABROAD without Danish
  // VAT — cross-border EU B2B reverse-charge sales ONLY. This is the figure
  // cross-checked against the EU sales list (VIES), so only the FOREIGN reverse-
  // charge base belongs here. Domestic §46 omvendt betalingspligt is explicitly
  // excluded (it would otherwise inflate rubrik B and break the VIES reconciliation).
  const rubrikB = rubrikker.rubrikB;
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
  const rubrikC = rubrikker.rubrikC;

  return {
    ok: true,
    appliedRules: [FILING_RULE_ID],
    periodStart,
    periodEnd,
    vatPeriodType,
    periodStatus,
    periodReference: period.reference,
    filingDeadline: canonicalWindow.filingDeadline,
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
    warnings: [...vatReport.warnings, ...euGoodsWarnings],
    errors: [],
  };
}
