import type { Database } from "bun:sqlite";
import {
  compareDkk,
  fromOre,
  normalizeCurrency,
  roundDkk,
  subtractDkk,
  sumDkk,
  toOre,
} from "./money";
import {
  calculateForeignReceivableRelief,
  resolveInvoiceReceivableAccount,
  validateInvoiceCreditNoteEvidence,
} from "./invoice-fx-receivable";
import {
  allocateClaimReceipt,
  calculateClaimReceivableBalances,
  calculateInterestIncomeBalances,
  calculateInterestReceivableBalances,
} from "./invoice-claim-receivable";
import { buildInterestCorrectionEvidencePlan } from "./invoice-interest";

export type InvoiceJournalApplicationKind = "payment" | "refund" | "claim";

export type InvoiceJournalApplicationCandidate = {
  kind: InvoiceJournalApplicationKind;
  invoiceDocumentId: number;
  bankTransactionId: number | null;
  journalEntryId: number | null;
  effectiveDate: string;
  amount: number;
  currency: string;
};

type InvoiceJournalApplication = InvoiceJournalApplicationCandidate & {
  applicationId: number | null;
};

type JournalEvidence = {
  id: number;
  document_id: number | null;
  source_bank_transaction_id: number | null;
  transaction_date: string;
  registration_datetime: string;
  currency: string | null;
  amount_foreign: number | null;
  amount_dkk: number | null;
  status: string;
  reversed_by_entry_id: number | null;
};

type BankEvidence = {
  id: number;
  amount: number;
  currency: string | null;
  amount_dkk: number | null;
  bank_account_id: number | null;
  bank_account_currency: string | null;
  ledger_account_no: string | null;
};

type JournalLineEvidence = {
  account_no: string;
  debit_amount: number;
  credit_amount: number;
};

const FX_GAIN_ACCOUNT_NO = "1020";
const FX_LOSS_ACCOUNT_NO = "3320";

function evidenceCurrency(value: unknown) {
  return normalizeCurrency(
    typeof value === "string" || value == null ? value : String(value),
  );
}

function applicationLabel(application: InvoiceJournalApplication) {
  const kind = application.kind === "claim" ? "claim payment" : application.kind;
  const id = application.applicationId == null ? "candidate" : String(application.applicationId);
  return `invoice ${kind} ${id} for invoice document ${application.invoiceDocumentId}`;
}

const APPLICATIONS_UNION_SQL = `
     SELECT 'payment' AS kind,
            id AS application_id,
            invoice_document_id,
            bank_transaction_id,
            journal_entry_id,
            payment_date AS effective_date,
            amount,
            currency
       FROM invoice_payments
     UNION ALL
     SELECT 'refund' AS kind,
            id AS application_id,
            invoice_document_id,
            bank_transaction_id,
            journal_entry_id,
            refund_date AS effective_date,
            amount,
            currency
       FROM invoice_refunds
     UNION ALL
     SELECT 'claim' AS kind,
            id AS application_id,
            invoice_document_id,
            bank_transaction_id,
            journal_entry_id,
            payment_date AS effective_date,
            amount,
            currency
       FROM invoice_claim_payments
`;

function mapApplications(rows: any[]): InvoiceJournalApplication[] {
  return rows.map((row: any) => ({
    kind: row.kind as InvoiceJournalApplicationKind,
    applicationId: Number(row.application_id),
    invoiceDocumentId: Number(row.invoice_document_id),
    bankTransactionId: row.bank_transaction_id == null ? null : Number(row.bank_transaction_id),
    journalEntryId: row.journal_entry_id == null ? null : Number(row.journal_entry_id),
    effectiveDate: String(row.effective_date),
    amount: Number(row.amount),
    currency: evidenceCurrency(row.currency),
  }));
}

function loadApplications(db: Database, invoiceDocumentId?: number): InvoiceJournalApplication[] {
  if (invoiceDocumentId == null) {
    return mapApplications(db.query(
      `${APPLICATIONS_UNION_SQL}
       ORDER BY journal_entry_id ASC, kind ASC, application_id ASC`,
    ).all() as any[]);
  }

  // Include applications on other invoices when they reuse a journal anchored
  // to this invoice. The CTE keeps scoped status reads linear in the relevant
  // evidence instead of loading every invoice application on every call.
  return mapApplications(db.query(
    `WITH scoped_journals AS (
       SELECT journal_entry_id FROM invoice_payments
        WHERE invoice_document_id = ? AND journal_entry_id IS NOT NULL
       UNION
       SELECT journal_entry_id FROM invoice_refunds
        WHERE invoice_document_id = ? AND journal_entry_id IS NOT NULL
       UNION
       SELECT journal_entry_id FROM invoice_claim_payments
        WHERE invoice_document_id = ? AND journal_entry_id IS NOT NULL
     ), applications AS (
       ${APPLICATIONS_UNION_SQL}
     )
     SELECT * FROM applications
      WHERE invoice_document_id = ?
         OR journal_entry_id IN (SELECT journal_entry_id FROM scoped_journals)
      ORDER BY journal_entry_id ASC, kind ASC, application_id ASC`,
  ).all(invoiceDocumentId, invoiceDocumentId, invoiceDocumentId, invoiceDocumentId) as any[]);
}

function loadApplicationsForJournal(db: Database, journalEntryId: number) {
  return mapApplications(db.query(
    `SELECT * FROM (${APPLICATIONS_UNION_SQL})
      WHERE journal_entry_id = ?
      ORDER BY kind ASC, application_id ASC`,
  ).all(journalEntryId) as any[]);
}

function sameNullableId(left: number | null, right: number | null) {
  return left === right;
}

function resolveRoleAccountsAtPosting(
  db: Database,
  journal: JournalEvidence,
  role: "bank" | "debtors",
) {
  const rows = db.query(
    `SELECT DISTINCT account_no
       FROM account_role_mappings
      WHERE role = ?
        AND confirmed_at <= ?
        AND confirmed_at = (
          SELECT MAX(candidate.confirmed_at)
            FROM account_role_mappings candidate
           WHERE candidate.role = ?
             AND candidate.confirmed_at <= ?
        )
      ORDER BY version DESC
    `,
  ).all(
    role,
    journal.registration_datetime,
    role,
    journal.registration_datetime,
  ) as Array<{ account_no: string }>;
  return rows.map((row) => row.account_no);
}

function reconstructForeignPaymentBasis(
  db: Database,
  journal: JournalEvidence,
  application: InvoiceJournalApplication,
) {
  const invoice = db.query(
    `SELECT invoice_no, amount_inc_vat, payload_json
       FROM documents
      WHERE id = ? AND document_type = 'issued_invoice'`,
  ).get(application.invoiceDocumentId) as {
    invoice_no: string | null;
    amount_inc_vat: number | null;
    payload_json: string | null;
  } | null;
  if (!invoice) return { error: `journal entry ${journal.id}: foreign invoice metadata is missing` };

  let payload: any;
  try {
    payload = invoice.payload_json ? JSON.parse(invoice.payload_json) : null;
  } catch {
    return { error: `journal entry ${journal.id}: foreign invoice payload is not valid JSON` };
  }
  const grossForeign = roundDkk(Number(invoice.amount_inc_vat));
  const grossDkk = roundDkk(Number(payload?.totals?.grossAmountDkk));
  if (!(grossForeign > 0) || !(grossDkk > 0) || !invoice.invoice_no) {
    return { error: `journal entry ${journal.id}: foreign invoice is missing positive gross foreign/DKK totals or an invoice number` };
  }

  const priorPayments = db.query(
    `SELECT amount
       FROM invoice_payments
      WHERE invoice_document_id = ?
        AND journal_entry_id < ?
      ORDER BY journal_entry_id ASC, id ASC`,
  ).all(application.invoiceDocumentId, journal.id) as Array<{ amount: number }>;
  const priorCredits = db.query(
    `SELECT c.amount_inc_vat AS amount
       FROM credit_note_postings p
       JOIN documents c ON c.id = p.credit_note_document_id
       JOIN journal_entries credit_journal ON credit_journal.id = p.journal_entry_id
      WHERE p.original_invoice_document_id = ?
        AND credit_journal.id < ?
        AND credit_journal.status = 'posted'
        AND NOT EXISTS (
          SELECT 1
            FROM journal_entries reversal
           WHERE reversal.reversal_of_entry_id = credit_journal.id
        )
      ORDER BY c.id ASC`,
  ).all(application.invoiceDocumentId, journal.id) as Array<{ amount: number }>;
  const priorWriteOffs = db.query(
    `SELECT gross_amount AS amount
       FROM invoice_bad_debt_writeoffs
      WHERE invoice_document_id = ?
        AND journal_entry_id < ?
      ORDER BY journal_entry_id ASC, id ASC`,
  ).all(application.invoiceDocumentId, journal.id) as Array<{ amount: number }>;

  const priorReduction = sumDkk([
    ...priorPayments.map((row) => Number(row.amount)),
    ...priorCredits.map((row) => Number(row.amount)),
    ...priorWriteOffs.map((row) => Number(row.amount)),
  ]);
  const openBefore = subtractDkk(grossForeign, priorReduction);
  const openAfter = subtractDkk(openBefore, application.amount);
  if (openBefore <= 0 || openAfter < 0) {
    return { error: `journal entry ${journal.id}: foreign payment exceeds the reconstructable principal balance` };
  }
  return { invoiceNumber: invoice.invoice_no, openBefore };
}

function validateAccountEffects(
  db: Database,
  journal: JournalEvidence,
  group: InvoiceJournalApplication[],
  lines: JournalLineEvidence[],
  expectedApplicationAmount: number | null,
) {
  const errors: string[] = [];
  let bankAccountNos: string[];
  const sourceBank = group[0]?.bankTransactionId == null
    ? null
    : db.query(
      `SELECT bt.bank_account_id, ba.ledger_account_no
         FROM bank_transactions bt
         LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE bt.id = ?`,
    ).get(group[0].bankTransactionId) as {
      bank_account_id: number | null;
      ledger_account_no: string | null;
    } | null;
  if (sourceBank?.bank_account_id != null) {
    const concrete = sourceBank.ledger_account_no?.trim() || "";
    if (!concrete) {
      errors.push(`journal entry ${journal.id}: source bank account ${sourceBank.bank_account_id} has no ledger account mapping`);
      return errors;
    }
    bankAccountNos = [concrete];
  } else {
    bankAccountNos = resolveRoleAccountsAtPosting(db, journal, "bank");
  }
  if (bankAccountNos.length === 0) {
    errors.push(`journal entry ${journal.id}: no confirmed bank account role existed when the journal was posted`);
  }
  if (bankAccountNos.length === 0) return errors;

  const effects = new Map<string, { debit: bigint; credit: bigint }>();
  for (const line of lines) {
    const debit = Number(line.debit_amount ?? 0);
    const credit = Number(line.credit_amount ?? 0);
    if (!Number.isFinite(debit) || !Number.isFinite(credit)) continue;
    const current = effects.get(line.account_no) ?? { debit: 0n, credit: 0n };
    current.debit += toOre(debit);
    current.credit += toOre(credit);
    effects.set(line.account_no, current);
  }
  const currency = evidenceCurrency(group[0]?.currency);
  const isRefund = group.length === 1 && group[0]?.kind === "refund";

  if (currency === "DKK" && expectedApplicationAmount != null) {
    const expectedOre = toOre(expectedApplicationAmount);
    const expectedBankDebit = isRefund ? 0n : expectedOre;
    const expectedBankCredit = isRefund ? expectedOre : 0n;
    const expectedReceivable = new Map<string, { debit: bigint; credit: bigint }>();
    const addExpected = (accountNo: string, debit: bigint, credit: bigint) => {
      const current = expectedReceivable.get(accountNo) ?? { debit: 0n, credit: 0n };
      current.debit += debit;
      current.credit += credit;
      expectedReceivable.set(accountNo, current);
    };

    const principalApplications = group.filter((row) => row.kind === "payment" || row.kind === "refund");
    for (const application of principalApplications) {
      const receivable = resolveInvoiceReceivableAccount(db, {
        invoiceDocumentId: application.invoiceDocumentId,
        beforeJournalEntryId: journal.id,
      });
      if (!receivable.ok) {
        errors.push(`journal entry ${journal.id}: ${receivable.error}`);
        continue;
      }
      addExpected(
        receivable.accountNo,
        application.kind === "refund" ? toOre(application.amount) : 0n,
        application.kind === "payment" ? toOre(application.amount) : 0n,
      );
    }

    const claimApplications = group.filter((row) => row.kind === "claim");
    for (const application of claimApplications) {
      const bankDate = application.bankTransactionId == null
        ? null
        : (db.query(
          "SELECT transaction_date FROM bank_transactions WHERE id = ?",
        ).get(application.bankTransactionId) as { transaction_date: string } | null)?.transaction_date ?? null;
      const claimEvidenceDate = bankDate && bankDate < application.effectiveDate
        ? bankDate
        : application.effectiveDate;
      const claimBalances = calculateClaimReceivableBalances(db, {
        invoiceDocumentId: application.invoiceDocumentId,
        beforeJournalEntryId: journal.id,
        asOfDate: claimEvidenceDate,
      });
      if (!claimBalances.ok) {
        errors.push(...claimBalances.errors.map((error) => `journal entry ${journal.id}: ${error}`));
        continue;
      }
      const allocation = allocateClaimReceipt(claimBalances.balances, application.amount);
      if (!allocation.ok) {
        errors.push(`journal entry ${journal.id}: ${allocation.error}`);
        continue;
      }
      for (const credit of allocation.credits) addExpected(credit.accountNo, 0n, toOre(credit.amountDkk));
    }
    if (errors.length > 0) return errors;

    const matchingBank = bankAccountNos.find((bankAccountNo) => {
      const bank = effects.get(bankAccountNo) ?? { debit: 0n, credit: 0n };
      return bank.debit === expectedBankDebit &&
        bank.credit === expectedBankCredit;
    });
    if (!matchingBank) {
      errors.push(
        `journal entry ${journal.id}: bank account effects do not match ${isRefund ? "an outgoing refund" : "an incoming invoice receipt"} on the source bank ledger`,
      );
      return errors;
    }
    if (expectedReceivable.has(matchingBank)) {
      errors.push(`journal entry ${journal.id}: source bank ledger ${matchingBank} is also used as an invoice receivable account`);
      return errors;
    }
    for (const [accountNo, expected] of expectedReceivable) {
      const actual = effects.get(accountNo) ?? { debit: 0n, credit: 0n };
      if (actual.debit !== expected.debit || actual.credit !== expected.credit) {
        errors.push(
          `journal entry ${journal.id}: receivable account ${accountNo} effect ${fromOre(actual.debit)}/${fromOre(actual.credit)} DKK does not match expected debit/credit ${fromOre(expected.debit)}/${fromOre(expected.credit)} DKK`,
        );
      }
    }
    return errors;
  }

  const isForeignPayment =
    group.length === 1 && group[0]?.kind === "payment" && currency !== "DKK";
  const amountDkk = Number(journal.amount_dkk);
  if (!isForeignPayment || !Number.isFinite(amountDkk) || !(amountDkk > 0)) {
    errors.push(`journal entry ${journal.id}: unsupported non-DKK invoice application accounting effects`);
    return errors;
  }

  const basis = reconstructForeignPaymentBasis(db, journal, group[0]!);
  if (basis.error || basis.openBefore == null || !basis.invoiceNumber) {
    errors.push(basis.error ?? `journal entry ${journal.id}: foreign payment basis cannot be reconstructed`);
    return errors;
  }
  const receivable = resolveInvoiceReceivableAccount(db, {
    invoiceDocumentId: group[0]!.invoiceDocumentId,
    beforeJournalEntryId: journal.id,
  });
  if (!receivable.ok) {
    errors.push(`journal entry ${journal.id}: ${receivable.error}`);
    return errors;
  }
  const expectedBankDebit = toOre(amountDkk);
  const matchingPair = bankAccountNos.flatMap((bankAccountNo) => {
      const receivableAccountNo = receivable.accountNo;
      if (bankAccountNo === receivableAccountNo) return [];
      const relief = calculateForeignReceivableRelief(db, {
        invoiceDocumentId: group[0]!.invoiceDocumentId,
        invoiceNumber: basis.invoiceNumber!,
        receivableAccountNo,
        openForeignBefore: basis.openBefore!,
        paymentForeign: group[0]!.amount,
        beforeJournalEntryId: journal.id,
      });
      if (!relief.ok) return [];
      const bank = effects.get(bankAccountNo) ?? { debit: 0n, credit: 0n };
      const actualReceivable = effects.get(receivableAccountNo) ?? { debit: 0n, credit: 0n };
      const expectedReceivableCredit = toOre(relief.amountDkk);
      return bank.debit === expectedBankDebit &&
        bank.credit === 0n &&
        actualReceivable.debit === 0n &&
        actualReceivable.credit === expectedReceivableCredit
        ? [{ bankAccountNo, receivableAccountNo, reliefDkk: relief.amountDkk }]
        : [];
    })[0];
  if (!matchingPair) {
    errors.push(
      `journal entry ${journal.id}: foreign payment account effects do not match the actual DKK receivable relief on a role pair confirmed at posting time`,
    );
    return errors;
  }

  const expectedReceivableCredit = toOre(matchingPair.reliefDkk);
  const fxGain = effects.get(FX_GAIN_ACCOUNT_NO) ?? { debit: 0n, credit: 0n };
  const fxLoss = effects.get(FX_LOSS_ACCOUNT_NO) ?? { debit: 0n, credit: 0n };
  const expectedFxDelta = expectedBankDebit - expectedReceivableCredit;
  const expectedGainCredit = expectedFxDelta > 0n ? expectedFxDelta : 0n;
  const expectedLossDebit = expectedFxDelta < 0n ? -expectedFxDelta : 0n;
  if (
    fxGain.debit !== 0n ||
    fxGain.credit !== expectedGainCredit ||
    fxLoss.debit !== expectedLossDebit ||
    fxLoss.credit !== 0n
  ) {
    errors.push(`journal entry ${journal.id}: foreign exchange gain/loss does not match the reconstructed receivable relief`);
  }
  for (const [accountNo, effect] of effects) {
    if (
      accountNo !== matchingPair.bankAccountNo &&
      accountNo !== matchingPair.receivableAccountNo &&
      accountNo !== FX_GAIN_ACCOUNT_NO &&
      accountNo !== FX_LOSS_ACCOUNT_NO &&
      (effect.debit !== 0n || effect.credit !== 0n)
    ) {
      errors.push(`journal entry ${journal.id}: foreign payment uses unexpected account ${accountNo}`);
    }
  }
  return errors;
}

/**
 * Validate the accounting evidence behind invoice balance applications.
 *
 * Existing ledgers may contain pre-migration refund/claim rows with a NULL
 * journal link. They are deliberately preserved, but this validator fails
 * closed until a human has attached verified evidence. `candidates` lets a
 * write path prove a journal/application relationship before the append-only
 * application row is inserted.
 */
export function validateInvoiceJournalEvidence(
  db: Database,
  options: {
    invoiceDocumentId?: number;
    candidates?: InvoiceJournalApplicationCandidate[];
  } = {},
) {
  const scopedExisting = loadApplications(db, options.invoiceDocumentId);
  const candidates: InvoiceJournalApplication[] = (options.candidates ?? []).map((candidate) => ({
    ...candidate,
    applicationId: null,
    bankTransactionId: candidate.bankTransactionId ?? null,
    journalEntryId: candidate.journalEntryId ?? null,
    currency: evidenceCurrency(candidate.currency),
  }));

  let applications: InvoiceJournalApplication[];
  if (options.invoiceDocumentId == null) {
    applications = [...scopedExisting, ...candidates];
  } else {
    const byApplication = new Map(
      scopedExisting.map((row) => [`${row.kind}:${row.applicationId}`, row] as const),
    );
    const candidateJournalIds = new Set(
      candidates.flatMap((row) => row.journalEntryId == null ? [] : [row.journalEntryId]),
    );
    for (const journalEntryId of candidateJournalIds) {
      for (const row of loadApplicationsForJournal(db, journalEntryId)) {
        byApplication.set(`${row.kind}:${row.applicationId}`, row);
      }
    }
    applications = [...byApplication.values(), ...candidates];
  }

  const errors: string[] = [];

  const unresolvedInvoiceJournals = db.query(
    `SELECT d.id AS invoice_document_id, d.invoice_no,
            j.id AS journal_entry_id, j.entry_no
       FROM documents d
       JOIN journal_entries j
         ON j.document_id = d.id
        AND j.status = 'posted'
        AND j.reversal_of_entry_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries reversal
           WHERE reversal.reversal_of_entry_id = j.id
        )
      WHERE d.document_type = 'issued_invoice'
        AND NOT EXISTS (
          SELECT 1 FROM issued_invoice_postings posting
           WHERE posting.journal_entry_id = j.id
        )
        AND NOT EXISTS (SELECT 1 FROM invoice_payments application WHERE application.journal_entry_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_refunds application WHERE application.journal_entry_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_claim_payments application WHERE application.journal_entry_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_bad_debt_writeoffs application WHERE application.journal_entry_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_interest_corrections application WHERE application.journal_entry_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_reminder_postings application WHERE application.journal_entry_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_compensation_postings application WHERE application.journal_entry_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM invoice_interest_postings application WHERE application.journal_entry_id = j.id)
        AND (? IS NULL OR d.id = ?)
      ORDER BY d.id ASC, j.id ASC`,
  ).all(
    options.invoiceDocumentId ?? null,
    options.invoiceDocumentId ?? null,
  ) as Array<{
    invoice_document_id: number;
    invoice_no: string | null;
    journal_entry_id: number;
    entry_no: string;
  }>;
  const candidateApplicationJournalIds = new Set(
    candidates.flatMap((candidate) => candidate.journalEntryId == null ? [] : [candidate.journalEntryId]),
  );
  for (const row of unresolvedInvoiceJournals) {
    // Write paths validate a newly posted journal before inserting the
    // append-only application row. The explicit candidate is its temporary
    // classification inside this same transaction; global/scoped reads have no
    // candidates and therefore still flag every persisted unclassified entry.
    if (candidateApplicationJournalIds.has(row.journal_entry_id)) continue;
    errors.push(
      `invoice ${row.invoice_no ?? row.invoice_document_id} has unresolved legacy journal ${row.entry_no} without an explicit issued-invoice posting link`,
    );
  }

  const noncanonicalCreditNoteJournals = db.query(
    `SELECT credit.id AS credit_note_document_id,
            credit.invoice_no AS credit_note_no,
            journal.id AS journal_entry_id,
            journal.entry_no
       FROM documents credit
       JOIN journal_entries journal
         ON journal.document_id = credit.id
       LEFT JOIN credit_note_postings posting
         ON posting.credit_note_document_id = credit.id
       LEFT JOIN documents inferred
         ON inferred.document_type = 'issued_invoice'
        AND inferred.invoice_no = credit.payment_details
      WHERE credit.document_type = 'credit_note'
        AND (posting.journal_entry_id IS NULL OR posting.journal_entry_id <> journal.id)
        AND (
          ? IS NULL
          OR posting.original_invoice_document_id = ?
          OR inferred.id = ?
        )
      ORDER BY credit.id ASC, journal.id ASC`,
  ).all(
    options.invoiceDocumentId ?? null,
    options.invoiceDocumentId ?? null,
    options.invoiceDocumentId ?? null,
  ) as Array<{
    credit_note_document_id: number;
    credit_note_no: string | null;
    journal_entry_id: number;
    entry_no: string;
  }>;
  for (const row of noncanonicalCreditNoteJournals) {
    errors.push(
      `credit note ${row.credit_note_no ?? row.credit_note_document_id} has journal ${row.entry_no} outside its canonical credit-note posting link`,
    );
  }

  const badDebtWriteoffs = db.query(
    `SELECT writeoff.id AS writeoff_id,
            writeoff.invoice_document_id,
            invoice.invoice_no,
            writeoff.journal_entry_id,
            evidence.is_valid
       FROM invoice_bad_debt_writeoffs writeoff
       LEFT JOIN documents invoice ON invoice.id = writeoff.invoice_document_id
       LEFT JOIN invoice_bad_debt_writeoff_journal_evidence evidence
         ON evidence.writeoff_id = writeoff.id
      WHERE (? IS NULL OR writeoff.invoice_document_id = ?)
      ORDER BY writeoff.invoice_document_id ASC, writeoff.id ASC`,
  ).all(
    options.invoiceDocumentId ?? null,
    options.invoiceDocumentId ?? null,
  ) as Array<{
    writeoff_id: number;
    invoice_document_id: number;
    invoice_no: string | null;
    journal_entry_id: number;
    is_valid: number | null;
  }>;
  for (const writeoff of badDebtWriteoffs) {
    if (writeoff.is_valid === 1) continue;
    errors.push(
      `invoice ${writeoff.invoice_no ?? writeoff.invoice_document_id} bad-debt writeoff ${writeoff.writeoff_id} journal ${writeoff.journal_entry_id} does not match the exact VAT-relief expense/output-VAT/receivable evidence`,
    );
  }

  const linkedInvoiceIds = options.invoiceDocumentId == null
    ? (db.query(
      `SELECT invoice_document_id
         FROM issued_invoice_postings
        ORDER BY invoice_document_id ASC`,
    ).all() as Array<{ invoice_document_id: number }>).map((row) => row.invoice_document_id)
    : (db.query(
      "SELECT invoice_document_id FROM issued_invoice_postings WHERE invoice_document_id = ?",
    ).all(options.invoiceDocumentId) as Array<{ invoice_document_id: number }>).map((row) => row.invoice_document_id);
  for (const invoiceDocumentId of linkedInvoiceIds) {
    const booking = resolveInvoiceReceivableAccount(db, { invoiceDocumentId });
    if (!booking.ok) errors.push(booking.error);
  }

  if (options.invoiceDocumentId == null) {
    const orphanCreditDocuments = db.query(
      `SELECT c.id, c.invoice_no, c.payment_details,
              original.id AS original_invoice_document_id,
              p.original_invoice_document_id AS linked_original_invoice_document_id
         FROM documents c
         LEFT JOIN documents original
           ON original.document_type = 'issued_invoice'
          AND original.invoice_no = c.payment_details
         LEFT JOIN credit_note_postings p
           ON p.credit_note_document_id = c.id
        WHERE c.document_type = 'credit_note'
          AND (
            original.id IS NULL
            OR p.credit_note_document_id IS NULL
            OR p.original_invoice_document_id <> original.id
          )
        ORDER BY c.id ASC`,
    ).all() as Array<{
      id: number;
      invoice_no: string | null;
      payment_details: string | null;
      original_invoice_document_id: number | null;
      linked_original_invoice_document_id: number | null;
    }>;
    for (const credit of orphanCreditDocuments) {
      errors.push(
        `credit note ${credit.invoice_no ?? credit.id} has no exact issued-invoice posting evidence for ${credit.payment_details ?? "an original invoice"}`,
      );
    }
  }

  const creditInvoiceIds = options.invoiceDocumentId == null
    ? (db.query(
      `SELECT DISTINCT d.id AS invoice_document_id
         FROM documents d
        WHERE d.document_type = 'issued_invoice'
          AND (
            EXISTS (
              SELECT 1 FROM documents c
               WHERE c.document_type = 'credit_note'
                 AND c.payment_details = d.invoice_no
            )
            OR EXISTS (
              SELECT 1 FROM credit_note_postings p
               WHERE p.original_invoice_document_id = d.id
            )
          )
        ORDER BY d.id ASC`,
    ).all() as Array<{ invoice_document_id: number }>).map((row) => row.invoice_document_id)
    : [options.invoiceDocumentId];
  for (const invoiceDocumentId of creditInvoiceIds) {
    const creditEvidence = validateInvoiceCreditNoteEvidence(db, { invoiceDocumentId });
    if (!creditEvidence.ok) errors.push(...creditEvidence.errors);
  }

  const claimPostingInvoiceIds = (db.query(
    `SELECT DISTINCT invoice_document_id
       FROM (
         SELECT reminder.invoice_document_id
           FROM invoice_reminders reminder
           JOIN invoice_reminder_postings posting ON posting.reminder_id = reminder.id
         UNION ALL
         SELECT claim.invoice_document_id
           FROM invoice_compensation_claims claim
           JOIN invoice_compensation_postings posting ON posting.compensation_claim_id = claim.id
         UNION ALL
         SELECT claim.invoice_document_id
           FROM invoice_interest_claims claim
           JOIN invoice_interest_postings posting ON posting.interest_claim_id = claim.id
       ) claim_posting
      WHERE (? IS NULL OR invoice_document_id = ?)
      ORDER BY invoice_document_id ASC`,
  ).all(
    options.invoiceDocumentId ?? null,
    options.invoiceDocumentId ?? null,
  ) as Array<{ invoice_document_id: number }>).map((row) => row.invoice_document_id);
  for (const invoiceDocumentId of claimPostingInvoiceIds) {
    const claimEvidence = calculateClaimReceivableBalances(db, {
      invoiceDocumentId,
      allowUnpostedClaims: true,
    });
    if (!claimEvidence.ok) errors.push(...claimEvidence.errors);
  }

  const correctionInvoiceIds = options.invoiceDocumentId == null
    ? (db.query(
      `SELECT DISTINCT invoice_document_id
         FROM invoice_interest_corrections
        ORDER BY invoice_document_id ASC`,
    ).all() as Array<{ invoice_document_id: number }>).map((row) => row.invoice_document_id)
    : (db.query(
      `SELECT DISTINCT invoice_document_id
         FROM invoice_interest_corrections
        WHERE invoice_document_id = ?`,
    ).all(options.invoiceDocumentId) as Array<{ invoice_document_id: number }>).map((row) => row.invoice_document_id);
  for (const invoiceDocumentId of correctionInvoiceIds) {
    const receivables = calculateClaimReceivableBalances(db, {
      invoiceDocumentId,
      allowUnpostedClaims: true,
    });
    if (!receivables.ok) errors.push(...receivables.errors);
    const interestReceivables = calculateInterestReceivableBalances(db, {
      invoiceDocumentId,
      allowUnpostedClaims: true,
    });
    if (!interestReceivables.ok) errors.push(...interestReceivables.errors);
    const incomes = calculateInterestIncomeBalances(db, {
      invoiceDocumentId,
      allowUnpostedClaims: true,
    });
    if (!incomes.ok) errors.push(...incomes.errors);
    const correctionEvidence = buildInterestCorrectionEvidencePlan(db, {
      invoiceDocumentId,
    });
    if (!correctionEvidence.ok) errors.push(...correctionEvidence.errors);
  }

  const orphanCorrectionPlans = db.query(
    `SELECT plan.journal_entry_id, plan.invoice_document_id
       FROM invoice_interest_correction_plans plan
       LEFT JOIN invoice_interest_corrections correction
         ON correction.journal_entry_id = plan.journal_entry_id
      WHERE correction.id IS NULL
        AND (? IS NULL OR plan.invoice_document_id = ?)
      ORDER BY plan.journal_entry_id ASC`,
  ).all(
    options.invoiceDocumentId ?? null,
    options.invoiceDocumentId ?? null,
  ) as Array<{ journal_entry_id: number; invoice_document_id: number }>;
  for (const plan of orphanCorrectionPlans) {
    errors.push(
      `invoice ${plan.invoice_document_id} has orphan interest-correction plan for journal ${plan.journal_entry_id}`,
    );
  }

  const documentCache = new Map<number, { id: number; document_type: string; currency: string | null } | null>();
  const journalCache = new Map<number, JournalEvidence | null>();
  const bankCache = new Map<number, BankEvidence | null>();

  const getDocument = (id: number) => {
    if (!documentCache.has(id)) {
      documentCache.set(id, db.query(
        "SELECT id, document_type, currency FROM documents WHERE id = ?",
      ).get(id) as { id: number; document_type: string; currency: string | null } | null);
    }
    return documentCache.get(id) ?? null;
  };
  const getJournal = (id: number) => {
    if (!journalCache.has(id)) {
      journalCache.set(id, db.query(
        `SELECT id, document_id, source_bank_transaction_id, transaction_date,
                registration_datetime,
                currency, amount_foreign, amount_dkk, status,
                (SELECT reversal.id
                   FROM journal_entries reversal
                  WHERE reversal.reversal_of_entry_id = journal_entries.id
                  ORDER BY reversal.id ASC
                  LIMIT 1) AS reversed_by_entry_id
           FROM journal_entries WHERE id = ?`,
      ).get(id) as JournalEvidence | null);
    }
    return journalCache.get(id) ?? null;
  };
  const getBank = (id: number) => {
    if (!bankCache.has(id)) {
      bankCache.set(id, db.query(
        `SELECT bt.id, bt.amount, bt.currency, bt.amount_dkk, bt.bank_account_id,
                ba.currency AS bank_account_currency, ba.ledger_account_no
           FROM bank_transactions bt
           LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id
          WHERE bt.id = ?`,
      ).get(id) as BankEvidence | null);
    }
    return bankCache.get(id) ?? null;
  };

  for (const application of applications) {
    const label = applicationLabel(application);
    if (!Number.isFinite(application.amount) || !(application.amount > 0)) {
      errors.push(`${label}: application amount must be a positive finite number`);
    }
    if (evidenceCurrency(application.currency).length !== 3) {
      errors.push(`${label}: application currency must be a 3-letter ISO code`);
    }
    const document = getDocument(application.invoiceDocumentId);
    if (!document) {
      errors.push(`${label}: invoice document is missing`);
    } else if (document.document_type !== "issued_invoice") {
      errors.push(`${label}: document is not an issued invoice`);
    } else if (
      application.kind === "payment" &&
      evidenceCurrency(document.currency) !== evidenceCurrency(application.currency)
    ) {
      errors.push(`${label}: application currency ${evidenceCurrency(application.currency)} does not match invoice currency ${evidenceCurrency(document.currency)}`);
    }

    if (application.journalEntryId == null) {
      errors.push(`${label}: missing journal evidence (legacy row unresolved)`);
      continue;
    }
    const journal = getJournal(application.journalEntryId);
    if (!journal) {
      errors.push(`${label}: missing journal evidence; journal entry ${application.journalEntryId} does not exist`);
      continue;
    }
    if (journal.status !== "posted") {
      errors.push(`${label}: journal entry ${journal.id} is ${journal.status}, not posted`);
    }
    if (journal.reversed_by_entry_id != null) {
      errors.push(`${label}: journal entry ${journal.id} was reversed by journal entry ${journal.reversed_by_entry_id}`);
    }
    if (journal.document_id !== application.invoiceDocumentId) {
      errors.push(`${label}: journal entry ${journal.id} references invoice document ${journal.document_id ?? "none"}`);
    }
    if (!sameNullableId(journal.source_bank_transaction_id, application.bankTransactionId)) {
      errors.push(`${label}: journal entry ${journal.id} bank transaction ${journal.source_bank_transaction_id ?? "none"} does not match application bank transaction ${application.bankTransactionId ?? "none"}`);
    }
    if (journal.transaction_date !== application.effectiveDate) {
      errors.push(`${label}: journal entry ${journal.id} date ${journal.transaction_date} does not match application date ${application.effectiveDate}`);
    }
    if (evidenceCurrency(journal.currency) !== evidenceCurrency(application.currency)) {
      errors.push(`${label}: journal entry ${journal.id} currency ${evidenceCurrency(journal.currency)} does not match application currency ${evidenceCurrency(application.currency)}`);
    }

    if (application.bankTransactionId != null) {
      const bank = getBank(application.bankTransactionId);
      if (!bank) {
        errors.push(`${label}: bank transaction ${application.bankTransactionId} does not exist`);
      } else {
        const bankAmount = Number(bank.amount);
        const requiresIncoming = application.kind === "payment" || application.kind === "claim";
        if (!Number.isFinite(bankAmount)) {
          errors.push(`${label}: bank transaction ${bank.id} amount is not a finite number`);
        } else if ((requiresIncoming && !(bankAmount > 0)) || (!requiresIncoming && !(bankAmount < 0))) {
          errors.push(`${label}: bank transaction ${bank.id} has the wrong direction for ${application.kind}`);
        }
        if (evidenceCurrency(bank.currency) !== evidenceCurrency(application.currency)) {
          errors.push(`${label}: bank transaction ${bank.id} currency ${evidenceCurrency(bank.currency)} does not match application currency ${evidenceCurrency(application.currency)}`);
        }
        if (
          bank.bank_account_id != null &&
          evidenceCurrency(bank.bank_account_currency) !== evidenceCurrency(bank.currency)
        ) {
          errors.push(`${label}: bank transaction ${bank.id} currency ${evidenceCurrency(bank.currency)} does not match source bank account currency ${evidenceCurrency(bank.bank_account_currency)}`);
        }
      }
    }
  }

  const byJournal = new Map<number, InvoiceJournalApplication[]>();
  for (const application of applications) {
    if (application.journalEntryId == null) continue;
    const group = byJournal.get(application.journalEntryId) ?? [];
    group.push(application);
    byJournal.set(application.journalEntryId, group);
  }

  for (const [journalEntryId, group] of byJournal) {
    const journal = getJournal(journalEntryId);
    if (!journal) continue;
    const kinds = group.map((row) => row.kind).sort();
    const allowed =
      (group.length === 1 && ["payment", "refund", "claim"].includes(kinds[0]!)) ||
      (group.length === 2 && kinds[0] === "claim" && kinds[1] === "payment");
    if (!allowed) {
      errors.push(`journal entry ${journalEntryId}: unsupported invoice application group (${kinds.join("+") || "none"})`);
      continue;
    }

    const first = group[0]!;
    for (const application of group.slice(1)) {
      if (
        application.invoiceDocumentId !== first.invoiceDocumentId ||
        !sameNullableId(application.bankTransactionId, first.bankTransactionId) ||
        application.effectiveDate !== first.effectiveDate ||
        evidenceCurrency(application.currency) !== evidenceCurrency(first.currency)
      ) {
        errors.push(`journal entry ${journalEntryId}: grouped invoice applications do not share invoice, bank transaction, date, and currency`);
        break;
      }
    }

    const groupAmountsAreValid = group.every((row) => Number.isFinite(row.amount) && row.amount > 0);
    const expectedApplicationAmount = groupAmountsAreValid
      ? sumDkk(group.map((row) => row.amount))
      : null;
    const lines = db.query(
      `SELECT a.account_no, jl.debit_amount, jl.credit_amount
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
        WHERE jl.journal_entry_id = ?
        ORDER BY jl.id ASC`,
    ).all(journalEntryId) as JournalLineEvidence[];
    let debitOre = 0n;
    let creditOre = 0n;
    let journalLineAmountsAreValid = true;
    for (const line of lines) {
      const debit = Number(line.debit_amount ?? 0);
      const credit = Number(line.credit_amount ?? 0);
      if (!Number.isFinite(debit) || !Number.isFinite(credit)) {
        journalLineAmountsAreValid = false;
        errors.push(`journal entry ${journalEntryId}: invoice evidence contains a non-finite journal-line amount`);
        continue;
      }
      debitOre += toOre(debit);
      creditOre += toOre(credit);
    }
    const journalDebit = fromOre(debitOre);
    const journalCredit = fromOre(creditOre);
    const currency = evidenceCurrency(first.currency);

    if (lines.length === 0) {
      errors.push(`journal entry ${journalEntryId}: invoice application evidence has no journal lines`);
    } else if (currency === "DKK" && expectedApplicationAmount != null && journalLineAmountsAreValid) {
      if (compareDkk(journalDebit, expectedApplicationAmount) !== 0 || compareDkk(journalCredit, expectedApplicationAmount) !== 0) {
        errors.push(`journal entry ${journalEntryId}: journal debit/credit ${journalDebit}/${journalCredit} does not match invoice application total ${expectedApplicationAmount} DKK`);
      }
    } else if (group.length === 1 && first.kind === "payment" && expectedApplicationAmount != null && journalLineAmountsAreValid) {
      if (journal.amount_foreign == null || !Number.isFinite(Number(journal.amount_foreign)) || compareDkk(Number(journal.amount_foreign), expectedApplicationAmount) !== 0) {
        errors.push(`journal entry ${journalEntryId}: foreign amount ${journal.amount_foreign ?? "none"} does not match invoice payment ${expectedApplicationAmount} ${currency}`);
      }
      if (journal.amount_dkk == null || !Number.isFinite(Number(journal.amount_dkk)) || !(Number(journal.amount_dkk) > 0) || debitOre !== creditOre) {
        errors.push(`journal entry ${journalEntryId}: DKK metadata/lines do not provide balanced evidence for the foreign invoice payment`);
      }
      const bank = first.bankTransactionId == null ? null : getBank(first.bankTransactionId);
      if (
        bank?.amount_dkk != null && Number.isFinite(Number(bank.amount_dkk)) &&
        journal.amount_dkk != null &&
        Number.isFinite(Number(journal.amount_dkk)) &&
        compareDkk(Math.abs(Number(bank.amount_dkk)), Number(journal.amount_dkk)) !== 0
      ) {
        errors.push(`journal entry ${journalEntryId}: DKK amount ${journal.amount_dkk} does not match bank transaction ${bank.id} DKK amount ${Math.abs(Number(bank.amount_dkk))}`);
      }
    }

    if (first.bankTransactionId != null) {
      const bank = getBank(first.bankTransactionId);
      if (bank && expectedApplicationAmount != null && Number.isFinite(Number(bank.amount)) && compareDkk(Math.abs(Number(bank.amount)), expectedApplicationAmount) !== 0) {
        errors.push(`journal entry ${journalEntryId}: bank transaction ${bank.id} amount ${Math.abs(Number(bank.amount))} does not match invoice application total ${expectedApplicationAmount} ${currency}`);
      }
    }

    errors.push(...validateAccountEffects(db, journal, group, lines, expectedApplicationAmount));
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}
