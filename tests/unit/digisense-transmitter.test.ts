// Tests: src/core/efaktura/digisense-transmitter.ts
//
// Den konkrete DigisenseTransmitter opfylder PeppolTransmitter-injektionssømmen
// fra public-einvoice.ts. Flow: validate-document (schematron-gate) ->
// deliver-document -> ved 202/queued: poll document-status til delivered eller
// fejl-status. Hele kæden testes mod en FAKE DigisenseClient — INGEN netkald og
// INGEN rigtig ventetid (sleep + clock injiceres).
import { describe, expect, test } from "bun:test";
import type {
  DigisenseClient,
  DigisenseResult,
  DeliverDocumentResponse,
  DocumentStatusResponse,
  ValidateDocumentResponse,
} from "../../src/core/efaktura/digisense-client";
import { createDigisenseTransmitter } from "../../src/core/efaktura/digisense-transmitter";

// ----------------------------------------------------------------------------
// Fake DigisenseClient: kun de tre metoder transmitteren rører (validateDocument,
// deliverDocument, documentStatus) er scriptbare; resten kaster hvis de kaldes,
// så en utilsigtet udvidelse af kontaktfladen fanges af testen.
// ----------------------------------------------------------------------------
type FakeScript = {
  validate?: DigisenseResult<ValidateDocumentResponse>;
  deliver?: DigisenseResult<DeliverDocumentResponse>;
  /** Én status pr. poll-iteration; sidste genbruges hvis pollet videre. */
  statuses?: DigisenseResult<DocumentStatusResponse>[];
};

type FakeCalls = {
  validateXml: string[];
  deliver: Array<{ xml: string; companyKey: string; ksefEnvironment?: string }>;
  status: Array<{ documentId: string; companyKey: string }>;
};

function ok<T>(data: T, status = 200): DigisenseResult<T> {
  return { ok: true, status, data };
}

function notImplemented(name: string): never {
  throw new Error(`fake digisense client: ${name} should not be called by the transmitter`);
}

function fakeClient(script: FakeScript): { client: DigisenseClient; calls: FakeCalls } {
  const calls: FakeCalls = { validateXml: [], deliver: [], status: [] };
  let statusIndex = 0;
  const client: DigisenseClient = {
    validateAuth: () => notImplemented("validateAuth"),
    registerCompany: () => notImplemented("registerCompany"),
    registerParticipant: () => notImplemented("registerParticipant"),
    lookupParticipant: () => notImplemented("lookupParticipant"),
    listReceivedDocuments: () => notImplemented("listReceivedDocuments"),
    async validateDocument(xml) {
      calls.validateXml.push(xml);
      return script.validate ?? ok<ValidateDocumentResponse>({ statusCode: 200, success: true, errors: [] });
    },
    async deliverDocument(xml, query) {
      calls.deliver.push({ xml, companyKey: query.companyKey, ksefEnvironment: query.ksefEnvironment });
      if (!script.deliver) throw new Error("fake: no deliver scripted");
      return script.deliver;
    },
    async documentStatus(documentId, companyKey) {
      calls.status.push({ documentId, companyKey });
      const statuses = script.statuses ?? [];
      const result = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      if (!result) throw new Error("fake: no status scripted");
      return result;
    },
  };
  return { client, calls };
}

// Deterministisk clock/sleep: ingen rigtig ventetid. sleep skubber blot uret
// frem så transmittedAt er forudsigeligt.
function fakeTime(startMs = 0) {
  let now = startMs;
  const slept: number[] = [];
  return {
    clock: () => new Date(now).toISOString(),
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}

const TRANSMITTER_INPUT = {
  oioublXml: "<Invoice>…</Invoice>",
  oioublSha256: "abc123",
  receiverEndpointId: "5790000000001",
  accessPoint: { accessPointId: "ap-digisense", endpointUrl: "https://x", senderEndpointId: "12345678" },
};

describe("digisense transmitter — schematron gate", () => {
  test("a validate-document failure rejects before any deliver call", async () => {
    const { client, calls } = fakeClient({
      validate: ok<ValidateDocumentResponse>({
        statusCode: 422,
        success: false,
        errors: [
          { context: "/Invoice", pattern: "PEPPOL-EN16931-R003", description: "BuyerReference mangler", xpath: "/x", type: "error" },
          { context: "/Invoice", pattern: "warn", description: "kun en warning", xpath: "/y", type: "warning" },
        ],
      }),
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, {
      companyKey: "ck-1",
      clock: time.clock,
      sleep: time.sleep,
    });

    const outcome = await transmit(TRANSMITTER_INPUT);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Den konkrete schematron-fejl skal være tydelig i beskeden.
      expect(outcome.error).toContain("BuyerReference mangler");
      expect(outcome.error).toContain("PEPPOL-EN16931-R003");
    }
    // Gate: deliver må ALDRIG kaldes når validering fejler.
    expect(calls.deliver).toHaveLength(0);
    expect(calls.validateXml).toEqual([TRANSMITTER_INPUT.oioublXml]);
  });

  test("a transport/HTTP error from validate-document is surfaced and gates delivery", async () => {
    const { client, calls } = fakeClient({
      validate: { ok: false, error: { status: 0, message: "digisense transport error: ECONNRESET" } },
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, { companyKey: "ck-1", clock: time.clock, sleep: time.sleep });

    const outcome = await transmit(TRANSMITTER_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("ECONNRESET");
    expect(calls.deliver).toHaveLength(0);
  });
});

describe("digisense transmitter — deliver happy path", () => {
  test("a 200/delivered response acknowledges immediately without polling", async () => {
    const { client, calls } = fakeClient({
      deliver: ok<DeliverDocumentResponse>({
        statusCode: 200,
        documentStatus: "delivered",
        documentId: "doc-200",
        message: "ok",
        publicUrl: "https://pub/200",
      }),
    });
    const time = fakeTime(1_000);
    const transmit = createDigisenseTransmitter(client, { companyKey: "ck-key", clock: time.clock, sleep: time.sleep });

    const outcome = await transmit(TRANSMITTER_INPUT);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.transmissionId).toBe("doc-200");
      expect(outcome.transmittedAt).toBe(new Date(1_000).toISOString());
    }
    // companyKey skal være båret med på deliver-kaldet (XML er rå).
    expect(calls.deliver[0]!.companyKey).toBe("ck-key");
    expect(calls.deliver[0]!.xml).toBe(TRANSMITTER_INPUT.oioublXml);
    // Ingen polling når allerede delivered.
    expect(calls.status).toHaveLength(0);
    expect(time.slept).toHaveLength(0);
  });

  test("ksefEnvironment is forwarded to deliver when configured", async () => {
    const { client, calls } = fakeClient({
      deliver: ok<DeliverDocumentResponse>({
        statusCode: 200,
        documentStatus: "delivered",
        documentId: "doc-env",
        message: "ok",
        publicUrl: "https://pub",
      }),
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, {
      companyKey: "ck",
      ksefEnvironment: "TEST",
      clock: time.clock,
      sleep: time.sleep,
    });
    const outcome = await transmit(TRANSMITTER_INPUT);
    expect(outcome.ok).toBe(true);
    expect(calls.deliver[0]!.ksefEnvironment).toBe("TEST");
  });
});

describe("digisense transmitter — 202 queued triggers polling", () => {
  test("polls document-status until delivered, then acknowledges", async () => {
    const { client, calls } = fakeClient({
      deliver: ok<DeliverDocumentResponse>(
        { statusCode: 202, documentStatus: "queued-for-delivery", documentId: "doc-202", message: "queued", publicUrl: "" },
        202,
      ),
      statuses: [
        ok<DocumentStatusResponse>({ statusCode: 202, documentStatus: "queued-for-delivery", documentId: "doc-202", message: "still queued", publicUrl: "" }),
        ok<DocumentStatusResponse>({ statusCode: 200, documentStatus: "delivered", documentId: "doc-202", message: "done", publicUrl: "https://pub/202" }),
      ],
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, {
      companyKey: "ck-poll",
      clock: time.clock,
      sleep: time.sleep,
      pollIntervalMs: 500,
      maxPollAttempts: 5,
    });

    const outcome = await transmit(TRANSMITTER_INPUT);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.transmissionId).toBe("doc-202");
      // transmittedAt = uret efter de to sleeps (2 × 500ms).
      expect(outcome.transmittedAt).toBe(new Date(1_000).toISOString());
    }
    // Pollede præcis to gange med doc-id + companyKey.
    expect(calls.status).toEqual([
      { documentId: "doc-202", companyKey: "ck-poll" },
      { documentId: "doc-202", companyKey: "ck-poll" },
    ]);
    expect(time.slept).toEqual([500, 500]);
  });

  test("a terminal failure status (unable-to-deliver) rejects without further polling", async () => {
    const { client, calls } = fakeClient({
      deliver: ok<DeliverDocumentResponse>(
        { statusCode: 202, documentStatus: "queued-for-delivery", documentId: "doc-fail", message: "queued", publicUrl: "" },
        202,
      ),
      statuses: [
        ok<DocumentStatusResponse>({ statusCode: 422, documentStatus: "unable-to-deliver", documentId: "doc-fail", message: "receiver rejected", publicUrl: "" }),
        // Hvis transmitteren poller videre efter terminal-fejl fanges det her:
        ok<DocumentStatusResponse>({ statusCode: 200, documentStatus: "delivered", documentId: "doc-fail", message: "should-not-reach", publicUrl: "" }),
      ],
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, { companyKey: "ck", clock: time.clock, sleep: time.sleep });

    const outcome = await transmit(TRANSMITTER_INPUT);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("unable-to-deliver");
      expect(outcome.error).toContain("receiver rejected");
    }
    // Kun ÉT status-poll: terminal fejl stopper loopet.
    expect(calls.status).toHaveLength(1);
  });

  test("a document-not-valid status rejects", async () => {
    const { client } = fakeClient({
      deliver: ok<DeliverDocumentResponse>(
        { statusCode: 202, documentStatus: "queued-for-delivery", documentId: "doc-nv", message: "queued", publicUrl: "" },
        202,
      ),
      statuses: [
        ok<DocumentStatusResponse>({ statusCode: 422, documentStatus: "document-not-valid", documentId: "doc-nv", message: "schematron", publicUrl: "" }),
      ],
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, { companyKey: "ck", clock: time.clock, sleep: time.sleep });
    const outcome = await transmit(TRANSMITTER_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("document-not-valid");
  });

  test("a transient status keeps polling until the bounded attempt budget is exhausted", async () => {
    const { client, calls } = fakeClient({
      deliver: ok<DeliverDocumentResponse>(
        { statusCode: 202, documentStatus: "queued-for-delivery", documentId: "doc-timeout", message: "queued", publicUrl: "" },
        202,
      ),
      statuses: [
        // Aldrig terminal — loopet skal stoppe på maxPollAttempts, ikke hænge.
        ok<DocumentStatusResponse>({ statusCode: 202, documentStatus: "temporary-upstream-error", documentId: "doc-timeout", message: "retry later", publicUrl: "" }),
      ],
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, {
      companyKey: "ck",
      clock: time.clock,
      sleep: time.sleep,
      pollIntervalMs: 100,
      maxPollAttempts: 3,
    });

    const outcome = await transmit(TRANSMITTER_INPUT);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.toLowerCase()).toContain("timed out");
      expect(outcome.error).toContain("doc-timeout");
    }
    // Præcis maxPollAttempts polls, ikke uendeligt.
    expect(calls.status).toHaveLength(3);
    expect(time.slept).toHaveLength(3);
  });

  test("preserves the queued document id when a later status HTTP error occurs", async () => {
    const { client } = fakeClient({
      deliver: ok<DeliverDocumentResponse>({ statusCode: 202, documentStatus: "queued-for-delivery", documentId: "doc-guard", message: "queued", publicUrl: "" }, 202),
      statuses: [{ ok: false, error: { status: 503, message: "upstream unavailable" } }],
    });
    const transmit = createDigisenseTransmitter(client, { companyKey: "ck", sleep: async () => {} });
    const outcome = await transmit(TRANSMITTER_INPUT);
    expect(outcome).toMatchObject({ ok: false, queuedDocumentId: "doc-guard" });
  });
});

describe("digisense transmitter — deliver-level errors", () => {
  test("a non-2xx deliver response rejects without polling", async () => {
    const { client, calls } = fakeClient({
      deliver: { ok: false, error: { status: 503, message: "digisense responded 503", body: "upstream down" } },
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, { companyKey: "ck", clock: time.clock, sleep: time.sleep });

    const outcome = await transmit(TRANSMITTER_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("503");
    expect(calls.status).toHaveLength(0);
  });

  test("a 4xx deliver documentStatus rejects immediately", async () => {
    const { client } = fakeClient({
      deliver: ok<DeliverDocumentResponse>(
        { statusCode: 422, documentStatus: "document-not-valid", documentId: "doc-4xx", message: "rejected at deliver", publicUrl: "" },
        // Klienten mapper ikke-2xx til ok:false; men hvis access point svarer
        // 200 med en fejl-documentStatus i body fanges det også:
        200,
      ),
    });
    const time = fakeTime();
    const transmit = createDigisenseTransmitter(client, { companyKey: "ck", clock: time.clock, sleep: time.sleep });
    const outcome = await transmit(TRANSMITTER_INPUT);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("document-not-valid");
  });
});
