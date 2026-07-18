import type { Database } from "bun:sqlite";
import { compareDkk, fromOre, roundDkk, toOre } from "./money";

export type ClaimReceivableBalance = { accountNo: string; amountDkk: number };

export type ClaimReceivableResult =
  | { ok: true; balances: ClaimReceivableBalance[]; totalDkk: number }
  | { ok: false; errors: string[] };

export type ClaimReceiptAllocationResult =
  | { ok: true; credits: ClaimReceivableBalance[] }
  | { ok: false; error: string };

export type InterestIncomeBalanceResult =
  | { ok: true; balances: ClaimReceivableBalance[]; totalDkk: number }
  | { ok: false; errors: string[] };

export type InterestReceivableBalanceResult =
  | {
      ok: true;
      balances: ClaimReceivableBalance[];
      totalDkk: number;
      possibleTotalDkk: number;
      ambiguousDkk: number;
    }
  | { ok: false; errors: string[] };

type ClaimPosting = {
  kind: "reminder" | "compensation" | "interest";
  claim_id: number;
  effective_date: string;
  amount_dkk: number;
  journal_entry_id: number | null;
};

type JournalEvidence = {
  id: number;
  document_id: number | null;
  transaction_date: string;
  status: string;
  reversed_by_entry_id: number | null;
};

type ClaimPostingJournalEvidence = {
  journal_entry_id: number;
  source_bank_transaction_id: number | null;
  currency: string | null;
  amount_foreign: number | null;
  amount_dkk: number | null;
  fx_rate_to_dkk: number | null;
  line_count: number;
  total_debit_ore: number;
  total_credit_ore: number;
  receivable_debit_ore: number;
  income_credit_ore: number;
  invalid_line_count: number;
};

export type ClaimIncomeAccountResult =
  | { ok: true; accountNo: string }
  | { ok: false; error: string };

/** Resolve the only account class a claim-origin credit may use. */
export function resolveClaimIncomeAccount(
  db: Database,
  requestedAccountNo = "1010",
): ClaimIncomeAccountResult {
  const accountNo = requestedAccountNo.trim();
  const account = db.query(
    `SELECT account_no, type, normal_balance, active, allow_direct_posting
       FROM accounts
      WHERE account_no = ?`,
  ).get(accountNo) as {
    account_no: string;
    type: string;
    normal_balance: string;
    active: number;
    allow_direct_posting: number;
  } | null;
  if (!account) return { ok: false, error: `claim income account ${accountNo || "(empty)"} does not exist` };
  if (
    account.type !== "income" ||
    account.normal_balance !== "credit" ||
    account.active !== 1 ||
    account.allow_direct_posting !== 1
  ) {
    return {
      ok: false,
      error: `account ${accountNo} is not an active, directly postable credit-normal income account`,
    };
  }
  return { ok: true, accountNo };
}

function journalAtCutoff(
  db: Database,
  journalEntryId: number,
  beforeJournalEntryId?: number,
): JournalEvidence | null {
  const cutoff = beforeJournalEntryId ?? null;
  return db.query(
    `SELECT j.id, j.document_id, j.transaction_date, j.status,
            (SELECT reversal.id
               FROM journal_entries reversal
              WHERE reversal.reversal_of_entry_id = j.id
                AND (? IS NULL OR reversal.id < ?)
              ORDER BY reversal.id ASC
              LIMIT 1) AS reversed_by_entry_id
       FROM journal_entries j
      WHERE j.id = ?
        AND (? IS NULL OR j.id < ?)`,
  ).get(cutoff, cutoff, journalEntryId, cutoff, cutoff) as JournalEvidence | null;
}

function claimPostingJournalEvidence(
  db: Database,
  journalEntryId: number,
): ClaimPostingJournalEvidence | null {
  return db.query(
    `SELECT journal_entry_id, source_bank_transaction_id, currency,
            amount_foreign, amount_dkk, fx_rate_to_dkk, line_count,
            total_debit_ore, total_credit_ore, receivable_debit_ore,
            income_credit_ore, invalid_line_count
       FROM invoice_claim_posting_journal_evidence
      WHERE journal_entry_id = ?`,
  ).get(journalEntryId) as ClaimPostingJournalEvidence | null;
}

function assetEffects(db: Database, journalEntryId: number) {
  return db.query(
    `SELECT a.account_no,
            SUM(jl.debit_amount) - SUM(jl.credit_amount) AS effect_dkk
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.journal_entry_id = ?
        AND a.type = 'asset'
        AND a.normal_balance = 'debit'
      GROUP BY a.account_no
     HAVING ROUND(SUM(jl.debit_amount) - SUM(jl.credit_amount), 2) <> 0
      ORDER BY a.account_no ASC`,
  ).all(journalEntryId) as Array<{ account_no: string; effect_dkk: number }>;
}

function incomeEffects(db: Database, journalEntryId: number) {
  return db.query(
    `SELECT a.account_no,
            SUM(jl.credit_amount) - SUM(jl.debit_amount) AS effect_dkk
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
      WHERE jl.journal_entry_id = ?
        AND a.type = 'income'
        AND a.normal_balance = 'credit'
      GROUP BY a.account_no
     HAVING ROUND(SUM(jl.credit_amount) - SUM(jl.debit_amount), 2) <> 0
      ORDER BY a.account_no ASC`,
  ).all(journalEntryId) as Array<{ account_no: string; effect_dkk: number }>;
}

function addEffect(target: Map<string, bigint>, accountNo: string, amountDkk: number) {
  target.set(accountNo, (target.get(accountNo) ?? 0n) + toOre(amountDkk));
}

function claimPostings(db: Database, invoiceDocumentId: number): ClaimPosting[] {
  return db.query(
    `SELECT 'reminder' AS kind, r.id AS claim_id,
            r.reminder_date AS effective_date, r.fee_amount AS amount_dkk,
            p.journal_entry_id
       FROM invoice_reminders r
       LEFT JOIN invoice_reminder_postings p ON p.reminder_id = r.id
      WHERE r.invoice_document_id = ?
     UNION ALL
     SELECT 'compensation' AS kind, c.id AS claim_id,
            c.claim_date AS effective_date, c.amount_dkk,
            p.journal_entry_id
       FROM invoice_compensation_claims c
       LEFT JOIN invoice_compensation_postings p ON p.compensation_claim_id = c.id
      WHERE c.invoice_document_id = ?
     UNION ALL
     SELECT 'interest' AS kind, c.id AS claim_id,
            c.claim_date AS effective_date, c.amount_dkk,
            p.journal_entry_id
       FROM invoice_interest_claims c
       LEFT JOIN invoice_interest_postings p ON p.interest_claim_id = c.id
      WHERE c.invoice_document_id = ?
      ORDER BY kind ASC, claim_id ASC`,
  ).all(invoiceDocumentId, invoiceDocumentId, invoiceDocumentId) as ClaimPosting[];
}

/**
 * Reconstruct the outstanding, ledger-backed claim receivable by account.
 * Registered claims only become settleable after their own active journal has
 * debited a receivable. Corrections and earlier claim receipts are then applied
 * in append order so a role change cannot strand a balance on an old account.
 */
export function calculateClaimReceivableBalances(
  db: Database,
  input: {
    invoiceDocumentId: number;
    beforeJournalEntryId?: number;
    asOfDate?: string;
    allowUnpostedClaims?: boolean;
  },
): ClaimReceivableResult {
  const errors: string[] = [];
  const balances = new Map<string, bigint>();

  for (const posting of claimPostings(db, input.invoiceDocumentId)) {
    const label = `${posting.kind} claim ${posting.claim_id}`;
    if (posting.journal_entry_id == null) {
      if (!input.allowUnpostedClaims) errors.push(`${label} is not ledger-posted`);
      continue;
    }
    const journal = journalAtCutoff(db, posting.journal_entry_id, input.beforeJournalEntryId);
    if (!journal) {
      errors.push(`${label} has no posting journal active before settlement`);
      continue;
    }
    if (journal.status !== "posted") errors.push(`${label} journal ${journal.id} is ${journal.status}, not posted`);
    if (journal.reversed_by_entry_id != null) errors.push(`${label} journal ${journal.id} was reversed by journal ${journal.reversed_by_entry_id}`);
    if (journal.document_id !== input.invoiceDocumentId) {
      errors.push(`${label} journal ${journal.id} is linked to invoice document ${journal.document_id ?? "none"}`);
    }
    if (journal.status !== "posted" || journal.reversed_by_entry_id != null || journal.document_id !== input.invoiceDocumentId) continue;

    if (journal.transaction_date < posting.effective_date) {
      errors.push(
        `${label} journal ${journal.id} date ${journal.transaction_date} predates claim date ${posting.effective_date}`,
      );
      continue;
    }

    if (
      input.asOfDate &&
      (posting.effective_date > input.asOfDate || journal.transaction_date > input.asOfDate)
    ) {
      errors.push(
        `${label} is not effective by ${input.asOfDate} ` +
        `(claim date ${posting.effective_date}, journal date ${journal.transaction_date})`,
      );
      continue;
    }

    const canonical = claimPostingJournalEvidence(db, journal.id);
    const expectedOre = toOre(Number(posting.amount_dkk));
    if (
      !canonical ||
      canonical.source_bank_transaction_id != null ||
      (canonical.currency ?? "DKK").trim().toUpperCase() !== "DKK" ||
      canonical.amount_foreign != null ||
      canonical.amount_dkk != null ||
      canonical.fx_rate_to_dkk != null ||
      canonical.line_count < 2 ||
      canonical.invalid_line_count !== 0 ||
      BigInt(canonical.total_debit_ore) !== expectedOre ||
      BigInt(canonical.total_credit_ore) !== expectedOre ||
      BigInt(canonical.receivable_debit_ore) !== expectedOre ||
      BigInt(canonical.income_credit_ore) !== expectedOre
    ) {
      errors.push(
        `${label} journal ${journal.id} must debit DKK receivable assets and credit income by exactly ${roundDkk(Number(posting.amount_dkk))} DKK without VAT, FX, bank, or other account effects`,
      );
      continue;
    }

    const effects = assetEffects(db, journal.id);
    const positive = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) > 0);
    const nonPositive = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) < 0);
    const totalDebit = roundDkk(positive.reduce((sum, row) => sum + Number(row.effect_dkk), 0));
    if (nonPositive.length > 0 || compareDkk(totalDebit, Number(posting.amount_dkk)) !== 0) {
      errors.push(`${label} journal ${journal.id} does not debit receivable assets by exactly ${roundDkk(Number(posting.amount_dkk))} DKK`);
      continue;
    }
    for (const row of positive) addEffect(balances, row.account_no, Number(row.effect_dkk));
  }

  const cutoff = input.beforeJournalEntryId ?? null;
  const corrections = db.query(
    `SELECT id, amount_dkk, journal_entry_id
       FROM invoice_interest_corrections
      WHERE invoice_document_id = ?
        AND (? IS NULL OR journal_entry_id < ?)
      ORDER BY journal_entry_id ASC, id ASC`,
  ).all(input.invoiceDocumentId, cutoff, cutoff) as Array<{
    id: number;
    amount_dkk: number;
    journal_entry_id: number;
  }>;
  for (const correction of corrections) {
    const label = `interest correction ${correction.id}`;
    const journal = journalAtCutoff(db, correction.journal_entry_id, input.beforeJournalEntryId);
    if (!journal || journal.status !== "posted" || journal.reversed_by_entry_id != null || journal.document_id !== input.invoiceDocumentId) {
      errors.push(`${label} does not have active journal evidence for invoice document ${input.invoiceDocumentId}`);
      continue;
    }
    const effects = assetEffects(db, journal.id);
    const negative = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) < 0);
    const positive = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) > 0);
    const totalCredit = roundDkk(negative.reduce((sum, row) => sum + -Number(row.effect_dkk), 0));
    if (positive.length > 0 || compareDkk(totalCredit, Number(correction.amount_dkk)) !== 0) {
      errors.push(`${label} journal ${journal.id} does not credit receivable assets by exactly ${roundDkk(Number(correction.amount_dkk))} DKK`);
      continue;
    }
    for (const row of negative) addEffect(balances, row.account_no, Number(row.effect_dkk));
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };

  const priorPayments = db.query(
    `SELECT id, amount, journal_entry_id
       FROM invoice_claim_payments
      WHERE invoice_document_id = ?
        AND journal_entry_id IS NOT NULL
        AND (? IS NULL OR journal_entry_id < ?)
      ORDER BY journal_entry_id ASC, id ASC`,
  ).all(input.invoiceDocumentId, cutoff, cutoff) as Array<{
    id: number;
    amount: number;
    journal_entry_id: number;
  }>;
  for (const payment of priorPayments) {
    const allocation = allocateClaimReceipt(
      [...balances.entries()]
        .filter(([, ore]) => ore > 0n)
        .map(([accountNo, ore]) => ({ accountNo, amountDkk: fromOre(ore) })),
      Number(payment.amount),
    );
    if (!allocation.ok) {
      return { ok: false, errors: [`claim payment ${payment.id}: ${allocation.error}`] };
    }
    for (const credit of allocation.credits) addEffect(balances, credit.accountNo, -credit.amountDkk);
  }

  const negative = [...balances.entries()].filter(([, ore]) => ore < 0n);
  if (negative.length > 0) {
    return {
      ok: false,
      errors: negative.map(([accountNo, ore]) => `claim receivable account ${accountNo} is over-cleared by ${fromOre(-ore)} DKK`),
    };
  }
  const resultBalances = [...balances.entries()]
    .filter(([, ore]) => ore > 0n)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountNo, ore]) => ({ accountNo, amountDkk: fromOre(ore) }));
  return {
    ok: true,
    balances: resultBalances,
    totalDkk: roundDkk(resultBalances.reduce((sum, row) => sum + row.amountDkk, 0)),
  };
}

/**
 * Reconstruct the still-credit interest income by the accounts actually used
 * by active claim postings. Corrections debit those same balances. This makes a
 * new correction an exact reversal of historical bookkeeping instead of an
 * assertion about whichever account happens to be configured today.
 */
export function calculateInterestIncomeBalances(
  db: Database,
  input: {
    invoiceDocumentId: number;
    beforeJournalEntryId?: number;
    allowUnpostedClaims?: boolean;
  },
): InterestIncomeBalanceResult {
  const errors: string[] = [];
  const balances = new Map<string, bigint>();
  const cutoff = input.beforeJournalEntryId ?? null;
  const claims = db.query(
    `SELECT c.id, c.amount_dkk, p.journal_entry_id
       FROM invoice_interest_claims c
       LEFT JOIN invoice_interest_postings p ON p.interest_claim_id = c.id
      WHERE c.invoice_document_id = ?
      ORDER BY c.claim_date ASC, c.id ASC`,
  ).all(input.invoiceDocumentId) as Array<{
    id: number;
    amount_dkk: number;
    journal_entry_id: number | null;
  }>;

  for (const claim of claims) {
    const label = `interest claim ${claim.id}`;
    if (claim.journal_entry_id == null) {
      if (!input.allowUnpostedClaims) errors.push(`${label} is not ledger-posted`);
      continue;
    }
    const journal = journalAtCutoff(db, claim.journal_entry_id, input.beforeJournalEntryId);
    if (!journal || journal.status !== "posted" || journal.reversed_by_entry_id != null || journal.document_id !== input.invoiceDocumentId) {
      errors.push(`${label} does not have active journal evidence for invoice document ${input.invoiceDocumentId}`);
      continue;
    }
    const effects = incomeEffects(db, journal.id);
    const positive = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) > 0);
    const negative = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) < 0);
    const totalCredit = roundDkk(positive.reduce((sum, row) => sum + Number(row.effect_dkk), 0));
    if (negative.length > 0 || compareDkk(totalCredit, Number(claim.amount_dkk)) !== 0) {
      errors.push(`${label} journal ${journal.id} does not credit income by exactly ${roundDkk(Number(claim.amount_dkk))} DKK`);
      continue;
    }
    for (const row of positive) addEffect(balances, row.account_no, Number(row.effect_dkk));
  }

  const corrections = db.query(
    `SELECT id, amount_dkk, journal_entry_id
       FROM invoice_interest_corrections
      WHERE invoice_document_id = ?
        AND (? IS NULL OR journal_entry_id < ?)
      ORDER BY journal_entry_id ASC, id ASC`,
  ).all(input.invoiceDocumentId, cutoff, cutoff) as Array<{
    id: number;
    amount_dkk: number;
    journal_entry_id: number;
  }>;
  for (const correction of corrections) {
    const label = `interest correction ${correction.id}`;
    const journal = journalAtCutoff(db, correction.journal_entry_id, input.beforeJournalEntryId);
    if (!journal || journal.status !== "posted" || journal.reversed_by_entry_id != null || journal.document_id !== input.invoiceDocumentId) {
      errors.push(`${label} does not have active journal evidence for invoice document ${input.invoiceDocumentId}`);
      continue;
    }
    const effects = incomeEffects(db, journal.id);
    const negative = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) < 0);
    const positive = effects.filter((row) => compareDkk(Number(row.effect_dkk), 0) > 0);
    const totalDebit = roundDkk(negative.reduce((sum, row) => sum + -Number(row.effect_dkk), 0));
    if (positive.length > 0 || compareDkk(totalDebit, Number(correction.amount_dkk)) !== 0) {
      errors.push(`${label} journal ${journal.id} does not debit income by exactly ${roundDkk(Number(correction.amount_dkk))} DKK`);
      continue;
    }
    for (const row of negative) addEffect(balances, row.account_no, Number(row.effect_dkk));
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  const negative = [...balances.entries()].filter(([, ore]) => ore < 0n);
  if (negative.length > 0) {
    return {
      ok: false,
      errors: negative.map(([accountNo, ore]) => `interest income account ${accountNo} is over-reversed by ${fromOre(-ore)} DKK`),
    };
  }
  const resultBalances = [...balances.entries()]
    .filter(([, ore]) => ore > 0n)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountNo, ore]) => ({ accountNo, amountDkk: fromOre(ore) }));
  return {
    ok: true,
    balances: resultBalances,
    totalDkk: roundDkk(resultBalances.reduce((sum, row) => sum + row.amountDkk, 0)),
  };
}

/**
 * Reconstruct the interest-only portion that is certainly still receivable.
 * Generic claim receipts do not identify a claim kind. When interest and other
 * claims share an account, conservatively assume receipts may have cleared the
 * interest first; only the remainder above all non-interest origins is safe to
 * reverse automatically. The possible/ambiguous totals let callers distinguish
 * a definite cash settlement from missing allocation evidence.
 */
export function calculateInterestReceivableBalances(
  db: Database,
  input: {
    invoiceDocumentId: number;
    beforeJournalEntryId?: number;
    allowUnpostedClaims?: boolean;
  },
): InterestReceivableBalanceResult {
  const aggregate = calculateClaimReceivableBalances(db, input);
  if (!aggregate.ok) return aggregate;

  const errors: string[] = [];
  const interestOrigins = new Map<string, bigint>();
  const otherOrigins = new Map<string, bigint>();
  for (const posting of claimPostings(db, input.invoiceDocumentId)) {
    if (posting.journal_entry_id == null) continue;
    const journal = journalAtCutoff(db, posting.journal_entry_id, input.beforeJournalEntryId);
    if (
      !journal ||
      journal.status !== "posted" ||
      journal.reversed_by_entry_id != null ||
      journal.document_id !== input.invoiceDocumentId
    ) continue;
    const target = posting.kind === "interest" ? interestOrigins : otherOrigins;
    for (const effect of assetEffects(db, journal.id)) {
      if (compareDkk(Number(effect.effect_dkk), 0) > 0) {
        addEffect(target, effect.account_no, Number(effect.effect_dkk));
      }
    }
  }

  const cutoff = input.beforeJournalEntryId ?? null;
  const corrections = db.query(
    `SELECT id, journal_entry_id
       FROM invoice_interest_corrections
      WHERE invoice_document_id = ?
        AND (? IS NULL OR journal_entry_id < ?)
      ORDER BY journal_entry_id ASC, id ASC`,
  ).all(input.invoiceDocumentId, cutoff, cutoff) as Array<{
    id: number;
    journal_entry_id: number;
  }>;
  for (const correction of corrections) {
    const journal = journalAtCutoff(db, correction.journal_entry_id, input.beforeJournalEntryId);
    if (!journal || journal.status !== "posted" || journal.reversed_by_entry_id != null) continue;
    for (const effect of assetEffects(db, journal.id)) {
      if (compareDkk(Number(effect.effect_dkk), 0) < 0) {
        addEffect(interestOrigins, effect.account_no, Number(effect.effect_dkk));
      }
    }
  }
  for (const [accountNo, ore] of interestOrigins) {
    if (ore < 0n) {
      errors.push(`interest receivable account ${accountNo} is over-reversed by ${fromOre(-ore)} DKK`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const aggregateByAccount = new Map(
    aggregate.balances.map((row) => [row.accountNo, toOre(row.amountDkk)] as const),
  );
  const balances: ClaimReceivableBalance[] = [];
  let possibleOre = 0n;
  let certainOre = 0n;
  for (const [accountNo, interestOre] of [...interestOrigins.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (interestOre <= 0n) continue;
    const aggregateOre = aggregateByAccount.get(accountNo) ?? 0n;
    const possible = interestOre < aggregateOre ? interestOre : aggregateOre;
    const otherOre = otherOrigins.get(accountNo) ?? 0n;
    const certainCandidate = aggregateOre > otherOre ? aggregateOre - otherOre : 0n;
    const certain = interestOre < certainCandidate ? interestOre : certainCandidate;
    possibleOre += possible > 0n ? possible : 0n;
    certainOre += certain > 0n ? certain : 0n;
    if (certain > 0n) balances.push({ accountNo, amountDkk: fromOre(certain) });
  }
  return {
    ok: true,
    balances,
    totalDkk: fromOre(certainOre),
    possibleTotalDkk: fromOre(possibleOre),
    ambiguousDkk: fromOre(possibleOre - certainOre),
  };
}

/** Deterministically allocate a receipt across the actual open claim accounts. */
export function allocateClaimReceipt(
  balances: ClaimReceivableBalance[],
  amountDkk: number,
): ClaimReceiptAllocationResult {
  let remaining = toOre(amountDkk);
  if (remaining <= 0n) return { ok: false, error: "claim receipt amount must be positive" };
  const credits: ClaimReceivableBalance[] = [];
  for (const balance of [...balances].sort((left, right) => left.accountNo.localeCompare(right.accountNo))) {
    const available = toOre(balance.amountDkk);
    if (available <= 0n || remaining <= 0n) continue;
    const applied = available < remaining ? available : remaining;
    credits.push({ accountNo: balance.accountNo, amountDkk: fromOre(applied) });
    remaining -= applied;
  }
  if (remaining > 0n) {
    return { ok: false, error: `claim receipt exceeds ledger-backed claim balance by ${fromOre(remaining)} DKK` };
  }
  return { ok: true, credits };
}
