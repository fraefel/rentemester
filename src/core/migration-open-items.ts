/**
 * Migration open items are source-evidenced balances carried into a ledger
 * without replaying the recognition journal that Dinero already exported.
 *
 * They deliberately do not share the native invoice/payable tables: those
 * tables own Rentemester-originated document workflows and journal posting.
 * This narrow domain records only immutable migration evidence and derives a
 * remaining balance from immutable applications.
 */
import type { Database } from "bun:sqlite";
import { isValidIsoDate } from "./dates";
import { fromOre, toOre } from "./money";

export type MigrationOpenItemKind = "receivable" | "payable";
export type MigrationOpenItemSourceKind = "opening" | "journal" | "control_balance";
export type MigrationOpenItemResolutionStatus = "resolved" | "unallocated";

export type MigrationOpenItemInput = {
  externalRef: string;
  counterpartyName?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  originalAmount: number;
  openAmountAtImport: number;
  documentId?: number | null;
  /** Required only when the item was recognised by an imported source journal. */
  sourceRecognitionJournalEntryId?: number | null;
  sourceKind: MigrationOpenItemSourceKind;
  /** Defaults to resolved. Unallocated items preserve only a control balance. */
  resolutionStatus?: MigrationOpenItemResolutionStatus;
};

export type RecordMigrationOpenItemBatchInput = {
  dineroImportAttemptId: number;
  controlAccountNo: string;
  kind: MigrationOpenItemKind;
  /** The unsigned source balance on the control account at import time. */
  sourceControlAmount: number;
  /** Required when this batch contains opening-source items; this API never posts it. */
  openingJournalEntryId?: number | null;
  items: MigrationOpenItemInput[];
};

export type MigrationOpenItemMutationResult = {
  ok: boolean;
  batchId?: number;
  itemId?: number;
  applicationId?: number;
  errors: string[];
};

export type ApplyMigrationOpenItemInput = {
  itemId: number;
  amount: number;
  applicationDate: string;
  /** Existing settlement journal evidence, with the inverse control effect. */
  sourceJournalEntryId: number;
  /** Optional bank evidence, bound to the settlement journal when supplied. */
  bankTransactionId?: number | null;
  note?: string | null;
};

export type MigrationOpenItemReadRow = {
  batchId: number;
  itemId: number;
  kind: MigrationOpenItemKind;
  controlAccountNo: string;
  externalRef: string;
  counterpartyName: string | null;
  issueDate: string | null;
  dueDate: string | null;
  originalAmount: number;
  openAmountAtImport: number;
  appliedAmount: number;
  openBalance: number;
  status: "open" | "settled";
  documentId: number | null;
  sourceRecognitionJournalEntryId: number | null;
  sourceKind: MigrationOpenItemSourceKind;
  resolutionStatus: MigrationOpenItemResolutionStatus;
  applications: Array<{
    applicationId: number;
    amount: number;
    applicationDate: string;
    sourceJournalEntryId: number | null;
    bankTransactionId: number | null;
    note: string | null;
  }>;
};

export type MigrationOpenItemsReadResult = {
  ok: true;
  rows: MigrationOpenItemReadRow[];
};

type ItemWithBatch = {
  id: number;
  batch_id: number;
  kind: MigrationOpenItemKind;
  control_account_no: string;
  open_amount_at_import: number;
};

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function validPositiveAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && toOre(value) > 0n;
}

function signedControlEffect(kind: MigrationOpenItemKind, amount: number, phase: "recognition" | "settlement"): bigint {
  const sign = kind === "receivable" ? 1n : -1n;
  return toOre(amount) * (phase === "recognition" ? sign : -sign);
}

function postedJournalControlEffect(db: Database, journalEntryId: number, controlAccountNo: string): bigint | null {
  const journal = db.query("SELECT id FROM journal_entries WHERE id = ? AND status = 'posted'").get(journalEntryId);
  if (!journal) return null;
  const rows = db.query(
    `SELECT jl.debit_amount, jl.credit_amount
       FROM journal_lines jl
       JOIN accounts account ON account.id = jl.account_id
      WHERE jl.journal_entry_id = ? AND account.account_no = ?`,
  ).all(journalEntryId, controlAccountNo) as Array<{ debit_amount: number; credit_amount: number }>;
  return rows.reduce((total, row) => total + toOre(Number(row.debit_amount)) - toOre(Number(row.credit_amount)), 0n);
}

function postedJournalBankTransactionId(db: Database, journalEntryId: number): number | null {
  const row = db.query("SELECT source_bank_transaction_id FROM journal_entries WHERE id = ? AND status = 'posted'").get(journalEntryId) as { source_bank_transaction_id: number | null } | null;
  return row?.source_bank_transaction_id == null ? null : Number(row.source_bank_transaction_id);
}

function bankAmount(db: Database, bankTransactionId: number): bigint | null {
  const row = db.query("SELECT COALESCE(amount_dkk, amount) AS amount FROM bank_transactions WHERE id = ?").get(bankTransactionId) as { amount: number } | null;
  return row == null ? null : toOre(Number(row.amount));
}

function hasId(db: Database, table: "dinero_import_attempts" | "documents" | "bank_transactions", id: number): boolean {
  return db.query(`SELECT id FROM ${table} WHERE id = ?`).get(id) != null;
}

function errorsForItem(db: Database, input: MigrationOpenItemInput, kind: MigrationOpenItemKind, controlAccountNo: string): string[] {
  const errors: string[] = [];
  const externalRef = cleanText(input.externalRef);
  const resolutionStatus = input.resolutionStatus ?? "resolved";
  if (!externalRef) errors.push("migration open item needs an external reference");
  if (resolutionStatus !== "resolved" && resolutionStatus !== "unallocated") errors.push(`migration open item ${externalRef ?? "?"} has an invalid resolution status`);
  if (resolutionStatus === "resolved" && !cleanText(input.counterpartyName)) errors.push(`migration open item ${externalRef ?? "?"} needs a counterparty name`);
  if (resolutionStatus === "resolved" && !isValidIsoDate(input.issueDate ?? "")) errors.push(`migration open item ${externalRef ?? "?"} has an invalid issue date`);
  if (resolutionStatus === "unallocated" && (cleanText(input.counterpartyName) || input.issueDate != null || input.dueDate != null || input.documentId != null)) {
    errors.push(`unallocated migration open item ${externalRef ?? "?"} cannot claim item-level evidence`);
  }
  if (input.dueDate != null && !isValidIsoDate(input.dueDate)) errors.push(`migration open item ${externalRef ?? "?"} has an invalid due date`);
  if (!validPositiveAmount(input.originalAmount)) errors.push(`migration open item ${externalRef ?? "?"} needs a positive original amount`);
  if (!validPositiveAmount(input.openAmountAtImport)) errors.push(`migration open item ${externalRef ?? "?"} needs a positive open amount`);
  if (validPositiveAmount(input.originalAmount) && validPositiveAmount(input.openAmountAtImport) && toOre(input.openAmountAtImport) > toOre(input.originalAmount)) {
    errors.push(`migration open item ${externalRef ?? "?"} open amount exceeds original amount`);
  }
  if (input.documentId != null && (!Number.isInteger(input.documentId) || !hasId(db, "documents", input.documentId))) errors.push(`migration open item ${externalRef ?? "?"} references an unknown document`);
  if (input.sourceKind !== "opening" && input.sourceKind !== "journal" && input.sourceKind !== "control_balance") errors.push(`migration open item ${externalRef ?? "?"} has an invalid source kind`);
  if (resolutionStatus === "unallocated" && input.sourceKind !== "opening" && input.sourceKind !== "control_balance") errors.push(`unallocated migration open item ${externalRef ?? "?"} needs opening or control-balance evidence`);
  const recognitionId = input.sourceRecognitionJournalEntryId ?? null;
  if (input.sourceKind === "opening" && recognitionId != null) errors.push(`opening migration open item ${externalRef ?? "?"} cannot carry source recognition journal evidence`);
  if (input.sourceKind === "control_balance" && recognitionId != null) errors.push(`control-balance migration open item ${externalRef ?? "?"} cannot carry source recognition journal evidence`);
  if (input.sourceKind === "journal" && (!Number.isInteger(recognitionId) || recognitionId == null)) errors.push(`journal migration open item ${externalRef ?? "?"} needs source recognition journal evidence`);
  if (input.sourceKind === "journal" && Number.isInteger(recognitionId) && validPositiveAmount(input.originalAmount)) {
    const effect = postedJournalControlEffect(db, recognitionId!, controlAccountNo);
    if (effect == null) errors.push(`migration open item ${externalRef ?? "?"} references an unknown or non-posted recognition journal`);
    else if (effect !== signedControlEffect(kind, input.originalAmount, "recognition")) errors.push(`migration open item ${externalRef ?? "?"} recognition journal has the wrong control-account effect`);
  }
  return errors;
}

/** Record a complete, exact opening/current-journal batch without posting journals. */
export function recordMigrationOpenItemBatch(db: Database, input: RecordMigrationOpenItemBatchInput): MigrationOpenItemMutationResult {
  const errors: string[] = [];
  const controlAccountNo = cleanText(input.controlAccountNo);
  if (!Number.isInteger(input.dineroImportAttemptId) || !hasId(db, "dinero_import_attempts", input.dineroImportAttemptId)) errors.push("migration open-item batch needs an existing Dinero import attempt");
  if (!controlAccountNo || db.query("SELECT id FROM accounts WHERE account_no = ?").get(controlAccountNo) == null) errors.push("migration open-item batch needs an existing control account");
  if (input.kind !== "receivable" && input.kind !== "payable") errors.push("migration open-item batch has an invalid kind");
  if (!validPositiveAmount(input.sourceControlAmount)) errors.push("migration open-item batch needs a positive source control amount");
  if (!Array.isArray(input.items) || input.items.length === 0) errors.push("migration open-item batch needs at least one item");
  const references = new Set<string>();
  for (const item of input.items ?? []) {
    const ref = cleanText(item.externalRef);
    if (ref && references.has(ref)) errors.push(`migration open-item batch repeats external reference '${ref}'`);
    if (ref) references.add(ref);
    if (controlAccountNo && (input.kind === "receivable" || input.kind === "payable")) errors.push(...errorsForItem(db, item, input.kind, controlAccountNo));
  }
  if (validPositiveAmount(input.sourceControlAmount) && Array.isArray(input.items)) {
    const itemOre = input.items.reduce((sum, item) => sum + (validPositiveAmount(item.openAmountAtImport) ? toOre(item.openAmountAtImport) : 0n), 0n);
    if (itemOre !== toOre(input.sourceControlAmount)) errors.push("migration open-item batch does not exactly reconcile to the source control amount in øre");
  }
  const openingJournalEntryId = input.openingJournalEntryId ?? null;
  const openingItems = (input.items ?? []).filter((item) => item.sourceKind === "opening");
  const openingAmount = openingItems.reduce((sum, item) => sum + (validPositiveAmount(item.openAmountAtImport) ? toOre(item.openAmountAtImport) : 0n), 0n);
  if (openingItems.length > 0 && openingJournalEntryId == null) {
    errors.push("migration open-item batch with opening items needs opening journal evidence");
  } else if (openingItems.length === 0 && openingJournalEntryId != null) {
    errors.push("migration open-item batch without opening items cannot carry opening journal evidence");
  } else if (openingJournalEntryId != null && (!Number.isInteger(openingJournalEntryId) || !controlAccountNo || (input.kind !== "receivable" && input.kind !== "payable"))) {
    errors.push("migration open-item batch has invalid opening journal evidence");
  } else if (openingJournalEntryId != null) {
    const effect = postedJournalControlEffect(db, openingJournalEntryId, controlAccountNo!);
    if (effect == null) errors.push("migration open-item batch opening journal is unknown or non-posted");
    else if (effect !== (input.kind === "receivable" ? openingAmount : -openingAmount)) errors.push("migration open-item batch opening journal has the wrong control-account effect");
  }
  if (errors.length > 0) return { ok: false, errors };

  try {
    return db.transaction(() => {
      const batch = db.query(
        `INSERT INTO migration_open_item_batches
          (dinero_import_attempt_id, control_account_no, kind, source_control_amount, opening_journal_entry_id)
         VALUES (?, ?, ?, ?, ?)
         RETURNING id`,
      ).get(input.dineroImportAttemptId, controlAccountNo, input.kind, input.sourceControlAmount, openingJournalEntryId) as { id: number };
      for (const item of input.items) {
        db.query(
          `INSERT INTO migration_open_items
            (batch_id, external_ref, counterparty_name, issue_date, due_date, original_amount, open_amount_at_import, document_id, source_recognition_journal_entry_id, source_kind, resolution_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(batch.id, item.externalRef.trim(), cleanText(item.counterpartyName), item.issueDate ?? null, item.dueDate ?? null, item.originalAmount, item.openAmountAtImport, item.documentId ?? null, item.sourceRecognitionJournalEntryId ?? null, item.sourceKind, item.resolutionStatus ?? "resolved");
      }
      return { ok: true, batchId: batch.id, errors: [] };
    }).immediate();
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Apply an evidenced settlement without creating a journal or amount-only match. */
export function applyMigrationOpenItem(db: Database, input: ApplyMigrationOpenItemInput): MigrationOpenItemMutationResult {
  const errors: string[] = [];
  if (!Number.isInteger(input.itemId)) errors.push("migration open-item application needs an item id");
  if (!validPositiveAmount(input.amount)) errors.push("migration open-item application needs a positive amount");
  if (!isValidIsoDate(input.applicationDate)) errors.push("migration open-item application has an invalid date");
  const journalId = input.sourceJournalEntryId ?? null;
  const bankId = input.bankTransactionId ?? null;
  if (!Number.isInteger(journalId)) errors.push("migration open-item application needs settlement journal evidence");
  const item = Number.isInteger(input.itemId) ? db.query(
    `SELECT item.id, item.batch_id, batch.kind, batch.control_account_no, item.open_amount_at_import
       FROM migration_open_items item JOIN migration_open_item_batches batch ON batch.id = item.batch_id
      WHERE item.id = ?`,
  ).get(input.itemId) as ItemWithBatch | null : null;
  if (!item) errors.push("migration open-item application references an unknown item");
  if (!Number.isInteger(journalId) || !item || !validPositiveAmount(input.amount)) errors.push("migration open-item application has invalid journal evidence");
  else {
    const effect = postedJournalControlEffect(db, journalId, item.control_account_no);
    if (effect == null) errors.push("migration open-item application journal is unknown or non-posted");
    else if (effect !== signedControlEffect(item.kind, input.amount, "settlement")) errors.push("migration open-item application journal has the wrong control-account effect");
  }
  if (Number.isInteger(journalId) && db.query("SELECT id FROM migration_open_item_applications WHERE source_journal_entry_id = ?").get(journalId) != null) {
    errors.push("migration open-item application journal evidence is already used");
  }
  if (bankId != null && (!Number.isInteger(bankId) || !hasId(db, "bank_transactions", bankId))) errors.push("migration open-item application references an unknown bank transaction");
  else if (bankId != null && item && validPositiveAmount(input.amount) && Number.isInteger(journalId)) {
    const amount = bankAmount(db, bankId);
    if (amount == null) errors.push("migration open-item application references an unknown bank transaction");
    else if (amount !== (item.kind === "receivable" ? toOre(input.amount) : -toOre(input.amount))) errors.push("migration open-item application bank amount has the wrong signed amount");
    else if (postedJournalBankTransactionId(db, journalId) !== bankId) errors.push("migration open-item application journal is not linked to its bank evidence");
  }
  if (bankId != null && db.query("SELECT id FROM migration_open_item_applications WHERE bank_transaction_id = ?").get(bankId) != null) {
    errors.push("migration open-item application bank evidence is already used");
  }
  if (item && validPositiveAmount(input.amount)) {
    const applied = db.query("SELECT COALESCE(SUM(amount), 0) AS amount FROM migration_open_item_applications WHERE item_id = ?").get(item.id) as { amount: number };
    if (toOre(Number(applied.amount)) + toOre(input.amount) > toOre(item.open_amount_at_import)) errors.push("migration open-item application would over-apply the open balance");
  }
  if (errors.length > 0) return { ok: false, errors };
  try {
    return db.transaction(() => {
      const result = db.query(
        `INSERT INTO migration_open_item_applications
          (item_id, amount, application_date, source_journal_entry_id, bank_transaction_id, note)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id`,
      ).get(input.itemId, input.amount, input.applicationDate, journalId, bankId, input.note?.trim() || null) as { id: number };
      return { ok: true, itemId: input.itemId, applicationId: result.id, errors: [] };
    }).immediate();
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

/** Read an evidence-rich, derived balance view. It performs no matching or posting. */
export function getMigrationOpenItems(db: Database, batchId?: number): MigrationOpenItemsReadResult {
  const itemRows = db.query(
    `SELECT batch.id AS batch_id, item.id AS item_id, batch.kind, batch.control_account_no,
            item.external_ref, item.counterparty_name, item.issue_date, item.due_date,
            item.original_amount, item.open_amount_at_import, item.document_id,
            item.source_recognition_journal_entry_id, item.source_kind, item.resolution_status,
            COALESCE(SUM(application.amount), 0) AS applied_amount
       FROM migration_open_items item
       JOIN migration_open_item_batches batch ON batch.id = item.batch_id
       LEFT JOIN migration_open_item_applications application ON application.item_id = item.id
      WHERE (? IS NULL OR batch.id = ?)
      GROUP BY item.id
      ORDER BY batch.id, item.id`,
  ).all(batchId ?? null, batchId ?? null) as Array<Record<string, unknown>>;
  const appsByItem = new Map<number, MigrationOpenItemReadRow["applications"]>();
  const applications = db.query(
    `SELECT item_id, id, amount, application_date, source_journal_entry_id, bank_transaction_id, note
       FROM migration_open_item_applications
      ORDER BY item_id, id`,
  ).all() as Array<Record<string, unknown>>;
  for (const app of applications) {
    const itemId = Number(app.item_id);
    if (batchId != null && !itemRows.some((item) => Number(item.item_id) === itemId)) continue;
    const entries = appsByItem.get(itemId) ?? [];
    entries.push({ applicationId: Number(app.id), amount: Number(app.amount), applicationDate: String(app.application_date), sourceJournalEntryId: app.source_journal_entry_id == null ? null : Number(app.source_journal_entry_id), bankTransactionId: app.bank_transaction_id == null ? null : Number(app.bank_transaction_id), note: app.note == null ? null : String(app.note) });
    appsByItem.set(itemId, entries);
  }
  return {
    ok: true,
    rows: itemRows.map((row) => {
      const openOre = toOre(Number(row.open_amount_at_import)) - toOre(Number(row.applied_amount));
      return {
        batchId: Number(row.batch_id), itemId: Number(row.item_id), kind: row.kind as MigrationOpenItemKind,
        controlAccountNo: String(row.control_account_no), externalRef: String(row.external_ref), counterpartyName: row.counterparty_name == null ? null : String(row.counterparty_name),
        issueDate: row.issue_date == null ? null : String(row.issue_date), dueDate: row.due_date == null ? null : String(row.due_date),
        originalAmount: Number(row.original_amount), openAmountAtImport: Number(row.open_amount_at_import), appliedAmount: Number(row.applied_amount),
        openBalance: fromOre(openOre), status: openOre === 0n ? "settled" : "open", documentId: row.document_id == null ? null : Number(row.document_id),
        sourceRecognitionJournalEntryId: row.source_recognition_journal_entry_id == null ? null : Number(row.source_recognition_journal_entry_id),
        sourceKind: row.source_kind as MigrationOpenItemSourceKind, resolutionStatus: row.resolution_status as MigrationOpenItemResolutionStatus,
        applications: appsByItem.get(Number(row.item_id)) ?? [],
      };
    }),
  };
}
