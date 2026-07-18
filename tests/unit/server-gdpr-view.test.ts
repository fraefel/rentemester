// Tests: src/server/router.ts + write-handlers/gdpr.ts.
//
// #334 — cockpittet skal kunne svare på en GDPR-indsigtsanmodning ved at
// finde personoplysninger for en data-subject (CVR eller navn) og
// derefter anonymisere data via en separat write-handler.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleRequest } from "../../src/server/router";
import { type ServerConfig } from "../../src/server/config";
import { createCompany } from "../../src/core/company";
import { companyPaths } from "../../src/core/paths";
import { openDb } from "../../src/core/db";
import { companyRootForSlug, initWorkspace } from "../../src/core/workspace";

function makeWorkspace(label: string, companyNames: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-${label}-`));
  initWorkspace(root);
  for (const name of companyNames) createCompany(root, { name });
  return root;
}

function config(workspaceRoot: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    workspaceRoot,
    authRequired: false,
    authToken: null,
  };
}

async function fetchJson<T>(cfg: ServerConfig, path: string): Promise<T> {
  const res = await handleRequest(new Request(`http://localhost${path}`), cfg);
  return (await res.json()) as T;
}

function gdprPost(path: string, body: Record<string, unknown>, cfg: ServerConfig) {
  return handleRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1",
      },
      body: JSON.stringify(body),
    }),
    cfg,
  );
}

describe("#334 — GDPR-view", () => {
  test("GET /gdpr/export afvises, fordi audit-loggede exports kun er POST", async () => {
    const ws = makeWorkspace("gdpr-no-key", ["Acme ApS"]);
    try {
      const res = await handleRequest(
        new Request("http://localhost/api/companies/acme-aps/gdpr/export"),
        config(ws),
      );
      expect(res.status).toBe(405);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("POST /gdpr/export kræver confirm og skriver intet ved afvisning", async () => {
    const ws = makeWorkspace("gdpr-confirm", ["Acme ApS"]);
    try {
      const res = await gdprPost(
        "/api/companies/acme-aps/gdpr/export",
        { cvr: "DK99999999" },
        config(ws),
      );
      expect(res.status).toBe(400);
      const db = openDb(companyPaths(companyRootForSlug(ws, "acme-aps")).db);
      const count = db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'gdpr_export'")
        .get() as { n: number };
      db.close();
      expect(count.n).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("POST /gdpr/export returnerer rapport og bruger Cockpit-actor", async () => {
    const ws = makeWorkspace("gdpr-empty", ["Acme ApS"]);
    try {
      const response = await gdprPost(
        "/api/companies/acme-aps/gdpr/export",
        { cvr: "DK99999999", confirm: true },
        config(ws),
      );
      const body = (await response.json()) as {
        ok: boolean;
        gdpr: {
          slug: string;
          company: { name: string };
          export: {
            ok: boolean;
            asOf: string;
            subject: { cvr: string | null; name: string | null };
            records: any[];
            appliedRules: string[];
          };
        };
      };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.gdpr.export.ok).toBe(true);
      expect(body.gdpr.export.subject.cvr).toBe("DK99999999");
      expect(body.gdpr.export.records).toEqual([]);
      // appliedRules skal komme fra rules/dk pipelinen
      expect(body.gdpr.export.appliedRules.length).toBeGreaterThan(0);
      const db = openDb(companyPaths(companyRootForSlug(ws, "acme-aps")).db);
      const audit = db
        .query(
          "SELECT actor, entity_id, message FROM audit_log WHERE event_type = 'gdpr_export'",
        )
        .get() as { actor: string; entity_id: string; message: string };
      db.close();
      expect(audit.actor).toBe("system:cockpit via rentemester-cockpit");
      expect(audit.entity_id).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(audit.message).not.toContain("DK99999999");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("POST /gdpr/erase uden cvr/name afvises med 400", async () => {
    const ws = makeWorkspace("gdpr-erase-400", ["Acme ApS"]);
    try {
      const res = await gdprPost(
        "/api/companies/acme-aps/gdpr/erase",
        { confirm: true },
        config(ws),
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("POST /gdpr/erase kræver confirm, afviser asOf og attribuerer beslutningen", async () => {
    const ws = makeWorkspace("gdpr-erase-governance", ["Acme ApS"]);
    const cfg = config(ws);
    try {
      const unconfirmed = await gdprPost(
        "/api/companies/acme-aps/gdpr/erase",
        { cvr: "DK88888888" },
        cfg,
      );
      expect(unconfirmed.status).toBe(400);

      const futureClock = await gdprPost(
        "/api/companies/acme-aps/gdpr/erase",
        { cvr: "DK88888888", asOf: "2099-01-01", confirm: true },
        cfg,
      );
      expect(futureClock.status).toBe(400);

      const accepted = await gdprPost(
        "/api/companies/acme-aps/gdpr/erase",
        { cvr: "DK88888888", confirm: true },
        cfg,
      );
      expect(accepted.status).toBe(200);

      const db = openDb(companyPaths(companyRootForSlug(ws, "acme-aps")).db);
      const decisions = db
        .query(
          "SELECT actor, message FROM audit_log WHERE event_type = 'gdpr_erasure_decision'",
        )
        .all() as Array<{ actor: string; message: string }>;
      db.close();
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.actor).toBe(
        "system:cockpit via rentemester-cockpit",
      );
      expect(decisions[0]!.message).toContain("outcome=no_matching_records");
      expect(decisions[0]!.message).not.toContain("DK88888888");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("rute-kataloget annoncerer /gdpr/export og /gdpr/erase", async () => {
    const ws = makeWorkspace("gdpr-catalog");
    try {
      const body = await fetchJson<{
        routes: Array<{ method: string; pattern: string }>;
      }>(config(ws), "/api/health");
      const patterns = body.routes.map((r) => `${r.method} ${r.pattern}`);
      expect(patterns).toContain("POST /api/companies/:slug/gdpr/export");
      expect(patterns).toContain("POST /api/companies/:slug/gdpr/erase");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
