/**
 * Generic four-eyes accounting drafts. Draft evidence is append-only; only an
 * independently reviewed, exact submitted version can reach the ledger, and
 * the journal post plus approval evidence commit in one SQLite transaction.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { insertAuditLog, resolveActor, type ResolveActorInput } from "./actor";
import { asJournalEntryId } from "./ids";
import { postJournalEntryInCurrentTransaction, validateJournalEntry, type JournalEntryInput, type JournalPostResult } from "./ledger";

const DRAFT_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DRAFT_PROGRAM = "rentemester-accounting-draft";

type DraftEventType = "created" | "revised" | "submitted" | "rejected" | "approved_posted";
type DraftEventRow = {
  id: number;
  draft_id: string;
  version: number;
  event_type: DraftEventType;
  payload_hash: string;
  canonical_payload: string;
  reason: string | null;
  journal_entry_id: number | null;
  actor_id: string;
  actor_program: string;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
};

export type AccountingDraftState = {
  id: string;
  version: number;
  status: DraftEventType;
  payloadHash: string;
  eventHash: string;
  payload: Omit<JournalEntryInput, "createdBy" | "createdByProgram">;
  actorId: string;
  reason?: string;
  journalEntryId?: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertDraftId(value: string): string {
  const normalized = value.trim().normalize("NFC");
  if (!DRAFT_ID.test(normalized)) throw new Error("draft id must be a lowercase stable identifier");
  return normalized;
}

function canonicalPayload(input: JournalEntryInput): string {
  const payload: Omit<JournalEntryInput, "createdBy" | "createdByProgram"> = {
    transactionDate: input.transactionDate,
    text: input.text,
    ...(input.documentId == null ? {} : { documentId: input.documentId }),
    ...(input.sourceBankTransactionId == null ? {} : { sourceBankTransactionId: input.sourceBankTransactionId }),
    ...(input.currency == null ? {} : { currency: input.currency }),
    ...(input.amountForeign == null ? {} : { amountForeign: input.amountForeign }),
    ...(input.amountDkk == null ? {} : { amountDkk: input.amountDkk }),
    ...(input.fxRateToDkk == null ? {} : { fxRateToDkk: input.fxRateToDkk }),
    lines: input.lines.map((line) => ({
      accountNo: line.accountNo,
      ...(line.debitAmount == null ? {} : { debitAmount: line.debitAmount }),
      ...(line.creditAmount == null ? {} : { creditAmount: line.creditAmount }),
      ...(line.vatCode == null ? {} : { vatCode: line.vatCode }),
      ...(line.text == null ? {} : { text: line.text }),
    })),
  };
  const canonical = JSON.stringify(payload);
  if (Buffer.byteLength(canonical, "utf8") > 262144) throw new Error("accounting draft payload exceeds 262144 bytes");
  return canonical;
}

function eventHash(previousHash: string | null, event: Omit<DraftEventRow, "event_hash">): string {
  return sha256(JSON.stringify({
    previousHash,
    id: event.id,
    draftId: event.draft_id,
    version: event.version,
    eventType: event.event_type,
    payloadHash: event.payload_hash,
    canonicalPayload: event.canonical_payload,
    reason: event.reason,
    journalEntryId: event.journal_entry_id,
    actorId: event.actor_id,
    actorProgram: event.actor_program,
    createdAt: event.created_at,
  }));
}

function readEvents(db: Database): DraftEventRow[] {
  const rows = db.query(
    `SELECT id,draft_id,version,event_type,payload_hash,canonical_payload,reason,journal_entry_id,
            actor_id,actor_program,previous_hash,event_hash,created_at
       FROM accounting_draft_events ORDER BY id`,
  ).all() as DraftEventRow[];
  let previous: string | null = null;
  for (const row of rows) {
    if (row.previous_hash !== previous || row.event_hash !== eventHash(previous, row)) {
      throw new Error("accounting draft event hash-chain is invalid");
    }
    if (!SHA256.test(row.payload_hash) || sha256(row.canonical_payload) !== row.payload_hash) {
      throw new Error("accounting draft payload evidence is invalid");
    }
    previous = row.event_hash;
  }
  return rows;
}

function draftEvents(db: Database, draftId: string): DraftEventRow[] {
  return readEvents(db).filter((event) => event.draft_id === draftId);
}

function currentEvent(db: Database, draftId: string): DraftEventRow | null {
  return draftEvents(db, draftId).at(-1) ?? null;
}

function stateFromEvent(event: DraftEventRow): AccountingDraftState {
  return {
    id: event.draft_id,
    version: event.version,
    status: event.event_type,
    payloadHash: event.payload_hash,
    eventHash: event.event_hash,
    payload: JSON.parse(event.canonical_payload) as AccountingDraftState["payload"],
    actorId: event.actor_id,
    ...(event.reason == null ? {} : { reason: event.reason }),
    ...(event.journal_entry_id == null ? {} : { journalEntryId: event.journal_entry_id }),
  };
}

function appendEvent(
  db: Database,
  input: { draftId: string; version: number; type: DraftEventType; canonical: string; reason?: string; journalEntryId?: number },
  audit: ResolveActorInput,
): DraftEventRow {
  const events = readEvents(db);
  const actor = resolveActor(audit);
  const previousHash = events.at(-1)?.event_hash ?? null;
  const event = {
    id: (events.at(-1)?.id ?? 0) + 1,
    draft_id: input.draftId,
    version: input.version,
    event_type: input.type,
    payload_hash: sha256(input.canonical),
    canonical_payload: input.canonical,
    reason: input.reason ?? null,
    journal_entry_id: input.journalEntryId ?? null,
    actor_id: actor.createdBy,
    actor_program: actor.createdByProgram,
    previous_hash: previousHash,
    created_at: new Date().toISOString(),
  };
  const complete: DraftEventRow = { ...event, event_hash: eventHash(previousHash, event) };
  db.query(
    `INSERT INTO accounting_draft_events
       (id,draft_id,version,event_type,payload_hash,canonical_payload,reason,journal_entry_id,
        actor_id,actor_program,previous_hash,event_hash,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    complete.id, complete.draft_id, complete.version, complete.event_type,
    complete.payload_hash, complete.canonical_payload, complete.reason,
    complete.journal_entry_id, complete.actor_id, complete.actor_program,
    complete.previous_hash, complete.event_hash, complete.created_at,
  );
  insertAuditLog(db, {
    ...audit,
    eventType: `accounting_draft_${input.type}`,
    entityType: "accounting_draft",
    entityId: input.draftId,
    message: `Accounting draft ${input.draftId} version ${input.version}: ${input.type}`,
  });
  return complete;
}

function validatePayload(db: Database, payload: JournalEntryInput): string {
  const validation = validateJournalEntry(db, payload);
  if (!validation.ok) throw new Error(`accounting draft is invalid: ${validation.errors.join("; ")}`);
  return canonicalPayload(payload);
}

function assertExactCurrent(current: DraftEventRow | null, expectedEventHash: string, expectedStatus: DraftEventType): DraftEventRow {
  if (!current || current.event_type !== expectedStatus || current.event_hash !== expectedEventHash) {
    throw new Error(`exact ${expectedStatus} accounting draft was not found`);
  }
  return current;
}

export function createAccountingDraft(db: Database, draftIdInput: string, payload: JournalEntryInput, audit: ResolveActorInput): AccountingDraftState {
  return db.transaction(() => {
    const draftId = assertDraftId(draftIdInput);
    if (currentEvent(db, draftId)) throw new Error("accounting draft id already exists");
    const event = appendEvent(db, { draftId, version: 1, type: "created", canonical: validatePayload(db, payload) }, audit);
    return stateFromEvent(event);
  }).immediate();
}

export function reviseAccountingDraft(db: Database, draftIdInput: string, expectedEventHash: string, payload: JournalEntryInput, audit: ResolveActorInput): AccountingDraftState {
  return db.transaction(() => {
    const draftId = assertDraftId(draftIdInput);
    const current = currentEvent(db, draftId);
    if (!current || !(["created", "revised", "rejected"] as DraftEventType[]).includes(current.event_type) || current.event_hash !== expectedEventHash) {
      throw new Error("exact editable accounting draft was not found");
    }
    const event = appendEvent(db, { draftId, version: current.version + 1, type: "revised", canonical: validatePayload(db, payload) }, audit);
    return stateFromEvent(event);
  }).immediate();
}

export function submitAccountingDraft(db: Database, draftIdInput: string, expectedEventHash: string, audit: ResolveActorInput): AccountingDraftState {
  return db.transaction(() => {
    const draftId = assertDraftId(draftIdInput);
    const current = currentEvent(db, draftId);
    if (!current || !(["created", "revised"] as DraftEventType[]).includes(current.event_type) || current.event_hash !== expectedEventHash) {
      throw new Error("exact editable accounting draft was not found");
    }
    // Revalidation makes a draft fail closed if account, evidence or period
    // preconditions changed between editing and submission.
    validatePayload(db, JSON.parse(current.canonical_payload) as JournalEntryInput);
    return stateFromEvent(appendEvent(db, { draftId, version: current.version, type: "submitted", canonical: current.canonical_payload }, audit));
  }).immediate();
}

function assertIndependentReviewer(db: Database, submitted: DraftEventRow, audit: ResolveActorInput): void {
  const reviewer = resolveActor(audit).createdBy;
  const versionAuthor = [...draftEvents(db, submitted.draft_id)].reverse().find(
    (event: DraftEventRow) => event.version === submitted.version && (event.event_type === "created" || event.event_type === "revised"),
  );
  if (!versionAuthor || reviewer === submitted.actor_id || reviewer === versionAuthor.actor_id) {
    throw new Error("accounting draft review requires an actor distinct from author and submitter");
  }
}

export function rejectAccountingDraft(db: Database, draftIdInput: string, expectedEventHash: string, reasonInput: string, audit: ResolveActorInput): AccountingDraftState {
  return db.transaction(() => {
    const draftId = assertDraftId(draftIdInput);
    const existing = currentEvent(db, draftId);
    const submitted = assertExactCurrent(existing, expectedEventHash, "submitted");
    assertIndependentReviewer(db, submitted, audit);
    const reason = reasonInput.trim().normalize("NFC");
    if (!reason || reason.length > 1000) throw new Error("rejection reason must contain 1 through 1000 characters");
    return stateFromEvent(appendEvent(db, { draftId, version: submitted.version, type: "rejected", canonical: submitted.canonical_payload, reason }, audit));
  }).immediate();
}

export function approveAndPostAccountingDraft(
  db: Database,
  draftIdInput: string,
  expectedEventHash: string,
  audit: ResolveActorInput,
): AccountingDraftState & { journal: JournalPostResult } {
  return db.transaction(() => {
    const draftId = assertDraftId(draftIdInput);
    const existing = currentEvent(db, draftId);
    if (existing?.event_type === "approved_posted") {
      const submittedEvidence = draftEvents(db, draftId).find(
        (event) => event.event_hash === expectedEventHash && event.event_type === "submitted",
      );
      if (!submittedEvidence || existing.journal_entry_id == null) {
        throw new Error("exact submitted accounting draft was not found");
      }
      const journalRow = db.query(
        "SELECT id,entry_no,entry_hash FROM journal_entries WHERE id = ?",
      ).get(existing.journal_entry_id) as { id: number; entry_no: string; entry_hash: string } | null;
      if (!journalRow) throw new Error("posted accounting draft has missing journal evidence");
      return {
        ...stateFromEvent(existing),
        journal: {
          ok: true,
          entryId: asJournalEntryId(journalRow.id),
          entryNo: journalRow.entry_no,
          entryHash: journalRow.entry_hash,
          appliedRules: [],
          errors: [],
        },
      };
    }
    const submitted = assertExactCurrent(existing, expectedEventHash, "submitted");
    assertIndependentReviewer(db, submitted, audit);
    const actor = resolveActor(audit);
    const payload = JSON.parse(submitted.canonical_payload) as JournalEntryInput;
    const journal = postJournalEntryInCurrentTransaction(db, { ...payload, createdBy: actor.createdBy, createdByProgram: DRAFT_PROGRAM });
    if (!journal.ok || journal.entryId == null) throw new Error(`accounting draft could not be posted: ${journal.errors.join("; ")}`);
    const event = appendEvent(db, { draftId, version: submitted.version, type: "approved_posted", canonical: submitted.canonical_payload, journalEntryId: Number(journal.entryId) }, audit);
    return { ...stateFromEvent(event), journal };
  }).immediate();
}

export function getAccountingDraft(db: Database, draftIdInput: string): AccountingDraftState | null {
  const current = currentEvent(db, assertDraftId(draftIdInput));
  return current ? stateFromEvent(current) : null;
}

export function listAccountingDrafts(db: Database): AccountingDraftState[] {
  const latest = new Map<string, DraftEventRow>();
  for (const event of readEvents(db)) latest.set(event.draft_id, event);
  return [...latest.values()].map(stateFromEvent).sort((left, right) => left.id.localeCompare(right.id));
}
