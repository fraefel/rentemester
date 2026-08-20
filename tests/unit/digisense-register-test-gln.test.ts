import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { saveDigisenseCompany } from "../../src/core/efaktura/digisense-state";
import { registerDigisenseTestGln } from "../../src/core/efaktura/digisense-register-test-gln";
import type { DigisenseClient, RegisterParticipantRequest } from "../../src/core/efaktura/digisense-client";

const COMPANY_KEY = "local-company-key";
const TEST_GLN = "5790000000001";

function freshLedger() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-test-gln-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  saveDigisenseCompany(db, {
    companyKey: COMPANY_KEY,
    companyType: { type: "DK:CVR", id: "DK12345678" },
    companyName: "Untouched CVR ApS",
  });
  return { root, db };
}

function fakeClient(options: {
  constraint?: string | null;
  gln?: string;
  fail?: boolean;
  registeredOnNetwork?: boolean;
} = {}) {
  const calls: Array<{ network: string; body: RegisterParticipantRequest }> = [];
  const client = {
    async validateAuth() {
      return {
        ok: true as const,
        status: 200,
        data: {
          apiLicenseKey: "secret-not-for-output",
          label: "vendor-label-not-for-output",
          signatureSecret: "secret-not-for-output",
          testGlnNumber: options.gln ?? TEST_GLN,
          companyKeyConstraint: options.constraint === undefined ? COMPANY_KEY : options.constraint,
        },
      };
    },
    async registerParticipant(network: string, body: RegisterParticipantRequest) {
      calls.push({ network, body });
      return options.fail
        ? { ok: false as const, error: { status: 500, message: "vendor response not for output", body: "secret vendor body" } }
        : {
            ok: true as const,
            status: 200,
            data: {
              registeredOnNetwork: options.registeredOnNetwork ?? true,
              webhookRegistered: false,
            },
          };
    },
  } as unknown as DigisenseClient;
  return { client, calls };
}

describe("registerDigisenseTestGln", () => {
  test("uses the authorized test GLN in the exact inbound NemHandel request and preserves CVR state", async () => {
    const { root, db } = freshLedger();
    const { client, calls } = fakeClient();
    try {
      const cvrBefore = db.query("SELECT company_key, company_type, participant_id, company_name, registered_at FROM digisense_companies").all();
      expect(await registerDigisenseTestGln(db, client)).toEqual({ ok: true, registered: true });
      expect(calls).toEqual([{
        network: "nemhandel",
        body: {
          direction: "inbound", participantType: "GLN", participantId: TEST_GLN,
          companyKey: COMPANY_KEY, webhookUrl: null, documentProfiles: "default-nemhandel",
        },
      }]);
      expect(db.query("SELECT company_key, company_type, participant_id, company_name, registered_at FROM digisense_companies").all()).toEqual(cvrBefore);
      const audit = db.query("SELECT message FROM audit_log WHERE event_type LIKE 'digisense_test_gln_registration_%'").all() as Array<{ message: string }>;
      expect(audit.map((row) => row.message)).toEqual([
        "Digisense test GLN registration requested",
        "Digisense test GLN registration completed",
      ]);
      expect(JSON.stringify(audit)).not.toContain(TEST_GLN);
      expect(JSON.stringify(audit)).not.toContain(COMPANY_KEY);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("rejects a company-key constraint mismatch before POST", async () => {
    const { root, db } = freshLedger();
    const { client, calls } = fakeClient({ constraint: "another-company" });
    try {
      expect(await registerDigisenseTestGln(db, client)).toEqual({ ok: false, errors: ["Digisense test GLN is not authorized for the local company"] });
      expect(calls).toHaveLength(0);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("accepts an unconstrained license and still binds the GLN request to the local company", async () => {
    const { root, db } = freshLedger();
    const { client, calls } = fakeClient({ constraint: null });
    try {
      expect(await registerDigisenseTestGln(db, client)).toEqual({ ok: true, registered: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body.companyKey).toBe(COMPANY_KEY);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("treats a 200 response without network registration as a generic failure", async () => {
    const { root, db } = freshLedger();
    const { client } = fakeClient({ registeredOnNetwork: false });
    try {
      expect(await registerDigisenseTestGln(db, client)).toEqual({
        ok: false,
        errors: ["Digisense test GLN registration failed"],
      });
      const events = db.query(
        "SELECT event_type, message FROM audit_log WHERE event_type LIKE 'digisense_test_gln_registration_%' ORDER BY id",
      ).all() as Array<{ event_type: string; message: string }>;
      expect(events.map((row) => row.event_type)).toEqual([
        "digisense_test_gln_registration_intended",
        "digisense_test_gln_registration_failed",
      ]);
      expect(JSON.stringify(events)).not.toContain(TEST_GLN);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("is idempotent and never exposes vendor failures or writes sensitive audit text", async () => {
    const { root, db } = freshLedger();
    const { client, calls } = fakeClient({ fail: true });
    try {
      const first = await registerDigisenseTestGln(db, client);
      const second = await registerDigisenseTestGln(db, client);
      expect(first).toEqual({ ok: false, errors: ["Digisense test GLN registration failed"] });
      expect(second).toEqual(first);
      expect(calls).toHaveLength(2);
      const auditText = JSON.stringify(db.query("SELECT message FROM audit_log WHERE event_type LIKE 'digisense_test_gln_registration_%'").all());
      expect(auditText).not.toContain("vendor response not for output");
      expect(auditText).not.toContain("secret vendor body");
      expect(auditText).not.toContain(TEST_GLN);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
