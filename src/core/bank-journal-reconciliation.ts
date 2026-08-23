import type { Database } from "bun:sqlite";
import { insertAuditLog, resolveActor, type ResolveActorInput } from "./actor";
import { resolveOpenExceptionsForBankTransaction } from "./exceptions";
import { roundDkk } from "./money";

export const BANK_JOURNAL_RECONCILIATION_RULE = "DK-BOOKKEEPING-RECONCILIATION-001";

export type BankJournalMatchMethod =
  | "exact-date-amount"
  | "settlement-lag-amount"
  | "source-reference"
  | "manual-review";

export type LinkBankTransactionToJournalInput = ResolveActorInput & {
  bankTransactionId: number;
  journalEntryId: number;
  matchMethod: BankJournalMatchMethod;
  sourceReference?: string;
  note?: string;
};

export function findBankJournalReconciliation(
  db: Database,
  bankTransactionId: number,
): { bankTransactionId: number; journalEntryId: number; journalEntryNo: string; linkKind: string } | null {
  const row = db.query(
    `SELECT bank_transaction_id, journal_entry_id, journal_entry_no, link_kind
       FROM bank_journal_reconciliations
      WHERE bank_transaction_id = ?
      LIMIT 1`,
  ).get(bankTransactionId) as {
    bank_transaction_id: number;
    journal_entry_id: number;
    journal_entry_no: string;
    link_kind: string;
  } | null;
  return row ? {
    bankTransactionId: Number(row.bank_transaction_id),
    journalEntryId: Number(row.journal_entry_id),
    journalEntryNo: row.journal_entry_no,
    linkKind: row.link_kind,
  } : null;
}

/**
 * Append-only reconciliation for a bank row whose accounting journal already
 * exists (typically after a verified migration). No journal row or amount is
 * changed. The v6 database guard independently proves that the journal's net
 * movement on the bank account mapped to the row equals the bank amount in DKK.
 */
export function linkBankTransactionToJournal(
  db: Database,
  input: LinkBankTransactionToJournalInput,
) {
  const errors: string[] = [];
  if (!Number.isInteger(input.bankTransactionId) || input.bankTransactionId <= 0) {
    errors.push("bankTransactionId must be a positive integer");
  }
  if (!Number.isInteger(input.journalEntryId) || input.journalEntryId <= 0) {
    errors.push("journalEntryId must be a positive integer");
  }
  const methods: BankJournalMatchMethod[] = ["exact-date-amount", "settlement-lag-amount", "source-reference", "manual-review"];
  if (!methods.includes(input.matchMethod)) errors.push("matchMethod is invalid");
  if (input.sourceReference !== undefined && !input.sourceReference.trim()) errors.push("sourceReference must not be blank when present");
  if (input.note !== undefined && !input.note.trim()) errors.push("note must not be blank when present");
  if (errors.length > 0) return { ok: false as const, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors };

  const existing = findBankJournalReconciliation(db, input.bankTransactionId);
  if (existing) {
    if (existing.journalEntryId === input.journalEntryId) {
      return { ok: true as const, idempotent: true, ...existing, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors: [] as string[] };
    }
    return { ok: false as const, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors: [
      `bank transaction ${input.bankTransactionId} is already reconciled to journal entry ${existing.journalEntryId}`,
    ] };
  }

  const bank = db.query(
    `SELECT bt.id, bt.amount, bt.amount_dkk, bt.currency, bt.transaction_date,
            ba.ledger_account_no
       FROM bank_transactions bt
       LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.id = ?`,
  ).get(input.bankTransactionId) as {
    id: number; amount: number; amount_dkk: number | null; currency: string;
    transaction_date: string; ledger_account_no: string | null;
  } | null;
  if (!bank) return { ok: false as const, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors: [`bank transaction ${input.bankTransactionId} does not exist`] };
  if (!bank.ledger_account_no) return { ok: false as const, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors: [`bank transaction ${input.bankTransactionId} has no bank account with a ledger mapping`] };

  const journal = db.query(
    `SELECT je.id, je.entry_no, je.transaction_date, je.status, je.reversal_of_entry_id,
            je.source_bank_transaction_id,
            COALESCE(SUM(CASE WHEN a.account_no = ? THEN jl.debit_amount - jl.credit_amount ELSE 0 END), 0) AS bank_movement,
            EXISTS(SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id = je.id) AS has_reversal
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
       LEFT JOIN accounts a ON a.id = jl.account_id
      WHERE je.id = ?
      GROUP BY je.id`,
  ).get(bank.ledger_account_no, input.journalEntryId) as {
    id: number; entry_no: string; transaction_date: string; status: string;
    reversal_of_entry_id: number | null; source_bank_transaction_id: number | null;
    bank_movement: number; has_reversal: number;
  } | null;
  if (!journal) return { ok: false as const, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors: [`journal entry ${input.journalEntryId} does not exist`] };
  if (journal.status !== "posted" || journal.reversal_of_entry_id != null || Number(journal.has_reversal) !== 0) {
    errors.push(`journal entry ${input.journalEntryId} is not an active original posted entry`);
  }
  if (journal.source_bank_transaction_id != null) errors.push(`journal entry ${input.journalEntryId} already carries a direct bank link`);
  const bankAmountDkk = bank.currency.trim().toUpperCase() === "DKK" ? Number(bank.amount) : Number(bank.amount_dkk);
  if (!Number.isFinite(bankAmountDkk)) errors.push(`bank transaction ${input.bankTransactionId} has no deterministic DKK amount`);
  if (Number.isFinite(bankAmountDkk) && roundDkk(Number(journal.bank_movement)) !== roundDkk(bankAmountDkk)) {
    errors.push(`journal entry ${input.journalEntryId} bank movement ${roundDkk(Number(journal.bank_movement))} does not equal bank transaction ${input.bankTransactionId} amount ${roundDkk(bankAmountDkk)}`);
  }
  if (errors.length > 0) return { ok: false as const, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors };

  const actor = resolveActor(input);
  try {
    return db.transaction(() => {
      const inserted = db.query(
        `INSERT INTO bank_journal_reconciliation_links
           (bank_transaction_id, journal_entry_id, match_method, source_reference, note, created_by, created_by_program)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.bankTransactionId,
        input.journalEntryId,
        input.matchMethod,
        input.sourceReference?.trim() || null,
        input.note?.trim() || null,
        actor.createdBy,
        actor.createdByProgram,
      );
      insertAuditLog(db, {
        eventType: "bank_journal_reconciliation_link",
        entityType: "bank_transaction",
        entityId: String(input.bankTransactionId),
        message: `Reconciled bank transaction ${input.bankTransactionId} to existing journal entry ${journal.entry_no} without a new posting (${input.matchMethod})`,
        createdBy: actor.createdBy,
        createdByProgram: actor.createdByProgram,
      });
      resolveOpenExceptionsForBankTransaction(
        db,
        input.bankTransactionId,
        `Resolved by append-only reconciliation link to journal entry ${journal.entry_no}`,
        actor.createdBy,
      );
      return {
        ok: true as const,
        id: Number(inserted.lastInsertRowid),
        idempotent: false,
        bankTransactionId: input.bankTransactionId,
        journalEntryId: input.journalEntryId,
        journalEntryNo: journal.entry_no,
        linkKind: "append-only",
        bankAmount: roundDkk(bankAmountDkk),
        journalBankMovement: roundDkk(Number(journal.bank_movement)),
        appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE],
        errors: [] as string[],
      };
    }).immediate();
  } catch (error) {
    return { ok: false as const, appliedRules: [BANK_JOURNAL_RECONCILIATION_RULE], errors: [error instanceof Error ? error.message : String(error)] };
  }
}
