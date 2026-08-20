import type { Database } from "bun:sqlite";
import type { DigisenseClient } from "./digisense-client";
import { loadDigisenseSecretConfig } from "./digisense-config";
import { resolveDigisenseIdentity, resolveBoundDigisenseCompanyKey } from "./digisense-identity";
import { listDigisenseParticipants } from "./digisense-state";
import { registerDigisenseCompany } from "./digisense-register";

export type DigisenseOnboardingStatus = {
  configured: boolean;
  environment: "test" | "production" | null;
  identity: { cvr: string; companyName: string } | null;
  companyKeyConfigured: boolean;
  inboundReady: boolean;
  outboundReady: boolean;
  ready: boolean;
  blockers: string[];
};

/** Local-only status; deliberately contains no license key or validate-auth secret. */
export function getDigisenseOnboardingStatus(db: Database, companyRoot: string): DigisenseOnboardingStatus {
  const config = loadDigisenseSecretConfig(companyRoot);
  const identity = resolveDigisenseIdentity(db);
  const blockers: string[] = [];
  if (!config) blockers.push("Digisense API credentials are not configured.");
  if (!identity.ok) blockers.push(...identity.errors);
  const key = identity.ok ? resolveBoundDigisenseCompanyKey(db) : null;
  if (identity.ok && (!key || !key.ok)) blockers.push(...(key?.ok === false ? key.errors : []));
  const participants = key?.ok ? listDigisenseParticipants(db, key.value) : [];
  const inboundReady = participants.some((p) => p.direction === "inbound" && p.registeredOnNetwork);
  const outboundReady = participants.some((p) => p.direction === "outbound" && p.registeredOnNetwork);
  if (key?.ok && !inboundReady) blockers.push("Inbound participant is not registered.");
  if (key?.ok && !outboundReady) blockers.push("Outbound participant is not registered.");
  return { configured: Boolean(config), environment: config?.environment ?? null, identity: identity.ok ? identity.value : null, companyKeyConfigured: Boolean(key?.ok), inboundReady, outboundReady, ready: blockers.length === 0, blockers };
}

/** Idempotently validates authorization then makes the current profile send+receive ready. */
export async function onboardDigisenseCompany(
  db: Database, companyRoot: string, client: DigisenseClient,
): Promise<{ ok: true; status: DigisenseOnboardingStatus; companyKey: string } | { ok: false; errors: string[]; status: DigisenseOnboardingStatus }> {
  const before = getDigisenseOnboardingStatus(db, companyRoot);
  if (!before.identity) return { ok: false, errors: before.blockers, status: before };
  const auth = await client.validateAuth();
  if (!auth.ok) return { ok: false, errors: [`validate-auth failed: ${auth.error.message}`], status: before };
  const result = await registerDigisenseCompany(db, companyRoot, client, {
    companyType: { type: "DK:CVR", id: before.identity.cvr }, companyName: before.identity.companyName,
  });
  const status = getDigisenseOnboardingStatus(db, companyRoot);
  return result.ok ? { ok: true, status, companyKey: result.companyKey } : { ok: false, errors: result.errors, status };
}
