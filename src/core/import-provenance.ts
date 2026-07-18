/**
 * Runtime capability for a verified historical import. Its membership is held
 * in a module-private WeakSet, so JSON, CLI and MCP payloads cannot forge it.
 */
export type HistoricalImportProvenance = object;
const trusted = new WeakSet<object>();

export function createTrustedHistoricalImportProvenance(): HistoricalImportProvenance {
  const capability = Object.freeze({});
  trusted.add(capability);
  return capability;
}

export function isTrustedHistoricalImportProvenance(value: unknown): value is HistoricalImportProvenance {
  return typeof value === "object" && value !== null && trusted.has(value);
}
