/**
 * Audit 2026-06-11 SEC-5: outgoing network calls (CVR distribution API, VIES)
 * had NO timeout — a hung TCP connection or a server that accepts but never
 * responds would block the lookup (and any caller awaiting it) indefinitely.
 *
 * Each network call now passes an `AbortSignal.timeout(...)`. These tests
 * inject a `fetchImpl` that honours the abort signal and never resolves on its
 * own, then assert the call aborts quickly and degrades to the documented
 * non-throwing error / cache-fallback path instead of hanging.
 */

import { describe, expect, test } from "bun:test";
import { openDb, migrate } from "../../src/core/db";
import { lookupCvrCompany } from "../../src/core/cvr";
import { validateVatAgainstVies } from "../../src/core/vies";

function memoryDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

/**
 * A fetch that resolves only when its abort signal fires — modelling a server
 * that accepts the connection but never answers. Rejects with the same
 * AbortError shape the platform `fetch` produces on timeout.
 */
const hangingFetch: typeof fetch = ((_url: any, init?: any) =>
  new Promise((_resolve, reject) => {
    const signal: AbortSignal | undefined = init?.signal;
    if (!signal) {
      // If no signal was passed the call would hang forever — fail loudly so
      // the test surfaces a missing timeout rather than itself hanging.
      reject(new Error("TEST-NO-ABORT-SIGNAL-PASSED"));
      return;
    }
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  })) as typeof fetch;

describe("SEC-5: CVR lookup times out instead of hanging", () => {
  test("a hung CVR endpoint aborts and returns a non-throwing error", async () => {
    const db = memoryDb();
    const started = Date.now();
    const result = await lookupCvrCompany(db, "12345678", {
      fetchImpl: hangingFetch,
      username: "u",
      password: "p",
      timeoutMs: 30,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("SEC-5: VIES validation times out instead of hanging", () => {
  test("a hung VIES endpoint aborts and returns a non-throwing error", async () => {
    const db = memoryDb();
    const started = Date.now();
    const result = await validateVatAgainstVies(db, "DE123456789", {
      fetchImpl: hangingFetch,
      timeoutMs: 30,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });
});
