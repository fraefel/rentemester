import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { executeLocalIdempotentMutation, IdempotencyError, canonicalPayloadHash, pruneExpiredIdempotencyOutcomes } from "../../src/core/idempotency";
import { migrate } from "../../src/core/db";

const actor = { createdBy: "agent:synthetic", createdByProgram: "test" };
const input = (key: string, payload: Record<string, unknown>, execute: () => unknown, principal = { kind: "service-account" as const, subjectId: "svc-a" }, now = new Date("2026-01-01T00:00:00.000Z")) =>
  ({ key, operation: "journal_post" as const, workspaceScope: "workspace-a", companyScope: "company-a", principal, payload, actor, execute, now });

describe("#583 local idempotency tombstones", () => {
  test("canonical payload replay is principal-scoped, not actor- or credential-scoped", () => {
    const db = new Database(":memory:"); migrate(db); let calls = 0;
    const first = executeLocalIdempotentMutation(db, input("key-1", { b: 2, a: 1 }, () => ({ ok: true, value: ++calls })));
    const replay = executeLocalIdempotentMutation(db, { ...input("key-1", { a: 1, b: 2 }, () => ({ ok: true, value: ++calls })), actor: { createdBy: "agent:rotated-token", createdByProgram: "other" } });
    expect(canonicalPayloadHash({ a: 1, b: 2 })).toBe(canonicalPayloadHash({ b: 2, a: 1 }));
    expect(replay.result).toEqual(first.result); expect(replay.receipt?.replayed).toBe(true); expect(calls).toBe(1);
    const separate = executeLocalIdempotentMutation(db, input("key-1", { a: 1, b: 2 }, () => ({ ok: true, value: ++calls }), { kind: "service-account", subjectId: "svc-b" }));
    expect(separate.receipt?.replayed).toBe(false); expect(calls).toBe(2); db.close();
  });
  test("conflict, unauthenticated key, rollback and expiry all fail closed", () => {
    const db = new Database(":memory:"); migrate(db);
    executeLocalIdempotentMutation(db, input("key-2", { amount: 10 }, () => ({ ok: true })));
    expect(() => executeLocalIdempotentMutation(db, input("key-2", { amount: 11 }, () => ({ ok: true })))).toThrow("idempotency key was already used");
    expect(() => executeLocalIdempotentMutation(db, { ...input("key-x", {}, () => ({ ok: true })), principal: undefined })).toThrow("authenticated user");
    const crash = () => { db.query("INSERT INTO accounts (account_no,name,type,normal_balance,active) VALUES ('9999','x','asset','debit',1)").run(); throw new Error("fault"); };
    expect(() => executeLocalIdempotentMutation(db, input("crash", {}, crash))).toThrow("fault");
    expect(db.query("SELECT COUNT(*) AS n FROM mutation_idempotency_tombstones WHERE operation = 'journal_post'").get()).toEqual({ n: 1 });
    pruneExpiredIdempotencyOutcomes(db, new Date("2026-02-01T00:00:00.000Z"));
    expect(() => executeLocalIdempotentMutation(db, { ...input("key-2", { amount: 10 }, () => ({ ok: true })), now: new Date("2026-02-01T00:00:00.000Z") })).toThrow("outcome has expired");
    expect(() => executeLocalIdempotentMutation(db, { ...input("key-2", { amount: 12 }, () => ({ ok: true })), now: new Date("2026-02-01T00:00:00.000Z") })).toThrow("different validated payload");
    db.close();
  });

  test("does not poison a key on business rejection and audits original, replay, conflict and expired outcomes", () => {
    const db = new Database(":memory:"); migrate(db); let effects = 0;
    expect(() => executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 1 }, () => {
      throw new Error("business precondition");
    }))).toThrow("business precondition");
    const accepted = executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 1 }, () => ({ ok: true, effect: ++effects })));
    expect(accepted.receipt?.replayed).toBe(false);
    executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 1 }, () => ({ ok: true, effect: ++effects })));
    expect(() => executeLocalIdempotentMutation(db, input("retryable-rejection", { amount: 2 }, () => ({ ok: true })))).toThrow(IdempotencyError);
    pruneExpiredIdempotencyOutcomes(db, new Date("2026-02-01T00:00:00.000Z"));
    expect(() => executeLocalIdempotentMutation(db, { ...input("retryable-rejection", { amount: 1 }, () => ({ ok: true })), now: new Date("2026-02-01T00:00:00.000Z") })).toThrow("outcome has expired");
    const events = (db.query("SELECT event_type FROM audit_log WHERE event_type LIKE 'idempotency_%' ORDER BY id").all() as Array<{ event_type: string }>).map((row) => row.event_type);
    expect(events).toEqual(["idempotency_original", "idempotency_replay", "idempotency_conflict", "idempotency_outcome_expired"]);
    expect(effects).toBe(1); db.close();
  });
});
