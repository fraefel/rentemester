/**
 * Durable transport-neutral mutation receipts (#583).
 *
 * A receipt is reserved before the business executor runs.  A process crash
 * therefore fails closed (`IDEMPOTENCY_IN_PROGRESS`) rather than silently
 * running a second mutation.  This module deliberately never retries a
 * failed storage operation: callers must surface that failure and let the
 * client decide whether it is safe to retry the request.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const IDEMPOTENCY_PAYLOAD_MAX_BYTES = 65_536;
export const IDEMPOTENCY_RETENTION_DAYS = 30;

export type IdempotencyReceipt = {
  replayed: boolean;
  receiptId: number;
  createdAt: string;
  expiresAt: string;
};

export class IdempotencyError extends Error {
  constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "IDEMPOTENCY_IN_PROGRESS" | "IDEMPOTENCY_STORAGE_FAILURE", message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

export function canonicalPayloadHash(value: unknown): string {
  const serialized = canonical(value);
  if (Buffer.byteLength(serialized, "utf8") > IDEMPOTENCY_PAYLOAD_MAX_BYTES) {
    throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", "validated idempotency payload exceeds receipt limit");
  }
  return createHash("sha256").update(serialized).digest("hex");
}

export function validateIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", `idempotency key must be a non-empty string of at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
  }
  return value;
}

/** Confirmation and the key authenticate transport intent, not business intent. */
export function withoutIdempotencyTransportFields(payload: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey: _key, confirm: _confirm, ...businessPayload } = payload;
  return businessPayload;
}

type ReceiptRow = { id: number; payload_hash: string; outcome_json: string | null; created_at: string; expires_at: string };

export async function executeIdempotently<T>(
  db: Database,
  input: { key?: string; operation: string; workspaceScope: string; companyScope: string | null; actorScope: string; payload: Record<string, unknown>; execute: () => Promise<T> | T },
): Promise<{ result: T; receipt?: IdempotencyReceipt }> {
  if (!input.key) return { result: await input.execute() };
  const key = input.key;
  const payloadHash = canonicalPayloadHash(input.payload);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + IDEMPOTENCY_RETENTION_DAYS * 86_400_000).toISOString();
  let receiptId = 0;
  let existing: ReceiptRow | null = null;
  try {
    db.transaction(() => {
      db.query("DELETE FROM mutation_idempotency_receipts WHERE expires_at <= ?").run(createdAt);
      existing = db.query(`SELECT id, payload_hash, outcome_json, created_at, expires_at
        FROM mutation_idempotency_receipts WHERE client_key = ? AND operation = ? AND workspace_scope = ?
          AND company_scope IS ? AND actor_scope = ? LIMIT 1`).get(
        key, input.operation, input.workspaceScope, input.companyScope, input.actorScope,
      ) as ReceiptRow | null;
      if (existing) return;
      receiptId = Number(db.query(`INSERT INTO mutation_idempotency_receipts
        (client_key, operation, workspace_scope, company_scope, actor_scope, payload_hash, state, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(
        key, input.operation, input.workspaceScope, input.companyScope, input.actorScope, payloadHash, createdAt, expiresAt,
      ).lastInsertRowid);
    }).immediate();
  } catch (error) {
    throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", "could not reserve idempotency receipt");
  }
  const prior = existing as ReceiptRow | null;
  if (prior) {
    if (prior.payload_hash !== payloadHash) throw new IdempotencyError("IDEMPOTENCY_CONFLICT", "idempotency key was already used with a different validated payload");
    if (prior.outcome_json === null) throw new IdempotencyError("IDEMPOTENCY_IN_PROGRESS", "idempotency receipt is reserved; inspect canonical state before retrying");
    return { result: JSON.parse(prior.outcome_json) as T, receipt: { replayed: true, receiptId: prior.id, createdAt: prior.created_at, expiresAt: prior.expires_at } };
  }
  let result: T;
  try {
    result = await input.execute();
  } catch (error) {
    // Keep the reservation: after an unknown crash boundary, repeating the
    // executor could duplicate a journal entry or an external side effect.
    throw error;
  }
  try {
    db.query("UPDATE mutation_idempotency_receipts SET state = 'completed', outcome_json = ?, completed_at = ? WHERE id = ? AND state = 'reserved'")
      .run(JSON.stringify(result), new Date().toISOString(), receiptId);
  } catch {
    throw new IdempotencyError("IDEMPOTENCY_STORAGE_FAILURE", "mutation outcome could not be durably receipted");
  }
  return { result, receipt: { replayed: false, receiptId, createdAt, expiresAt } };
}
