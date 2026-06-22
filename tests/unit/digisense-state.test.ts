// Tests: src/core/efaktura/digisense-state.ts — companyKey↔virksomhed +
// participant-state i ledger-DB'en (mutabel, ikke append-only).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import {
  getDigisenseCompanyByParticipantId,
  listDigisenseCompanies,
  listDigisenseParticipants,
  saveDigisenseCompany,
  saveDigisenseParticipant,
} from "../../src/core/efaktura/digisense-state";

function freshLedger(label: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-digisense-state-${label}-`));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

describe("migration creates the digisense state tables idempotently", () => {
  test("re-running migrate() does not throw and tables exist", () => {
    const { root, db } = freshLedger("migrate");
    try {
      // The tables must already exist after the first migrate().
      saveDigisenseCompany(db, {
        companyKey: "ck-1",
        companyType: { type: "DK:CVR", id: "DK12345678" },
        companyName: "Acme ApS",
      });
      // A second migrate() (idempotent) must not drop or duplicate the row.
      migrate(db);
      expect(listDigisenseCompanies(db)).toHaveLength(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("digisense_companies — companyKey ↔ virksomhed", () => {
  test("save → lookup by participant id", () => {
    const { root, db } = freshLedger("company");
    try {
      saveDigisenseCompany(db, {
        companyKey: "ck-abc",
        companyType: { type: "DK:CVR", id: "DK12345678" },
        companyName: "Min Virksomhed ApS",
      });
      const got = getDigisenseCompanyByParticipantId(db, "DK12345678");
      expect(got).not.toBeNull();
      expect(got!.companyKey).toBe("ck-abc");
      expect(got!.companyType).toBe("DK:CVR");
      expect(got!.companyName).toBe("Min Virksomhed ApS");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-registering the same participant updates the companyKey in place", () => {
    const { root, db } = freshLedger("reregister");
    try {
      saveDigisenseCompany(db, {
        companyKey: "ck-old",
        companyType: { type: "DK:CVR", id: "DK12345678" },
        companyName: "Acme ApS",
      });
      saveDigisenseCompany(db, {
        companyKey: "ck-new",
        companyType: { type: "DK:CVR", id: "DK12345678" },
        companyName: "Acme ApS",
      });
      expect(listDigisenseCompanies(db)).toHaveLength(1);
      expect(getDigisenseCompanyByParticipantId(db, "DK12345678")!.companyKey).toBe("ck-new");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("digisense_participants — direction × network", () => {
  test("inbound + outbound are separate rows for the same companyKey", () => {
    const { root, db } = freshLedger("participant");
    try {
      saveDigisenseParticipant(db, {
        companyKey: "ck-abc",
        network: "nemhandel",
        direction: "outbound",
        participantType: "DK:CVR",
        participantId: "DK12345678",
        webhookUrl: null,
        registeredOnNetwork: true,
        webhookRegistered: false,
      });
      saveDigisenseParticipant(db, {
        companyKey: "ck-abc",
        network: "nemhandel",
        direction: "inbound",
        participantType: "DK:CVR",
        participantId: "DK12345678",
        webhookUrl: null,
        registeredOnNetwork: true,
        webhookRegistered: false,
      });
      const participants = listDigisenseParticipants(db, "ck-abc");
      expect(participants).toHaveLength(2);
      expect(participants.map((p) => p.direction).sort()).toEqual(["inbound", "outbound"]);
      expect(participants[0]!.webhookUrl).toBeNull();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-registering the same (companyKey, network, direction) updates the row", () => {
    const { root, db } = freshLedger("participant-update");
    try {
      saveDigisenseParticipant(db, {
        companyKey: "ck-abc",
        network: "peppol",
        direction: "inbound",
        participantType: "DK:CVR",
        participantId: "DK12345678",
        webhookUrl: null,
        registeredOnNetwork: false,
        webhookRegistered: false,
      });
      saveDigisenseParticipant(db, {
        companyKey: "ck-abc",
        network: "peppol",
        direction: "inbound",
        participantType: "DK:CVR",
        participantId: "DK12345678",
        webhookUrl: "https://hook.example/peppol",
        registeredOnNetwork: true,
        webhookRegistered: true,
      });
      const participants = listDigisenseParticipants(db, "ck-abc");
      expect(participants).toHaveLength(1);
      expect(participants[0]!.registeredOnNetwork).toBe(true);
      expect(participants[0]!.webhookRegistered).toBe(true);
      expect(participants[0]!.webhookUrl).toBe("https://hook.example/peppol");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
