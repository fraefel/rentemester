import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { saveDigisenseCompany, listDigisenseParticipants } from "../../src/core/efaktura/digisense-state";
import { registerDigisenseTestSender } from "../../src/core/efaktura/digisense-register-test-sender";
import type { DigisenseClient, RegisterParticipantRequest } from "../../src/core/efaktura/digisense-client";

function freshLedger() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-test-sender-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  saveDigisenseCompany(db, {
    companyKey: "local-company-key",
    companyType: { type: "DK:CVR", id: "DK12345678" },
    companyName: "Test ApS",
  });
  return { root, db };
}

describe("registerDigisenseTestSender", () => {
  test("registers the exact bare scheme-0184 supplier endpoint on Peppol", async () => {
    const { root, db } = freshLedger();
    const calls: Array<{ network: string; body: RegisterParticipantRequest }> = [];
    const client = {
      async validateAuth() {
        return { ok: true as const, status: 200, data: { apiLicenseKey: "secret", label: "test", signatureSecret: "secret", testGlnNumber: "5790000000001", companyKeyConstraint: null } };
      },
      async registerParticipant(network: string, body: RegisterParticipantRequest) {
        calls.push({ network, body });
        return { ok: true as const, status: 200, data: { registeredOnNetwork: true, webhookRegistered: false } };
      },
    } as unknown as DigisenseClient;
    try {
      expect(await registerDigisenseTestSender(db, client)).toEqual({ ok: true, registered: true });
      expect(calls).toEqual([{ network: "peppol", body: {
        direction: "outbound", participantType: "DK:CVR", participantId: "12345678",
        companyKey: "local-company-key", webhookUrl: null, documentProfiles: "default-peppol",
      } }]);
      expect(listDigisenseParticipants(db, "local-company-key")).toMatchObject([{
        network: "peppol", direction: "outbound", participantId: "12345678",
      }]);
      const audit = JSON.stringify(db.query("select message from audit_log where event_type like 'digisense_test_sender_registration_%'").all());
      expect(audit).not.toContain("12345678");
      expect(audit).not.toContain("local-company-key");
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
