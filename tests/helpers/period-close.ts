import { expect } from "bun:test";
import { openDb } from "../../src/core/db";
import { ensureCompanyDirs } from "../../src/core/paths";
import { linkBankTransactionToJournal } from "../../src/core/bank-journal-reconciliation";

async function cli(args: string[], env?: Record<string, string | undefined>) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect({ exitCode, stderr }, `${args.join(" ")}\n${stdout}`).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(stdout) as Record<string, unknown>;
}

/**
 * Adds a synthetic, append-only DKK statement for existing bank journals and
 * links every statement row via the same reconciliation primitive as a normal
 * migration. It never mutates the original journal entries. This makes legacy
 * report fixtures honest about their bank balance before closing a period.
 */
export function reconcileFixtureBankJournals(company: string, cutoff: string) {
  const db = openDb(ensureCompanyDirs(company).db);
  try {
    const account = db.query("SELECT id FROM bank_accounts WHERE slug='synthetic-close-statement'").get() as { id: number } | null;
    const inserted = account ? null : db.query("INSERT INTO bank_accounts(slug,name,currency,ledger_account_no) VALUES('synthetic-close-statement','Synthetic close statement','DKK','2000') RETURNING id").get() as { id: number };
    const bankAccountId = account?.id ?? inserted!.id;
    const journals = db.query(`SELECT je.id,je.transaction_date,COALESCE(SUM(jl.debit_amount-jl.credit_amount),0) AS bank_movement
      FROM journal_entries je JOIN journal_lines jl ON jl.journal_entry_id=je.id JOIN accounts a ON a.id=jl.account_id
      WHERE je.transaction_date<=? AND a.account_no='2000' AND je.status='posted' AND je.reversal_of_entry_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM journal_entries reversal WHERE reversal.reversal_of_entry_id=je.id)
      AND NOT EXISTS(SELECT 1 FROM bank_journal_reconciliations r WHERE r.journal_entry_id=je.id)
      GROUP BY je.id ORDER BY je.transaction_date,je.id`).all(cutoff) as Array<{ id: number; transaction_date: string; bank_movement: number }>;
    let balance = 0;
    for (const journal of journals) {
      balance = Math.round((balance + Number(journal.bank_movement)) * 100) / 100;
      const transaction = db.query(`INSERT INTO bank_transactions(transaction_date,text,amount,currency,bank_account_id,balance_after)
        VALUES(?,?,?,?,?,?) RETURNING id`).get(journal.transaction_date, `Synthetic statement journal ${journal.id}`, journal.bank_movement, "DKK", bankAccountId, balance) as { id: number };
      const linked = linkBankTransactionToJournal(db, {
        bankTransactionId: transaction.id, journalEntryId: journal.id, matchMethod: "exact-date-amount", createdBy: "user:ejer", createdByProgram: "rentemester-test",
      });
      expect(linked.ok, linked.ok ? "" : linked.errors.join("; ")).toBe(true);
    }
  } finally { db.close(); }
}

/** The mandatory readiness → explicit review → exact-packet close flow. */
export async function closeReviewedFixturePeriod(input: { company: string; from: string; to: string; kind: "vat_period" | "vat_quarter" | "fiscal_year" | "custom"; status?: "closed" | "reported"; env?: Record<string, string | undefined> }) {
  reconcileFixtureBankJournals(input.company, input.to);
  const readiness = await cli(["period", "readiness", "--company", input.company, "--from", input.from, "--to", input.to], input.env);
  const packet = readiness.packet as { hash: string };
  expect(packet?.hash).toMatch(/^[a-f0-9]{64}$/);
  const reviewed = await cli(["period", "review", "--company", input.company, "--from", input.from, "--to", input.to, "--packet-hash", packet.hash, "--actor", "user:ejer", "--confirm", "yes"], input.env);
  const review = reviewed as { id: number };
  expect(review?.id).toBeGreaterThan(0);
  await cli(["period", "close", "--company", input.company, "--from", input.from, "--to", input.to, "--kind", input.kind, "--packet-hash", packet.hash, "--review-id", String(review.id), "--actor", "user:ejer", "--confirm", "yes", ...(input.status ? ["--status", input.status] : [])], input.env);
}
