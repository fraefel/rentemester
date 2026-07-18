// Import framework — maps a normalised `ImportSource` onto the primobalance.
// Issue #185.
//
// `runImport` is the parser-agnostic engine. A per-system parser (implementing
// the `SourceParser` contract in ./types.ts) produces an `ImportSource`;
// `runImport` validates it and lands it on the #179 primobalance target by
// calling `postOpeningBalance`. It never reimplements opening-balance logic —
// the hash chain, append-only protection and audit log are inherited for free.
//
// Validation done HERE (before postOpeningBalance is even called):
//  - cut-over date present and well-formed
//  - at least one opening-balance line
//  - every opening-balance line references an account in the source's chart
//  - no line carries both a debit AND a credit amount
//  - the opening balances balance (sum debit == sum credit, in øre)
//
// postOpeningBalance then re-validates against the LIVE chart of accounts and
// owns idempotency (one primobalance per company). Failing fast here gives a
// clear, source-shaped error; postOpeningBalance is the backstop.

import { dirname } from "node:path";
import type { Database } from "bun:sqlite";
import { postOpeningBalance } from "../opening-balance";
import { isValidIsoDate } from "../dates";
import { toOre } from "../money";
import { reconcileChartOfAccounts, reconcileCompanyMasterData } from "./reconcile";
import { postDineroPostings, IMPORT_POSTINGS_RULE } from "./dinero-postings";
import { resolveSource } from "./source";
import {
  archiveDineroYears,
  checkRollForward,
  describeRollForward,
  parseArchiveYears,
} from "./dinero-archive";
import { ingestDineroBilag } from "./dinero-bilag";
import type {
  ImportOptions,
  ImportResult,
  ImportSource,
  MultiArtifactSource,
  ParseResult,
  SourceParser,
} from "./types";

const IMPORT_RULE = "DK-BOOKKEEPING-BALANCED-001";

/**
 * Validates and posts a normalised `ImportSource` as the company's
 * primobalance. Pure with respect to its inputs and deterministic: the same
 * `ImportSource` always produces the same `auditTrail` and (on a fresh
 * company) the same `entryNo`.
 */
export function runImport(
  db: Database,
  source: ImportSource,
  options: ImportOptions = {},
): ImportResult {
  const errors: string[] = [];
  const auditTrail: string[] = [];
  const sourceSystem =
    typeof source?.sourceSystem === "string" && source.sourceSystem.trim().length > 0
      ? source.sourceSystem.trim()
      : "unknown";

  const fail = (extra: string[] = []): ImportResult => ({
    ok: false,
    sourceSystem,
    cutOverDate: typeof source?.cutOverDate === "string" ? source.cutOverDate.trim() : undefined,
    openingBalanceLineCount: Array.isArray(source?.openingBalances)
      ? source.openingBalances.length
      : 0,
    historicalEntriesSkipped: Array.isArray(source?.historicalEntries)
      ? source.historicalEntries.length
      : 0,
    auditTrail,
    appliedRules: [IMPORT_RULE],
    errors: [...errors, ...extra],
  });

  auditTrail.push(`Import started from source system '${sourceSystem}'`);

  // --- chart of accounts ---------------------------------------------------
  const chart = Array.isArray(source?.chartOfAccounts) ? source.chartOfAccounts : [];
  const chartAccountNos = new Set(
    chart
      .map((a) => (typeof a?.accountNo === "string" ? a.accountNo.trim() : ""))
      .filter((a) => a.length > 0),
  );
  const chartNames = new Map(
    chart
      .filter((a) => typeof a?.accountNo === "string" && a.accountNo.trim().length > 0)
      .map((a) => [a.accountNo.trim(), typeof a.name === "string" ? a.name.trim() : ""]),
  );
  auditTrail.push(`Source chart of accounts has ${chartAccountNos.size} account(s)`);

  // --- opening balances & cut-over date ------------------------------------
  // A source may carry only a chart of accounts + company master data and no
  // primobalance — that is the Dinero chart import (#193); posting the
  // primobalance is a separate step (#194). Such a source declares its intent
  // by carrying NO cut-over date: it is reconciled into the live ledger but
  // posts nothing. A source that DOES carry a cut-over date is a primobalance
  // import and must carry balanced opening balances.
  const openingBalances = Array.isArray(source?.openingBalances) ? source.openingBalances : [];
  const cutOverDate = typeof source?.cutOverDate === "string" ? source.cutOverDate.trim() : "";
  const chartOnly = cutOverDate.length === 0 && openingBalances.length === 0 && chart.length > 0;

  if (chartOnly) {
    auditTrail.push("Source carries no cut-over date — chart/master-data import only");
  } else {
    if (!isValidIsoDate(cutOverDate)) {
      errors.push("cut-over date must be present in YYYY-MM-DD format");
    } else {
      auditTrail.push(`Cut-over date is ${cutOverDate}`);
    }
    if (openingBalances.length === 0) {
      errors.push("import source has no opening balances to post");
    }
  }

  let debitOre = 0n;
  let creditOre = 0n;
  for (let i = 0; i < openingBalances.length; i += 1) {
    const line = openingBalances[i]!;
    const accountNo = typeof line.accountNo === "string" ? line.accountNo.trim() : "";
    if (!accountNo) {
      errors.push(`openingBalances[${i}] is missing an accountNo`);
      continue;
    }
    if (chartAccountNos.size > 0 && !chartAccountNos.has(accountNo)) {
      errors.push(
        `openingBalances[${i}] references account '${accountNo}' which is not in the source chart of accounts`,
      );
    }
    const hasDebit = typeof line.debitAmount === "number" && Number.isFinite(line.debitAmount);
    const hasCredit = typeof line.creditAmount === "number" && Number.isFinite(line.creditAmount);
    if (hasDebit && hasCredit && line.debitAmount! !== 0 && line.creditAmount! !== 0) {
      errors.push(
        `openingBalances[${i}] (account '${accountNo}') carries both a debit and a credit amount`,
      );
    }
    if (!hasDebit && !hasCredit) {
      errors.push(`openingBalances[${i}] (account '${accountNo}') has neither a debit nor a credit amount`);
    }
    debitOre += toOre(hasDebit ? line.debitAmount! : 0);
    creditOre += toOre(hasCredit ? line.creditAmount! : 0);
  }

  if (openingBalances.length > 0 && debitOre !== creditOre) {
    errors.push(
      `import source does not balance: opening-balance debits != credits (${debitOre} != ${creditOre} øre)`,
    );
  }

  // Historical entries (#195) — year-to-date vouchers replayed AFTER the
  // primobalance. Their per-voucher balance is checked up front so an
  // unbalanced voucher rejects the WHOLE import before anything is posted.
  const historicalEntries = Array.isArray(source?.historicalEntries)
    ? source.historicalEntries
    : [];
  for (let i = 0; i < historicalEntries.length; i += 1) {
    const entry = historicalEntries[i]!;
    const ref =
      typeof entry?.voucherRef === "string" && entry.voucherRef.trim().length > 0
        ? entry.voucherRef.trim()
        : `#${i + 1}`;
    const lines = Array.isArray(entry?.lines) ? entry.lines : [];
    if (lines.length < 2) {
      errors.push(`historical voucher ${ref} needs at least two lines`);
    }
    let voucherDebitOre = 0n;
    let voucherCreditOre = 0n;
    for (const line of lines) {
      const accountNo = typeof line.accountNo === "string" ? line.accountNo.trim() : "";
      if (!accountNo) {
        errors.push(`historical voucher ${ref} has a line missing an accountNo`);
        continue;
      }
      if (chartAccountNos.size > 0 && !chartAccountNos.has(accountNo)) {
        errors.push(
          `historical voucher ${ref} references account '${accountNo}' which is not in the source chart of accounts`,
        );
      }
      const hasDebit = typeof line.debitAmount === "number" && Number.isFinite(line.debitAmount);
      const hasCredit = typeof line.creditAmount === "number" && Number.isFinite(line.creditAmount);
      voucherDebitOre += toOre(hasDebit ? line.debitAmount! : 0);
      voucherCreditOre += toOre(hasCredit ? line.creditAmount! : 0);
    }
    if (lines.length >= 2 && voucherDebitOre !== voucherCreditOre) {
      errors.push(
        `historical voucher ${ref} does not balance: debits != credits (${voucherDebitOre} != ${voucherCreditOre} øre)`,
      );
    }
  }

  if (errors.length > 0) {
    auditTrail.push(`Validation failed with ${errors.length} error(s) — nothing posted`);
    return fail();
  }

  // --- reconcile chart of accounts & company master data ------------------
  // This always runs when the source carries them, for BOTH a chart-only
  // import (#193) and a full primobalance import (#194). It is the prerequisite
  // that lets `postOpeningBalance` validate every line against the live chart.
  let chartResult: ImportResult["chart"];
  let companyResult: ImportResult["company"];
  if (chart.length > 0) {
    chartResult = reconcileChartOfAccounts(db, source, {
      createdBy: options.createdBy,
      createdByProgram: options.createdByProgram ?? "rentemester-import",
    });
    auditTrail.push(
      `Reconciled chart of accounts: ${chartResult.created.length} created, ` +
        `${chartResult.existing.length} already present, ` +
        `${chartResult.updated.length} reclassified, ` +
        `${chartResult.conflicts.length} conflict(s)`,
    );
    if (chartResult.unmappedVatCodes.length > 0) {
      auditTrail.push(
        `Unmapped VAT code(s) — review required: ${chartResult.unmappedVatCodes.join("; ")}`,
      );
    }
    for (const diff of chartResult.differences) auditTrail.push(`Chart difference: ${diff}`);
    for (const conflict of chartResult.conflicts) {
      auditTrail.push(`Chart conflict — review required: ${conflict}`);
    }
  }
  if (source?.companyMasterData) {
    companyResult = reconcileCompanyMasterData(db, source, {
      createdBy: options.createdBy,
      createdByProgram: options.createdByProgram ?? "rentemester-import",
    });
    auditTrail.push(
      `Reconciled company master data: updated [${companyResult.updatedFields.join(", ") || "nothing"}]`,
    );
    for (const note of companyResult.notes) auditTrail.push(`Company note: ${note}`);
  }

  // A chart-only source (#193) is done here — the primobalance is #194's job.
  if (chartOnly) {
    return {
      ok: true,
      sourceSystem,
      openingBalanceLineCount: 0,
      historicalEntriesSkipped: historicalEntries.length,
      chart: chartResult,
      company: companyResult,
      auditTrail,
      appliedRules: [IMPORT_RULE],
      errors: [],
    };
  }

  auditTrail.push(
    `Validated ${openingBalances.length} opening-balance line(s); balanced at ${debitOre} øre`,
  );

  // --- map onto the #179 primobalance target ------------------------------
  // Deterministic ordering: opening-balance lines are posted in the order the
  // parser produced them, so the resulting journal entry is reproducible.
  const note =
    typeof source.note === "string" && source.note.trim().length > 0
      ? `Import fra ${sourceSystem} — ${source.note.trim()}`
      : `Import fra ${sourceSystem}`;

  const result = postOpeningBalance(db, {
    cutOverDate,
    note,
    createdBy: options.createdBy,
    createdByProgram: options.createdByProgram ?? "rentemester-import",
    lines: openingBalances.map((line) => {
      const accountNo = line.accountNo.trim();
      return {
        accountNo,
        debitAmount: line.debitAmount,
        creditAmount: line.creditAmount,
        text:
          typeof line.text === "string" && line.text.trim().length > 0
            ? line.text.trim()
            : chartNames.get(accountNo) || `Primobalance ${accountNo}`,
      };
    }),
  });

  if (!result.ok || result.entryId == null || result.entryNo == null) {
    auditTrail.push("postOpeningBalance rejected the primobalance — nothing posted");
    return {
      ok: false,
      sourceSystem,
      cutOverDate,
      openingBalanceLineCount: openingBalances.length,
      historicalEntriesSkipped: historicalEntries.length,
      auditTrail,
      appliedRules: [...new Set([IMPORT_RULE, ...result.appliedRules])],
      errors: result.errors,
    };
  }

  auditTrail.push(`Posted primobalance as journal entry ${result.entryNo}`);

  // --- year-to-date postings (#195) ---------------------------------------
  // After the primobalance the company sits at the cut-over date. The source's
  // historical entries are the activity since then; replay each as a balanced
  // journal entry, marked as an imported migration posting. Each voucher was
  // already balance-checked above, so this should not fail — but if a voucher
  // is still rejected by `postJournalEntry` the import is reported as failed
  // with the primobalance left posted (it is valid and idempotent on its own).
  let historicalEntriesPosted: ImportResult["historicalEntriesPosted"];
  const appliedRules = new Set([IMPORT_RULE, ...result.appliedRules]);
  if (historicalEntries.length > 0) {
    const postings = postDineroPostings(db, historicalEntries, chartAccountNos, {
      createdBy: options.createdBy,
    });
    for (const line of postings.auditTrail) auditTrail.push(line);
    if (!postings.ok) {
      return {
        ok: false,
        sourceSystem,
        cutOverDate,
        entryId: result.entryId,
        entryNo: result.entryNo,
        entryHash: result.entryHash,
        openingBalanceLineCount: openingBalances.length,
        historicalEntriesSkipped: historicalEntries.length,
        historicalEntriesPosted: postings.posted,
        chart: chartResult,
        company: companyResult,
        auditTrail,
        appliedRules: [...appliedRules, IMPORT_POSTINGS_RULE],
        errors: postings.errors,
      };
    }
    appliedRules.add(IMPORT_POSTINGS_RULE);
    historicalEntriesPosted = postings.posted;
  }

  return {
    ok: true,
    sourceSystem,
    cutOverDate,
    entryId: result.entryId,
    entryNo: result.entryNo,
    entryHash: result.entryHash,
    openingBalanceLineCount: openingBalances.length,
    historicalEntriesSkipped: 0,
    ...(historicalEntriesPosted ? { historicalEntriesPosted } : {}),
    chart: chartResult,
    company: companyResult,
    auditTrail,
    appliedRules: [...appliedRules],
    errors: [],
  };
}

/**
 * Runs an import end-to-end from an export PATH using a `SourceParser`. It
 * resolves the path (a directory, a `.zip`'s unpacked tree, or a single file)
 * into a `MultiArtifactSource`, dispatches to whichever parser shape is
 * implemented — `parseSource` (multi-file, e.g. Dinero #193) or `parse` (a
 * single text file, e.g. synthetic-csv) — checks the parser's `requiredFiles`,
 * and hands the resulting `ImportSource` to `runImport`.
 *
 * The CLI `import run` calls this so a single code path serves every parser.
 */
export function runImportFromSource(
  db: Database,
  parser: SourceParser,
  path: string,
  options: ImportOptions = {},
): ImportResult {
  const failParse = (errors: string[], resolved?: MultiArtifactSource): ImportResult => ({
    ok: false,
    sourceSystem: parser.system,
    openingBalanceLineCount: 0,
    historicalEntriesSkipped: 0,
    auditTrail: [`Import started from source system '${parser.system}'`],
    appliedRules: [IMPORT_RULE],
    errors,
    ...(resolved?.archiveIntegrity ? { archiveIntegrity: resolved.archiveIntegrity } : {}),
  });

  let resolved: MultiArtifactSource;
  try {
    resolved = resolveSource(path);
  } catch (error) {
    return failParse([
      error instanceof Error ? error.message : `failed to resolve import source '${path}'`,
    ]);
  }

  let parsed: ParseResult;
  if (typeof parser.parseSource === "function") {
    // Multi-file parser: enforce declared required files before parsing.
    const missing: string[] = [];
    for (const required of parser.requiredFiles ?? []) {
      if (!resolved.files[required]) {
        missing.push(`required export file '${required}' is missing`);
      }
    }
    if (missing.length > 0) return failParse(missing, resolved);
    parsed = parser.parseSource(resolved);
  } else if (typeof parser.parse === "function") {
    // Single-string parser: it expects one file's text. A directory with more
    // than one file is ambiguous for such a parser.
    const names = Object.keys(resolved.files);
    if (names.length !== 1) {
      return failParse([
        `parser '${parser.system}' expects a single export file but ${names.length} were found at ${path}`,
      ], resolved);
    }
    parsed = parser.parse(resolved.files[names[0]!]!.text);
  } else {
    return failParse([`parser '${parser.system}' implements neither parse nor parseSource`], resolved);
  }

  if (!parsed.ok || !parsed.source) {
    return failParse(parsed.errors, resolved);
  }
  if (parser.system === "dinero" && typeof parser.parseSource === "function") {
    const archivePreflightErrors = preflightDineroArchive(db, resolved, parsed.source);
    if (archivePreflightErrors.length > 0) return failParse(archivePreflightErrors, resolved);
  }
  const result = runImport(db, parsed.source as ImportSource, options);
  if (resolved.archiveIntegrity) result.archiveIntegrity = resolved.archiveIntegrity;

  // --- pre-cut-over fiscal-year archive (#197) -----------------------------
  // A Dinero export spans several fiscal years; only the cut-over year was
  // posted above. The EARLIER years are archived as read-only reference data
  // (outside the live ledger) and their closing `SaldoBalance` is checked for
  // roll-forward consistency into the next year's opening balance. Archiving
  // is purely additive: it never affects whether the ledger import succeeded.
  if (result.ok && parser.system === "dinero" && typeof parser.parseSource === "function") {
    archivePreCutOverYears(db, resolved, result);
    // --- bilag (receipts) ingest (#196) ------------------------------------
    // A Dinero export ships the actual receipts. Ingest each cut-over-year
    // bilag through the documents pipeline, link it to its voucher's journal
    // entry, and flag every unbooked receipt in the exception queue. Like
    // archiving this is purely additive — it never changes the ledger import
    // outcome.
    ingestBilag(db, resolved, result, companyRootFor(db, options));
  }
  return result;
}

/** Validates archive parsing and roll-forward before the live ledger can change. */
function preflightDineroArchive(
  db: Database,
  resolved: MultiArtifactSource,
  source: ImportSource,
): string[] {
  const parsed = parseArchiveYears(resolved);
  if (!parsed.ok) return parsed.errors.map((error) => `archive integrity failure: ${error}`);
  const closingBalances = new Map<number, Map<string, number>>(
    parsed.years.map((year) => [
      year.fiscalYear,
      new Map(year.balances.map((balance) => [balance.accountNo, balance.amount])),
    ]),
  );
  const accountTypes = new Map(
    source.chartOfAccounts
      .filter((account) => account.normalizedType)
      .map((account) => [account.accountNo, account.normalizedType!] as const),
  );
  const rollForward = checkRollForward(db, resolved, { closingBalances, accountTypes });
  if (rollForward.ok) return [];
  return [
    ...rollForward.errors.map((error) => `roll-forward integrity failure: ${error}`),
    ...rollForward.breaks.map(
      (item) =>
        `roll-forward integrity failure: account ${item.accountNo} ${item.fromYear}->${item.toYear} closing ${item.closingAmount} != opening ${item.openingAmount}`,
    ),
  ];
}

/**
 * Resolves the company root directory for receipt-originals storage (#196).
 * An explicit `options.companyRoot` wins; otherwise it is derived from the open
 * database's path (`<root>/data/ledger.sqlite` -> `<root>`). Returns `null`
 * for an in-memory ledger with no explicit root — bilag ingest is then skipped.
 */
function companyRootFor(db: Database, options: ImportOptions): string | null {
  if (typeof options.companyRoot === "string" && options.companyRoot.trim().length > 0) {
    return options.companyRoot.trim();
  }
  const filename = (db as unknown as { filename?: string }).filename;
  if (typeof filename === "string" && filename.length > 0 && filename !== ":memory:") {
    return dirname(dirname(filename));
  }
  return null;
}

/**
 * Ingests the Dinero export's bilag (receipts) and records the outcome on the
 * `ImportResult` — `bilag` counts plus the bilag-ingest audit lines. A missing
 * company root (in-memory ledger) skips ingest with an audit note; bilag ingest
 * never changes whether the ledger import succeeded.
 */
function ingestBilag(
  db: Database,
  resolved: MultiArtifactSource,
  result: ImportResult,
  companyRoot: string | null,
): void {
  if (!companyRoot) {
    result.auditTrail.push(
      "Bilag ingest skipped: no company root available for receipt storage",
    );
    return;
  }
  const bilag = ingestDineroBilag(db, companyRoot, resolved, result);
  for (const line of bilag.auditTrail) result.auditTrail.push(line);
  for (const error of bilag.errors) {
    result.auditTrail.push(`Bilag ingest warning: ${error}`);
  }
  result.bilag = {
    linkedCount: bilag.linked.length,
    unmatchedCount: bilag.unmatched.length,
    duplicateCount: bilag.duplicates.length,
    unbookedCount: bilag.unbooked.length,
  };
}

/**
 * Archives the pre-cut-over fiscal years of a resolved Dinero export and runs
 * the closing-balance roll-forward consistency check, appending both outcomes
 * to the `ImportResult.auditTrail`. The archive lives in the `import_archive_*`
 * tables, entirely outside the hash-chained live journal (#197).
 */
function archivePreCutOverYears(
  db: Database,
  resolved: MultiArtifactSource,
  result: ImportResult,
): void {
  const archive = archiveDineroYears(db, resolved);
  for (const line of archive.auditTrail) result.auditTrail.push(line);
  if (!archive.ok) {
    for (const error of archive.errors) {
      result.auditTrail.push(`Archive warning: ${error}`);
    }
    return;
  }
  const rollForward = checkRollForward(db, resolved);
  for (const line of describeRollForward(rollForward)) result.auditTrail.push(line);
  if (!rollForward.ok) {
    result.auditTrail.push(
      `Roll-forward check FAILED: ${rollForward.breaks.length} break(s) flagged — review required`,
    );
  } else if (rollForward.steps.length > 0) {
    result.auditTrail.push("Roll-forward check passed: archived years carry forward consistently");
  }
}
