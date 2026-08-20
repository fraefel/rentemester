// Register the GLN supplied by a Digisense *test* license.  This is intentionally
// separate from the CVR registration flow: it must never create or alter local
// company/participant state.

import type { Database } from "bun:sqlite";
import { insertAuditLog } from "../actor";
import type { DigisenseClient, DigisenseNetwork, RegisterParticipantRequest } from "./digisense-client";
import { listDigisenseCompanies } from "./digisense-state";

const GENERIC_FAILURE = "Digisense test GLN registration failed";
const INTENT_MESSAGE = "Digisense test GLN registration requested";
const SUCCESS_MESSAGE = "Digisense test GLN registration completed";
const FAILURE_MESSAGE = "Digisense test GLN registration failed";

export type RegisterTestGlnResult =
  | { ok: true; registered: true }
  | { ok: false; errors: string[] };

/**
 * Registers the test GLN authorized by the license for exactly one already
 * registered local company.  Neither the GLN nor vendor response data is ever
 * persisted in audit output or returned to the caller.
 */
export async function registerDigisenseTestGln(
  db: Database,
  client: DigisenseClient,
  network: DigisenseNetwork = "nemhandel",
): Promise<RegisterTestGlnResult> {
  const companies = listDigisenseCompanies(db);
  if (companies.length !== 1) {
    return { ok: false, errors: ["Exactly one existing local Digisense company is required"] };
  }
  const companyKey = companies[0]!.companyKey.trim();
  if (!companyKey) return { ok: false, errors: ["Exactly one existing local Digisense company is required"] };

  const auth = await client.validateAuth();
  if (!auth.ok) return { ok: false, errors: [GENERIC_FAILURE] };

  const testGlnNumber = auth.data.testGlnNumber?.trim();
  if (!/^\d{13}$/.test(testGlnNumber)) {
    return { ok: false, errors: ["Digisense returned an invalid test GLN"] };
  }
  if (
    auth.data.companyKeyConstraint != null &&
    auth.data.companyKeyConstraint.trim() !== companyKey
  ) {
    return { ok: false, errors: ["Digisense test GLN is not authorized for the local company"] };
  }

  // Intentionally generic: audit records prove the action without retaining a
  // GLN, company key, license metadata, or any vendor-provided text/body.
  insertAuditLog(db, {
    eventType: "digisense_test_gln_registration_intended",
    entityType: "digisense_test_gln",
    message: INTENT_MESSAGE,
  });

  const request: RegisterParticipantRequest = {
    direction: "inbound",
    participantType: "GLN",
    participantId: testGlnNumber,
    companyKey,
    webhookUrl: null,
    documentProfiles: network === "peppol" ? "default-peppol" : "default-nemhandel",
  };
  const registered = await client.registerParticipant(network, request);
  if (!registered.ok || registered.data.registeredOnNetwork !== true) {
    insertAuditLog(db, {
      eventType: "digisense_test_gln_registration_failed",
      entityType: "digisense_test_gln",
      message: FAILURE_MESSAGE,
    });
    return { ok: false, errors: [GENERIC_FAILURE] };
  }

  insertAuditLog(db, {
    eventType: "digisense_test_gln_registration_succeeded",
    entityType: "digisense_test_gln",
    message: SUCCESS_MESSAGE,
  });
  return { ok: true, registered: true };
}
