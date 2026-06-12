// Tests: src/mcp/envelope.ts (AGENT-16)
//
// wrapCoreResult stamps a stable, machine-readable `code` on the most common
// cross-cutting business failures so an agent branches on `code` instead of
// pattern-matching the free-text errors[].
import { describe, expect, test } from "bun:test";
import { wrapCoreResult } from "../../src/mcp/envelope";

describe("envelope cross-cutting codes (AGENT-16)", () => {
  test("a closed-period rejection gets PERIOD_CLOSED", () => {
    const env = wrapCoreResult({
      ok: false,
      errors: [
        "transactionDate 2026-01-15 falls in closed period vat_quarter 2026-01-01..2026-03-31",
      ],
    });
    expect(env.ok).toBe(false);
    expect(env.code).toBe("PERIOD_CLOSED");
  });

  test("a reported-period rejection also gets PERIOD_CLOSED", () => {
    const env = wrapCoreResult({
      ok: false,
      errors: ["date 2026-02-01 falls in reported period fiscal_year 2026-01-01..2026-12-31"],
    });
    expect(env.code).toBe("PERIOD_CLOSED");
  });

  test("a lifecycle-precondition rejection gets PRECONDITION_MISSING", () => {
    const env = wrapCoreResult({
      ok: false,
      errors: [
        "Forudsætning ikke opfyldt: faktura 2026-0001 er udstedt men ikke bogført. Kald invoice_post først.",
      ],
    });
    expect(env.code).toBe("PRECONDITION_MISSING");
  });

  test("a missing-entity rejection gets NOT_FOUND", () => {
    const env = wrapCoreResult({
      ok: false,
      errors: ["invoice document 42 does not exist"],
    });
    expect(env.code).toBe("NOT_FOUND");
  });

  test("a Danish missing-entity rejection gets NOT_FOUND", () => {
    const env = wrapCoreResult({
      ok: false,
      errors: ["bilaget findes ikke i bogføringen"],
    });
    expect(env.code).toBe("NOT_FOUND");
  });

  test("an ordinary per-tool business error carries NO code", () => {
    const env = wrapCoreResult({
      ok: false,
      errors: ["grossAmount must be a positive number"],
    });
    expect(env.ok).toBe(false);
    expect(env.code).toBeUndefined();
  });

  test("a success result never carries a code", () => {
    const env = wrapCoreResult({ ok: true, errors: [], entryNo: "B-1" });
    expect(env.ok).toBe(true);
    expect(env.code).toBeUndefined();
    expect(env.data).toMatchObject({ entryNo: "B-1" });
  });
});
