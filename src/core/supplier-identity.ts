/**
 * Supplier identity is deliberately typed.  A foreign-looking identifier is
 * not evidence of EU VAT registration and must never silently turn a purchase
 * into an intra-EU/reverse-charge transaction.
 */
export type SupplierIdentifierKind = "dk_cvr" | "eu_vat" | "non_eu";
export type SupplierIdentityInput = {
  country: string;
  identifier?: string;
  identifierKind?: SupplierIdentifierKind;
};
export type SupplierIdentityResolution =
  | { ok: true; status: "resolved"; country: string; identifier: string; identifierKind: SupplierIdentifierKind; euVatRegistered: boolean }
  | { ok: false; status: "human_resolution_required"; errors: string[] };

const EU_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "GR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]);

export function resolveSupplierIdentity(input: SupplierIdentityInput): SupplierIdentityResolution {
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  const identifier = typeof input.identifier === "string" ? input.identifier.trim().toUpperCase().replace(/\s/g, "") : "";
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, status: "human_resolution_required", errors: ["supplier country must be an ISO 3166-1 alpha-2 code"] };
  if (!identifier || !input.identifierKind) return { ok: false, status: "human_resolution_required", errors: ["supplier identity is ambiguous: country and typed identifier require human resolution"] };
  if (input.identifierKind === "dk_cvr") {
    const digits = identifier.replace(/^DK/, "");
    if (country !== "DK" || !/^\d{8}$/.test(digits)) return { ok: false, status: "human_resolution_required", errors: ["Danish CVR identity requires country DK and exactly 8 digits"] };
    return { ok: true, status: "resolved", country, identifier: `DK${digits}`, identifierKind: "dk_cvr", euVatRegistered: true };
  }
  if (input.identifierKind === "eu_vat") {
    if (!EU_COUNTRIES.has(country) || country === "DK" || !identifier.startsWith(country) || !/^[A-Z]{2}[A-Z0-9]{2,14}$/.test(identifier)) return { ok: false, status: "human_resolution_required", errors: ["EU VAT identity requires a non-Danish EU country and a matching VAT identifier"] };
    return { ok: true, status: "resolved", country, identifier, identifierKind: "eu_vat", euVatRegistered: true };
  }
  if (input.identifierKind === "non_eu") {
    if (EU_COUNTRIES.has(country) || identifier.length < 2) return { ok: false, status: "human_resolution_required", errors: ["non-EU identifier requires a non-EU country and non-empty identifier"] };
    return { ok: true, status: "resolved", country, identifier, identifierKind: "non_eu", euVatRegistered: false };
  }
  return { ok: false, status: "human_resolution_required", errors: ["supplier identifier kind is unsupported"] };
}
