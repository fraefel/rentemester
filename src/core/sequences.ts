import type { Database } from "bun:sqlite";
import { getCompanySettings } from "./company";
import { todayIsoDate } from "./dates";
import { fiscalYearForDate } from "./fiscal-year";

export function companySequenceScope(db: Database, fiscalScope: string) {
  const company = getCompanySettings(db);
  const companyKey = company.cvr ?? `company-${company.id}`;
  return `${companyKey}:${fiscalScope}`;
}

export function nextSequenceValue(db: Database, kind: string, scope: string, currentFloor = 0) {
  const row = db.query(
    `INSERT INTO sequences (kind, scope, value)
     VALUES (?, ?, ?)
     ON CONFLICT(kind, scope) DO UPDATE SET value = CASE
       WHEN sequences.value + 1 < excluded.value THEN excluded.value
       ELSE sequences.value + 1
     END
     RETURNING value`
  ).get(kind, scope, currentFloor + 1) as { value: number };
  return Number(row.value);
}

export function currentSequenceValue(db: Database, kind: string, scope: string, currentFloor = 0) {
  const row = db.query(`SELECT value FROM sequences WHERE kind = ? AND scope = ?`).get(kind, scope) as { value: number } | null;
  return Math.max(Number(row?.value ?? 0), currentFloor);
}

export function reserveSequenceValue(db: Database, kind: string, scope: string, requestedValue: number, currentFloor = 0) {
  // KODE-10: immediate so the read of currentSequenceValue and the conditional
  // write below take the write lock up front, avoiding a SQLITE_BUSY_SNAPSHOT
  // when two issuers race to reserve the next number in the same scope.
  return db.transaction(() => {
    const currentValue = currentSequenceValue(db, kind, scope, currentFloor);
    const expectedValue = currentValue + 1;
    if (requestedValue !== expectedValue) {
      return { ok: false as const, expectedValue, currentValue };
    }
    db.query(
      `INSERT INTO sequences (kind, scope, value)
       VALUES (?, ?, ?)
       ON CONFLICT(kind, scope) DO UPDATE SET value = excluded.value`
    ).run(kind, scope, requestedValue);
    return { ok: true as const, expectedValue, currentValue };
  }, { immediate: true })();
}

export function fiscalYearLabelFromDate(db: Database, dateText: string) {
  const company = getCompanySettings(db);
  return fiscalYearForDate(dateText, company.fiscalYearStartMonth, company.fiscalYearLabelStrategy).identifierLabel;
}

/**
 * Today's date (YYYY-MM-DD) for ledger-side defaults (document dating,
 * retention as-of, GDPR as-of). Delegates to the ONE canonical clock in
 * `core/dates.ts`: the Danish calendar date, RENTEMESTER_TODAY-overridable
 * (KODE-11). The name is historical — it used to read SQLite's
 * CURRENT_TIMESTAMP, which is UTC and ignored the test override. The unused
 * `db` parameter is kept so existing call sites stay source-compatible.
 */
export function currentUtcIsoDate(_db: Database) {
  return todayIsoDate();
}
