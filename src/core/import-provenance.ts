/**
 * Persisted marker for vouchers replayed by the verified historical-postings
 * adapter. The privilege is never accepted from a journal payload: the narrow
 * internal posting path stamps this value itself.
 */
export const HISTORICAL_IMPORT_PROGRAM = "rentemester-import-postings";

export function isPersistedHistoricalImportProgram(value: unknown): boolean {
  return value === HISTORICAL_IMPORT_PROGRAM;
}
