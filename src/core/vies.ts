import type { Database } from "bun:sqlite";
import { addDaysToTimestamp } from "./dates";

export type NormalizedEuVat = {
  countryCode: string;
  vatNumber: string;
  normalized: string;
};

export type ViesValidationRecord = NormalizedEuVat & {
  valid: boolean;
  name: string | null;
  address: string | null;
  validatedAt: string;
  expiresAt: string;
  rawResponse: string | null;
};

export type ValidateVatResult = {
  ok: boolean;
  validation?: ViesValidationRecord;
  appliedRules: string[];
  errors: string[];
};

const RULE_ID = "DK-VAT-REVERSE-CHARGE-001";
const DEFAULT_TTL_DAYS = 90;
export const OFFICIAL_EU_VIES_BASE_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";
/**
 * SEC-5 (Audit 2026-06-11): default timeout for the outgoing VIES request.
 * Without a bound a hung endpoint would block validation indefinitely; on
 * timeout the call returns a non-throwing error (the caller may fall back to a
 * cached validation via `requireCachedViesValidation`).
 */
const DEFAULT_VIES_TIMEOUT_MS = 12_000;

// EU member-state VAT country codes recognised by VIES. EU service reverse
// charge (momsloven §46) applies only to suppliers in *other* EU member
// states, so DK and non-EU codes (NO, CH, GB, ...) must be rejected here.
// EL is the VIES code for Greece.
const EU_VAT_COUNTRY_CODES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK",
]);

export function normalizeEuVatNumber(input?: string | null): NormalizedEuVat | null {
  const compact = input?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact || compact.length < 3) return null;
  const countryCode = compact.slice(0, 2);
  const vatNumber = compact.slice(2);
  if (!/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z0-9]{2,14}$/.test(vatNumber)) return null;
  // Domestic (DK) numbers are valid EU VAT numbers for VIES caching but must
  // not be treated as a foreign EU supplier — the reverse-charge path rejects
  // them explicitly below.
  if (!EU_VAT_COUNTRY_CODES.has(countryCode)) return null;
  return { countryCode, vatNumber, normalized: `${countryCode}${vatNumber}` };
}

export function lookupCachedViesValidation(db: Database, input?: string | null) {
  const parsed = normalizeEuVatNumber(input);
  if (!parsed) return null;
  const row = db.query(
    `SELECT country_code, vat_number, valid, name, address, validated_at, expires_at, raw_response
       FROM vies_validations
      WHERE country_code = ? AND vat_number = ?`
  ).get(parsed.countryCode, parsed.vatNumber) as {
    country_code: string;
    vat_number: string;
    valid: number;
    name: string | null;
    address: string | null;
    validated_at: string;
    expires_at: string;
    raw_response: string | null;
  } | null;
  if (!row) return null;
  return {
    countryCode: row.country_code,
    vatNumber: row.vat_number,
    normalized: `${row.country_code}${row.vat_number}`,
    valid: row.valid === 1,
    name: row.name,
    address: row.address,
    validatedAt: row.validated_at,
    expiresAt: row.expires_at,
    rawResponse: row.raw_response,
  } satisfies ViesValidationRecord;
}

export function storeViesValidation(db: Database, validation: {
  vatOrCvr?: string | null;
  countryCode?: string;
  vatNumber?: string;
  valid: boolean;
  name?: string | null;
  address?: string | null;
  validatedAt?: string;
  expiresAt?: string;
  rawResponse?: string | null;
}) {
  const parsed = validation.vatOrCvr ? normalizeEuVatNumber(validation.vatOrCvr) : (validation.countryCode && validation.vatNumber
    ? normalizeEuVatNumber(`${validation.countryCode}${validation.vatNumber}`)
    : null);
  if (!parsed) throw new Error("valid EU VAT number is required");
  const validatedAt = validation.validatedAt ?? new Date().toISOString();
  const expiresAt = validation.expiresAt ?? addDaysToTimestamp(validatedAt, DEFAULT_TTL_DAYS);
  db.query(
    `INSERT INTO vies_validations (country_code, vat_number, valid, name, address, validated_at, expires_at, raw_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(country_code, vat_number) DO UPDATE SET
       valid = excluded.valid,
       name = excluded.name,
       address = excluded.address,
       validated_at = excluded.validated_at,
       expires_at = excluded.expires_at,
       raw_response = excluded.raw_response`
  ).run(
    parsed.countryCode,
    parsed.vatNumber,
    validation.valid ? 1 : 0,
    validation.name ?? null,
    validation.address ?? null,
    validatedAt,
    expiresAt,
    validation.rawResponse ?? null,
  );
  return lookupCachedViesValidation(db, parsed.normalized)!;
}

function isExpired(expiresAt: string, asOfIso?: string) {
  const expires = new Date(expiresAt).getTime();
  const asOf = new Date(asOfIso ?? new Date().toISOString()).getTime();
  return Number.isFinite(expires) && Number.isFinite(asOf) ? expires < asOf : true;
}

export function requireCachedViesValidation(db: Database, vatOrCvr: string | null | undefined, label: string, asOfIso?: string): ValidateVatResult {
  const parsed = normalizeEuVatNumber(vatOrCvr);
  if (!parsed) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`${label} must be a plausible EU VAT number`] };
  }
  const cached = lookupCachedViesValidation(db, parsed.normalized);
  if (!cached) {
    return {
      ok: false,
      appliedRules: [RULE_ID],
      errors: [
        `VIES lookup not yet performed for ${label} (${parsed.normalized}) — ` +
          `validate the VAT number against VIES first ` +
          `(CLI: \`customer validate-vat\`; MCP: \`customer_validate_vat\`).`,
      ],
    };
  }
  if (!cached.valid) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`${label} ${parsed.normalized} is not a valid EU VAT number per cached VIES result from ${cached.validatedAt}`] };
  }
  if (isExpired(cached.expiresAt, asOfIso)) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`VIES validation for ${label} ${parsed.normalized} expired at ${cached.expiresAt} — re-run validation`] };
  }
  return { ok: true, validation: cached, appliedRules: [RULE_ID], errors: [] };
}

/**
 * Pick the first recognised validity field that is an explicit boolean.
 * Returns `undefined` when the response carries no unambiguous boolean
 * validity field (schema change, partial outage, error body) — the caller
 * must NOT treat such a response as authoritative.
 */
function extractValidity(json: unknown): boolean | undefined {
  if (!json || typeof json !== "object") return undefined;
  const body = json as { isValid?: unknown; valid?: unknown };
  const values = [body.isValid, body.valid].filter((candidate): candidate is boolean => typeof candidate === "boolean");
  // A response with two disagreeing booleans is not an authoritative answer.
  // Accepting either field preserves both the official REST payload and the
  // established local/test adapter contract without weakening fail-closed I/O.
  return values.length > 0 && values.every((value) => value === values[0]) ? values[0] : undefined;
}

type ParsedValidationResponse =
  | { ok: true; record: ViesValidationRecord }
  | { ok: false; error: string };

function availableIdentityText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed !== "---" ? trimmed : null;
}

function parseValidationResponse(json: any, parsed: NormalizedEuVat, validatedAt: string): ParsedValidationResponse {
  const valid = extractValidity(json);
  if (valid === undefined) {
    // "VIES could not answer" must be distinguishable from "VIES says
    // invalid" — refuse to cache an ambiguous body.
    return { ok: false, error: `VIES response for ${parsed.normalized} did not contain a recognised boolean validity field` };
  }
  const name = availableIdentityText(json?.name ?? json?.traderName ?? json?.result?.name);
  const address = availableIdentityText(json?.address ?? json?.traderAddress ?? json?.result?.address);
  return {
    ok: true,
    record: {
      ...parsed,
      valid,
      name,
      address,
      validatedAt,
      expiresAt: addDaysToTimestamp(validatedAt, DEFAULT_TTL_DAYS),
      rawResponse: JSON.stringify(json),
    },
  };
}

/** Injectable bounded adapter for the official EU VIES REST endpoint. */
export function createOfficialEuViesProvider(options: { fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string; clock?: () => Date } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIES_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? OFFICIAL_EU_VIES_BASE_URL).replace(/\/$/, "");
  return {
    async validate(input: NormalizedEuVat): Promise<{ status: "valid" | "invalid" | "inconclusive" | "unavailable"; name?: string | null; address?: string | null; rawResponse?: string | null }> {
      // Path components are validated again at the network boundary. This
      // avoids turning a malformed persisted identity into a request path.
      if (!/^[A-Z]{2}$/.test(input.countryCode) || !/^[A-Z0-9]{2,14}$/.test(input.vatNumber) || input.normalized !== `${input.countryCode}${input.vatNumber}` || !EU_VAT_COUNTRY_CODES.has(input.countryCode)) {
        return { status: "inconclusive", rawResponse: "invalid normalized VIES path parameters" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const requestedAt = (options.clock ?? (() => new Date()))().toISOString();
      try {
        const response = await fetchImpl(`${baseUrl}/ms/${encodeURIComponent(input.countryCode)}/vat/${encodeURIComponent(input.vatNumber)}`, { method: "GET", headers: { accept: "application/json" }, signal: controller.signal });
        let body: any;
        try { body = await response.json(); } catch { return { status: "inconclusive", rawResponse: JSON.stringify({ requestedAt, httpStatus: response.status, providerStatus: "malformed-json" }) }; }
        const rawResponse = JSON.stringify({ requestedAt, resultAt: (options.clock ?? (() => new Date()))().toISOString(), httpStatus: response.status, providerStatus: body?.userError ?? body?.status ?? null, response: body });
        if (!response.ok) return { status: "unavailable", rawResponse };
        const validity = extractValidity(body);
        // The official service can report `userError: VALID` alongside an
        // authoritative isValid boolean. Keep that provider status in the
        // raw evidence, but do not reject the actual validation result.
        const providerStatus = typeof body?.userError === "string" ? body.userError.trim() : "";
        if (validity === undefined || (providerStatus && providerStatus !== "VALID")) return { status: "inconclusive", rawResponse };
        return { status: validity ? "valid" : "invalid", name: availableIdentityText(body.name), address: availableIdentityText(body.address), rawResponse };
      } catch (error) {
        const timedOut = controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
        return { status: "unavailable", rawResponse: JSON.stringify({ requestedAt, resultAt: (options.clock ?? (() => new Date()))().toISOString(), providerStatus: timedOut ? "timeout" : "network-error" }) };
      } finally { clearTimeout(timer); }
    },
  };
}
/** Backwards-friendly spelling for callers that use a provider noun. */
export const officialEuViesProvider = createOfficialEuViesProvider;

export async function validateVatAgainstVies(db: Database, vatOrCvr: string, options: { endpoint?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<ValidateVatResult> {
  const parsed = normalizeEuVatNumber(vatOrCvr);
  if (!parsed) return { ok: false, appliedRules: [RULE_ID], errors: ["cvr must be a plausible EU VAT number"] };

  const provider = createOfficialEuViesProvider({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, baseUrl: options.endpoint ?? process.env.RENTEMESTER_VIES_ENDPOINT });
  const result = await provider.validate(parsed);
  if (result.status !== "valid" && result.status !== "invalid") return { ok: false, appliedRules: [RULE_ID], errors: [`VIES lookup ${result.status}`] };
  const stored = storeViesValidation(db, { ...parsed, valid: result.status === "valid", name: result.name, address: result.address, rawResponse: result.rawResponse });
  return { ok: true, validation: stored, appliedRules: [RULE_ID], errors: [] };
}
