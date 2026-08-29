/** Durable transaction-owning retry receipts for high-risk local writes (#583). */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { insertAuditLog } from "./actor";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_PAYLOAD_MAX_BYTES = 65_536;
export const IDEMPOTENCY_RETENTION_DAYS = 30;
export type RetryClass = "safe-read" | "key-idempotent" | "natural-idempotent" | "external-provider-reconciled" | "unsafe-read-back";
export const RETRY_CLASS_BY_OPERATION: Readonly<Record<string, RetryClass>> = Object.freeze({
  journal_post: "key-idempotent", journal_reverse: "key-idempotent", expense_book: "key-idempotent", payable_register: "key-idempotent", payable_pay: "key-idempotent",
  bookkeeping_batch_apply: "natural-idempotent", reconcile_bank: "natural-idempotent", bank_import: "natural-idempotent",
  efaktura_send: "external-provider-reconciled", invoice_send_email: "external-provider-reconciled",
});
export type StablePrincipal = { kind: "user" | "service-account"; subjectId: string };
export type IdempotencyReceipt = { replayed: boolean; receiptId: number; createdAt: string; expiresAt: string };
export class IdempotencyError extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "IDEMPOTENCY_OUTCOME_EXPIRED" | "IDEMPOTENCY_AUTH_REQUIRED" | "IDEMPOTENCY_STORAGE_FAILURE", message: string) { super(message); this.name = "IdempotencyError"; }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
export function canonicalPayloadHash(value: unknown): string {
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized, "utf8") > IDEMPOTENCY_PAYLOAD_MAX_BYTES) throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", "validated idempotency payload exceeds receipt limit");
  return createHash("sha256").update(serialized).digest("hex");
}
export function validateIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", `idempotency key must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  return value;
}
export function withoutIdempotencyTransportFields(payload: Record<string, unknown>): Record<string, unknown> { const { idempotencyKey: _key, confirm: _confirm, ...business } = payload; return business; }
function keyHash(key: string): string { return createHash("sha256").update(key).digest("hex"); }
type Row = { id: number; payload_hash: string; outcome_json: string | null; created_at: string; expires_at: string };

/**
 * The executor MUST use in-current-transaction core primitives. It is called
 * inside the same BEGIN IMMEDIATE as the immutable tombstone, outcome and
 * audit event. Actor and credential are evidence only; principal is scope.
 */
export function executeLocalIdempotentMutation<T>(db: Database, input: {
  key?: string; operation: keyof typeof RETRY_CLASS_BY_OPERATION; workspaceScope: string; companyScope: string;
  principal?: StablePrincipal; payload: Record<string, unknown>; actor: { createdBy: string; createdByProgram: string }; now?: Date; execute: () => T;
}): { result: T; receipt?: IdempotencyReceipt } {
  if (!input.key) return { result: input.execute() };
  if (RETRY_CLASS_BY_OPERATION[input.operation] !== "key-idempotent") throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", `operation ${input.operation} does not accept a client idempotency key`);
  if (!input.principal?.subjectId) throw new IdempotencyError("IDEMPOTENCY_AUTH_REQUIRED", "idempotency keys require an authenticated user or workspace service principal");
  const payloadHash = canonicalPayloadHash(input.payload); const now = input.now ?? new Date(); const createdAt = now.toISOString(); const expiresAt = new Date(now.getTime() + IDEMPOTENCY_RETENTION_DAYS * 86_400_000).toISOString();
  let rejectedAudit: { eventType: "idempotency_conflict" | "idempotency_outcome_expired"; entityId: number; message: string } | undefined;
  try {
    return db.transaction(() => {
    const prior = db.query(`SELECT id, payload_hash, outcome_json, created_at, expires_at FROM mutation_idempotency_tombstones WHERE client_key_hash = ? AND operation = ? AND workspace_scope = ? AND company_scope = ? AND principal_kind = ? AND principal_subject_id = ?`).get(keyHash(input.key!), input.operation, input.workspaceScope, input.companyScope, input.principal!.kind, input.principal!.subjectId) as Row | null;
    if (prior) {
      if (prior.payload_hash !== payloadHash) { rejectedAudit = { eventType: "idempotency_conflict", entityId: prior.id, message: `Rejected conflicting idempotency retry for ${input.operation}` }; throw new IdempotencyError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with a different validated payload"); }
      if (prior.outcome_json === null) { rejectedAudit = { eventType: "idempotency_outcome_expired", entityId: prior.id, message: `Idempotency outcome expired for ${input.operation}; key remains reserved` }; throw new IdempotencyError("IDEMPOTENCY_OUTCOME_EXPIRED", "idempotency outcome has expired; inspect canonical state and use a new key only for a new operation"); }
      insertAuditLog(db, { eventType: "idempotency_replay", entityType: "idempotency_receipt", entityId: prior.id, message: `Replayed durable idempotency outcome for ${input.operation}`, ...input.actor });
      return { result: JSON.parse(prior.outcome_json) as T, receipt: { replayed: true, receiptId: prior.id, createdAt: prior.created_at, expiresAt: prior.expires_at } };
    }
    const result = input.execute(); const outcome = JSON.stringify(result);
    if (Buffer.byteLength(outcome, "utf8") > IDEMPOTENCY_PAYLOAD_MAX_BYTES) throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", "mutation outcome exceeds receipt limit");
    const receiptId = Number(db.query(`INSERT INTO mutation_idempotency_tombstones (client_key_hash,operation,workspace_scope,company_scope,principal_kind,principal_subject_id,payload_hash,outcome_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(keyHash(input.key!), input.operation, input.workspaceScope, input.companyScope, input.principal!.kind, input.principal!.subjectId, payloadHash, outcome, createdAt, expiresAt).lastInsertRowid);
    insertAuditLog(db, { eventType: "idempotency_original", entityType: "idempotency_receipt", entityId: receiptId, message: `Recorded idempotent ${input.operation} outcome`, ...input.actor });
    return { result, receipt: { replayed: false, receiptId, createdAt, expiresAt } };
    }).immediate();
  } catch (error) {
    // The rejected mutation transaction must roll back, but the attempt itself
    // is security-relevant evidence. Append it in a separate transaction only
    // after the immutable receipt lookup has completed.
    if (rejectedAudit) insertAuditLog(db, { ...rejectedAudit, entityType: "idempotency_receipt", ...input.actor });
    throw error;
  }
}
/** Retention prunes response material only; a key tombstone is never deleted. */
export function pruneExpiredIdempotencyOutcomes(db: Database, now = new Date()): number {
  return db.query("UPDATE mutation_idempotency_tombstones SET outcome_json = NULL, outcome_pruned_at = ? WHERE outcome_json IS NOT NULL AND expires_at <= ?").run(now.toISOString(), now.toISOString()).changes;
}
