// Tests: src/core/efaktura/digisense-receive.ts — MODTAG-stien (#efaktura).
//
// Poll-baseret modtagelse: list-received-documents (pr. companyKey, pagination
// via nextPageUrl) -> for hvert NYT dokument (dedup på internalId) -> hent rå
// XML fra det signerede downloadUrl gennem en INJICÉRBAR downloader -> ingest
// via den eksisterende ingest-pipeline -> skriv audit_log. Idempotent: gentaget
// poll skaber ingen dubletter.
//
// Hele kæden testes mod en FAKE DigisenseClient + FAKE downloader — INGEN
// netkald. Samme injection-mønster som digisense-transmitter.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import type {
  DigisenseClient,
  DigisenseResult,
  ListReceivedDocumentsQuery,
  ListReceivedDocumentsResponse,
  ReceivedDocument,
} from "../../src/core/efaktura/digisense-client";
import {
  pollDigisenseReceived,
  type DigisenseDocumentDownloader,
} from "../../src/core/efaktura/digisense-receive";

function freshLedger(label: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-digisense-receive-${label}-`));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

function ok<T>(data: T, status = 200): DigisenseResult<T> {
  return { ok: true, status, data };
}

function notImplemented(name: string): never {
  throw new Error(`fake digisense client: ${name} should not be called by the receiver`);
}

// A minimal-but-realistic UBL invoice body. It carries the standard UBL
// elements the receiver's extractor reads (issue date, parties, totals) so the
// derived metadata satisfies the ingest pipeline's minimum-field rule without
// the caller supplying anything. The internalId is woven into the IDs so dedup
// (which keys on internalId, not content) and content are independent.
function xmlFor(internalId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${internalId}</cbc:ID>
  <cbc:IssueDate>2026-06-19</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>DKK</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>Leverandør ApS</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Leverandørvej 2</cbc:StreetName></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DK98765432</cbc:CompanyID></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyName><cbc:Name>Min Virksomhed ApS</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Testvej 1</cbc:StreetName></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DK12345678</cbc:CompanyID></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="DKK">250.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="DKK">1250.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>
`;
}

function receivedDoc(overrides: Partial<ReceivedDocument> & { internalId: string }): ReceivedDocument {
  return {
    documentId: `ds-${overrides.internalId}`,
    documentType: "Invoice",
    documentTypeUrn: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    profileId: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
    customizationId: "urn:cen.eu:en16931:2017",
    receivedAt: "2026-06-20T08:30:00Z",
    senderParticipantType: "DK:CVR",
    senderParticipantId: "DK98765432",
    senderName: "Leverandør ApS",
    destinationParticipantType: "DK:CVR",
    destinationParticipantId: "DK12345678",
    destinationName: "Min Virksomhed ApS",
    sourceNetwork: "nemhandel",
    downloadUrlExpiresAt: "2026-06-20T09:30:00Z",
    downloadUrl: `https://signed.example/${overrides.internalId}`,
    ...overrides,
  };
}

// Fake client: only listReceivedDocuments is scriptable. Each scripted page is
// returned in order; the query (companyKey, limit, offset) is recorded so tests
// can assert pagination is followed.
type ListCall = ListReceivedDocumentsQuery;
function fakeClient(pages: ListReceivedDocumentsResponse[]): {
  client: DigisenseClient;
  listCalls: ListCall[];
} {
  const listCalls: ListCall[] = [];
  let pageIndex = 0;
  const client: DigisenseClient = {
    validateAuth: () => notImplemented("validateAuth"),
    registerCompany: () => notImplemented("registerCompany"),
    registerParticipant: () => notImplemented("registerParticipant"),
    validateDocument: () => notImplemented("validateDocument"),
    lookupParticipant: () => notImplemented("lookupParticipant"),
    deliverDocument: () => notImplemented("deliverDocument"),
    documentStatus: () => notImplemented("documentStatus"),
    async listReceivedDocuments(query) {
      listCalls.push(query);
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      if (!page) throw new Error("fake: no list page scripted");
      return ok<ListReceivedDocumentsResponse>(page);
    },
  };
  return { client, listCalls };
}

function page(
  documents: ReceivedDocument[],
  nextPageUrl: string | null = null,
): ListReceivedDocumentsResponse {
  return { documents, participants: [], licenseKey: "lic", searchParams: {}, nextPageUrl };
}

// An UBL body that is MISSING the customer (recipient) postal address, so the
// ingest pipeline's minimum-field rule rejects it terminally (recipient.address
// is required). Used to exercise the "download ok, ingest fails" path.
function xmlMissingRecipientAddress(internalId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>${internalId}</cbc:ID>
  <cbc:IssueDate>2026-06-19</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>DKK</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyName><cbc:Name>Leverandør ApS</cbc:Name></cac:PartyName>
    <cac:PostalAddress><cbc:StreetName>Leverandørvej 2</cbc:StreetName></cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>DK98765432</cbc:CompanyID></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party>
    <cac:PartyName><cbc:Name>Min Virksomhed ApS</cbc:Name></cac:PartyName>
    <cac:PartyTaxScheme><cbc:CompanyID>DK12345678</cbc:CompanyID></cac:PartyTaxScheme>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="DKK">250.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="DKK">1250.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
</Invoice>
`;
}

// Fake downloader: serves XML keyed by the document's downloadUrl, and records
// every URL it was asked to fetch (so we can assert dedup skips downloads).
function fakeDownloader(): {
  downloader: DigisenseDocumentDownloader;
  fetchedUrls: string[];
} {
  const fetchedUrls: string[] = [];
  const downloader: DigisenseDocumentDownloader = async (url) => {
    fetchedUrls.push(url);
    const internalId = url.split("/").pop() ?? "";
    return { ok: true, xml: xmlFor(internalId) };
  };
  return { downloader, fetchedUrls };
}

// Fake downloader whose served XML is selected per internalId via `xmlByInternalId`,
// falling back to the standard happy-path body. Records every fetched URL.
function fakeDownloaderWith(xmlByInternalId: Record<string, string>): {
  downloader: DigisenseDocumentDownloader;
  fetchedUrls: string[];
} {
  const fetchedUrls: string[] = [];
  const downloader: DigisenseDocumentDownloader = async (url) => {
    fetchedUrls.push(url);
    const internalId = url.split("/").pop() ?? "";
    return { ok: true, xml: xmlByInternalId[internalId] ?? xmlFor(internalId) };
  };
  return { downloader, fetchedUrls };
}

describe("pollDigisenseReceived — MODTAG happy path", () => {
  test("a new received document is downloaded and ingested", async () => {
    const { root, db } = freshLedger("ingest");
    try {
      const { client } = fakeClient([page([receivedDoc({ internalId: "iid-1" })])]);
      const { downloader, fetchedUrls } = fakeDownloader();

      const result = await pollDigisenseReceived(db, root, client, downloader, {
        companyKey: "ck-abc",
      });

      expect(result.ok).toBe(true);
      expect(result.documentsListed).toBe(1);
      expect(result.documentsIngested).toBe(1);
      expect(result.documentsSkipped).toBe(0);
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0]!.internalId).toBe("iid-1");
      expect(result.documents[0]!.documentNo).toMatch(/^DOC-/);
      // The signed downloadUrl was fetched exactly once.
      expect(fetchedUrls).toEqual(["https://signed.example/iid-1"]);

      // The document landed in the ledger as a received e-invoice with the
      // financial fields extracted from the UBL body and the sender from the
      // listing/UBL.
      const doc = db
        .query(
          "SELECT source, document_type, mime_type, sender_vat_cvr, amount_inc_vat, vat_amount, invoice_date FROM documents WHERE source = ?",
        )
        .get("digisense_modtag") as
        | {
            source: string;
            document_type: string;
            mime_type: string;
            sender_vat_cvr: string;
            amount_inc_vat: number;
            vat_amount: number;
            invoice_date: string;
          }
        | null;
      expect(doc).not.toBeNull();
      expect(doc!.mime_type).toBe("application/xml");
      expect(doc!.document_type).toBe("purchase_sale");
      expect(doc!.sender_vat_cvr).toBe("DK98765432");
      expect(doc!.amount_inc_vat).toBe(1250);
      expect(doc!.vat_amount).toBe(250);
      expect(doc!.invoice_date).toBe("2026-06-19");

      // A dedup row was recorded.
      const dedup = db
        .query("SELECT internal_id, company_key FROM digisense_received_documents WHERE internal_id = ?")
        .get("iid-1") as { internal_id: string; company_key: string } | null;
      expect(dedup).not.toBeNull();
      expect(dedup!.company_key).toBe("ck-abc");

      // An audit_log entry was written for the receipt.
      const audit = db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'digisense_document_received'")
        .get() as { n: number };
      expect(audit.n).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pollDigisenseReceived — idempotent dedup on internalId", () => {
  test("a second poll of the same document ingests nothing again", async () => {
    const { root, db } = freshLedger("dedup");
    try {
      // First poll: one document.
      const first = fakeClient([page([receivedDoc({ internalId: "iid-1" })])]);
      const firstDl = fakeDownloader();
      const r1 = await pollDigisenseReceived(db, root, first.client, firstDl.downloader, {
        companyKey: "ck-abc",
      });
      expect(r1.ok).toBe(true);
      expect(r1.documentsIngested).toBe(1);

      // Second poll: the SAME document is listed again (downloadUrl re-listed).
      const second = fakeClient([page([receivedDoc({ internalId: "iid-1" })])]);
      const secondDl = fakeDownloader();
      const r2 = await pollDigisenseReceived(db, root, second.client, secondDl.downloader, {
        companyKey: "ck-abc",
      });

      expect(r2.ok).toBe(true);
      expect(r2.documentsListed).toBe(1);
      expect(r2.documentsIngested).toBe(0);
      expect(r2.documentsSkipped).toBe(1);
      // Dedup short-circuits BEFORE downloading: the URL is never fetched again.
      expect(secondDl.fetchedUrls).toEqual([]);

      // Still exactly one document + one dedup row in the ledger.
      const docs = db.query("SELECT COUNT(*) AS n FROM documents WHERE source = 'digisense_modtag'").get() as { n: number };
      expect(docs.n).toBe(1);
      const dedup = db.query("SELECT COUNT(*) AS n FROM digisense_received_documents").get() as { n: number };
      expect(dedup.n).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pollDigisenseReceived — pagination via nextPageUrl", () => {
  test("all pages are followed and every new document is ingested", async () => {
    const { root, db } = freshLedger("pagination");
    try {
      const { client, listCalls } = fakeClient([
        page([receivedDoc({ internalId: "iid-1" }), receivedDoc({ internalId: "iid-2" })], "next-1"),
        page([receivedDoc({ internalId: "iid-3" })], null),
      ]);
      const { downloader, fetchedUrls } = fakeDownloader();

      const result = await pollDigisenseReceived(db, root, client, downloader, {
        companyKey: "ck-abc",
        limit: 2,
      });

      expect(result.ok).toBe(true);
      expect(result.pagesFetched).toBe(2);
      expect(result.documentsListed).toBe(3);
      expect(result.documentsIngested).toBe(3);
      expect(fetchedUrls).toHaveLength(3);

      // Two list calls were made; both scoped by companyKey + the limit, and the
      // second advanced the offset past the first page.
      expect(listCalls).toHaveLength(2);
      expect(listCalls[0]!.companyKey).toBe("ck-abc");
      expect(listCalls[0]!.limit).toBe(2);
      expect(listCalls[0]!.offset ?? 0).toBe(0);
      expect(listCalls[1]!.offset).toBe(2);

      const docs = db.query("SELECT COUNT(*) AS n FROM documents WHERE source = 'digisense_modtag'").get() as { n: number };
      expect(docs.n).toBe(3);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pollDigisenseReceived — terminal ingest failure is quarantined, not re-downloaded forever", () => {
  test("download ok + ingest fails (missing recipient address) ⇒ quarantine row; a second poll does NOT re-download", async () => {
    const { root, db } = freshLedger("quarantine");
    try {
      // First poll: a document whose UBL is missing the recipient address, so
      // the ingest pipeline rejects it terminally.
      const first = fakeClient([page([receivedDoc({ internalId: "bad-1" })])]);
      const firstDl = fakeDownloaderWith({ "bad-1": xmlMissingRecipientAddress("bad-1") });
      const r1 = await pollDigisenseReceived(db, root, first.client, firstDl.downloader, {
        companyKey: "ck-abc",
      });

      // The batch itself succeeded (list ok); the document is reported as a
      // terminal quarantine, NOT a transient error — so `ok` is not perpetually
      // false on a fully-listable poll.
      expect(r1.ok).toBe(true);
      expect(r1.documentsIngested).toBe(0);
      expect(r1.documentsQuarantined).toBe(1);
      expect(r1.documents[0]!.status).toBe("quarantined");
      expect(firstDl.fetchedUrls).toEqual(["https://signed.example/bad-1"]);

      // A quarantine dedup row was written (document_id NULL + skip_reason set).
      const quarantined = db
        .query("SELECT document_id, skip_reason FROM digisense_received_documents WHERE internal_id = ?")
        .get("bad-1") as { document_id: number | null; skip_reason: string | null } | null;
      expect(quarantined).not.toBeNull();
      expect(quarantined!.document_id).toBeNull();
      expect(quarantined!.skip_reason).toContain("recipient.address");
      // No document landed in the ledger.
      const docs0 = db.query("SELECT COUNT(*) AS n FROM documents WHERE source = 'digisense_modtag'").get() as { n: number };
      expect(docs0.n).toBe(0);

      // Second poll: the SAME bad document is re-listed. The dedup short-circuit
      // must skip it BEFORE downloading — no perpetual re-download/re-fail loop.
      const second = fakeClient([page([receivedDoc({ internalId: "bad-1" })])]);
      const secondDl = fakeDownloaderWith({ "bad-1": xmlMissingRecipientAddress("bad-1") });
      const r2 = await pollDigisenseReceived(db, root, second.client, secondDl.downloader, {
        companyKey: "ck-abc",
      });

      expect(r2.ok).toBe(true);
      expect(r2.documentsIngested).toBe(0);
      expect(r2.documentsQuarantined).toBe(0);
      expect(r2.documentsSkipped).toBe(1);
      expect(r2.documents[0]!.status).toBe("skipped-duplicate");
      // The signed downloadUrl was NOT fetched again.
      expect(secondDl.fetchedUrls).toEqual([]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pollDigisenseReceived — partial success when one document fails", () => {
  test("one bad + two good in the same batch ⇒ ok:true, the two good are ingested", async () => {
    const { root, db } = freshLedger("partial");
    try {
      const { client } = fakeClient([
        page([
          receivedDoc({ internalId: "good-1" }),
          receivedDoc({ internalId: "bad-1" }),
          receivedDoc({ internalId: "good-2" }),
        ]),
      ]);
      const { downloader } = fakeDownloaderWith({ "bad-1": xmlMissingRecipientAddress("bad-1") });

      const result = await pollDigisenseReceived(db, root, client, downloader, {
        companyKey: "ck-abc",
      });

      // The poll is a PARTIAL success: the batch listed fine, the two good ones
      // ingested, and the one bad one is surfaced (quarantined) without
      // discarding the others or failing the whole poll.
      expect(result.ok).toBe(true);
      expect(result.documentsListed).toBe(3);
      expect(result.documentsIngested).toBe(2);
      expect(result.documentsQuarantined).toBe(1);
      expect(result.errors.length).toBeGreaterThan(0);

      const docs = db.query("SELECT COUNT(*) AS n FROM documents WHERE source = 'digisense_modtag'").get() as { n: number };
      expect(docs.n).toBe(2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
