import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { executeIdempotently, IdempotencyError, canonicalPayloadHash } from "../../src/core/idempotency";
import { migrate } from "../../src/core/db";

const input = (key: string, payload: Record<string, unknown>, execute: () => unknown) => ({
  key, operation: "mcp:synthetic_write", workspaceScope: "workspace-a", companyScope: "company-a", actorScope: "agent:test", payload, execute,
});

describe("durable mutation idempotency receipts", () => {
  test("canonicalizes object keys and replays the exact completed outcome once", async () => {
    const db = new Database(":memory:"); migrate(db);
    let calls = 0;
    const first = await executeIdempotently(db, input("key-1", { b: 2, a: 1 }, () => ({ ok: true, value: ++calls })));
    const replay = await executeIdempotently(db, input("key-1", { a: 1, b: 2 }, () => ({ ok: true, value: ++calls })));
    expect(canonicalPayloadHash({ a: 1, b: 2 })).toBe(canonicalPayloadHash({ b: 2, a: 1 }));
    expect(first.result).toEqual({ ok: true, value: 1 });
    expect(replay.result).toEqual(first.result);
    expect(replay.receipt?.replayed).toBe(true);
    expect(calls).toBe(1);
    db.close();
  });

  test("rejects conflicting, cross-actor and crash-boundary retries without re-executing", async () => {
    const db = new Database(":memory:"); migrate(db);
    await executeIdempotently(db, input("key-2", { amount: 10 }, () => ({ ok: false, errors: ["period closed"] })));
    const conflict = await executeIdempotently(db, input("key-2", { amount: 11 }, () => ({ ok: true }))).catch((error) => error);
    expect(conflict).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" } satisfies Partial<IdempotencyError>);
    const actorReplay = await executeIdempotently(db, { ...input("key-2", { amount: 10 }, () => ({ ok: true })), actorScope: "agent:other" });
    expect(actorReplay.receipt?.replayed).toBe(false);
    db.query("INSERT INTO mutation_idempotency_receipts (client_key,operation,workspace_scope,company_scope,actor_scope,payload_hash,state,created_at,expires_at) VALUES ('crash','mcp:synthetic_write','workspace-a','company-a','agent:test',?, 'reserved','2026-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z')").run(canonicalPayloadHash({ amount: 1 }));
    const crash = await executeIdempotently(db, input("crash", { amount: 1 }, () => ({ ok: true }))).catch((error) => error);
    expect(crash).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" } satisfies Partial<IdempotencyError>);
    db.close();
  });
});
