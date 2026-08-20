// TEST-only registration of the exact supplier endpoint emitted by the
// Peppol BIS3 exporter (scheme 0184: bare 8-digit Danish CVR).

import type { Database } from "bun:sqlite";
import { insertAuditLog } from "../actor";
import type { DigisenseClient, RegisterParticipantRequest } from "./digisense-client";
import { listDigisenseCompanies, saveDigisenseParticipant } from "./digisense-state";

const GENERIC_FAILURE = "Digisense test sender registration failed";

export type RegisterTestSenderResult =
  | { ok: true; registered: true }
  | { ok: false; errors: string[] };

export async function registerDigisenseTestSender(
  db: Database,
  client: DigisenseClient,
): Promise<RegisterTestSenderResult> {
  const companies = listDigisenseCompanies(db);
  if (companies.length !== 1) {
    return { ok: false, errors: ["Exactly one existing local Digisense company is required"] };
  }
  const company = companies[0]!;
  const companyKey = company.companyKey.trim();
  const supplierEndpoint = company.participantId.replace(/^DK/, "");
  if (company.companyType !== "DK:CVR" || !/^\d{8}$/.test(supplierEndpoint) || !companyKey) {
    return { ok: false, errors: ["A Danish local Digisense company is required"] };
  }

  const auth = await client.validateAuth();
  if (!auth.ok) return { ok: false, errors: [GENERIC_FAILURE] };
  if (auth.data.companyKeyConstraint != null && auth.data.companyKeyConstraint.trim() !== companyKey) {
    return { ok: false, errors: ["Digisense test license is not authorized for the local company"] };
  }

  insertAuditLog(db, {
    eventType: "digisense_test_sender_registration_intended",
    entityType: "digisense_test_sender",
    message: "Digisense test sender registration requested",
  });

  const request: RegisterParticipantRequest = {
    direction: "outbound",
    participantType: "DK:CVR",
    participantId: supplierEndpoint,
    companyKey,
    webhookUrl: null,
    documentProfiles: "default-peppol",
  };
  const registered = await client.registerParticipant("peppol", request);
  if (!registered.ok || registered.data.registeredOnNetwork !== true) {
    insertAuditLog(db, {
      eventType: "digisense_test_sender_registration_failed",
      entityType: "digisense_test_sender",
      message: "Digisense test sender registration failed",
    });
    return { ok: false, errors: [GENERIC_FAILURE] };
  }

  saveDigisenseParticipant(db, {
    companyKey,
    network: "peppol",
    direction: "outbound",
    participantType: "DK:CVR",
    participantId: supplierEndpoint,
    webhookUrl: null,
    registeredOnNetwork: true,
    webhookRegistered: registered.data.webhookRegistered === true,
  });
  insertAuditLog(db, {
    eventType: "digisense_test_sender_registration_succeeded",
    entityType: "digisense_test_sender",
    message: "Digisense test sender registration completed",
  });
  return { ok: true, registered: true };
}
