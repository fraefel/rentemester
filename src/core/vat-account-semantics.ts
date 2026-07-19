import type { Database } from "bun:sqlite";
import type { AccountRole } from "./account-roles";
import { resolveAccountRole } from "./account-roles";

export type VatAmountSide = "output" | "input";

/** Persistable line classifications understood by the current ledger/report. */
export const VAT_LINE_CODES: ReadonlySet<string> = new Set([
  "DK_PURCHASE_25",
  "DK_PURCHASE_EXEMPT",
  "DK_SALE_25",
  "DK_SALE_EXEMPT",
  "EU_SERVICE_REVERSE_CHARGE",
  "NON_EU_SERVICE_REVERSE_CHARGE",
  "REPRESENTATION_SPECIAL",
  "REPRESENTATION_NON_DEDUCTIBLE_VAT",
  "DK_BAD_DEBT_25",
  "REVERSE_CHARGE_EXEMPT",
  "DOMESTIC_REVERSE_CHARGE_EXEMPT",
  "OSS_EU_CONSUMER",
]);

/**
 * Dinero's source-native VAT control accounts.
 *
 * These exact identifiers are evidence from the Dinero chart format, not a
 * general account-number range.  A legacy import may have persisted them as
 * liabilities; newer imports normalise them to `type = 'vat'`.  The output
 * controls can be recognised from that chart evidence. A legacy 64060 is
 * intentionally not recognised here: its liability/credit representation is
 * accepted as input VAT only for the verified historical Dinero pair in the
 * VAT report, never merely because a manual journal used that account number.
 */
export const DINERO_VAT_CONTROL_ACCOUNTS = {
  "64000": { role: "output_vat", normalBalance: "credit", side: "output" },
  "64040": { role: "reverse_charge_vat", normalBalance: "credit", side: "output" },
  "64060": { role: "input_vat", normalBalance: "debit", side: "input" },
} as const satisfies Record<
  string,
  { role: AccountRole; normalBalance: "debit" | "credit"; side: VatAmountSide }
>;

export type VatAccountSemantics = {
  /** VAT amount accounts and whether their signed movement is output or input VAT. */
  amountSideByAccountNo: ReadonlyMap<string, VatAmountSide>;
  /** Output-VAT accounts dedicated to reverse charge rather than ordinary sales. */
  reverseChargeOutputAccountNos: ReadonlySet<string>;
  /** Settlement accounts move the net balance but are not themselves VAT amounts. */
  settlementAccountNos: ReadonlySet<string>;
};

/**
 * Load the canonical VAT-account meaning for one ledger.
 *
 * Recognition is deliberately narrow and chart-aware:
 *
 * - every active native/imported account explicitly typed `vat` is classified
 *   from its normal balance;
 * - the exact source-validated Dinero output controls are accepted in their
 *   legacy liability shape, never an arbitrary `64000..64099` range;
 * - explicitly confirmed account roles are authoritative and included; and
 * - the confirmed VAT-settlement role is kept separate from VAT amounts.
 */
export function loadVatAccountSemantics(db: Database): VatAccountSemantics {
  const rows = db
    .query("SELECT account_no, type, normal_balance, active FROM accounts")
    .all() as Array<{
    account_no: string;
    type: string;
    normal_balance: "debit" | "credit";
    active: number;
  }>;

  const amountSideByAccountNo = new Map<string, VatAmountSide>();
  for (const row of rows) {
    if (row.active !== 1) continue;
    if (row.type === "vat") {
      amountSideByAccountNo.set(
        row.account_no,
        row.normal_balance === "debit" ? "input" : "output",
      );
      continue;
    }
    const dinero =
      DINERO_VAT_CONTROL_ACCOUNTS[
        row.account_no as keyof typeof DINERO_VAT_CONTROL_ACCOUNTS
      ];
    if (
      dinero &&
      // A 64060 liability is too ambiguous outside a verified historical
      // Dinero voucher. `buildVatReport` admits it only after checking the
      // matching 64040/64060 control pair and provenance.
      row.account_no !== "64060" &&
      row.type === "liability" &&
      row.normal_balance === dinero.normalBalance
    ) {
      amountSideByAccountNo.set(row.account_no, dinero.side);
    }
  }

  for (const [role, side] of [
    ["output_vat", "output"],
    ["reverse_charge_vat", "output"],
    ["input_vat", "input"],
  ] as const) {
    const resolution = resolveAccountRole(db, role);
    if (resolution.ok) amountSideByAccountNo.set(resolution.accountNo, side);
  }

  const reverseChargeOutputAccountNos = new Set<string>();
  // Dinero's exact 64040 control is source-native evidence of a dedicated
  // reverse-charge output account, even before its imported role proposal is
  // confirmed.
  if (amountSideByAccountNo.get("64040") === "output") {
    reverseChargeOutputAccountNos.add("64040");
  }
  const outputVat = resolveAccountRole(db, "output_vat");
  const reverseChargeVat = resolveAccountRole(db, "reverse_charge_vat");
  // A confirmed role is dedicated only when it is distinct from ordinary
  // output VAT. Native charts deliberately use 1200 for both, so those need
  // base-derived allocation at report time.
  if (
    reverseChargeVat.ok &&
    (!outputVat.ok || reverseChargeVat.accountNo !== outputVat.accountNo)
  ) {
    reverseChargeOutputAccountNos.add(reverseChargeVat.accountNo);
  }

  const settlementAccountNos = new Set<string>();
  const settlement = resolveAccountRole(db, "vat_settlement");
  if (settlement.ok) settlementAccountNos.add(settlement.accountNo);

  return {
    amountSideByAccountNo,
    reverseChargeOutputAccountNos,
    settlementAccountNos,
  };
}
