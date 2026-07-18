import type { Database } from "bun:sqlite";
import { postJournalEntry, type JournalPostResult } from "./ledger";
import { getCompanySettings } from "./company";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { requireCachedViesValidation, normalizeEuVatNumber } from "./vies";
import { addDkk, compareDkk, fromOre, percentOfDkk, roundDkk, subtractDkk, sumDkk, toOre } from "./money";
import { resolveAccountRole } from "./account-roles";
import { emptyVatRubric, projectVatRubric, type VatRubric } from "./vat-rubric";
import { deductibleDanishPurchaseSupplierErrors, resolvePersistedSupplierIdentity, type SupplierIdentityResolution } from "./supplier-identity";
import { parsePurchaseVatLinesPayload } from "./documents";

/** Absolute difference between two DKK amounts, expressed in whole øre. */
function oreDifference(left: number, right: number): number {
  const delta = toOre(left) - toOre(right);
  return Number(delta < 0n ? -delta : delta);
}

export type VatPeriodReport = {
  ok: boolean;
  appliedRules: string[];
  periodStart: string;
  periodEnd: string;
  outputVat: number;
  inputVat: number;
  netVatPayable: number;
  purchaseBase25: number;
  salesBase25: number;
  /**
   * Combined value of all VAT-exempt reverse-charge sales (domestic + foreign).
   * Kept for backwards compatibility and human display ("Salg med omvendt
   * betalingspligt"). For the momsangivelse the two must be split — see
   * foreignReverseChargeSalesBase / domesticReverseChargeSalesBase below.
   */
  reverseChargeSalesBase: number;
  /**
   * JUR-2/KODE-2: value of FOREIGN reverse-charge sales — cross-border EU B2B
   * sales without Danish VAT (vat_code REVERSE_CHARGE_EXEMPT). These feed rubrik
   * B of the momsangivelse and are cross-checked against the EU sales list (VIES).
   */
  foreignReverseChargeSalesBase: number;
  /**
   * JUR-2/KODE-2: value of DOMESTIC reverse-charge sales — Danish §46 omvendt
   * betalingspligt (mobiltelefoner, CPU'er, metalskrot; vat_code
   * DOMESTIC_REVERSE_CHARGE_EXEMPT). These carry no Danish output VAT and feed
   * rubrik C ("værdi af andet salg uden moms"), NOT rubrik B, and must never
   * appear on the VIES EU sales list. Source: SKAT Den juridiske vejledning
   * A.B.3.3.1.5.
   */
  domesticReverseChargeSalesBase: number;
  /** EU service reverse-charge purchase base only. This feeds rubrik A and the
   * EU-goods limitation warning; non-EU services are kept separate below. */
  reverseChargePurchaseBase: number;
  /** Service-purchase base from suppliers outside the EU. It contributes to
   * foreign-service reverse-charge VAT, but never to EU-only rubrik A. */
  nonEuServiceReverseChargePurchaseBase: number;
  /**
   * Output VAT actually booked on the reverse-charge VAT role by foreign
   * service purchases (EU and non-EU). This is
   * the *booked* sum — the øre-rounded VAT of each individual purchase added up
   * — which can differ by up to 1 øre per purchase from 25% of the summed
   * combined EU/non-EU foreign-service base. The momsangivelse uses this figure for "Moms af
   * ydelseskøb i udlandet" so that rubrik, and the salgsmoms derived by
   * subtracting it from the booked outputVat, are both exact.
   */
  reverseChargePurchaseOutputVat: number;
  representationPurchaseBase: number;
  badDebtReliefBase25: number;
  /**
   * Value of VAT-exempt domestic sales (momsloven §13 — vat_code
   * DK_SALE_EXEMPT). These carry no output VAT and feed rubrik C of the
   * momsangivelse; they are kept out of the standard 25% sales base.
   */
  exemptSalesBase: number;
  /**
   * Value of digital-service sales to EU consumers handled under the OSS
   * scheme (vat_code OSS_EU_CONSUMER). These carry no Danish output VAT and
   * are reported via a separate OSS return — they are kept out of every
   * standard momsangivelse rubrik. See src/core/vat-oss.ts.
   */
  ossConsumerSalesBase: number;
  /** Number of journal entries that include an OSS_EU_CONSUMER line. */
  ossConsumerSalesEntryCount: number;
  journalEntryCount: number;
  reversedJournalEntryCount: number;
  reversalJournalEntryCount: number;
  totalJournalEntryCount: number;
  linesConsidered: number;
  reversedLinesConsidered: number;
  reversalLinesConsidered: number;
  totalLinesConsidered: number;
  /** Canonical SKAT rubric projection shared by report, filing and exports. */
  rubrikker: VatRubric;
  warnings: string[];
  errors: string[];
};

const RULE_ID = "DK-VAT-REPORT-001";
const REVERSE_CHARGE_RULE_ID = "DK-VAT-REVERSE-CHARGE-001";
const NON_EU_REVERSE_CHARGE_RULE_ID = "DK-VAT-NON-EU-SERVICE-REVERSE-CHARGE-001";
const REPRESENTATION_RULE_ID = "DK-VAT-REPRESENTATION-001";
const REGISTRATION_RULE_ID = "DK-VAT-REGISTRATION-001";

/**
 * True when the single company row is VAT-registered (a cadence is set). A
 * null `vat_period_type` marks a NOT VAT-registered company (Momsloven § 47 /
 * § 48). Reads through `getCompanySettings`, the canonical reader, so the
 * notion of "registered" is byte-identical to every other surface.
 */
function companyIsVatRegistered(db: Database): boolean {
  return getCompanySettings(db).vatPeriodType !== null;
}

// EU service reverse charge for a NOT VAT-registered company is NOT a deductible
// net-zero booking: under Momsloven § 46, stk. 1, nr. 3, jf. § 50 b the buyer
// becomes separately liable to register and pay Danish erhvervelsesmoms "fra
// første krone" with NO input-VAT deduction (§ 37). That registration + filing
// flow is out of scope (parallel to the § 11 EU-goods erhvervelsesmoms
// limitation), so we must refuse rather than silently book a forbidden 4000
// deduction (or silently absorb VAT the company actually owes SKAT).
const NON_REGISTERED_EU_SERVICE_MSG =
  "selskabet er ikke momsregistreret — EU-ydelseskøb med omvendt betalingspligt udløser særskilt registreringspligt for erhvervelsesmoms (momsloven § 46, stk. 1, nr. 3, jf. § 50 b) fra første krone uden fradrag (§ 37); det håndterer Rentemester ikke endnu. Registrér selskabet for erhvervelsesmoms og søg rådgivning — bogfør ikke købet som reverse charge her";
const NON_REGISTERED_NON_EU_SERVICE_MSG =
  "selskabet er ikke momsregistreret — ydelseskøb fra en leverandør uden for EU med omvendt betalingspligt kræver særskilt momsbehandling uden automatisk fradrag; det håndterer Rentemester ikke endnu. Registrér selskabet og søg rådgivning før bogføring";

// Representation for a NOT VAT-registered company: the § 42 partial deduction
// is a registered-business relief, and § 37 grants no deduction at all, so the
// full VAT is simply a cost. The correct booking is gross absorption via
// `expense book --vat-treatment non_deductible`, not this partial-deduction path.
const NON_REGISTERED_REPRESENTATION_MSG =
  "selskabet er ikke momsregistreret — repræsentationsmoms kan ikke fradrages (momsloven § 37); bogfør bilaget brutto med 'expense book --vat-treatment non_deductible', så hele momsen absorberes i udgiften";

/**
 * SKAT filing/payment deadline for a VAT period (#236).
 *
 * For quarterly VAT (the only cadence Rentemester supports) the momsangivelse
 * must be filed and the moms paid by the 1st day of the third month after the
 * period ends — e.g. Q2 (ends 30-06) is due 1 September. This is the single
 * date that costs money with SKAT if missed, so it is computed here from the
 * period-end date and surfaced on every VAT output.
 *
 * Returns the deadline as a YYYY-MM-DD ISO date, or `null` when `periodEnd`
 * is not a valid ISO date.
 *
 * Cadence (JUR-12): this formula is correct ONLY for a quarterly afregnings-
 * periode — the single cadence Rentemester supports. buildVatFiling additionally
 * warns if the closed period is not a standard calendar quarter. The deadline is
 * deliberately NOT shifted off weekends/holidays: SKAT moves a non-banking-day
 * due date to the next banking day, always later, so the un-shifted date is the
 * conservative (earliest-possible) one and paying by it can never be late.
 */
export function vatFilingDeadline(periodEnd: string): string | null {
  if (!looksLikeIsoDate(periodEnd)) return null;
  const [yearStr, monthStr] = periodEnd.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  // The 1st of the third month after the period-end month. month is 1-based;
  // adding 3 and normalising the year keeps quarter-end → deadline correct
  // (06 → 09 same year, 12 → 03 next year).
  let deadlineMonth = month + 3;
  let deadlineYear = year;
  while (deadlineMonth > 12) {
    deadlineMonth -= 12;
    deadlineYear += 1;
  }
  return `${deadlineYear}-${String(deadlineMonth).padStart(2, "0")}-01`;
}

export type ReverseChargePurchaseInput = {
  transactionDate: string;
  text: string;
  documentId: number;
  netAmount: number;
  expenseAccountNo: string;
  paymentAccountNo?: string;
  sourceBankTransactionId?: number;
  currency?: string;
  amountForeign?: number;
  amountDkk?: number;
  fxRateToDkk?: number;
  createdBy?: string;
  createdByProgram?: string;
};

export type RepresentationPurchaseInput = {
  transactionDate: string;
  text: string;
  documentId: number;
  netAmount: number;
  expenseAccountNo?: string;
  paymentAccountNo?: string;
  sourceBankTransactionId?: number;
  currency?: string;
  amountForeign?: number;
  amountDkk?: number;
  fxRateToDkk?: number;
  createdBy?: string;
  createdByProgram?: string;
};

function reverseChargeInputErrors(input: ReverseChargePurchaseInput): string[] {
  const errors: string[] = [];
  if (!looksLikeIsoDate(input.transactionDate)) errors.push("transactionDate must be YYYY-MM-DD");
  if (typeof input.text !== "string" || input.text.trim().length === 0) errors.push("text is required");
  if (!Number.isInteger(input.documentId) || input.documentId <= 0) errors.push("documentId must be a positive integer");
  if (!Number.isFinite(input.netAmount) || input.netAmount <= 0) errors.push("netAmount must be a positive number");
  if (typeof input.expenseAccountNo !== "string" || input.expenseAccountNo.trim().length === 0) errors.push("expenseAccountNo is required");
  return errors;
}

function postServiceReverseChargeLines(
  db: Database,
  input: ReverseChargePurchaseInput,
  vatCode: "EU_SERVICE_REVERSE_CHARGE" | "NON_EU_SERVICE_REVERSE_CHARGE",
  ruleId: string,
  sourceLabel: string,
): JournalPostResult {
  const vatAmount = percentOfDkk(input.netAmount, 25);
  const inputVat = resolveAccountRole(db, "input_vat");
  const outputVat = resolveAccountRole(db, "reverse_charge_vat");
  const bank = input.paymentAccountNo ? { ok: true as const, accountNo: input.paymentAccountNo } : resolveAccountRole(db, "bank");
  const roleErrors = [inputVat, outputVat, bank].flatMap((resolution) => resolution.ok ? [] : [resolution.error]);
  if (roleErrors.length > 0) return { ok: false, appliedRules: [ruleId], errors: roleErrors };
  const result = postJournalEntry(db, {
    transactionDate: input.transactionDate,
    text: input.text.trim(),
    documentId: input.documentId,
    sourceBankTransactionId: input.sourceBankTransactionId,
    currency: input.currency,
    amountForeign: input.amountForeign,
    amountDkk: input.amountDkk,
    fxRateToDkk: input.fxRateToDkk,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: [
      { accountNo: input.expenseAccountNo, debitAmount: roundDkk(input.netAmount), vatCode, text: `${sourceLabel} service purchase base` },
      { accountNo: inputVat.accountNo, debitAmount: vatAmount, text: "Deductible reverse-charge input VAT" },
      { accountNo: bank.accountNo, creditAmount: roundDkk(input.netAmount), text: "Payment / liability" },
      { accountNo: outputVat.accountNo, creditAmount: vatAmount, text: "Reverse-charge output VAT" },
    ],
  });
  return {
    ...result,
    appliedRules: result.ok ? [...new Set([...(result.appliedRules ?? []), ruleId])] : [...new Set([ruleId, ...(result.appliedRules ?? [])])],
  };
}

function resolveDocumentSupplierIdentity(
  db: Database,
  documentId: number,
): SupplierIdentityResolution | null {
  const row = db.query(
    `SELECT sender_vat_cvr, supplier_country_code, supplier_identifier_kind, supplier_identity_status
       FROM documents
      WHERE id = ?`,
  ).get(documentId) as {
    sender_vat_cvr: string | null;
    supplier_country_code: string | null;
    supplier_identifier_kind: string | null;
    supplier_identity_status: string | null;
  } | null;
  if (!row) return null;
  return resolvePersistedSupplierIdentity({
    supplierVatOrCvr: row.sender_vat_cvr,
    supplierCountryCode: row.supplier_country_code,
    supplierIdentifierKind: row.supplier_identifier_kind,
    supplierIdentityStatus: row.supplier_identity_status,
  });
}

function unsupportedStructuredPurchaseLinesErrors(
  db: Database,
  documentId: number,
  treatment: "reverse_charge" | "representation",
): string[] {
  const row = db.query(
    `SELECT amount_inc_vat, vat_amount, payload_json
       FROM documents
      WHERE id = ?`,
  ).get(documentId) as {
    amount_inc_vat: number | null;
    vat_amount: number | null;
    payload_json: string | null;
  } | null;
  if (!row) return [`documentId ${documentId} does not exist`];
  const parsed = parsePurchaseVatLinesPayload(row.payload_json, {
    amountIncVat: row.amount_inc_vat,
    vatAmount: row.vat_amount,
  });
  if (parsed.status === "invalid") {
    return parsed.errors.map((error) => `document ${documentId} has invalid persisted purchaseVatLines: ${error}`);
  }
  if (parsed.status === "valid") {
    return [`${treatment} purchase posting does not support structured purchaseVatLines; use a dedicated unsplit document or human resolution`];
  }
  return [];
}

function documentDanishInputVatSupplierErrors(db: Database, documentId: number): string[] {
  const row = db.query(
    `SELECT sender_vat_cvr, supplier_country_code, supplier_identifier_kind, supplier_identity_status
       FROM documents
      WHERE id = ?`,
  ).get(documentId) as {
    sender_vat_cvr: string | null;
    supplier_country_code: string | null;
    supplier_identifier_kind: string | null;
    supplier_identity_status: string | null;
  } | null;
  if (!row) return [`documentId ${documentId} does not exist`];
  return deductibleDanishPurchaseSupplierErrors({
    supplierVatOrCvr: row.sender_vat_cvr,
    supplierCountryCode: row.supplier_country_code,
    supplierIdentifierKind: row.supplier_identifier_kind,
    supplierIdentityStatus: row.supplier_identity_status,
  });
}

/**
 * A non-EU invoice may be ingested without an EU VAT identifier (#529), but
 * automatic input-VAT deduction is a separate, higher-evidence decision. The
 * invoice must retain the supplier's home-country registration number, the
 * Danish buyer VAT identifier, and explicit reverse-charge wording. Otherwise
 * the purchase remains available for human resolution without creating a VAT
 * journal entry.
 */
function nonEuReverseChargeEvidenceErrors(db: Database, documentId: number): string[] {
  const row = db.query(
    `SELECT sender_vat_cvr, recipient_vat_cvr, payload_json
       FROM documents
      WHERE id = ?`,
  ).get(documentId) as {
    sender_vat_cvr: string | null;
    recipient_vat_cvr: string | null;
    payload_json: string | null;
  } | null;
  if (!row) return [`documentId ${documentId} does not exist`];

  const errors: string[] = [];
  if (!row.sender_vat_cvr?.trim()) {
    errors.push("non-EU reverse-charge input-VAT deduction requires the supplier's home-country registration number on the invoice");
  }
  const buyerVat = row.recipient_vat_cvr?.trim().toUpperCase().replace(/\s/g, "") ?? "";
  if (!/^DK\d{8}$/.test(buyerVat)) {
    errors.push("non-EU reverse-charge input-VAT deduction requires the Danish buyer VAT identifier (DK + 8 digits) on the invoice");
  } else {
    let configuredCompanyVat: string | null = null;
    try {
      configuredCompanyVat = getCompanySettings(db).cvr;
    } catch {
      configuredCompanyVat = null;
    }
    if (!configuredCompanyVat) {
      errors.push("non-EU reverse-charge input-VAT deduction requires the ledger company's own CVR/VAT identifier to be configured");
    } else if (buyerVat !== configuredCompanyVat) {
      errors.push(`invoice buyer VAT identifier ${buyerVat} does not match the ledger company's configured VAT identifier ${configuredCompanyVat}`);
    }
  }
  let wordingConfirmed = false;
  try {
    const payload = row.payload_json ? JSON.parse(row.payload_json) as unknown : null;
    wordingConfirmed = Boolean(
      payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && (payload as Record<string, unknown>).reverseChargeWordingConfirmed === true,
    );
  } catch {
    wordingConfirmed = false;
  }
  if (!wordingConfirmed) {
    errors.push("non-EU reverse-charge input-VAT deduction requires confirmed reverse-charge wording on the invoice");
  }
  return errors;
}


export function postEuServiceReverseChargePurchase(db: Database, input: ReverseChargePurchaseInput): JournalPostResult {
  const errors = reverseChargeInputErrors(input);
  if (errors.length > 0) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors };
  const splitErrors = unsupportedStructuredPurchaseLinesErrors(db, input.documentId, "reverse_charge");
  if (splitErrors.length > 0) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: splitErrors };

  // A non-registered company cannot book deductible reverse-charge VAT (§ 37);
  // the purchase instead triggers a § 50 b erhvervelsesmoms registration that
  // is out of scope. Refuse rather than book a forbidden 4000 line.
  if (!companyIsVatRegistered(db)) {
    return { ok: false, appliedRules: [REGISTRATION_RULE_ID, REVERSE_CHARGE_RULE_ID], errors: [NON_REGISTERED_EU_SERVICE_MSG] };
  }

  const identity = resolveDocumentSupplierIdentity(db, input.documentId);
  if (!identity) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: [`documentId ${input.documentId} does not exist`] };
  // EU service reverse charge (momsloven §46) applies only to suppliers in
  // *other* EU member states. A Danish supplier is a domestic purchase and
  // must not be booked as reverse charge.
  if (!identity.ok) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: ["document supplier identity requires human resolution before reverse-charge booking"] };
  if (identity.identifierKind === "dk_cvr") {
    return {
      ok: false,
      appliedRules: [REVERSE_CHARGE_RULE_ID],
      errors: ["document supplier identity is Danish — EU service reverse charge applies only to other EU member states; book this as a domestic DK_PURCHASE_25 expense"],
    };
  }
  if (identity.identifierKind === "non_eu") return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: ["document supplier identity is non-EU — use the applicable non-EU purchase treatment; do not fabricate an EU VAT ID"] };
  const viesCheck = requireCachedViesValidation(db, identity.identifier, "document sender_vat_cvr");
  if (!viesCheck.ok) return { ok: false, appliedRules: [...new Set([REVERSE_CHARGE_RULE_ID, ...viesCheck.appliedRules])], errors: viesCheck.errors };

  return postServiceReverseChargeLines(db, input, "EU_SERVICE_REVERSE_CHARGE", REVERSE_CHARGE_RULE_ID, "EU");
}

/** Explicit treatment for services bought from a supplier outside the EU.
 * Country + non_eu classification is enough to ingest and retain a voucher,
 * while automatic input-VAT deduction additionally requires invoice evidence
 * checked below. */
export function postNonEuServiceReverseChargePurchase(db: Database, input: ReverseChargePurchaseInput): JournalPostResult {
  const errors = reverseChargeInputErrors(input);
  if (errors.length > 0) return { ok: false, appliedRules: [NON_EU_REVERSE_CHARGE_RULE_ID], errors };
  const splitErrors = unsupportedStructuredPurchaseLinesErrors(db, input.documentId, "reverse_charge");
  if (splitErrors.length > 0) return { ok: false, appliedRules: [NON_EU_REVERSE_CHARGE_RULE_ID], errors: splitErrors };
  if (!companyIsVatRegistered(db)) {
    return { ok: false, appliedRules: [REGISTRATION_RULE_ID, NON_EU_REVERSE_CHARGE_RULE_ID], errors: [NON_REGISTERED_NON_EU_SERVICE_MSG] };
  }
  const identity = resolveDocumentSupplierIdentity(db, input.documentId);
  if (!identity) return { ok: false, appliedRules: [NON_EU_REVERSE_CHARGE_RULE_ID], errors: [`documentId ${input.documentId} does not exist`] };
  if (!identity.ok || identity.identifierKind !== "non_eu") {
    return { ok: false, appliedRules: [NON_EU_REVERSE_CHARGE_RULE_ID], errors: ["document supplier identity must be resolved explicitly as non-EU before non-EU service reverse-charge booking"] };
  }
  const evidenceErrors = nonEuReverseChargeEvidenceErrors(db, input.documentId);
  if (evidenceErrors.length > 0) {
    return {
      ok: false,
      appliedRules: [NON_EU_REVERSE_CHARGE_RULE_ID],
      errors: ["document requires human resolution before non-EU reverse-charge input-VAT deduction", ...evidenceErrors],
    };
  }
  return postServiceReverseChargeLines(db, input, "NON_EU_SERVICE_REVERSE_CHARGE", NON_EU_REVERSE_CHARGE_RULE_ID, "Non-EU");
}

/**
 * Expense-booking entry point for a foreign service. The user chooses one
 * reverse-charge action; the immutable supplier identity on the document
 * decides whether EU/VIES or non-EU provenance and VAT codes apply.
 */
export function postForeignServiceReverseChargePurchase(db: Database, input: ReverseChargePurchaseInput): JournalPostResult {
  const errors = reverseChargeInputErrors(input);
  if (errors.length > 0) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors };
  const splitErrors = unsupportedStructuredPurchaseLinesErrors(db, input.documentId, "reverse_charge");
  if (splitErrors.length > 0) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: splitErrors };
  const identity = resolveDocumentSupplierIdentity(db, input.documentId);
  if (!identity) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: [`documentId ${input.documentId} does not exist`] };
  if (!identity.ok) return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: ["document supplier identity requires human resolution before reverse-charge booking"] };
  if (identity.identifierKind === "dk_cvr") {
    return { ok: false, appliedRules: [REVERSE_CHARGE_RULE_ID], errors: ["document supplier identity is Danish — foreign service reverse charge is not applicable; use standard domestic purchase VAT"] };
  }
  if (!companyIsVatRegistered(db)) {
    const ruleId = identity.identifierKind === "non_eu" ? NON_EU_REVERSE_CHARGE_RULE_ID : REVERSE_CHARGE_RULE_ID;
    const message = identity.identifierKind === "non_eu" ? NON_REGISTERED_NON_EU_SERVICE_MSG : NON_REGISTERED_EU_SERVICE_MSG;
    return { ok: false, appliedRules: [REGISTRATION_RULE_ID, ruleId], errors: [message] };
  }
  if (identity.identifierKind === "non_eu") {
    return postNonEuServiceReverseChargePurchase(db, input);
  }
  const viesCheck = requireCachedViesValidation(db, identity.identifier, "document sender_vat_cvr");
  if (!viesCheck.ok) return { ok: false, appliedRules: [...new Set([REVERSE_CHARGE_RULE_ID, ...viesCheck.appliedRules])], errors: viesCheck.errors };
  return postServiceReverseChargeLines(db, input, "EU_SERVICE_REVERSE_CHARGE", REVERSE_CHARGE_RULE_ID, "EU");
}

export function postRepresentationPurchase(db: Database, input: RepresentationPurchaseInput): JournalPostResult {
  const errors: string[] = [];
  if (!looksLikeIsoDate(input.transactionDate)) errors.push("transactionDate must be YYYY-MM-DD");
  if (typeof input.text !== "string" || input.text.trim().length === 0) errors.push("text is required");
  if (!Number.isInteger(input.documentId) || input.documentId <= 0) errors.push("documentId must be a positive integer");
  if (!Number.isFinite(input.netAmount) || input.netAmount <= 0) errors.push("netAmount must be a positive number");
  if (errors.length > 0) return { ok: false, appliedRules: [REPRESENTATION_RULE_ID], errors };

  // The § 42 partial representation deduction is a registered-business relief;
  // a non-registered company gets no deduction (§ 37), so the full VAT is a
  // cost. Refuse and direct to gross non_deductible absorption.
  if (!companyIsVatRegistered(db)) {
    return { ok: false, appliedRules: [REGISTRATION_RULE_ID, REPRESENTATION_RULE_ID], errors: [NON_REGISTERED_REPRESENTATION_MSG] };
  }
  const splitErrors = unsupportedStructuredPurchaseLinesErrors(db, input.documentId, "representation");
  if (splitErrors.length > 0) return { ok: false, appliedRules: [REPRESENTATION_RULE_ID], errors: splitErrors };
  const supplierErrors = documentDanishInputVatSupplierErrors(db, input.documentId);
  if (supplierErrors.length > 0) return { ok: false, appliedRules: [REPRESENTATION_RULE_ID], errors: supplierErrors };

  const fullVatAmount = percentOfDkk(input.netAmount, 25);
  const deductibleVatAmount = percentOfDkk(fullVatAmount, 25);
  const nonDeductibleVatAmount = subtractDkk(fullVatAmount, deductibleVatAmount);
  const grossAmount = addDkk(input.netAmount, fullVatAmount);
  const inputVat = resolveAccountRole(db, "input_vat");
  const payment = input.paymentAccountNo ? { ok: true as const, accountNo: input.paymentAccountNo } : resolveAccountRole(db, "bank");
  if (!inputVat.ok || !payment.ok) return { ok: false, appliedRules: [REPRESENTATION_RULE_ID], errors: [!inputVat.ok ? inputVat.error : payment.error] };

  const result = postJournalEntry(db, {
    transactionDate: input.transactionDate,
    text: input.text.trim(),
    documentId: input.documentId,
    sourceBankTransactionId: input.sourceBankTransactionId,
    currency: input.currency,
    amountForeign: input.amountForeign,
    amountDkk: input.amountDkk,
    fxRateToDkk: input.fxRateToDkk,
    createdBy: input.createdBy,
    createdByProgram: input.createdByProgram,
    lines: [
      {
        accountNo: input.expenseAccountNo ?? "3070",
        debitAmount: roundDkk(input.netAmount),
        vatCode: "REPRESENTATION_SPECIAL",
        text: "Representation purchase base"
      },
      {
        accountNo: input.expenseAccountNo ?? "3070",
        debitAmount: nonDeductibleVatAmount,
        // This amount is a real cost, not a VAT base. It nevertheless needs
        // an explicit classification so the report can distinguish it from a
        // forgotten manual VAT code without inventing a deductible base.
        vatCode: "REPRESENTATION_NON_DEDUCTIBLE_VAT",
        text: "Non-deductible representation VAT (75%)"
      },
      { accountNo: inputVat.accountNo, debitAmount: deductibleVatAmount, text: "Deductible representation VAT (25%)" },
      { accountNo: payment.accountNo, creditAmount: grossAmount, text: "Payment / liability" },
    ],
  });

  return {
    ...result,
    appliedRules: result.ok ? [...new Set([...(result.appliedRules ?? []), REPRESENTATION_RULE_ID])] : [...new Set([REPRESENTATION_RULE_ID, ...(result.appliedRules ?? [])])],
  };
}

export function buildVatReport(db: Database, periodStart: string, periodEnd: string): VatPeriodReport {
  const errors: string[] = [];
  if (!looksLikeIsoDate(periodStart)) errors.push("periodStart must be YYYY-MM-DD");
  if (!looksLikeIsoDate(periodEnd)) errors.push("periodEnd must be YYYY-MM-DD");
  if (errors.length === 0 && periodStart > periodEnd) errors.push("periodStart must be before or equal to periodEnd");
  if (errors.length > 0) {
    return {
      ok: false,
      appliedRules: [RULE_ID],
      periodStart,
      periodEnd,
      outputVat: 0,
      inputVat: 0,
      netVatPayable: 0,
      purchaseBase25: 0,
      salesBase25: 0,
      reverseChargeSalesBase: 0,
      foreignReverseChargeSalesBase: 0,
      domesticReverseChargeSalesBase: 0,
      reverseChargePurchaseBase: 0,
      nonEuServiceReverseChargePurchaseBase: 0,
      reverseChargePurchaseOutputVat: 0,
      representationPurchaseBase: 0,
      badDebtReliefBase25: 0,
      exemptSalesBase: 0,
      ossConsumerSalesBase: 0,
      ossConsumerSalesEntryCount: 0,
      journalEntryCount: 0,
      reversedJournalEntryCount: 0,
      reversalJournalEntryCount: 0,
      totalJournalEntryCount: 0,
      linesConsidered: 0,
      reversedLinesConsidered: 0,
      reversalLinesConsidered: 0,
      totalLinesConsidered: 0,
      rubrikker: emptyVatRubric(),
      warnings: [],
      errors,
    };
  }

  const rows = db.query(
    `SELECT je.id as entry_id, je.status, je.reversal_of_entry_id, je.currency as entry_currency, a.account_no, a.type as account_type, a.normal_balance, a.default_vat_code, jl.debit_amount, jl.credit_amount, jl.vat_code
     FROM journal_entries je
     JOIN journal_lines jl ON jl.journal_entry_id = je.id
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.transaction_date >= ? AND je.transaction_date <= ?
     ORDER BY je.id ASC, jl.id ASC`
  ).all(periodStart, periodEnd) as Array<{
    entry_id: number;
    status: string;
    reversal_of_entry_id: number | null;
    entry_currency: string;
    account_no: string;
    account_type: string;
    normal_balance: "debit" | "credit";
    default_vat_code: string | null;
    debit_amount: number;
    credit_amount: number;
    vat_code: string | null;
  }>;
  const outputVatRole = resolveAccountRole(db, "output_vat");
  const reverseChargeVatRole = resolveAccountRole(db, "reverse_charge_vat");
  const inputVatRole = resolveAccountRole(db, "input_vat");

  let outputVat = 0;
  let inputVat = 0;
  let purchaseBase25 = 0;
  let salesBase25 = 0;
  let foreignReverseChargeSalesBase = 0;
  let domesticReverseChargeSalesBase = 0;
  let reverseChargePurchaseBase = 0;
  let nonEuServiceReverseChargePurchaseBase = 0;
  let representationPurchaseBase = 0;
  // Reverse-charge output VAT is booked per purchase on account 1200, øre-
  // rounded per transaction. To recover the *booked* total (which can differ
  // from 25% of the summed base by up to 1 øre per purchase), accumulate the
  // 1200 net (credit − debit) per journal entry and the set of entries that
  // carry an EU_SERVICE_REVERSE_CHARGE base line, then sum 1200 over exactly
  // those entries after the scan.
  const account1200NetByEntry = new Map<number, number>();
  const reverseChargeEntryIds = new Set<number>();
  let badDebtReliefBase25 = 0;
  let exemptSalesBase = 0;
  let ossConsumerSalesBase = 0;
  // OSS sales are counted per *entry*, not per line, so a multi-line OSS
  // invoice still counts as one entry.
  const ossConsumerSalesEntryIds = new Set<number>();
  // Count VAT-bearing base lines per category. 25% of a period-summed base is
  // not equal to the sum of per-line 25%-rounded VAT when amounts have odd
  // øre, so each base line can drift the aggregate by up to 1 øre. We allow a
  // (lineCount - 1)-øre tolerance on the reconciliation cross-check below.
  let outputVatBaseLines = 0;
  let inputVatBaseLines = 0;
  let foreignOutputVatBaseLines = 0;
  let foreignInputVatBaseLines = 0;
  const activeEntryIds = new Set<number>();
  const reversedEntryIds = new Set<number>();
  const reversalEntryIds = new Set<number>();
  let activeLinesConsidered = 0;
  let reversedLinesConsidered = 0;
  let reversalLinesConsidered = 0;
  const reversedByInPeriodReversal = new Set(rows.filter((row) => row.reversal_of_entry_id != null).map((row) => row.reversal_of_entry_id as number));

  for (const row of rows) {
    const isReversalEntry = row.reversal_of_entry_id != null;
    const isReversedEntry = !isReversalEntry && reversedByInPeriodReversal.has(row.entry_id);

    if (isReversalEntry) {
      reversalEntryIds.add(row.entry_id);
      reversalLinesConsidered += 1;
    } else if (isReversedEntry) {
      reversedEntryIds.add(row.entry_id);
      reversedLinesConsidered += 1;
    } else {
      activeEntryIds.add(row.entry_id);
      activeLinesConsidered += 1;
    }

    const debit = roundDkk(Number(row.debit_amount ?? 0));
    const credit = roundDkk(Number(row.credit_amount ?? 0));

    // Native account roles are resolved centrally; Dinero's trusted
    // historical chart has the standard 64000/64040 output and 64060 input
    // accounts. No income-number heuristic is used (1200 can be ordinary
    // income in an imported chart).
    const isDineroOutputVat = row.account_no === "64000" || row.account_no === "64040";
    const isDineroInputVat = row.account_no === "64060";
    const isNativeOutputVat =
      (outputVatRole.ok && row.account_no === outputVatRole.accountNo) ||
      (reverseChargeVatRole.ok && row.account_no === reverseChargeVatRole.accountNo);
    const isNativeInputVat = inputVatRole.ok && row.account_no === inputVatRole.accountNo;
    if (isNativeOutputVat || isDineroOutputVat) {
      outputVat += credit - debit;
      account1200NetByEntry.set(row.entry_id, (account1200NetByEntry.get(row.entry_id) ?? 0) + (credit - debit));
    }
    if (isNativeInputVat || isDineroInputVat) inputVat += debit - credit;

    // Ledger hashes make old lines immutable. Rather than retroactively
    // guessing from their account defaults, make an unclassified VAT-relevant
    // line a blocking, auditable report error. New verified imports receive
    // the default at posting time; manual calls never do.
    if (row.vat_code === null && row.default_vat_code !== null && (row.account_type === "income" || row.account_type === "expense")) {
      errors.push(`journal entry ${row.entry_id} line on VAT-relevant account ${row.account_no} has no explicit vat_code; no VAT base was inferred — document and resolve the classification before filing`);
    }

    const isForeignCurrencyEntry = row.entry_currency !== "DKK";
    if (row.vat_code === "DK_PURCHASE_25") {
      purchaseBase25 += debit - credit;
      inputVatBaseLines += 1;
      if (isForeignCurrencyEntry) foreignInputVatBaseLines += 1;
    }
    if (row.vat_code === "DK_SALE_25") {
      salesBase25 += credit - debit;
      outputVatBaseLines += 1;
      if (isForeignCurrencyEntry) foreignOutputVatBaseLines += 1;
    }
    // JUR-2/KODE-2: keep the two reverse-charge sales bases apart so the
    // momsangivelse can route foreign → rubrik B (VIES) and domestic → rubrik C.
    if (row.vat_code === "REVERSE_CHARGE_EXEMPT") foreignReverseChargeSalesBase += credit - debit;
    if (row.vat_code === "DOMESTIC_REVERSE_CHARGE_EXEMPT") domesticReverseChargeSalesBase += credit - debit;
    if (row.vat_code === "EU_SERVICE_REVERSE_CHARGE") {
      reverseChargePurchaseBase += debit - credit;
      reverseChargeEntryIds.add(row.entry_id);
      // Reverse charge contributes to both output and input VAT.
      inputVatBaseLines += 1;
      outputVatBaseLines += 1;
      if (isForeignCurrencyEntry) {
        foreignInputVatBaseLines += 1;
        foreignOutputVatBaseLines += 1;
      }
    }
    if (row.vat_code === "NON_EU_SERVICE_REVERSE_CHARGE") {
      nonEuServiceReverseChargePurchaseBase += debit - credit;
      reverseChargeEntryIds.add(row.entry_id);
      inputVatBaseLines += 1;
      outputVatBaseLines += 1;
      if (isForeignCurrencyEntry) {
        foreignInputVatBaseLines += 1;
        foreignOutputVatBaseLines += 1;
      }
    }
    if (row.vat_code === "REPRESENTATION_SPECIAL") {
      representationPurchaseBase += debit - credit;
      inputVatBaseLines += 1;
      if (isForeignCurrencyEntry) foreignInputVatBaseLines += 1;
    }
    if (row.vat_code === "DK_BAD_DEBT_25") {
      badDebtReliefBase25 += debit - credit;
      outputVatBaseLines += 1;
      if (isForeignCurrencyEntry) foreignOutputVatBaseLines += 1;
    }
    // VAT-exempt domestic sales (momsloven §13) and OSS consumer sales carry
    // NO Danish output VAT, so they are tracked in their own bases and are
    // deliberately NOT added to outputVatBaseLines (the output-VAT
    // reconciliation must not expect 25% of them).
    if (row.vat_code === "DK_SALE_EXEMPT") exemptSalesBase += credit - debit;
    if (row.vat_code === "OSS_EU_CONSUMER") {
      ossConsumerSalesBase += credit - debit;
      ossConsumerSalesEntryIds.add(row.entry_id);
    }
  }

  outputVat = roundDkk(outputVat);
  inputVat = roundDkk(inputVat);
  purchaseBase25 = roundDkk(purchaseBase25);
  salesBase25 = roundDkk(salesBase25);
  foreignReverseChargeSalesBase = roundDkk(foreignReverseChargeSalesBase);
  domesticReverseChargeSalesBase = roundDkk(domesticReverseChargeSalesBase);
  const reverseChargeSalesBase = addDkk(foreignReverseChargeSalesBase, domesticReverseChargeSalesBase);
  reverseChargePurchaseBase = roundDkk(reverseChargePurchaseBase);
  nonEuServiceReverseChargePurchaseBase = roundDkk(nonEuServiceReverseChargePurchaseBase);
  // Booked reverse-charge output VAT: the 1200 net booked on exactly the
  // entries that carry a reverse-charge base line. Summed as the øre-rounded
  // per-entry amounts so the figure equals what hit account 1200, not 25% of
  // the aggregate base.
  let reverseChargePurchaseOutputVat = 0;
  for (const entryId of reverseChargeEntryIds) {
    reverseChargePurchaseOutputVat = addDkk(reverseChargePurchaseOutputVat, account1200NetByEntry.get(entryId) ?? 0);
  }
  representationPurchaseBase = roundDkk(representationPurchaseBase);
  badDebtReliefBase25 = roundDkk(badDebtReliefBase25);
  exemptSalesBase = roundDkk(exemptSalesBase);
  ossConsumerSalesBase = roundDkk(ossConsumerSalesBase);

  const foreignServiceReverseChargeBase = addDkk(reverseChargePurchaseBase, nonEuServiceReverseChargePurchaseBase);
  const expectedOutputVat = subtractDkk(addDkk(percentOfDkk(salesBase25, 25), percentOfDkk(foreignServiceReverseChargeBase, 25)), percentOfDkk(badDebtReliefBase25, 25));
  const expectedInputVat = addDkk(addDkk(percentOfDkk(purchaseBase25, 25), percentOfDkk(foreignServiceReverseChargeBase, 25)), percentOfDkk(percentOfDkk(representationPurchaseBase, 25), 25));
  const warnings: string[] = [];
  // Each VAT-bearing base line is rounded to øre independently when booked,
  // so the booked aggregate can differ from "25% of the summed base" by up to
  // 1 øre per line. Only the *first* line establishes the aggregate; the
  // remaining (n-1) lines can each drift it, so the tolerance is (n-1) øre.
  // A genuine mis-booking exceeds this small bound and still warns.
  // Foreign-currency entries round the stated VAT and its net base into DKK
  // independently before balancing. That conversion can add one further øre
  // of legitimate drift per foreign base line.
  const outputVatTolerance = Math.max(0, outputVatBaseLines - 1) + foreignOutputVatBaseLines;
  const inputVatTolerance = Math.max(0, inputVatBaseLines - 1) + foreignInputVatBaseLines;
  if (oreDifference(outputVat, expectedOutputVat) > outputVatTolerance) {
    warnings.push(`output VAT mismatch: booked ${outputVat}, expected from base × rate ${expectedOutputVat}`);
  }
  if (oreDifference(inputVat, expectedInputVat) > inputVatTolerance) {
    warnings.push(`input VAT mismatch: booked ${inputVat}, expected from base × rate ${expectedInputVat}`);
  }

  // Partial deduction (delvis fradragsret, momsloven §§37-38) is NOT modelled:
  // every purchase code assumes 100% deductible input VAT. When a period has
  // BOTH VAT-exempt turnover (DK_SALE_EXEMPT, §13) AND deducted input VAT, some
  // of that input VAT may be only partly deductible (a pro-rata split tied to
  // the exempt vs. taxable revenue mix). Rentemester does not compute that
  // split — warn so the user/advisor checks it. Warning only: no amount changes
  // and the netVatPayable invariant is untouched.
  if (exemptSalesBase > 0 && inputVat > 0) {
    warnings.push(
      "Delvis fradragsret (momsloven §§37-38) håndteres ikke: perioden har både " +
        "momsfri omsætning (DK_SALE_EXEMPT) og fuldt fradraget købsmoms. Noget af " +
        "købsmomsen kan være delvis fradragsberettiget (pro rata efter momspligtig " +
        "vs. momsfri omsætning). Få revisor til at vurdere fradragsprocenten — " +
        "Rentemester beregner ikke fordelingen.",
    );
  }

  const report: Omit<VatPeriodReport, "rubrikker"> = {
    ok: errors.length === 0,
    appliedRules: [RULE_ID],
    periodStart,
    periodEnd,
    outputVat,
    inputVat,
    netVatPayable: subtractDkk(outputVat, inputVat),
    purchaseBase25,
    salesBase25,
    reverseChargeSalesBase,
    foreignReverseChargeSalesBase,
    domesticReverseChargeSalesBase,
    reverseChargePurchaseBase,
    nonEuServiceReverseChargePurchaseBase,
    reverseChargePurchaseOutputVat,
    representationPurchaseBase,
    badDebtReliefBase25,
    exemptSalesBase,
    ossConsumerSalesBase,
    ossConsumerSalesEntryCount: ossConsumerSalesEntryIds.size,
    journalEntryCount: activeEntryIds.size,
    reversedJournalEntryCount: reversedEntryIds.size,
    reversalJournalEntryCount: reversalEntryIds.size,
    totalJournalEntryCount: activeEntryIds.size + reversedEntryIds.size + reversalEntryIds.size,
    linesConsidered: activeLinesConsidered,
    reversedLinesConsidered,
    reversalLinesConsidered,
    totalLinesConsidered: rows.length,
    warnings,
    errors,
  };
  return { ...report, rubrikker: projectVatRubric(report as VatPeriodReport) };
}
