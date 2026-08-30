// Tests: src/core/periods.ts closeAccountingPeriod — EJER-6 (server part).
//
// Closing a period whose end date is in the FUTURE means the period (often a
// whole fiscal year) is not over yet — postings can still legitimately arrive
// for those future days, and locking now would wrongly reject them. The close
// must refuse such a period unless the caller explicitly forces it (reusing the
// existing `force` bypass), so an accidental early year-end close is caught.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { closeAccountingPeriod } from "../helpers/close-period";
import { todayIsoDate, addDays } from "../../src/core/dates";

function freshDb(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

describe("close-period future guard (EJER-6)", () => {
  test("refuses to close a period that ends in the future", () => {
    const { root, db } = freshDb("rentemester-close-future-");
    const future = addDays(todayIsoDate(), 30);

    const result = closeAccountingPeriod(db, {
      periodStart: addDays(todayIsoDate(), -30),
      periodEnd: future,
      kind: "fiscal_year",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ").toLowerCase()).toMatch(/future|fremtid/);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("force:true closes a future-ending period anyway", () => {
    const { root, db } = freshDb("rentemester-close-future-force-");
    const future = addDays(todayIsoDate(), 30);

    const result = closeAccountingPeriod(db, {
      periodStart: addDays(todayIsoDate(), -30),
      periodEnd: future,
      kind: "fiscal_year",
      force: true,
    });
    expect(result.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a period that ended in the past closes normally without force", () => {
    const { root, db } = freshDb("rentemester-close-past-");
    const result = closeAccountingPeriod(db, {
      periodStart: "2025-01-01",
      periodEnd: "2025-03-31",
      kind: "vat_quarter",
    });
    expect(result.ok).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
