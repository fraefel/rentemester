// Import framework — the Dinero export's year-to-date postings. Issue #195
// (epic #173).
//
// After the opening balance (#194) the company sits at the cut-over date — the
// fiscal-year's first day. But a real migration happens mid-year: the cut-over
// year's `Posteringer.csv` already carries every posting since then (purchases,
// payments, settlements, VAT payments). #194 imports only the leading
// `Primobeholdning` rows; this module replays the REST so Rentemester is up to
// date the moment the company is onboarded.
//
// MODEL — the deliberate decision (#195):
//  - Every non-primo `Posteringer.csv` row (`Bilag` != 0 / `Tekst` !=
//    `Primobeholdning`) is replayed as a journal-entry line.
//  - Rows are grouped by `Bilag` (voucher) number — each voucher's rows form
//    ONE balanced journal entry (the Dinero voucher's debits == credits).
//  - The Dinero `Beløb` sign convention carries over: positive = debit,
//    negative = credit (kroner, comma decimal).
//  - `Dato` becomes the entry's transaction date; `Tekst` / `Bilagstype` carry
//    into the entry text; `Momstype` carries onto the line's VAT code.
//  - Each entry is posted via the EXISTING `postJournalEntry`, marked with a
//    distinct `created_by_program` (`rentemester-import-postings`) so it is
//    auditable and visibly an imported migration entry — never agent-derived.
//  - Each voucher group is validated to balance (debits == credits in øre);
//    one unbalanced voucher rejects the WHOLE batch, nothing is posted.
//
// The Dinero postings are taken as the source of truth for the migration
// window: this module does NOT re-derive them from bilag. Linking a receipt to
// its voucher's journal entry is #196's job — the entries land here with no
// `document_id`, through the ledger's narrow verified-import policy.
//
// The parser part is PURE and DETERMINISTIC: the same `Posteringer.csv` always
// yields the same ordered list of `DineroVoucher`s.

import type { Database } from "bun:sqlite";
import { postVerifiedHistoricalImportEntry } from "../ledger";
import { HISTORICAL_IMPORT_PROGRAM } from "../import-provenance";
import { isValidIsoDate } from "../dates";
import { percentOfDkk, toOre } from "../money";
import type { ImportHistoricalEntry } from "./types";

/**
 * The `created_by_program` stamped on every year-to-date journal entry posted
 * by this module. Distinct from the primobalance / chart import program so a
 * migrated posting is visibly an imported voucher — and so `verifyAuditChain`
 * can exempt it from the income/expense document-evidence requirement until
 * #196 attaches the bilag.
 */
export const IMPORT_POSTINGS_PROGRAM = HISTORICAL_IMPORT_PROGRAM;

/** The import rule applied to a replayed year-to-date voucher. */
export const IMPORT_POSTINGS_RULE = "DK-IMPORT-POSTINGS-001";

// The Dinero marker for an opening-balance row: voucher number 0, voucher text
// `Primobeholdning`. Such rows are #194's job and are skipped here.
const PRIMOBEHOLDNING_TEXT = "primobeholdning";

/** One replayed line of a Dinero voucher (kroner; exactly one side set). */
export type DineroPostingLine = {
  accountNo: string;
  debitAmount?: number;
  creditAmount?: number;
  vatCode?: string;
  text: string;
};

/**
 * One Dinero voucher — the `Posteringer.csv` rows that share a `Bilag` number,
 * forming a single balanced journal entry. `transactionDate` is the voucher's
 * `Dato`, `voucherType` its `Bilagstype`.
 */
export type DineroVoucher = {
  bilag: string;
  transactionDate: string;
  voucherType: string;
  text: string;
  lines: DineroPostingLine[];
};

/** Splits a Dinero semicolon-delimited CSV record. The format has no quoting. */
function splitRecord(line: string): string[] {
  return line.split(";").map((cell) => cell.trim());
}

/**
 * Parses a Dinero `Beløb` cell — a signed decimal with a comma decimal
 * separator, e.g. `5000,000000` or `-2400,000000` — into a kroner Number.
 * Returns `null` on a malformed cell. The result is a kroner amount: it feeds
 * straight into `postJournalEntry`, which stores kroner (and converts to øre
 * internally only for the balance check). `5000,00` -> `5000`, not `500000`.
 */
function parseBelob(cell: string): number | null {
  const trimmed = cell.trim().replace(",", ".");
  if (trimmed.length === 0 || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses the cut-over year's `Posteringer.csv` non-primo rows into the Dinero
 * vouchers — the year-to-date activity AFTER the cut-over date.
 *
 * Every row that is NOT a `Primobeholdning` row (`Bilag != 0` /
 * `Tekst != Primobeholdning`) is a posting line; lines are grouped by `Bilag`,
 * each group preserving the file order of its rows so the resulting journal
 * entry is reproducible. Vouchers are returned ordered by their first
 * appearance in the file.
 *
 * Pure and deterministic. Malformed rows append to `errors`; the function
 * still returns the vouchers it could parse so the caller reports every fault
 * at once. A file with no non-primo rows yields an empty list — not an error.
 */
export function parseDineroPostings(
  text: string,
  sourceName: string,
  errors: string[],
): DineroVoucher[] {
  const lines = text.split(/\r?\n/);
  let sawHeader = false;
  // Insertion-ordered: a Map preserves first-seen voucher order.
  const vouchers = new Map<string, DineroVoucher>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const cells = splitRecord(line);
    // The column-header row:
    // `Konto;Kontonavn;Dato;Bilag;Bilagstype;Tekst;Momstype;Beløb;Saldo`.
    if (!sawHeader) {
      if ((cells[0] ?? "").toLowerCase() === "konto") {
        sawHeader = true;
        continue;
      }
      errors.push(`${sourceName}: missing the 'Konto;Kontonavn;Dato;...' header row`);
      return [];
    }
    const accountNo = cells[0] ?? "";
    const date = (cells[2] ?? "").trim();
    const bilag = (cells[3] ?? "").trim();
    const bilagstype = (cells[4] ?? "").trim();
    const tekst = (cells[5] ?? "").trim();
    const momstype = (cells[6] ?? "").trim();
    const belob = cells[7] ?? "";
    // Skip the opening-balance (Primobeholdning) rows — those are #194's job.
    if (bilag === "0" || tekst.toLowerCase() === PRIMOBEHOLDNING_TEXT) continue;
    if (!bilag) {
      errors.push(`${sourceName} line ${i + 1}: posting row is missing a Bilag`);
      continue;
    }
    if (!accountNo) {
      errors.push(`${sourceName} line ${i + 1}: posting row (Bilag ${bilag}) is missing a Konto`);
      continue;
    }
    if (!isValidIsoDate(date)) {
      errors.push(
        `${sourceName} line ${i + 1}: posting row (Bilag ${bilag}) has an invalid Dato '${date}'`,
      );
      continue;
    }
    const amount = parseBelob(belob);
    if (amount === null) {
      errors.push(
        `${sourceName} line ${i + 1}: posting row (Bilag ${bilag}) has an invalid Beløb '${belob}'`,
      );
      continue;
    }
    // A zero-Beløb line carries no value and would fail the journal-line
    // two-sided check — skip it, exactly as the primobalance parser does.
    if (amount === 0) continue;

    let voucher = vouchers.get(bilag);
    if (!voucher) {
      voucher = {
        bilag,
        transactionDate: date,
        voucherType: bilagstype,
        text: tekst.length > 0 ? tekst : `Bilag ${bilag}`,
        lines: [],
      };
      vouchers.set(bilag, voucher);
    } else if (voucher.transactionDate !== date) {
      // Every row of a voucher carries the same Dato — a divergence means the
      // export is inconsistent and the entry cannot be dated unambiguously.
      errors.push(
        `${sourceName} line ${i + 1}: Bilag ${bilag} has rows with differing Dato (${voucher.transactionDate} vs ${date})`,
      );
    }
    // Sign convention: positive Beløb is a debit, negative is a credit.
    const lineText = tekst.length > 0 ? tekst : voucher.text;
    if (amount > 0) {
      voucher.lines.push({
        accountNo,
        debitAmount: amount,
        text: lineText,
        ...(momstype.length > 0 ? { vatCode: momstype } : {}),
      });
    } else {
      voucher.lines.push({
        accountNo,
        creditAmount: -amount,
        text: lineText,
        ...(momstype.length > 0 ? { vatCode: momstype } : {}),
      });
    }
  }
  if (!sawHeader) {
    errors.push(`${sourceName}: missing the 'Konto;Kontonavn;Dato;...' header row`);
    return [];
  }
  return [...vouchers.values()];
}

/** The outcome of posting one imported voucher into the live ledger. */
export type PostedVoucher = {
  /** Source voucher reference (Dinero `Bilag`); the #196 receipt-link handle. */
  voucherRef: string;
  entryId: number;
  entryNo: string;
  transactionDate: string;
};

/** The outcome of replaying the year-to-date postings. */
export type DineroPostingsResult = {
  ok: boolean;
  /** Vouchers posted, in the order they were posted. */
  posted: PostedVoucher[];
  /** Ordered, human-readable description of what happened. */
  auditTrail: string[];
  errors: string[];
};

/** Stable label for an entry whose `voucherRef` is absent. */
function refOf(entry: ImportHistoricalEntry, index: number): string {
  const ref = typeof entry.voucherRef === "string" ? entry.voucherRef.trim() : "";
  return ref.length > 0 ? ref : `#${index + 1}`;
}

/**
 * Pre-flight: every voucher must have at least two lines, reference known chart
 * accounts, and balance (debits == credits in øre). All faults are collected so
 * the caller sees every problem before anything is posted.
 */
function validateVouchers(
  entries: ImportHistoricalEntry[],
  chartAccountNos: Set<string>,
): string[] {
  const errors: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const ref = refOf(entry, index);
    const lines = Array.isArray(entry.lines) ? entry.lines : [];
    if (lines.length < 2) {
      errors.push(
        `voucher ${ref} has only ${lines.length} line(s) — a voucher needs at least two`,
      );
    }
    let debitOre = 0n;
    let creditOre = 0n;
    for (const line of lines) {
      const accountNo = typeof line.accountNo === "string" ? line.accountNo.trim() : "";
      if (!accountNo) {
        errors.push(`voucher ${ref} has a line missing an accountNo`);
        continue;
      }
      if (chartAccountNos.size > 0 && !chartAccountNos.has(accountNo)) {
        errors.push(
          `voucher ${ref} references account '${accountNo}' which is not in the source chart of accounts`,
        );
      }
      const hasDebit = typeof line.debitAmount === "number" && Number.isFinite(line.debitAmount);
      const hasCredit = typeof line.creditAmount === "number" && Number.isFinite(line.creditAmount);
      if (hasDebit && hasCredit && line.debitAmount !== 0 && line.creditAmount !== 0) {
        errors.push(`voucher ${ref} (account '${accountNo}') carries both a debit and a credit`);
      }
      debitOre += toOre(hasDebit ? line.debitAmount! : 0);
      creditOre += toOre(hasCredit ? line.creditAmount! : 0);
    }
    if (debitOre !== creditOre) {
      errors.push(
        `voucher ${ref} does not balance: debits != credits (${debitOre} != ${creditOre} øre)`,
      );
    }
  }
  return errors;
}

/**
 * Dinero records EU-service reverse charge through the exact control-account
 * pair 64040 (credit output VAT) + 64060 (debit input VAT). Older exports may
 * leave Momstype blank on the expense base even though that source-native
 * control pattern is present. Treating both control movements as unrelated
 * generic corrections would produce a filing with VAT amounts but no rubrik-A
 * base. Infer the base only when one unclassified expense line matches the
 * 25% controls exactly; otherwise fail closed for human resolution.
 */
function classifyDineroReverseChargePatterns(
  db: Database,
  entries: ImportHistoricalEntry[],
): { entries: ImportHistoricalEntry[]; errors: string[] } {
  const accountRows = db
    .query("SELECT account_no, type, normal_balance FROM accounts")
    .all() as Array<{
    account_no: string;
    type: string;
    normal_balance: "debit" | "credit";
  }>;
  const accounts = new Map(accountRows.map((row) => [row.account_no, row]));
  const errors: string[] = [];
  const legacyVatToleranceOre = 1n;
  const withinLegacyVatTolerance = (actual: bigint, expected: bigint): boolean => {
    const difference = actual - expected;
    return (difference < 0n ? -difference : difference) <= legacyVatToleranceOre;
  };
  const accountNoOf = (line: ImportHistoricalEntry["lines"][number]): string =>
    typeof line.accountNo === "string" ? line.accountNo.trim() : "";

  const classified = entries.map((entry, entryIndex) => {
    const lines = Array.isArray(entry.lines) ? entry.lines : [];
    const outputControls = lines.filter((line) => accountNoOf(line) === "64040");
    const inputControls = lines.filter((line) => accountNoOf(line) === "64060");
    if (outputControls.length === 0 || inputControls.length === 0) return entry;

    // Account numbers alone are never enough: retain the source chart shape
    // so an unrelated manual/custom chart cannot acquire Dinero semantics.
    const outputAccount = accounts.get("64040");
    const inputAccount = accounts.get("64060");
    const canonicalPair =
      outputAccount?.type === "vat" &&
      outputAccount.normal_balance === "credit" &&
      inputAccount?.type === "vat" &&
      inputAccount.normal_balance === "debit";
    const legacyPair =
      outputAccount?.type === "liability" &&
      outputAccount.normal_balance === "credit" &&
      inputAccount?.type === "liability" &&
      (inputAccount.normal_balance === "debit" || inputAccount.normal_balance === "credit");
    if (!canonicalPair && !legacyPair) return entry;

    const ref = refOf(entry, entryIndex);
    const outputOre = outputControls.reduce(
      (sum, line) => sum + toOre(line.creditAmount ?? 0) - toOre(line.debitAmount ?? 0),
      0n,
    );
    const inputOre = inputControls.reduce(
      (sum, line) => sum + toOre(line.debitAmount ?? 0) - toOre(line.creditAmount ?? 0),
      0n,
    );
    if (outputOre <= 0n || inputOre <= 0n || outputOre !== inputOre) {
      errors.push(
        `voucher ${ref} has an inconsistent Dinero reverse-charge control pattern on 64040/64060; human resolution is required`,
      );
      return entry;
    }

    const expenseIndexes = lines.flatMap((line, lineIndex) =>
      accounts.get(accountNoOf(line))?.type === "expense" ? [lineIndex] : [],
    );
    const explicitCode = (lineIndex: number): string => {
      const line = lines[lineIndex]!;
      return typeof line.vatCode === "string" ? line.vatCode.trim() : "";
    };
    const reverseChargeCodes = new Set([
      "EU_SERVICE_REVERSE_CHARGE",
      "NON_EU_SERVICE_REVERSE_CHARGE",
    ]);
    const alreadyClassified = expenseIndexes.filter(
      (lineIndex) => reverseChargeCodes.has(explicitCode(lineIndex)),
    );
    const explicitReverseChargeCodes = new Set(
      alreadyClassified.map((lineIndex) => explicitCode(lineIndex)),
    );
    if (explicitReverseChargeCodes.size > 1) {
      errors.push(
        `voucher ${ref} mixes EU and non-EU reverse-charge bases; human resolution is required`,
      );
      return entry;
    }

    let baseIndexes = alreadyClassified;
    if (baseIndexes.length === 0) {
      // A source line's explicit Momstype is authoritative. An account-level
      // default is only a normalisation convenience and may be wrong for an
      // old Dinero voucher, so the exact control pair may override that
      // default but never an explicit line classification.
      const conflicting = expenseIndexes.filter((lineIndex) => explicitCode(lineIndex).length > 0);
      if (conflicting.length > 0) {
        errors.push(
          `voucher ${ref} has Dinero reverse-charge controls but its expense base carries a conflicting VAT code; human resolution is required`,
        );
        return entry;
      }
      baseIndexes = expenseIndexes.filter((lineIndex) => {
        const line = lines[lineIndex]!;
        const netDebit = Number(line.debitAmount ?? 0) - Number(line.creditAmount ?? 0);
        return netDebit > 0 && withinLegacyVatTolerance(
          toOre(percentOfDkk(netDebit, 25)),
          outputOre,
        );
      });
      if (baseIndexes.length !== 1) {
        errors.push(
          `voucher ${ref} has Dinero reverse-charge controls but no single unclassified expense base matching 25%; human resolution is required`,
        );
        return entry;
      }
    }

    const baseOre = baseIndexes.reduce((sum, lineIndex) => {
      const line = lines[lineIndex]!;
      return sum + toOre(Number(line.debitAmount ?? 0) - Number(line.creditAmount ?? 0));
    }, 0n);
    if (!withinLegacyVatTolerance(toOre(percentOfDkk(Number(baseOre) / 100, 25)), outputOre)) {
      errors.push(
        `voucher ${ref} has Dinero reverse-charge controls that do not reconcile to its classified expense base; human resolution is required`,
      );
      return entry;
    }

    const baseIndexSet = new Set(baseIndexes);
    const inferredCode = explicitReverseChargeCodes.values().next().value ?? "EU_SERVICE_REVERSE_CHARGE";
    return {
      ...entry,
      lines: lines.map((line, lineIndex) =>
        baseIndexSet.has(lineIndex)
          ? { ...line, vatCode: inferredCode }
          : line,
      ),
    };
  });

  return { entries: classified, errors };
}

/**
 * Replays a source system's year-to-date vouchers into the live ledger as
 * journal entries — one balanced entry per voucher.
 *
 * The whole batch is validated FIRST (accounts known, every voucher balances);
 * if any voucher fails, nothing is posted and the faults are returned. On a
 * clean batch each voucher is posted through the verified import path, in voucher order,
 * stamped with `IMPORT_POSTINGS_PROGRAM` so the entries are auditable imports.
 * The source postings are the migration's source of truth and carry no
 * Rentemester document yet (#196 attaches the bilag), so the narrow internal
 * historical-import policy waives that document requirement.
 */
export function postDineroPostings(
  db: Database,
  entries: ImportHistoricalEntry[],
  chartAccountNos: Set<string>,
  options: { createdBy?: string } = {},
): DineroPostingsResult {
  const auditTrail: string[] = [];
  const posted: PostedVoucher[] = [];

  if (entries.length === 0) {
    auditTrail.push("No year-to-date postings to replay");
    return { ok: true, posted, auditTrail, errors: [] };
  }

  const reverseChargeClassification = classifyDineroReverseChargePatterns(db, entries);
  const validationErrors = [
    ...reverseChargeClassification.errors,
    ...validateVouchers(reverseChargeClassification.entries, chartAccountNos),
  ];
  if (validationErrors.length > 0) {
    auditTrail.push(
      `Year-to-date postings rejected: ${validationErrors.length} voucher validation error(s) — nothing posted`,
    );
    return { ok: false, posted, auditTrail, errors: validationErrors };
  }

  for (let index = 0; index < reverseChargeClassification.entries.length; index += 1) {
    const entry = reverseChargeClassification.entries[index]!;
    const ref = refOf(entry, index);
    const baseText = typeof entry.text === "string" && entry.text.trim().length > 0
      ? entry.text.trim()
      : `voucher ${ref}`;
    const entryType = typeof entry.entryType === "string" ? entry.entryType.trim() : "";
    const text =
      entryType.length > 0
        ? `Import: ${entryType} (bilag ${ref}) — ${baseText}`
        : `Import: bilag ${ref} — ${baseText}`;
    const result = postVerifiedHistoricalImportEntry(db, {
      transactionDate: entry.transactionDate,
      text,
      createdBy: options.createdBy,
      lines: entry.lines.map((line) => ({
        accountNo: line.accountNo,
        debitAmount: line.debitAmount,
        creditAmount: line.creditAmount,
        ...(line.vatCode ? { vatCode: line.vatCode } : {}),
        text:
          typeof line.text === "string" && line.text.trim().length > 0
            ? line.text.trim()
            : baseText,
      })),
    });
    if (!result.ok || result.entryId == null || result.entryNo == null) {
      auditTrail.push(
        `postJournalEntry rejected voucher ${ref} — ${posted.length} earlier voucher(s) already posted`,
      );
      return {
        ok: false,
        posted,
        auditTrail,
        errors: result.errors.map((e) => `voucher ${ref}: ${e}`),
      };
    }
    posted.push({
      voucherRef: ref,
      entryId: result.entryId as unknown as number,
      entryNo: result.entryNo,
      transactionDate: entry.transactionDate,
    });
  }

  auditTrail.push(
    `Replayed ${posted.length} year-to-date voucher(s) as journal entries ` +
      `(${posted.map((p) => `${p.voucherRef}->${p.entryNo}`).join(", ")})`,
  );
  return { ok: true, posted, auditTrail, errors: [] };
}
