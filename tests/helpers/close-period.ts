/**
 * Test-only adapter for legacy fixtures that exercise a downstream period
 * effect (posting locks, annual reports, VAT, …).  Product callers must use
 * the explicit readiness -> review -> close workflow.  These older fixtures
 * used the core close function directly, so this adapter makes that workflow
 * explicit without weakening the production contract.
 */
import type { Database } from "bun:sqlite";
import { seedNativeAccountRoles } from "../../src/core/account-roles";
import { linkBankTransactionToJournal } from "../../src/core/bank-journal-reconciliation";
import { computePeriodCloseReadiness, reviewPeriodCloseReadiness } from "../../src/core/period-close-readiness";
import {
  closeAccountingPeriod as closeCore,
  type CloseAccountingPeriodInput,
  type CloseAccountingPeriodResult,
} from "../../src/core/periods";

export function closeAccountingPeriod(
  db: Database,
  input: CloseAccountingPeriodInput,
): CloseAccountingPeriodResult {
  // Direct DB fixtures historically called only seedAccounts. The normal
  // company initialization supplies these role mappings; provide that same
  // synthetic prerequisite before evaluating the close controls.
  seedNativeAccountRoles(db);
  const periodStart = input.periodStart ?? "";
  const periodEnd = input.periodEnd ?? "";
  // Existing report fixtures predate the independent-statement control. Add
  // only synthetic, append-only statement rows for their already-posted bank
  // journals and reconcile them through the production primitive. This makes
  // the fixture evidence truthful without altering a ledger posting.
  const account = db.query("SELECT id FROM bank_accounts WHERE slug='synthetic-close-statement'").get() as { id: number } | null;
  const bankAccountId = account?.id ?? (db.query("INSERT INTO bank_accounts(slug,name,currency,ledger_account_no) VALUES('synthetic-close-statement','Synthetic close statement','DKK','2000') RETURNING id").get() as { id: number }).id;
  const journals = db.query(`SELECT je.id, je.transaction_date, COALESCE(SUM(jl.debit_amount-jl.credit_amount),0) AS movement FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id JOIN accounts a ON a.id=jl.account_id WHERE je.transaction_date<=? AND a.account_no='2000' AND je.status='posted' AND NOT EXISTS(SELECT 1 FROM bank_journal_reconciliations r WHERE r.journal_entry_id=je.id) GROUP BY je.id ORDER BY je.transaction_date,je.id`).all(periodEnd) as Array<{id:number;transaction_date:string;movement:number}>;
  let balance = 0;
  for (const journal of journals) {
    balance = Math.round((balance + Number(journal.movement)) * 100) / 100;
    const bank = db.query("INSERT INTO bank_transactions(transaction_date,text,amount,currency,bank_account_id,balance_after) VALUES(?,?,?,?,?,?) RETURNING id").get(journal.transaction_date, `Synthetic close statement ${journal.id}`, journal.movement, "DKK", bankAccountId, balance) as {id:number};
    const linked = linkBankTransactionToJournal(db, { bankTransactionId: bank.id, journalEntryId: journal.id, matchMethod: "exact-date-amount", createdBy: "user:test", createdByProgram: "rentemester-test" });
    if (!linked.ok) throw new Error(linked.errors.join("; "));
  }
  const actor = input.createdBy?.trim() || "agent:test";
  const packet = computePeriodCloseReadiness(db, {
    periodStart,
    periodEnd,
    companyRoot: input.companyRoot,
  });
  const review = reviewPeriodCloseReadiness(db, {
    packet,
    reviewerActor: actor,
    reviewerPrincipal: { kind: "local-trusted", subjectId: actor },
  });
  return closeCore(db, {
    ...input,
    createdBy: actor,
    readinessPacketHash: packet.hash,
    readinessReviewId: review.id,
    ...(input.force && !input.forceAuthorization
      ? {
          forceAuthorization: {
            principal: { kind: "local-trusted" as const, subjectId: actor },
            permissions: ["company.period.force-close"],
          },
          forceConfirmed: true,
          forceReason: input.forceReason ?? "synthetic test waiver",
        }
      : {}),
  });
}
