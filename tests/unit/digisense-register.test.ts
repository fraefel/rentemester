// Tests: src/core/efaktura/digisense-register.ts — REGISTRÉR-stien.
//
// INGEN rigtige netkald: DigisenseClient injiceres som en fake der optager hvert
// kald og svarer forudbestemt. Samme injection-mønster som PeppolTransmitter i
// public-einvoice.test.ts og DigisenseClient i digisense-receive.test.ts.
//
// Flowet der dækkes:
//   register-company (DK:CVR) -> companyKey gemmes i state-laget
//   -> register-participant/nemhandel for BÅDE outbound OG inbound
//   -> idempotent re-run (ingen dublet, ingen hård fejl).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import {
  listDigisenseCompanies,
  listDigisenseParticipants,
  getDigisenseCompanyByParticipantId,
} from "../../src/core/efaktura/digisense-state";
import { registerDigisenseCompany } from "../../src/core/efaktura/digisense-register";
import type {
  DigisenseClient,
  DigisenseNetwork,
  RegisterCompanyRequest,
  RegisterParticipantRequest,
} from "../../src/core/efaktura/digisense-client";

function freshLedger(label: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-digisense-register-${label}-`));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

type RecordedCall =
  | { kind: "register-company"; body: RegisterCompanyRequest }
  | { kind: "register-participant"; network: DigisenseNetwork; body: RegisterParticipantRequest };

/**
 * En fake DigisenseClient der KUN implementerer REGISTRÉR-overfladen
 * (registerCompany + registerParticipant) og optager hvert kald. Resten kaster,
 * så en utilsigtet brug fanges i test. companyKey er stabil pr. participantId så
 * et re-run rammer den samme upsert-nøgle.
 */
function fakeRegisterClient(): { client: DigisenseClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = {
    async registerCompany(body) {
      calls.push({ kind: "register-company", body });
      return {
        ok: true as const,
        status: 200,
        data: { companyKey: `ck-${body.companyType.id}`, message: "registered" },
      };
    },
    async registerParticipant(network, body) {
      calls.push({ kind: "register-participant", network, body });
      return {
        ok: true as const,
        status: 200,
        data: { registeredOnNetwork: true, webhookRegistered: false },
      };
    },
  } as unknown as DigisenseClient;
  return { client, calls };
}

const CVR = "DK12345678";

describe("registerDigisenseCompany — happy path", () => {
  test("registers the company, saves the companyKey, and registers inbound+outbound", async () => {
    const { root, db } = freshLedger("happy");
    const { client, calls } = fakeRegisterClient();
    try {
      const result = await registerDigisenseCompany(db, root, client, {
        companyType: { type: "DK:CVR", id: CVR },
        companyName: "Min Virksomhed ApS",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.companyKey).toBe(`ck-${CVR}`);
        expect(result.directionsRegistered.sort()).toEqual(["inbound", "outbound"]);
      }

      // register-company called once; participant registered for BOTH directions.
      expect(calls.filter((c) => c.kind === "register-company")).toHaveLength(1);
      const participantCalls = calls.filter((c) => c.kind === "register-participant");
      expect(participantCalls).toHaveLength(2);
      for (const call of participantCalls) {
        if (call.kind !== "register-participant") continue;
        expect(call.network).toBe("nemhandel");
        expect(call.body.documentProfiles).toBe("default-nemhandel");
        // webhookUrl=null => we poll ourselves (no always-on server).
        expect(call.body.webhookUrl).toBeNull();
        expect(call.body.companyKey).toBe(`ck-${CVR}`);
        expect(call.body.participantType).toBe("DK:CVR");
        expect(call.body.participantId).toBe(CVR);
      }

      // companyKey persisted in the state layer, keyed on the participant id.
      const company = getDigisenseCompanyByParticipantId(db, CVR);
      expect(company).not.toBeNull();
      expect(company!.companyKey).toBe(`ck-${CVR}`);

      // Both participant rows persisted.
      const participants = listDigisenseParticipants(db, `ck-${CVR}`);
      expect(participants).toHaveLength(2);
      expect(participants.map((p) => p.direction).sort()).toEqual(["inbound", "outbound"]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the Peppol document profile when registering on Peppol", async () => {
    const { root, db } = freshLedger("peppol-profile");
    const { client, calls } = fakeRegisterClient();
    try {
      const result = await registerDigisenseCompany(db, root, client, {
        companyType: { type: "DK:CVR", id: CVR },
        companyName: "Min Virksomhed ApS",
        network: "peppol",
      });
      expect(result.ok).toBe(true);
      const participantCalls = calls.filter((call) => call.kind === "register-participant");
      expect(participantCalls).toHaveLength(2);
      for (const call of participantCalls) {
        if (call.kind !== "register-participant") continue;
        expect(call.network).toBe("peppol");
        expect(call.body.documentProfiles).toBe("default-peppol");
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes an audit_log row for the registration", async () => {
    const { root, db } = freshLedger("audit");
    const { client } = fakeRegisterClient();
    try {
      await registerDigisenseCompany(db, root, client, {
        companyType: { type: "DK:CVR", id: CVR },
        companyName: "Min Virksomhed ApS",
      });
      const audit = db
        .query("SELECT event_type, message FROM audit_log WHERE event_type = 'digisense_company_registered'")
        .all() as Array<{ event_type: string; message: string }>;
      expect(audit.length).toBeGreaterThanOrEqual(1);
      expect(audit[0]!.message).toContain(CVR);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("registerDigisenseCompany — idempotent re-run", () => {
  test("re-registering the same CVR does not duplicate state and does not hard-fail", async () => {
    const { root, db } = freshLedger("idempotent");
    const { client, calls } = fakeRegisterClient();
    try {
      const first = await registerDigisenseCompany(db, root, client, {
        companyType: { type: "DK:CVR", id: CVR },
        companyName: "Min Virksomhed ApS",
      });
      const second = await registerDigisenseCompany(db, root, client, {
        companyType: { type: "DK:CVR", id: CVR },
        companyName: "Min Virksomhed ApS",
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(calls.filter((call) => call.kind === "register-company")).toHaveLength(1);

      // No duplicate company row; exactly one (inbound+outbound) participant pair.
      expect(listDigisenseCompanies(db)).toHaveLength(1);
      expect(listDigisenseParticipants(db, `ck-${CVR}`)).toHaveLength(2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("registerDigisenseCompany — error handling", () => {
  test("a failed register-company surfaces an error and persists no state", async () => {
    const { root, db } = freshLedger("company-fail");
    const calls: RecordedCall[] = [];
    const client = {
      async registerCompany(body: RegisterCompanyRequest) {
        calls.push({ kind: "register-company", body });
        return { ok: false as const, error: { status: 500, message: "boom" } };
      },
      async registerParticipant() {
        throw new Error("must not register a participant when company registration failed");
      },
    } as unknown as DigisenseClient;
    try {
      const result = await registerDigisenseCompany(db, root, client, {
        companyType: { type: "DK:CVR", id: CVR },
        companyName: "Acme ApS",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("boom");
      expect(listDigisenseCompanies(db)).toHaveLength(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed participant registration surfaces an error but keeps the saved companyKey", async () => {
    const { root, db } = freshLedger("participant-fail");
    const client = {
      async registerCompany(body: RegisterCompanyRequest) {
        return { ok: true as const, status: 200, data: { companyKey: `ck-${body.companyType.id}`, message: "ok" } };
      },
      async registerParticipant() {
        return { ok: false as const, error: { status: 502, message: "network down" } };
      },
    } as unknown as DigisenseClient;
    try {
      const result = await registerDigisenseCompany(db, root, client, {
        companyType: { type: "DK:CVR", id: CVR },
        companyName: "Acme ApS",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("network down");
      // The companyKey was saved before participant registration; re-run can retry.
      expect(getDigisenseCompanyByParticipantId(db, CVR)!.companyKey).toBe(`ck-${CVR}`);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
