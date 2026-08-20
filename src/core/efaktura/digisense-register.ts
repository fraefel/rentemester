// Digisense REGISTRÉR-sti (#efaktura) — registrér en virksomhed i NemHandel.
//
// Flow (én sammenhængende registrering for ét CVR):
//   1. register-company (DK:CVR/NIP) hos Digisense ⇒ companyKey. Gem companyKey
//      i state-laget (digisense_companies), keyed på participant-id, så en
//      genregistrering opdaterer i stedet for at duplikere.
//   2. register-participant/nemhandel for BÅDE direction:"outbound" OG
//      direction:"inbound" — så virksomheden kan både SENDE og MODTAGE. Hvert
//      udfald gemmes i state-laget (digisense_participants), keyed på
//      (companyKey, network, direction).
//   3. Skriv et audit_log.
//
// webhookUrl=null ⇒ ingen webhook; vi poller selv (bekræftet designvalg, ingen
// always-on server) — samme valg som MODTAG-stien i digisense-receive.ts.
//
// Idempotens: gentaget kald med samme CVR må hverken duplikere state eller fejle
// hårdt. Digisense' register-endpoints er selv idempotente (en re-registrering
// returnerer companyKey'en / registeredOnNetwork uden hård fejl), og state-laget
// upserter på sine unikke nøgler — så et re-run er en no-op på data-niveau.
//
// Determinisme/injektion: DigisenseClient injiceres (samme trust-boundary og
// injection-mønster som PeppolTransmitter i public-einvoice.ts og MODTAG-stien).
// Den rigtige klient wires i CLI/MCP via digisense-wiring.ts; unit-tests
// injicerer en fake og rører aldrig netværket. license-key lever i klientens
// config (secret-laget), aldrig her.

import type { Database } from "bun:sqlite";
import { insertAuditLog } from "../actor";
import type {
  DigisenseClient,
  DigisenseCompanyType,
  DigisenseNetwork,
  ParticipantDirection,
  ParticipantType,
  RegisterParticipantRequest,
} from "./digisense-client";
import {
  getDigisenseCompanyByParticipantId,
  saveDigisenseCompany,
  saveDigisenseParticipant,
} from "./digisense-state";

// Begge retninger registreres altid: en virksomhed der registreres skal kunne
// både sende (outbound) og modtage (inbound).
const DIRECTIONS: ParticipantDirection[] = ["outbound", "inbound"];

// Vi poller selv (ingen always-on server), så vi registrerer aldrig en webhook.
const NO_WEBHOOK = null;
function defaultDocumentProfiles(network: DigisenseNetwork): "default-nemhandel" | "default-peppol" {
  return network === "peppol" ? "default-peppol" : "default-nemhandel";
}

export type RegisterDigisenseCompanyOptions = {
  /** CVR/NIP-identifikatoren der registreres som virksomhed hos Digisense. */
  companyType: DigisenseCompanyType;
  /** Virksomhedsnavnet der sendes med register-company. */
  companyName: string;
  /**
   * Netværket participant-registreringen sker på. Standard "nemhandel" (det
   * danske offentlige netværk); "peppol" understøttes for fremtidig brug.
   */
  network?: DigisenseNetwork;
  /**
   * participant-typen for SMP-registreringen. Standard "DK:CVR" (samme værdi som
   * companyType for en dansk virksomhed); "GLN" understøttes for EAN-baserede
   * parter.
   */
  participantType?: ParticipantType;
  /**
   * participant-id'en der registreres på netværket. Standard companyType.id, så
   * en dansk virksomhed registreres på sit eget CVR.
   */
  participantId?: string;
};

export type RegisterDigisenseCompanyResult =
  | {
      ok: true;
      /** companyKey fra register-company — scoper alle efterfølgende kald. */
      companyKey: string;
      /** Retningerne der blev registreret (normalt outbound + inbound). */
      directionsRegistered: ParticipantDirection[];
      network: DigisenseNetwork;
      participantType: ParticipantType;
      participantId: string;
    }
  | { ok: false; errors: string[] };

/**
 * Registrér en virksomhed i NemHandel via Digisense: register-company ⇒ gem
 * companyKey ⇒ register-participant for outbound + inbound ⇒ audit_log.
 *
 * Kaster aldrig: transport-/API-fejl mappes til `errors` og et `ok:false`
 * resultat, så CLI/MCP kan vise en pæn envelope. Idempotent: et re-run med
 * samme CVR duplikerer ikke state.
 */
export async function registerDigisenseCompany(
  db: Database,
  companyRoot: string,
  client: DigisenseClient,
  options: RegisterDigisenseCompanyOptions,
): Promise<RegisterDigisenseCompanyResult> {
  const companyName = options.companyName?.trim();
  if (!companyName) {
    return { ok: false, errors: ["companyName is required to register a company"] };
  }
  const participantId = (options.participantId ?? options.companyType.id)?.trim();
  if (!participantId) {
    return { ok: false, errors: ["participantId is required to register a participant"] };
  }
  const network = options.network ?? "nemhandel";
  const participantType: ParticipantType = options.participantType ?? "DK:CVR";

  // 1) Genbrug en allerede auditeret lokal companyKey for samme juridiske
  // identitet. DigiSense returnerer 409 ved gentaget register-company, så den
  // lokale state er den idempotente genvej til at tilføje et nyt netværk.
  const existingCompany = getDigisenseCompanyByParticipantId(db, options.companyType.id);
  if (existingCompany && existingCompany.companyType !== options.companyType.type) {
    return { ok: false, errors: ["Existing Digisense company type does not match registration request"] };
  }
  let companyKey = existingCompany?.companyKey.trim() ?? "";
  if (!companyKey) {
    const registered = await client.registerCompany({
      companyType: options.companyType,
      companyName,
    });
    if (!registered.ok) {
      return {
        ok: false,
        errors: [`register-company failed: ${registered.error.message}`],
      };
    }
    companyKey = registered.data.companyKey?.trim() ?? "";
  }
  if (!companyKey) {
    return { ok: false, errors: ["register-company returned no companyKey"] };
  }

  // 2) Gem companyKey FØR participant-registreringen, så et delvist udfald (én
  // retning lykkes, den anden fejler) stadig kan retries på et re-run uden at
  // miste companyKey'en. Upsert på participant-id ⇒ ingen dublet ved re-run.
  if (!existingCompany) {
    saveDigisenseCompany(db, {
      companyKey,
      companyType: options.companyType,
      companyName,
    });
  }

  // 3) register-participant for BÅDE outbound OG inbound. webhookUrl=null ⇒ vi
  // poller selv. Hvert udfald gemmes i state-laget (upsert pr. retning).
  const errors: string[] = [];
  const directionsRegistered: ParticipantDirection[] = [];
  for (const direction of DIRECTIONS) {
    const body: RegisterParticipantRequest = {
      direction,
      participantType,
      participantId,
      companyKey,
      webhookUrl: NO_WEBHOOK,
      documentProfiles: defaultDocumentProfiles(network),
    };
    const result = await client.registerParticipant(network, body);
    if (!result.ok) {
      errors.push(`register-participant/${network} (${direction}) failed: ${result.error.message}`);
      continue;
    }
    saveDigisenseParticipant(db, {
      companyKey,
      network,
      direction,
      participantType,
      participantId,
      webhookUrl: NO_WEBHOOK,
      registeredOnNetwork: result.data.registeredOnNetwork === true,
      webhookRegistered: result.data.webhookRegistered === true,
    });
    directionsRegistered.push(direction);
  }

  // 4) Audit: én linje pr. registrering. Skrives uanset om begge retninger
  // lykkedes — en delvis registrering er stadig en hændelse værd at spore.
  insertAuditLog(db, {
    eventType: "digisense_company_registered",
    entityType: "company",
    entityId: participantId,
    message:
      `Registrerede ${options.companyType.type} ${participantId} (${companyName}) hos Digisense ` +
      `på ${network} (companyKey=${companyKey}); ` +
      `retninger: ${directionsRegistered.length > 0 ? directionsRegistered.join(", ") : "ingen"}` +
      (errors.length > 0 ? ` — ${errors.length} fejlede` : ""),
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    companyKey,
    directionsRegistered,
    network,
    participantType,
    participantId,
  };
}
