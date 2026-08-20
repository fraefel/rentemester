/** Local legal-entity boundary for DigiSense.
 *
 * A ledger is a single legal company.  DigiSense credentials may be shared,
 * but a companyKey must never cross that ledger boundary.
 */
import type { Database } from "bun:sqlite";
import { getCompanySettings, normalizeCvr } from "../company";
import { getDigisenseCompanyByParticipantId, listDigisenseCompanies } from "./digisense-state";

export type DigisenseIdentity = { cvr: string; companyName: string };

export function resolveDigisenseIdentity(db: Database): { ok: true; value: DigisenseIdentity } | { ok: false; errors: string[] } {
  const profile = getCompanySettings(db);
  const name = profile.name?.trim();
  if (!profile.cvr || !name || name === "Rentemester company") {
    return { ok: false, errors: ["DigiSense requires the ledger's company profile to contain both CVR and legal company name before any network operation."] };
  }
  return { ok: true, value: { cvr: profile.cvr, companyName: name } };
}

/** Validates caller supplied registration data against the sole ledger profile. */
export function validateDigisenseRegistrationIdentity(
  db: Database,
  input: { cvr: string; companyName: string },
): { ok: true; value: DigisenseIdentity } | { ok: false; errors: string[] } {
  const identity = resolveDigisenseIdentity(db);
  if (!identity.ok) return identity;
  let cvr: string | null;
  try { cvr = normalizeCvr(input.cvr); } catch { return { ok: false, errors: ["Registration CVR must be a valid Danish CVR."] }; }
  if (cvr !== identity.value.cvr || input.companyName.trim() !== identity.value.companyName) {
    return { ok: false, errors: ["Registration identity does not match this ledger's company profile. Update the profile or omit caller-supplied identity."] };
  }
  return identity;
}

/** Resolves a key only when it belongs to this ledger's profile CVR. */
export function resolveBoundDigisenseCompanyKey(
  db: Database,
  explicit?: string,
): { ok: true; value: string } | { ok: false; errors: string[] } {
  const identity = resolveDigisenseIdentity(db);
  if (!identity.ok) return identity;
  const own = getDigisenseCompanyByParticipantId(db, identity.value.cvr);
  const key = explicit?.trim();
  if (key) {
    if (!own || own.companyKey !== key) return { ok: false, errors: ["The supplied DigiSense companyKey is not bound to this ledger's profile CVR."] };
    return { ok: true, value: key };
  }
  if (own) return { ok: true, value: own.companyKey };
  const count = listDigisenseCompanies(db).length;
  return { ok: false, errors: [count ? "DigiSense company state belongs to a different legal company; registration is required for this profile CVR." : "No DigiSense company is registered for this ledger's profile CVR." ] };
}
