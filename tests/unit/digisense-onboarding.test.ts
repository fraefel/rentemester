import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { saveDigisenseSecretConfig } from "../../src/core/efaktura/digisense-config";
import { getDigisenseOnboardingStatus, onboardDigisenseCompany } from "../../src/core/efaktura/digisense-onboarding";
import type { DigisenseClient } from "../../src/core/efaktura/digisense-client";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-digisense-onboard-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  db.run("INSERT INTO companies (id, cvr, name) VALUES (1, 'DK12345678', 'Onboard ApS')");
  saveDigisenseSecretConfig(root, { apiLicenseKey: "top-secret-license", environment: "test" });
  return { root, db };
}

function client(calls: string[]): DigisenseClient {
  return {
    async validateAuth() {
      calls.push("validate-auth");
      return { ok: true as const, status: 200, data: { apiLicenseKey: "top-secret-license", label: "Rentemester", signatureSecret: "top-secret-signature", testGlnNumber: "5790000000000", companyKeyConstraint: null } };
    },
    async registerCompany(body) {
      calls.push("register-company");
      return { ok: true as const, status: 200, data: { companyKey: `key-${body.companyType.id}`, message: "ok" } };
    },
    async registerParticipant() {
      calls.push("register-participant");
      return { ok: true as const, status: 200, data: { registeredOnNetwork: true, webhookRegistered: false } };
    },
  } as unknown as DigisenseClient;
}

describe("DigiSense onboarding", () => {
  test("is idempotent, becomes bidirectionally ready, and never exposes secrets", async () => {
    const { root, db } = fixture();
    const calls: string[] = [];
    try {
      const first = await onboardDigisenseCompany(db, root, client(calls), { createdBy: "agent:onboard", createdByProgram: "rentemester-mcp" });
      const second = await onboardDigisenseCompany(db, root, client(calls));
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const status = getDigisenseOnboardingStatus(db, root);
      expect(status.ready).toBe(true);
      expect(status.inboundReady).toBe(true);
      expect(status.outboundReady).toBe(true);
      expect(calls.filter((call) => call === "register-company")).toHaveLength(1);
      expect(JSON.stringify(status)).not.toContain("top-secret");
      expect(JSON.stringify(first)).not.toContain("signature");
      const audit = db.query("SELECT actor FROM audit_log WHERE event_type = 'digisense_company_registered'").get() as { actor: string };
      expect(audit.actor).toBe("agent:onboard via rentemester-mcp");
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
