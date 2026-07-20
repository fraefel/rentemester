import { percentOfDkk, roundDkk, toOre } from "./money";
import type { VatAmountSide } from "./vat-account-semantics";

export type LegacyVatEvidenceRow = {
  entry_id: number;
  line_id: number;
  status: string;
  account_no: string;
  account_type: string;
  default_vat_code: string | null;
  debit_amount: number;
  credit_amount: number;
  vat_code: string | null;
};

export type LegacyVatEvidence = {
  amountSideByAccountNo: ReadonlyMap<string, VatAmountSide>;
  reverseChargeOutputAccountNos: ReadonlySet<string>;
  inferredVatCodeByLineId: ReadonlyMap<number, string>;
  reverseChargeToleranceByEntry: ReadonlyMap<number, number>;
  ordinaryInputToleranceByEntry: ReadonlyMap<number, number>;
  ordinaryOutputToleranceByEntry: ReadonlyMap<number, number>;
  errors: string[];
};

type KnownVatAmountSides = ReadonlyMap<string, VatAmountSide>;

type ControlMatch = {
  accountNo: string;
  amount: number;
};

function oreDifference(left: number, right: number): number {
  const delta = toOre(left) - toOre(right);
  return Number(delta < 0n ? -delta : delta);
}

function explicitVatCode(row: LegacyVatEvidenceRow): string | null {
  const code = row.vat_code?.trim();
  return code ? code : null;
}

function baseVatCode(
  row: LegacyVatEvidenceRow,
  inferredVatCodeByLineId: ReadonlyMap<number, string>,
): string | null {
  const explicit = explicitVatCode(row);
  if (explicit) return explicit;
  const inferred = inferredVatCodeByLineId.get(row.line_id);
  if (inferred) return inferred;
  if (row.account_type !== "expense" && row.account_type !== "income") return null;
  const accountDefault = row.default_vat_code?.trim();
  return accountDefault ? accountDefault : null;
}

function netDebit(row: LegacyVatEvidenceRow): number {
  return roundDkk(Number(row.debit_amount) - Number(row.credit_amount));
}

function controlMatches(
  entryRows: readonly LegacyVatEvidenceRow[],
  excludedLineIds: ReadonlySet<number>,
  expectedAmount: number,
  side: VatAmountSide,
): ControlMatch[] {
  const amountByAccountNo = new Map<string, number>();
  for (const row of entryRows) {
    if (excludedLineIds.has(row.line_id)) continue;
    if (row.account_type === "expense" || row.account_type === "income") continue;
    const signedAmount = side === "input" ? netDebit(row) : -netDebit(row);
    amountByAccountNo.set(
      row.account_no,
      roundDkk((amountByAccountNo.get(row.account_no) ?? 0) + signedAmount),
    );
  }
  return [...amountByAccountNo.entries()]
    .filter(([, amount]) => amount !== 0 && oreDifference(amount, expectedAmount) <= 1)
    .map(([accountNo, amount]) => ({ accountNo, amount }));
}

function chooseControl(
  matches: readonly ControlMatch[],
  side: VatAmountSide,
  knownAmountSideByAccountNo: ReadonlyMap<string, VatAmountSide>,
): ControlMatch | null {
  const knownMatches = matches.filter(
    (match) => knownAmountSideByAccountNo.get(match.accountNo) === side,
  );
  if (knownMatches.length === 1) return knownMatches[0]!;
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Recover VAT account meaning from immutable imported vouchers without using
 * chart-specific account numbers.
 *
 * This is deliberately narrower than ordinary account-role confirmation:
 * only posted rows from the reserved historical-import adapter are passed in,
 * a real income/expense base must carry an explicit or reviewed default code,
 * and exactly one non-base control account must reconcile to the VAT amount.
 * Later journals may reuse an account learned here, but they still need their
 * own explicit VAT base classification at the normal report boundary.
 */
export function inferLegacyVatEvidence(historicalRows: readonly LegacyVatEvidenceRow[], knownAmountSideByAccountNo: KnownVatAmountSides): LegacyVatEvidence {
  const errors: string[] = [];
  const inferredVatCodeByLineId = new Map<number, string>();
  const inferredAmountSideByAccountNo = new Map<string, VatAmountSide>();
  const reverseChargeOutputAccountNos = new Set<string>();
  const reverseChargeToleranceByEntry = new Map<number, number>();
  const ordinaryInputToleranceByEntry = new Map<number, number>();
  const ordinaryOutputToleranceByEntry = new Map<number, number>();
  const rowsByEntry = new Map<number, LegacyVatEvidenceRow[]>();

  for (const row of historicalRows) {
    if (row.status !== "posted") continue;
    const entryRows = rowsByEntry.get(row.entry_id) ?? [];
    entryRows.push(row);
    rowsByEntry.set(row.entry_id, entryRows);
  }

  const registerSide = (
    entryId: number,
    accountNo: string,
    side: VatAmountSide,
  ): boolean => {
    const knownSide =
      knownAmountSideByAccountNo.get(accountNo) ??
      inferredAmountSideByAccountNo.get(accountNo);
    if (knownSide && knownSide !== side) {
      errors.push(
        `journal entry ${entryId} gives VAT account ${accountNo} conflicting ${knownSide}/${side} evidence; human resolution is required`,
      );
      return false;
    }
    inferredAmountSideByAccountNo.set(accountNo, side);
    return true;
  };

  // First identify reverse-charge vouchers. The opposing, equal VAT controls
  // are stronger line-level evidence than an old account-level purchase code.
  for (const [entryId, entryRows] of rowsByEntry) {
    const expenseRows = entryRows.filter((row) => row.account_type === "expense");
    const explicitExpenseCodes = expenseRows
      .map(explicitVatCode)
      .filter((code): code is string => code !== null);
    if (explicitExpenseCodes.some((code) => code !== "EU_SERVICE_REVERSE_CHARGE")) {
      continue;
    }
    const baseCandidates = explicitExpenseCodes.length > 0
      ? expenseRows.filter((row) => explicitVatCode(row) === "EU_SERVICE_REVERSE_CHARGE")
      : expenseRows.filter((row) => netDebit(row) !== 0);
    const matchingShapes: Array<{
      base: LegacyVatEvidenceRow;
      expected: number;
      input: ControlMatch;
      output: ControlMatch;
    }> = [];

    for (const base of baseCandidates) {
      const expected = percentOfDkk(netDebit(base), 25);
      if (expected === 0) continue;
      const excluded = new Set([base.line_id]);
      const input = chooseControl(
        controlMatches(entryRows, excluded, expected, "input"),
        "input",
        knownAmountSideByAccountNo,
      );
      const output = chooseControl(
        controlMatches(entryRows, excluded, expected, "output"),
        "output",
        knownAmountSideByAccountNo,
      );
      if (input && output && input.accountNo !== output.accountNo) {
        matchingShapes.push({ base, expected, input, output });
      }
    }

    if (matchingShapes.length > 1) {
      errors.push(
        `journal entry ${entryId} has reverse-charge controls but no single expense base matching 25%; human resolution is required`,
      );
      continue;
    }
    const shape = matchingShapes[0];
    if (!shape) continue;
    if (
      !registerSide(entryId, shape.input.accountNo, "input") ||
      !registerSide(entryId, shape.output.accountNo, "output")
    ) {
      continue;
    }
    if (!explicitVatCode(shape.base)) {
      inferredVatCodeByLineId.set(shape.base.line_id, "EU_SERVICE_REVERSE_CHARGE");
    }
    reverseChargeOutputAccountNos.add(shape.output.accountNo);
    reverseChargeToleranceByEntry.set(
      entryId,
      Math.max(
        oreDifference(shape.expected, shape.input.amount),
        oreDifference(shape.expected, shape.output.amount),
      ),
    );
  }

  // Then learn ordinary input/output controls from classified purchase/sale
  // bases. Aggregating bases and controls per account handles split lines while
  // retaining a single unambiguous semantic account per side.
  for (const [entryId, entryRows] of rowsByEntry) {
    const entryBaseCodes = new Set(
      entryRows
        .map((row) => baseVatCode(row, inferredVatCodeByLineId))
        .filter((code): code is string => code !== null),
    );
    for (const category of [
      { code: "DK_PURCHASE_25", side: "input" as const },
      { code: "DK_SALE_25", side: "output" as const },
    ]) {
      // A mixed voucher can legitimately contain several controls of the same
      // amount (for example ordinary output VAT plus reverse-charge output
      // VAT). It is valid accounting evidence, but not unambiguous evidence
      // for learning one new ordinary control-account role.
      if ([...entryBaseCodes].some((code) => code !== category.code)) continue;
      const baseRows = entryRows.filter(
        (row) => baseVatCode(row, inferredVatCodeByLineId) === category.code,
      );
      if (baseRows.length === 0) continue;
      const baseAmount = roundDkk(baseRows.reduce(
        (sum, row) => sum + (category.side === "input" ? netDebit(row) : -netDebit(row)),
        0,
      ));
      const expected = percentOfDkk(baseAmount, 25);
      if (expected === 0) continue;
      const matches = controlMatches(
        entryRows,
        new Set(baseRows.map((row) => row.line_id)),
        expected,
        category.side,
      );
      const control = chooseControl(matches, category.side, knownAmountSideByAccountNo);
      if (!control) {
        if (matches.length > 1) {
          errors.push(
            `journal entry ${entryId} has multiple accounts matching its ${category.code} VAT control; human resolution is required`,
          );
        }
        continue;
      }
      if (!registerSide(entryId, control.accountNo, category.side)) continue;
      const tolerance = oreDifference(expected, control.amount);
      (category.side === "input"
        ? ordinaryInputToleranceByEntry
        : ordinaryOutputToleranceByEntry
      ).set(entryId, tolerance);
    }
  }

  return {
    amountSideByAccountNo: inferredAmountSideByAccountNo,
    reverseChargeOutputAccountNos,
    inferredVatCodeByLineId,
    reverseChargeToleranceByEntry,
    ordinaryInputToleranceByEntry,
    ordinaryOutputToleranceByEntry,
    errors,
  };
}
