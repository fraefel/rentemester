// Digisense PeppolTransmitter (#efaktura) — den konkrete transport der opfylder
// PeppolTransmitter-injektionssømmen i src/core/public-einvoice.ts.
//
// Fundamentet (digisense-client.ts) leverer den typede, injicérbare HTTP-klient.
// Dette lag binder den til den eksisterende transmit-orkestrering: en
// `PeppolTransmitter` får OIOUBL-XML'en (output fra exportPublicEInvoiceOioUbl)
// og skal returnere `{ ok, transmissionId, transmittedAt }` ELLER `{ ok:false,
// error }`. transmitPublicEInvoicePeppol bogfører selv en succes som en
// `acknowledged` peppol_submissions-række og lægger fejl i audit_log.
//
// FLOW (samme rækkefølge som Digisense' OpenAPI foreskriver):
//   1. validate-document (schematron-gate): kald FØR send. success=false =>
//      afvis tydeligt med de konkrete fejl, og rør ALDRIG deliver.
//   2. deliver-document(companyKey, XML): 200/delivered => acknowledged straks.
//   3. 202/queued => poll document-status til delivered eller en terminal
//      fejl-status. Poll-loopet er DETERMINISTISK: clock+sleep injiceres og
//      antallet af iterationer er bundet (maxPollAttempts), så tests aldrig
//      venter rigtigt og loopet aldrig hænger.
//
// INGEN HTTP-kode her: al transport går gennem den injicerede DigisenseClient.
// Credentials (license-key) lever i klientens config (secret-laget), ikke her.

import type {
  DigisenseClient,
  DigisenseDocumentStatus,
  KsefEnvironment,
  ValidateDocumentError,
} from "./digisense-client";
import type { PeppolTransmitter, PeppolTransmissionOutcome } from "../public-einvoice";

/**
 * Deterministiske afhængigheder + Digisense-scoping for transmitteren.
 *
 * `companyKey` scoper deliver/status-kaldene (fra digisense_companies-state).
 * `clock`/`sleep` injiceres så poll-loopet er testbart uden rigtig ventetid.
 */
export type DigisenseTransmitterDeps = {
  /** Digisense companyKey for afsenderen (fra register-company-state). */
  companyKey: string;
  /** Valgfrit KSeF-miljø videresendt til deliver-document. */
  ksefEnvironment?: KsefEnvironment;
  /** Returnerer nuværende tidspunkt som ISO-streng. Default: Date.now-baseret. */
  clock?: () => string;
  /** Venter `ms` millisekunder. Default: rigtig setTimeout. Mockes i tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Ventetid mellem polls (ms). Default 2000. */
  pollIntervalMs?: number;
  /** Maks. antal status-polls før transmitteren giver op. Default 30. */
  maxPollAttempts?: number;
};

// Terminale document-status-værdier. Alt andet end "delivered" her er en
// endelig fejl; "queued-for-delivery" + de transiente fejl er ikke-terminale og
// udløser videre polling indtil budget'et er brugt.
const TERMINAL_FAILURE_STATUSES: ReadonlySet<DigisenseDocumentStatus> = new Set([
  "document-not-valid",
  "unable-to-deliver",
  "unknown-server-error",
]);

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_POLL_ATTEMPTS = 30;

// Rigtig sleep — bruges KUN i produktion; tests injicerer altid en fake.
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultClock(): string {
  return new Date().toISOString();
}

// Render schematron-fejl kompakt til envelope-beskeden. Kun ægte fejl (ikke
// warnings) tæller for gaten, men beskeden viser dem konkret så et menneske
// kan se HVAD der mangler (fx BuyerReference).
function formatValidationErrors(errors: ValidateDocumentError[]): string {
  const hard = errors.filter((e) => e.type === "error");
  const shown = (hard.length > 0 ? hard : errors)
    .map((e) => `${e.pattern}: ${e.description}`)
    .join("; ");
  return shown || "ukendt schematron-fejl";
}

/**
 * Bygger en `PeppolTransmitter` oven på en (allerede konfigureret) DigisenseClient.
 *
 * Transmitteren er ren orkestrering: validate -> deliver -> (poll). Den kaster
 * aldrig — alle fejl mappes til `{ ok:false, error }` som transmit-laget
 * forventer (en throw ville alligevel blive fanget af transmitPublicEInvoicePeppol,
 * men vi holder kontrakten eksplicit her).
 */
export function createDigisenseTransmitter(
  client: DigisenseClient,
  deps: DigisenseTransmitterDeps,
): PeppolTransmitter {
  const companyKey = deps.companyKey?.trim();
  if (!companyKey) {
    throw new Error("digisense transmitter: companyKey is required");
  }
  const clock = deps.clock ?? defaultClock;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollAttempts = deps.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

  return async (input): Promise<PeppolTransmissionOutcome> => {
    const xml = input.oioublXml;

    // 1. Schematron-gate. Afvis ved success=false — uden at røre deliver.
    const validation = await client.validateDocument(xml);
    if (!validation.ok) {
      return { ok: false, error: `digisense validate-document failed: ${validation.error.message}` };
    }
    if (!validation.data.success) {
      return {
        ok: false,
        error: `digisense schematron rejected the invoice: ${formatValidationErrors(validation.data.errors ?? [])}`,
      };
    }

    // 2. Lever dokumentet. companyKey + valgfrit ksefEnvironment scoper kaldet.
    const delivered = await client.deliverDocument(xml, {
      companyKey,
      ksefEnvironment: deps.ksefEnvironment,
    });
    if (!delivered.ok) {
      return { ok: false, error: `digisense deliver-document failed: ${delivered.error.message}` };
    }

    const { documentId, documentStatus, statusCode } = delivered.data;

    // 200/delivered => kvitteret med det samme; documentId er transmissionId'et.
    if (documentStatus === "delivered") {
      return { ok: true, transmissionId: documentId, transmittedAt: clock() };
    }

    // En terminal fejl-status allerede ved deliver (fx 4xx i body) afvises.
    if (TERMINAL_FAILURE_STATUSES.has(documentStatus)) {
      return {
        ok: false,
        error: `digisense delivery rejected (${documentStatus}) for document ${documentId}: ${delivered.data.message}`,
      };
    }

    // 3. 202/queued (eller transient): poll document-status til terminal.
    if (statusCode !== 202 && documentStatus !== "queued-for-delivery") {
      // Ukendt ikke-terminal tilstand uden 202 — behandl konservativt som fejl
      // i stedet for at poll'e i blinde.
      return {
        ok: false,
        error: `digisense delivery returned an unexpected status (${documentStatus}, code ${statusCode}) for document ${documentId}`,
        queuedDocumentId: documentId,
      };
    }

    try {
      for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
        await sleep(pollIntervalMs);
        const status = await client.documentStatus(documentId, companyKey);
        if (!status.ok) {
          return { ok: false, error: `digisense document-status failed: ${status.error.message}`, queuedDocumentId: documentId };
        }
        const current = status.data.documentStatus;
        if (current === "delivered") {
          return { ok: true, transmissionId: documentId, transmittedAt: clock() };
        }
        if (TERMINAL_FAILURE_STATUSES.has(current)) {
          return {
            ok: false,
            error: `digisense delivery failed (${current}) for document ${documentId}: ${status.data.message}`,
          };
        }
        // queued-for-delivery / temporary-upstream-error => prøv igen.
      }
    } catch (error) {
      return {
        ok: false,
        error: `digisense document-status failed: ${error instanceof Error ? error.message : String(error)}`,
        queuedDocumentId: documentId,
      };
    }

    // Budget brugt op uden terminal status. Dokumentet er ACCEPTERET af
    // Digisense (202/queued) og leveres sandsynligvis asynkront — så en blind
    // retry der kalder deliver IGEN ville levere fakturaen TO gange. Vi bærer
    // documentId med som queuedDocumentId, så transmit-laget kan persistere en
    // ikke-terminal `prepared`-række og afvise re-deliver ved en senere kørsel
    // (den skal i stedet poll'e status på dette EKSISTERENDE documentId).
    return {
      ok: false,
      error: `digisense delivery timed out after ${maxPollAttempts} status polls for document ${documentId} (still queued, not yet delivered)`,
      queuedDocumentId: documentId,
    };
  };
}
