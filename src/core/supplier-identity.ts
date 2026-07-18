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
  | { ok: true; status: "resolved"; country: string; identifier: string | null; identifierKind: SupplierIdentifierKind; euVatRegistered: boolean }
  | { ok: false; status: "human_resolution_required"; errors: string[] };

export type PersistedSupplierIdentity = {
  supplierCountryCode: string | null | undefined;
  supplierIdentifierKind: string | null | undefined;
  supplierIdentityStatus: string | null | undefined;
  supplierVatOrCvr: string | null | undefined;
};

const EU_COUNTRIES = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "GR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]);

export function resolveSupplierIdentity(input: SupplierIdentityInput): SupplierIdentityResolution {
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  const identifier = typeof input.identifier === "string" ? input.identifier.trim().toUpperCase().replace(/\s/g, "") : "";
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, status: "human_resolution_required", errors: ["supplier country must be an ISO 3166-1 alpha-2 code"] };
  if (!input.identifierKind) return { ok: false, status: "human_resolution_required", errors: ["supplier identity is ambiguous: country and typed identifier require human resolution"] };
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
    if (EU_COUNTRIES.has(country)) return { ok: false, status: "human_resolution_required", errors: ["non-EU identity requires a non-EU country"] };
    return { ok: true, status: "resolved", country, identifier: identifier || null, identifierKind: "non_eu", euVatRegistered: false };
  }
  return { ok: false, status: "human_resolution_required", errors: ["supplier identifier kind is unsupported"] };
}

/**
 * Compatibility bridge for documents predating typed supplier identity. Only
 * explicit DK/EU VAT syntax is evidence enough to migrate automatically;
 * arbitrary foreign-looking text deliberately remains unresolved.
 */
export function resolveLegacySupplierIdentity(identifier: string | null | undefined): SupplierIdentityResolution {
  const value = typeof identifier === "string" ? identifier.trim().toUpperCase().replace(/\s/g, "") : "";
  if (/^DK\d{8}$/.test(value)) return resolveSupplierIdentity({ country: "DK", identifier: value, identifierKind: "dk_cvr" });
  const country = value.slice(0, 2);
  if (EU_COUNTRIES.has(country) && country !== "DK" && /^[A-Z]{2}[A-Z0-9]{2,14}$/.test(value)) {
    return resolveSupplierIdentity({ country, identifier: value, identifierKind: "eu_vat" });
  }
  return { ok: false, status: "human_resolution_required", errors: ["supplier identity is ambiguous: explicit country and typed identifier require human resolution"] };
}

/**
 * Resolve the durable identity stored on a purchase document. New rows must
 * carry an explicit resolved country/kind pair; legacy rows may only be
 * upgraded when their VAT identifier is unambiguous. Keeping this decision in
 * one place prevents booking and exports from interpreting the same row
 * differently.
 */
export function resolvePersistedSupplierIdentity(input: PersistedSupplierIdentity): SupplierIdentityResolution {
  if (input.supplierIdentityStatus === "resolved") {
    const identifierKind = input.supplierIdentifierKind;
    if (identifierKind === "dk_cvr" || identifierKind === "eu_vat" || identifierKind === "non_eu") {
      return resolveSupplierIdentity({
        country: input.supplierCountryCode ?? "",
        identifier: input.supplierVatOrCvr ?? undefined,
        identifierKind,
      });
    }
    return { ok: false, status: "human_resolution_required", errors: ["persisted supplier identity has an unsupported identifier kind"] };
  }
  if (input.supplierIdentityStatus !== null && input.supplierIdentityStatus !== undefined) {
    return { ok: false, status: "human_resolution_required", errors: ["persisted supplier identity is explicitly unresolved"] };
  }
  if (input.supplierCountryCode || input.supplierIdentifierKind) {
    return { ok: false, status: "human_resolution_required", errors: ["persisted supplier identity is explicitly unresolved"] };
  }
  return resolveLegacySupplierIdentity(input.supplierVatOrCvr);
}

/**
 * Danish input VAT (`DK_PURCHASE_25`) may only be deducted from a supplier
 * invoice whose durable identity resolves to a Danish CVR. Foreign VAT must
 * never be relabelled as Danish købsmoms; callers can instead use the relevant
 * reverse-charge flow or book the gross cost as non-deductible.
 */
export function deductibleDanishPurchaseSupplierErrors(
  input: PersistedSupplierIdentity,
): string[] {
  const identity = resolvePersistedSupplierIdentity(input);
  if (!identity.ok) {
    return ["deductible Danish purchase VAT requires a resolved Danish supplier identity; use human resolution or non_deductible instead"];
  }
  if (identity.identifierKind !== "dk_cvr" || identity.country !== "DK") {
    return [`deductible Danish purchase VAT requires a Danish supplier CVR, but the document supplier is ${identity.identifierKind}/${identity.country}; use the applicable reverse-charge flow or non_deductible instead`];
  }
  return [];
}
