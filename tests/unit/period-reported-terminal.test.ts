// Tests: src/core/periods.ts effectivePeriodState — KODE-9.
//
// A `reported` period has been submitted to the authority (SKAT /
// Erhvervsstyrelsen). reopenAccountingPeriod already refuses to reopen it, but
// the lifecycle replay in effectivePeriodState used to honour ANY later
// `period_reopen` audit event — so a raw `audit_log` INSERT of a `period_reopen`
// fact after a `period_report` could effectively reopen a reported period and
// let new postings land in it. `reported` must be TERMINAL in the replay:
// once a period has been reported, later reopen events are ignored.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import {
  closeAccountingPeriod,
  effectivePeriodState,
  validateJournalTransactionDate,
} from "../../src/core/periods";

function freshDb(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

describe("reported period is terminal in lifecycle replay (KODE-9)", () => {
  test("a raw period_reopen audit insert after a report cannot reopen the period", () => {
    const { root, db } = freshDb("rentemester-reported-terminal-");

    const reported = closeAccountingPeriod(db, {
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      kind: "vat_quarter",
      status: "reported",
      createdBy: "user:ejer",
    });
    expect(reported.ok).toBe(true);
    const periodId = reported.periodId!;

    // Effective state is reported, and a posting inside the period is blocked.
    expect(effectivePeriodState(db, periodId, "reported")).toBe("reported");
    expect(validateJournalTransactionDate(db, "2026-02-15")).toEqual([
      "transactionDate 2026-02-15 falls in reported period vat_period 2026-01-01..2026-03-31",
    ]);

    // An attacker / corrupted client injects a raw reopen fact AFTER the report
    // directly into the append-only audit_log (bypassing reopenAccountingPeriod,
    // which already refuses reported periods).
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES (?, ?, ?, ?, ?)",
      "period_reopen",
      "accounting_period",
      String(periodId),
      "Reopened vat_quarter 2026-01-01..2026-03-31 — reason: smuggled",
      "user:attacker via raw-sql",
    );

    // The replay must treat `reported` as terminal: the later reopen is ignored,
    // the period stays reported and the posting stays blocked.
    expect(effectivePeriodState(db, periodId, "reported")).toBe("reported");
    expect(validateJournalTransactionDate(db, "2026-02-15")).toEqual([
      "transactionDate 2026-02-15 falls in reported period vat_period 2026-01-01..2026-03-31",
    ]);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a close -> reopen -> report sequence stays terminal against a trailing reopen", () => {
    const { root, db } = freshDb("rentemester-reported-terminal-2-");

    const closed = closeAccountingPeriod(db, {
      periodStart: "2026-04-01",
      periodEnd: "2026-06-30",
      kind: "vat_quarter",
      // Period ends in the future relative to the harness clock — force past the
      // EJER-6 guard; this test is about the reported-terminal replay (KODE-9).
      force: true,
    });
    const periodId = closed.periodId!;

    // Legitimate reopen, then a fresh report event (e.g. corrected + submitted).
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES (?, ?, ?, ?, ?)",
      "period_reopen",
      "accounting_period",
      String(periodId),
      "Reopened",
      "user:ejer",
    );
    expect(effectivePeriodState(db, periodId, "closed")).toBe("open");
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES (?, ?, ?, ?, ?)",
      "period_report",
      "accounting_period",
      String(periodId),
      "Reported",
      "user:ejer",
    );
    expect(effectivePeriodState(db, periodId, "closed")).toBe("reported");

    // Trailing reopen after the report must be ignored.
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES (?, ?, ?, ?, ?)",
      "period_reopen",
      "accounting_period",
      String(periodId),
      "Reopened again",
      "user:attacker",
    );
    expect(effectivePeriodState(db, periodId, "closed")).toBe("reported");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an audit-only legacy report permits one attributable receipt backfill", () => {
    const { root, db } = freshDb("rentemester-reported-reference-backfill-");
    const closed = closeAccountingPeriod(db, {
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      kind: "vat_period",
      createdBy: "user:ejer",
    });
    expect(closed.ok).toBe(true);
    const periodId = closed.periodId!;
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES (?, ?, ?, ?, ?)",
      "period_reopen",
      "accounting_period",
      String(periodId),
      "Legacy reopen",
      "user:ejer",
    );
    db.run(
      "INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor) VALUES (?, ?, ?, ?, ?)",
      "period_report",
      "accounting_period",
      String(periodId),
      "Legacy report without structured receipt",
      "user:ejer",
    );
    expect(effectivePeriodState(db, periodId, "closed")).toBe("reported");
    expect(
      db.query("SELECT status, reference FROM accounting_periods WHERE id = ?").get(periodId),
    ).toEqual({ status: "closed", reference: null });

    const backfilled = closeAccountingPeriod(db, {
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      kind: "vat_period",
      status: "reported",
      reference: "SKAT-OLD",
      createdBy: "user:ejer",
      createdByProgram: "legacy-recovery",
    });
    expect(backfilled.ok).toBe(true);
    expect(backfilled.reference).toBe("SKAT-OLD");
    expect(
      db.query("SELECT status, reference FROM accounting_periods WHERE id = ?").get(periodId),
    ).toEqual({ status: "reported", reference: "SKAT-OLD" });
    expect(
      db.query(
        "SELECT actor, event_type FROM audit_log WHERE event_type = 'period_report_reference_backfill' ORDER BY id DESC LIMIT 1",
      ).get(),
    ).toEqual({
      actor: "user:ejer via legacy-recovery",
      event_type: "period_report_reference_backfill",
    });
    expect(
      closeAccountingPeriod(db, {
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        kind: "vat_period",
        status: "reported",
        reference: "SKAT-OLD",
      }).ok,
    ).toBe(true);
    expect(
      closeAccountingPeriod(db, {
        periodStart: "2026-01-01",
        periodEnd: "2026-03-31",
        kind: "vat_period",
        status: "reported",
        reference: "SKAT-DIFFERENT",
      }).ok,
    ).toBe(false);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
