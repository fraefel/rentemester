// Digisense MODTAG-sti (#efaktura) — poll-baseret modtagelse af e-fakturaer.
//
// Flow (poll, INGEN always-on server):
//   1. list-received-documents (pr. companyKey, limit<=100). Følg pagination
//      via nextPageUrl/offset til alle sider er hentet.
//   2. For hvert NYT dokument (dedup på Digisense' STABILE internalId mod
//      digisense_received_documents) ⇒ hent den rå UBL-XML fra det SIGNEREDE
//      downloadUrl gennem en INJICÉRBAR downloader (så tests aldrig rammer
//      nettet). Et allerede ingested dokument springes over FØR download.
//   3. Ingest XML'en som et MODTAGET bilag via den eksisterende ingest-pipeline
//      (ingestDocument), og skriv en append-only dedup-række + et audit_log.
//
// Idempotens: gentaget poll skaber ingen dubletter — dedup-rækken er keyed på
// internalId (UNIQUE), så en re-listning af samme dokument hverken downloader
// eller ingester igen.
//
// Determinisme/injektion: både DigisenseClient OG XML-downloaderen injiceres,
// præcis som PeppolTransmitter i public-einvoice.ts og ImapClient i
// imap-intake.ts. Den rigtige downloader wires i CLI/MCP, men køres aldrig i
// tests. license-key lever i klientens config (secret-laget), aldrig her.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { ingestDocument, type DocumentMetadata, type IngestDocumentOptions } from "../documents";
import { insertAuditLog, type ResolveActorInput } from "../actor";
import type {
  DigisenseClient,
  ListReceivedDocumentsQuery,
  ReceivedDocument,
} from "./digisense-client";

// ============================================================================
// Injicérbar XML-downloader (det signerede downloadUrl)
// ============================================================================

/** Resultatet af et XML-download: enten rå XML eller en sikker fejl-besked. */
export type DownloadXmlResult =
  | { ok: true; xml: string }
  | { ok: false; error: string };

/**
 * Transport-sømmen for at hente den rå UBL-XML fra et signeret (udløbende)
 * downloadUrl. Holdes minimal og fri af globals, så unit-tests kan levere en
 * fake der returnerer et forudbestemt svar uden netværk.
 */
export type DigisenseDocumentDownloader = (url: string) => Promise<DownloadXmlResult>;

/**
 * Default-downloaderen wrapper den globale fetch. Bruges KUN i produktion —
 * tests injicerer altid en fake, så denne sti rammes aldrig i bun test. En
 * ikke-2xx eller transport-fejl mappes til et tydeligt Result (ingen throw).
 */
export function defaultDocumentDownloader(): DigisenseDocumentDownloader {
  return async (url) => {
    try {
      const response = await fetch(url);
      const xml = await response.text();
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: `download responded ${response.status}` };
      }
      return { ok: true, xml };
    } catch (error) {
      return { ok: false, error: `download transport error: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}

// ============================================================================
// Poll-options + resultat
// ============================================================================

export type PollDigisenseReceivedOptions = {
  /** companyKey der scoper list-received-documents (fra digisense_companies). */
  companyKey: string;
  /** Side-størrelse (<=100). Default 100. */
  limit?: number;
  /** Valgfrit øvre tidsstempel (maxTimestamp) videresendt til API'et. */
  maxTimestamp?: string;
  /**
   * Caller-leverede booking-felter der OVERSTYRER de UBL-/listning-afledte
   * (samme konvention som mail-intake's --metadata). `source` sættes altid af
   * pipelinen og kan ikke overstyres.
   */
  metadata?: Omit<DocumentMetadata, "source">;
  /** Videresendt til ingestDocument (fx --force ved logisk dublet-scan). */
  ingestOptions?: IngestDocumentOptions;
  /** Hård øvre grænse på antal sider, så et fejlende nextPageUrl ikke looper. */
  maxPages?: number;
  /** Explicit actor propagated to every document and DigiSense audit event. */
  actor?: ResolveActorInput;
};

/**
 * Pr.-dokument-udfald i en poll (til envelope/diagnostik).
 *
 * - `ingested`           — nyt dokument hentet + bookført rent.
 * - `skipped-duplicate`  — allerede kendt internalId (ingested ELLER quarantined
 *                          tidligere); kortsluttes FØR download.
 * - `quarantined`        — TERMINAL ingest-fejl (validering/dublet) denne poll;
 *                          en dedup-/quarantine-række er skrevet så dokumentet
 *                          aldrig down­loades igen. Ikke en transient fejl.
 * - `error`              — TRANSIENT fejl (download-transport); INGEN række
 *                          skrevet, så næste poll prøver igen.
 */
export type ReceivedDocumentOutcome = {
  internalId: string;
  status: "ingested" | "skipped-duplicate" | "quarantined" | "error";
  documentNo?: string;
  errors?: string[];
};

export type PollDigisenseReceivedResult = {
  ok: boolean;
  /** Antal sider hentet fra list-received-documents. */
  pagesFetched: number;
  /** Antal dokumenter set på tværs af alle sider. */
  documentsListed: number;
  /** Antal NYE dokumenter ingested denne poll. */
  documentsIngested: number;
  /** Antal sprunget over (allerede ingested / dedup / quarantine). */
  documentsSkipped: number;
  /** Antal TERMINALE fejl denne poll (uingesterbare; nu quarantined). */
  documentsQuarantined: number;
  documents: ReceivedDocumentOutcome[];
  errors: string[];
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const DEFAULT_MAX_PAGES = 100;

// ============================================================================
// MODTAG-source: en stabil etiket på ingestede modtagne e-fakturaer, så de kan
// kendes fra mail-intake/photo-upload-bilag. NB: samme værdi forventes i UI/CLI.
// ============================================================================
const MODTAG_SOURCE = "digisense_modtag";

/**
 * Poller modtagne Digisense-dokumenter for ÉN companyKey og ingester hvert NYT
 * dokument. Følger pagination, deduplikerer på internalId, og er idempotent.
 *
 * Kaster aldrig: transport-/ingest-fejl mappes til `errors` og et `ok:false`
 * resultat, så CLI/MCP kan vise en pæn envelope.
 */
export async function pollDigisenseReceived(
  db: Database,
  companyRoot: string,
  client: DigisenseClient,
  downloader: DigisenseDocumentDownloader,
  options: PollDigisenseReceivedOptions,
): Promise<PollDigisenseReceivedResult> {
  const result: PollDigisenseReceivedResult = {
    ok: true,
    pagesFetched: 0,
    documentsListed: 0,
    documentsIngested: 0,
    documentsSkipped: 0,
    documentsQuarantined: 0,
    documents: [],
    errors: [],
  };

  const companyKey = options.companyKey?.trim();
  if (!companyKey) {
    return { ...result, ok: false, errors: ["companyKey is required to poll received documents"] };
  }

  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  // Pagination: vi følger nextPageUrl ved at avancere offset med antallet af
  // sete dokumenter. (API'et returnerer nextPageUrl=null på sidste side; offset
  // er den robuste, server-uafhængige markør.)
  let offset = 0;
  for (let pageNo = 0; pageNo < maxPages; pageNo += 1) {
    const query: ListReceivedDocumentsQuery = {
      limit,
      offset,
      companyKey,
      maxTimestamp: options.maxTimestamp,
    };
    const listed = await client.listReceivedDocuments(query);
    if (!listed.ok) {
      result.ok = false;
      result.errors.push(`list-received-documents failed: ${listed.error.message}`);
      return result;
    }
    result.pagesFetched += 1;

    const documents = listed.data.documents ?? [];
    result.documentsListed += documents.length;

    for (const doc of documents) {
      const outcome = await ingestReceivedDocument(db, companyRoot, downloader, companyKey, doc, options);
      result.documents.push(outcome);
      // En pr.-dokument-fejl må ALDRIG kaste hele pollen: 49 rene fakturaer +
      // 1 dårlig skal ikke give exit 1 / en error-envelope der kasserer de 49.
      // `ok` afspejler kun BATCH-niveau (list-received-documents). Pr.-dokument-
      // udfald rapporteres via tællerne + documents[] + errors[].
      if (outcome.status === "ingested") {
        result.documentsIngested += 1;
      } else if (outcome.status === "skipped-duplicate") {
        result.documentsSkipped += 1;
      } else if (outcome.status === "quarantined") {
        // TERMINAL fejl (validering/dublet): en quarantine-række er skrevet, så
        // dokumentet ikke down­loades + fejler igen i det uendelige. Tæller som
        // håndteret-skip, men fejl-grunden bevares til diagnostik.
        result.documentsQuarantined += 1;
        result.documentsSkipped += 1;
        if (outcome.errors) result.errors.push(...outcome.errors);
      } else {
        // TRANSIENT fejl (download-transport): INGEN række skrevet — næste poll
        // prøver igen. Noteres i errors, men fælder ikke batch-`ok`.
        if (outcome.errors) result.errors.push(...outcome.errors);
      }
    }

    // Stop når der ikke er flere sider. Vi stoler primært på nextPageUrl; en
    // kortere-end-limit side er en sekundær terminering hvis nextPageUrl mangler.
    const hasNext = listed.data.nextPageUrl != null && documents.length > 0;
    if (!hasNext || documents.length < limit) break;
    offset += documents.length;
  }

  return result;
}

/**
 * Dedup-check + download + ingest + audit for ÉT modtaget dokument.
 * Kortslutter FØR download hvis internalId allerede er kendt (idempotens).
 */
async function ingestReceivedDocument(
  db: Database,
  companyRoot: string,
  downloader: DigisenseDocumentDownloader,
  companyKey: string,
  doc: ReceivedDocument,
  options: PollDigisenseReceivedOptions,
): Promise<ReceivedDocumentOutcome> {
  const internalId = doc.internalId;

  // Dedup: internalId er Digisense' stabile nøgle. Allerede kendt ⇒ spring over
  // UDEN at downloade (det signerede downloadUrl er måske allerede udløbet).
  const existing = db
    .query("SELECT document_id FROM digisense_received_documents WHERE internal_id = ? LIMIT 1")
    .get(internalId) as { document_id: number | null } | null;
  if (existing) {
    return { internalId, status: "skipped-duplicate" };
  }

  // Hent den rå XML fra det signerede (udløbende) downloadUrl gennem den
  // injicerede downloader. INGEN netkald i tests.
  const download = await downloader(doc.downloadUrl);
  if (!download.ok) {
    return { internalId, status: "error", errors: [`download of ${internalId} failed: ${download.error}`] };
  }

  // Materialisér XML'en i en scratch-fil og ingest gennem den eksisterende
  // pipeline. Filen ryddes op uanset udfald.
  let scratchDir: string | null = null;
  try {
    scratchDir = mkdtempSync(join(tmpdir(), "rentemester-digisense-modtag-"));
    const xmlPath = join(scratchDir, `${sanitizeFilename(internalId)}.xml`);
    writeFileSync(xmlPath, download.xml, "utf8");

    const metadata = buildReceivedMetadata(doc, download.xml, options.metadata);
    const ingest = ingestDocument(db, companyRoot, xmlPath, metadata, {
      ...(options.ingestOptions ?? {}),
      createdBy: options.actor?.createdBy,
      createdByProgram: options.actor?.createdByProgram,
    });
    if (!ingest.ok) {
      // TERMINAL ingest-fejl: download lykkedes, men XML'en kan ikke bookføres
      // (manglende obligatoriske felter, indholds-dublet, logisk dublet). Det er
      // IKKE en transient fejl — samme XML giver samme udfald hver gang. Vi
      // skriver derfor en QUARANTINE-række (document_id=NULL + skip_reason), så
      // næste poll deduplikerer FØR download og dokumentet ikke down­loades +
      // fejler igen i det uendelige (den signerede downloadUrl udløber). Et
      // menneske kan se quarantine-rækken og håndtere bilaget manuelt.
      const reason = (ingest.errors ?? ["ingest failed"]).join("; ");
      quarantineReceivedDocument(db, companyKey, doc, reason, options.actor);
      return { internalId, status: "quarantined", errors: ingest.errors ?? ["ingest failed"] };
    }

    // Append-only dedup-række + audit_log i én transaktion: enten begge eller
    // ingen, så en halv-skreven modtagelse aldrig efterlader en uregistreret
    // dublet-mulighed.
    db.transaction(() => {
      db.run(
        `INSERT INTO digisense_received_documents
           (internal_id, company_key, document_id, skip_reason, digisense_document_id, source_network,
            sender_participant_id, sender_name, received_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        [
          internalId,
          companyKey,
          ingest.documentId ?? null,
          doc.documentId ?? null,
          doc.sourceNetwork ?? null,
          doc.senderParticipantId ?? null,
          doc.senderName ?? null,
          doc.receivedAt ?? null,
        ],
      );
      insertAuditLog(db, {
        eventType: "digisense_document_received",
        entityType: "document",
        entityId: ingest.documentId ?? null,
        message: `Modtog e-faktura ${ingest.documentNo} via Digisense (internalId=${internalId}, ${doc.sourceNetwork ?? "ukendt netværk"}, afsender ${doc.senderName ?? doc.senderParticipantId ?? "ukendt"})`,
        ...options.actor,
      });
    })();

    return { internalId, status: "ingested", documentNo: ingest.documentNo };
  } finally {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Skriver en QUARANTINE-række for en TERMINAL ingest-fejl: document_id=NULL +
 * skip_reason. Markerer internalId som "set, kan ikke bookføres", så dedup-
 * kortslutningen i ingestReceivedDocument springer dokumentet over FØR download
 * ved næste poll. Skrives i samme transaktion som et audit_log, så et menneske
 * kan se hvorfor dokumentet blev sat i karantæne.
 */
function quarantineReceivedDocument(
  db: Database,
  companyKey: string,
  doc: ReceivedDocument,
  reason: string,
  actor?: ResolveActorInput,
): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO digisense_received_documents
         (internal_id, company_key, document_id, skip_reason, digisense_document_id, source_network,
          sender_participant_id, sender_name, received_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        doc.internalId,
        companyKey,
        reason,
        doc.documentId ?? null,
        doc.sourceNetwork ?? null,
        doc.senderParticipantId ?? null,
        doc.senderName ?? null,
        doc.receivedAt ?? null,
      ],
    );
    insertAuditLog(db, {
      eventType: "digisense_document_quarantined",
      entityType: "document",
      entityId: null,
      message: `Sat modtaget e-faktura i karantæne (internalId=${doc.internalId}, afsender ${doc.senderName ?? doc.senderParticipantId ?? "ukendt"}): ${reason}`,
      ...actor,
    });
  })();
}

// ============================================================================
// Metadata-afledning: listning + UBL-ekstraktion (+ caller-overstyring)
// ============================================================================

/**
 * Bygger DocumentMetadata for et modtaget dokument ved at flette (i prioritet):
 *   listnings-data  <  UBL-ekstraktion  <  caller-leveret metadata.
 *
 * source sættes altid af pipelinen (MODTAG_SOURCE) og kan ikke overstyres.
 */
function buildReceivedMetadata(
  doc: ReceivedDocument,
  xml: string,
  override: Omit<DocumentMetadata, "source"> | undefined,
): DocumentMetadata {
  const ubl = extractUblFields(xml);

  const senderName = doc.senderName || ubl.senderName;
  const base: DocumentMetadata = {
    source: MODTAG_SOURCE,
    documentType: "purchase_sale",
    issueDate: ubl.issueDate ?? doc.receivedAt?.split("T")[0],
    invoiceNo: ubl.invoiceNo ?? doc.documentId,
    deliveryDescription:
      ubl.invoiceNo
        ? `Modtaget e-faktura ${ubl.invoiceNo} (${doc.documentType})`
        : `Modtaget e-faktura (${doc.documentType})`,
    amountIncVat: ubl.payableAmount,
    currency: ubl.currency ?? "DKK",
    sender: {
      name: senderName,
      address: ubl.senderAddress,
      vatOrCvr: ubl.senderVatOrCvr ?? normalizeParticipantId(doc.senderParticipantId),
    },
    recipient: {
      name: doc.destinationName || ubl.recipientName,
      address: ubl.recipientAddress,
      vatOrCvr: ubl.recipientVatOrCvr ?? normalizeParticipantId(doc.destinationParticipantId),
    },
    vatAmount: ubl.taxAmount,
  };

  // Caller-overstyring: kun definerede felter overskriver de afledte. sender/
  // recipient flettes felt-for-felt så en delvis override ikke nulstiller resten.
  if (!override) return base;
  return {
    ...base,
    ...stripUndefined(override),
    sender: { ...base.sender, ...stripUndefined(override.sender ?? {}) },
    recipient: { ...base.recipient, ...stripUndefined(override.recipient ?? {}) },
    source: MODTAG_SOURCE,
  };
}

/** Fjerner undefined-felter så en override ikke overskriver med undefined. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

/** En Digisense participant-id (fx "DK:CVR:12345678" eller "DK12345678") → CVR-streng. */
function normalizeParticipantId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const trimmed = id.trim();
  // Fjern et evt. scheme-prefix ("DK:CVR:") og returnér resten urørt ellers.
  const lastColon = trimmed.lastIndexOf(":");
  return lastColon >= 0 ? trimmed.slice(lastColon + 1) : trimmed;
}

type UblFields = {
  issueDate?: string;
  invoiceNo?: string;
  currency?: string;
  senderName?: string;
  senderAddress?: string;
  senderVatOrCvr?: string;
  recipientName?: string;
  recipientAddress?: string;
  recipientVatOrCvr?: string;
  payableAmount?: number;
  taxAmount?: number;
};

/**
 * Minimal, DETERMINISTISK UBL-ekstraktor. Læser de standard-elementer en
 * modtaget faktura bærer (issue date, parter, totaler) uden en fuld XML-parser
 * — nok til at en standard e-faktura ingestes som et bookbart bilag. Den er
 * bevidst tolerant: et felt der ikke findes bliver bare undefined (og udfyldes
 * fra listningen eller af caller-metadata). Namespace-præfikser ignoreres ved
 * at matche på lokal-navnet.
 */
function extractUblFields(xml: string): UblFields {
  const supplier = sliceBetween(xml, "AccountingSupplierParty");
  const customer = sliceBetween(xml, "AccountingCustomerParty");
  return {
    issueDate: tagText(xml, "IssueDate"),
    invoiceNo: tagText(xml, "ID"),
    currency: tagText(xml, "DocumentCurrencyCode"),
    senderName: supplier ? tagText(supplier, "Name") : undefined,
    senderAddress: supplier ? tagText(supplier, "StreetName") ?? tagText(supplier, "Line") : undefined,
    senderVatOrCvr: supplier ? tagText(supplier, "CompanyID") : undefined,
    recipientName: customer ? tagText(customer, "Name") : undefined,
    recipientAddress: customer ? tagText(customer, "StreetName") ?? tagText(customer, "Line") : undefined,
    recipientVatOrCvr: customer ? tagText(customer, "CompanyID") : undefined,
    payableAmount: parseAmount(tagText(xml, "PayableAmount")),
    taxAmount: parseAmount(tagText(xml, "TaxAmount")),
  };
}

/** Tekst-indholdet af det FØRSTE element med lokal-navnet `localName`. */
function tagText(xml: string, localName: string): string | undefined {
  // (?:\w+:)? matcher et evt. namespace-præfiks; attributter på start-taggen
  // tillades. Ikke-greedy indhold op til den matchende slut-tag.
  const re = new RegExp(`<(?:\\w+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, "i");
  const match = re.exec(xml);
  if (!match) return undefined;
  const text = match[1]!.trim();
  return text.length > 0 ? decodeBasicEntities(text) : undefined;
}

/** Returnerer XML-fragmentet inde i det FØRSTE element med `localName`. */
function sliceBetween(xml: string, localName: string): string | undefined {
  const re = new RegExp(`<(?:\\w+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, "i");
  return re.exec(xml)?.[1];
}

function parseAmount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Gør en internalId sikker som filnavn (kun den scratch-fil vi selv læser). */
function sanitizeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "received";
}
