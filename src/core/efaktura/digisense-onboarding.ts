import type { Database } from "bun:sqlite";
import type { DigisenseClient } from "./digisense-client";
import { loadDigisenseSecretConfig } from "./digisense-config";
import { resolveDigisenseIdentity, resolveBoundDigisenseCompanyKey } from "./digisense-identity";
import { listDigisenseParticipants } from "./digisense-state";
import { registerDigisenseCompany } from "./digisense-register";
import type { ResolveActorInput } from "../actor";

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
  // Readiness is a complete routing pair for the ledger identity on ONE
  // network. A stale GLN, another CVR, or directions split across networks is
  // not a send/receive-ready company.
  const matching = identity.ok
    ? participants.filter((p) => p.participantType === "DK:CVR" && p.participantId === identity.value.cvr && p.registeredOnNetwork)
    : [];
  const readyNetwork = ["nemhandel", "peppol"].find((network) =>
    matching.some((p) => p.network === network && p.direction === "inbound") &&
    matching.some((p) => p.network === network && p.direction === "outbound"),
  );
  const inboundReady = Boolean(readyNetwork);
  const outboundReady = Boolean(readyNetwork);
  if (key?.ok && !inboundReady) blockers.push("Inbound participant is not registered.");
  if (key?.ok && !outboundReady) blockers.push("Outbound participant is not registered.");
  return { configured: Boolean(config), environment: config?.environment ?? null, identity: identity.ok ? identity.value : null, companyKeyConfigured: Boolean(key?.ok), inboundReady, outboundReady, ready: blockers.length === 0, blockers };
}

/** Idempotently validates authorization then makes the current profile send+receive ready. */
export async function onboardDigisenseCompany(
  db: Database, companyRoot: string, client: DigisenseClient, actor?: ResolveActorInput,
): Promise<{ ok: true; status: DigisenseOnboardingStatus; companyKey: string } | { ok: false; errors: string[]; status: DigisenseOnboardingStatus }> {
  const before = getDigisenseOnboardingStatus(db, companyRoot);
  if (!before.identity) return { ok: false, errors: before.blockers, status: before };
  const auth = await client.validateAuth();
  if (!auth.ok) return { ok: false, errors: [`validate-auth failed: ${auth.error.message}`], status: before };
  const result = await registerDigisenseCompany(db, companyRoot, client, {
    companyType: { type: "DK:CVR", id: before.identity.cvr }, companyName: before.identity.companyName,
    actor,
  });
  const status = getDigisenseOnboardingStatus(db, companyRoot);
  return result.ok ? { ok: true, status, companyKey: result.companyKey } : { ok: false, errors: result.errors, status };
}
