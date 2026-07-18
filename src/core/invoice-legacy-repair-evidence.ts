import type { Database } from "bun:sqlite";

export type LegacyInvoiceRepairState = {
  invoiceDocumentId: number;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceStatus: string;
  payloadJson: string | null;
  legacyJournalEntryId: number;
  legacyEntryNo: string;
  legacyTransactionDate: string;
  replacementJournalEntryId?: number;
};

export type LegacyInvoiceRepairEvidenceResult =
  | { ok: true; state: LegacyInvoiceRepairState }
  | { ok: false; errors: string[] };

/**
 * Inspect the narrowly permitted state transition for an unclassified legacy
 * issued-invoice journal. This helper is intentionally read-only and shared by
 * the high-level atomic repair and the ledger's protected reversal adapter.
 */
export function validateLegacyInvoiceRepairEvidence(
  db: Database,
  input: {
    invoiceDocumentId: number;
    legacyJournalEntryId: number;
    replacementJournalEntryId?: number;
  },
): LegacyInvoiceRepairEvidenceResult {
  const errors: string[] = [];
  const invoice = db.query(
    `SELECT id, invoice_no, invoice_date, status, payload_json, document_type
       FROM documents
      WHERE id = ?`,
  ).get(input.invoiceDocumentId) as {
    id: number;
    invoice_no: string | null;
    invoice_date: string | null;
    status: string;
    payload_json: string | null;
    document_type: string;
  } | null;
  if (!invoice) {
    return { ok: false, errors: [`invoice document ${input.invoiceDocumentId} does not exist`] };
  }
  if (invoice.document_type !== "issued_invoice") {
    errors.push(`document ${input.invoiceDocumentId} is not an issued invoice`);
  }
  if (!invoice.invoice_no) errors.push(`invoice document ${input.invoiceDocumentId} has no invoice number`);
  if (!invoice.invoice_date) errors.push(`invoice document ${input.invoiceDocumentId} has no invoice date`);
  if (!new Set(["issued", "open"]).has(invoice.status)) {
    errors.push(`invoice ${invoice.invoice_no ?? input.invoiceDocumentId} has status ${invoice.status}, not issued/open`);
  }
  if (!invoice.payload_json) {
    errors.push(`invoice ${invoice.invoice_no ?? input.invoiceDocumentId} has no immutable payload for canonical reposting`);
  } else {
    try {
      JSON.parse(invoice.payload_json);
    } catch {
      errors.push(`invoice ${invoice.invoice_no ?? input.invoiceDocumentId} has invalid immutable payload JSON`);
    }
  }

  const legacy = db.query(
    `SELECT j.id, j.entry_no, j.transaction_date, j.status,
            j.reversal_of_entry_id, j.source_bank_transaction_id,
            j.document_id, j.locked,
            (SELECT r.id
               FROM journal_entries r
              WHERE r.reversal_of_entry_id = j.id
              ORDER BY r.id ASC LIMIT 1) AS reversed_by_entry_id
       FROM journal_entries j
      WHERE j.id = ?`,
  ).get(input.legacyJournalEntryId) as {
    id: number;
    entry_no: string;
    transaction_date: string;
    status: string;
    reversal_of_entry_id: number | null;
    source_bank_transaction_id: number | null;
    document_id: number | null;
    locked: number;
    reversed_by_entry_id: number | null;
  } | null;
  if (!legacy) {
    errors.push(`legacy journal entry ${input.legacyJournalEntryId} does not exist`);
  } else {
    if (legacy.document_id !== input.invoiceDocumentId) {
      errors.push(`legacy journal ${legacy.entry_no} does not belong to invoice document ${input.invoiceDocumentId}`);
    }
    if (legacy.status !== "posted" || legacy.reversal_of_entry_id != null || legacy.reversed_by_entry_id != null) {
      errors.push(`legacy journal ${legacy.entry_no} is not an active original posting`);
    }
    if (legacy.source_bank_transaction_id != null) {
      errors.push(`legacy journal ${legacy.entry_no} is tied to bank transaction ${legacy.source_bank_transaction_id}`);
    }
    if (legacy.locked !== 1) errors.push(`legacy journal ${legacy.entry_no} is not locked append-only evidence`);
  }

  const posting = db.query(
    `SELECT p.journal_entry_id,
            j.status,
            j.reversal_of_entry_id,
            (SELECT r.id FROM journal_entries r
              WHERE r.reversal_of_entry_id = j.id LIMIT 1) AS reversed_by_entry_id
       FROM issued_invoice_postings p
       JOIN journal_entries j ON j.id = p.journal_entry_id
      WHERE p.invoice_document_id = ?`,
  ).get(input.invoiceDocumentId) as {
    journal_entry_id: number;
    status: string;
    reversal_of_entry_id: number | null;
    reversed_by_entry_id: number | null;
  } | null;
  if (input.replacementJournalEntryId == null) {
    if (posting) errors.push(`invoice ${invoice.invoice_no ?? input.invoiceDocumentId} already has explicit posting journal ${posting.journal_entry_id}`);
  } else if (
    !posting ||
    posting.journal_entry_id !== input.replacementJournalEntryId ||
    posting.status !== "posted" ||
    posting.reversal_of_entry_id != null ||
    posting.reversed_by_entry_id != null
  ) {
    errors.push(`invoice ${invoice.invoice_no ?? input.invoiceDocumentId} does not have active replacement posting journal ${input.replacementJournalEntryId}`);
  }

  const domain = db.query(
    `SELECT
       (SELECT COUNT(*) FROM invoice_payments WHERE invoice_document_id = ?) AS payments,
       (SELECT COUNT(*) FROM invoice_refunds WHERE invoice_document_id = ?) AS refunds,
       (SELECT COUNT(*) FROM invoice_claim_payments WHERE invoice_document_id = ?) AS claim_payments,
       (SELECT COUNT(*) FROM invoice_reminders WHERE invoice_document_id = ?) AS reminders,
       (SELECT COUNT(*) FROM invoice_compensation_claims WHERE invoice_document_id = ?) AS compensation_claims,
       (SELECT COUNT(*) FROM invoice_interest_claims WHERE invoice_document_id = ?) AS interest_claims,
       (SELECT COUNT(*) FROM invoice_interest_corrections WHERE invoice_document_id = ?) AS interest_corrections,
       (SELECT COUNT(*) FROM invoice_bad_debt_writeoffs WHERE invoice_document_id = ?) AS bad_debt_writeoffs,
       (SELECT COUNT(*) FROM documents c
         WHERE c.document_type = 'credit_note'
           AND c.payment_details = ?) AS credit_note_documents,
       (SELECT COUNT(*) FROM credit_note_postings
         WHERE original_invoice_document_id = ?) AS credit_note_postings`,
  ).get(
    input.invoiceDocumentId,
    input.invoiceDocumentId,
    input.invoiceDocumentId,
    input.invoiceDocumentId,
    input.invoiceDocumentId,
    input.invoiceDocumentId,
    input.invoiceDocumentId,
    input.invoiceDocumentId,
    invoice.invoice_no,
    input.invoiceDocumentId,
  ) as Record<string, number>;
  const dependencies = Object.entries(domain)
    .filter(([, count]) => Number(count) > 0)
    .map(([kind, count]) => `${kind}=${count}`);
  if (dependencies.length > 0) {
    errors.push(`invoice ${invoice.invoice_no ?? input.invoiceDocumentId} has downstream evidence (${dependencies.join(", ")})`);
  }

  const inboundReferenceCount = Number((db.query(
    `SELECT
       (SELECT COUNT(*) FROM issued_invoice_postings WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM credit_note_postings WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_payments WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_refunds WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_claim_payments WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_bad_debt_writeoffs WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_interest_corrections WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_reminder_postings WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_compensation_postings WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM invoice_interest_postings WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM import_document_links WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM opening_balances WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM asset_depreciation_entries WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM asset_writeoffs WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM accruals WHERE registration_journal_entry_id = ?) +
       (SELECT COUNT(*) FROM accrual_schedule_postings WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM payables WHERE journal_entry_id = ?) +
       (SELECT COUNT(*) FROM payable_payments WHERE journal_entry_id = ?) AS n`,
  ).get(
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
    input.legacyJournalEntryId,
  ) as { n: number }).n);
  if (inboundReferenceCount > 0) {
    errors.push(`legacy journal ${legacy?.entry_no ?? input.legacyJournalEntryId} has ${inboundReferenceCount} inbound evidence reference(s)`);
  }

  const activeJournalIds = (db.query(
    `SELECT j.id
       FROM journal_entries j
      WHERE j.document_id = ?
        AND j.status = 'posted'
        AND j.reversal_of_entry_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries r
           WHERE r.reversal_of_entry_id = j.id
        )
      ORDER BY j.id ASC`,
  ).all(input.invoiceDocumentId) as Array<{ id: number }>).map((row) => row.id);
  const expectedJournalIds = [
    input.legacyJournalEntryId,
    ...(input.replacementJournalEntryId == null ? [] : [input.replacementJournalEntryId]),
  ].sort((left, right) => left - right);
  if (
    activeJournalIds.length !== expectedJournalIds.length ||
    activeJournalIds.some((id, index) => id !== expectedJournalIds[index])
  ) {
    errors.push(
      `invoice ${invoice.invoice_no ?? input.invoiceDocumentId} must have exactly the named legacy journal${input.replacementJournalEntryId == null ? "" : " and canonical replacement"} active; found ${activeJournalIds.join(", ") || "none"}`,
    );
  }

  if (errors.length > 0 || !legacy || !invoice.invoice_no || !invoice.invoice_date) {
    return { ok: false, errors: [...new Set(errors)] };
  }
  return {
    ok: true,
    state: {
      invoiceDocumentId: invoice.id,
      invoiceNumber: invoice.invoice_no,
      invoiceDate: invoice.invoice_date,
      invoiceStatus: invoice.status,
      payloadJson: invoice.payload_json,
      legacyJournalEntryId: legacy.id,
      legacyEntryNo: legacy.entry_no,
      legacyTransactionDate: legacy.transaction_date,
      ...(input.replacementJournalEntryId == null
        ? {}
        : { replacementJournalEntryId: input.replacementJournalEntryId }),
    },
  };
}
