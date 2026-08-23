// Tests: src/server/router/workspace-writes.ts — CSRF/DNS-rebinding-hærdning af
// de workspace-niveau skriveruter (audit 2026-06-11, SEC-1-BYPASS).
//
// Angrebet: POST /api/companies (handleCompanyCreate) og PATCH
// /api/companies/:slug (handleCompanyUpdate) kaldte IKKE withCompanyMutation —
// de gik direkte til readJsonBody. De manglede derfor de tre gates som dækker
// company-ledger-ruterne: Content-Type, Origin og localhost. Et ondsindet
// website kunne via en CORS simple-request (text/plain, ingen preflight)
// oprette/omdøbe/arkivere virksomheder.
//
// Forsvaret: samme tre gates anvendes nu på begge ruter, FØR body læses.
// Gaten skal virke uden en company-db/ledger (workspace har ingen).
import { describe, expect, test } from "bun:test";
import { config, handleRequest, makeWorkspace, rmSync } from "./_shared";
import { loadWorkspaceManifest, createCompany } from "./_shared";

function companyCount(ws: string): number {
  return loadWorkspaceManifest(ws).companies.length;
}

async function request(
  ws: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
  authRequired = false,
) {
  const cfg = config({
    workspaceRoot: ws,
    ...(authRequired ? { authRequired: true, authToken: "s3cret" } : {}),
  });
  const init: RequestInit = { method, headers: { host: "127.0.0.1", ...headers } };
  if (body !== undefined) init.body = body;
  const res = await handleRequest(new Request(`http://localhost${path}`, init), cfg);
  return { status: res.status, body: await res.json() };
}

describe("POST /api/companies — CSRF-gates (SEC-1-BYPASS)", () => {
  test("(a) text/plain afvises med INVALID_CONTENT_TYPE og opretter intet", async () => {
    const ws = makeWorkspace("ws-create-textplain");
    try {
      const before = companyCount(ws);
      const res = await request(
        ws,
        "POST",
        "/api/companies",
        { "content-type": "text/plain" },
        JSON.stringify({ name: "Evil ApS" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.subcode).toBe("INVALID_CONTENT_TYPE");
      expect(companyCount(ws)).toBe(before);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(b) Origin: https://evil.example afvises med FORBIDDEN_ORIGIN og opretter intet", async () => {
    const ws = makeWorkspace("ws-create-evil-origin");
    try {
      const before = companyCount(ws);
      const res = await request(
        ws,
        "POST",
        "/api/companies",
        { "content-type": "application/json", origin: "https://evil.example" },
        JSON.stringify({ name: "Evil ApS" }),
      );
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.subcode).toBe("FORBIDDEN_ORIGIN");
      expect(companyCount(ws)).toBe(before);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(c) Origin: http://localhost:5319 (Bun-dev) tillades", async () => {
    const ws = makeWorkspace("ws-create-bun-origin");
    try {
      const res = await request(
        ws,
        "POST",
        "/api/companies",
        { "content-type": "application/json", origin: "http://localhost:5319" },
        JSON.stringify({ name: "Acme ApS" }),
      );
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(d) ingen Origin-header tillades (CLI/curl/ikke-browser)", async () => {
    const ws = makeWorkspace("ws-create-no-origin");
    try {
      const res = await request(
        ws,
        "POST",
        "/api/companies",
        { "content-type": "application/json" },
        JSON.stringify({ name: "Acme ApS" }),
      );
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(e) normal JSON-create virker", async () => {
    const ws = makeWorkspace("ws-create-json-ok");
    try {
      const before = companyCount(ws);
      const res = await request(
        ws,
        "POST",
        "/api/companies",
        { "content-type": "application/json" },
        JSON.stringify({ name: "Acme ApS" }),
      );
      expect(res.status).toBe(201);
      expect(res.body.company.name).toBe("Acme ApS");
      expect(companyCount(ws)).toBe(before + 1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("PATCH /api/companies/:slug — CSRF-gates (SEC-1-BYPASS)", () => {
  function makeWsWithCompany(label: string) {
    const ws = makeWorkspace(label);
    const c = createCompany(ws, { name: "Acme ApS" });
    return { ws, slug: c.slug };
  }

  function nameOf(ws: string, slug: string): string {
    return loadWorkspaceManifest(ws).companies.find((c) => c.slug === slug)!.name;
  }

  test("(a) text/plain afvises og omdøber intet", async () => {
    const { ws, slug } = makeWsWithCompany("ws-patch-textplain");
    try {
      const res = await request(
        ws,
        "PATCH",
        `/api/companies/${slug}`,
        { "content-type": "text/plain" },
        JSON.stringify({ name: "Pwned ApS" }),
      );
      expect(res.status).toBe(400);
      expect(res.body.subcode).toBe("INVALID_CONTENT_TYPE");
      expect(nameOf(ws, slug)).toBe("Acme ApS");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(b) Origin: https://evil.example afvises og omdøber intet", async () => {
    const { ws, slug } = makeWsWithCompany("ws-patch-evil-origin");
    try {
      const res = await request(
        ws,
        "PATCH",
        `/api/companies/${slug}`,
        { "content-type": "application/json", origin: "https://evil.example" },
        JSON.stringify({ name: "Pwned ApS" }),
      );
      expect(res.status).toBe(401);
      expect(res.body.subcode).toBe("FORBIDDEN_ORIGIN");
      expect(nameOf(ws, slug)).toBe("Acme ApS");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(c) Origin: http://localhost:5319 tillades", async () => {
    const { ws, slug } = makeWsWithCompany("ws-patch-bun-origin");
    try {
      const res = await request(
        ws,
        "PATCH",
        `/api/companies/${slug}`,
        { "content-type": "application/json", origin: "http://localhost:5319" },
        JSON.stringify({ name: "Renamed ApS" }),
      );
      expect(res.status).toBe(200);
      expect(nameOf(ws, slug)).toBe("Renamed ApS");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(d) ingen Origin-header tillades", async () => {
    const { ws, slug } = makeWsWithCompany("ws-patch-no-origin");
    try {
      const res = await request(
        ws,
        "PATCH",
        `/api/companies/${slug}`,
        { "content-type": "application/json" },
        JSON.stringify({ name: "Renamed ApS" }),
      );
      expect(res.status).toBe(200);
      expect(nameOf(ws, slug)).toBe("Renamed ApS");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(e) normal JSON-patch virker", async () => {
    const { ws, slug } = makeWsWithCompany("ws-patch-json-ok");
    try {
      const res = await request(
        ws,
        "PATCH",
        `/api/companies/${slug}`,
        { "content-type": "application/json" },
        JSON.stringify({ archived: true }),
      );
      expect(res.status).toBe(200);
      expect(res.body.company.archived).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
