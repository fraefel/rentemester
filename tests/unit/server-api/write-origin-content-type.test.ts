// Tests: src/server/mutations.ts — CSRF/DNS-rebinding-hærdning af Cockpit-
// skrivepipelinen (audit 2026-06-11, SEC-1).
//
// Angrebet: `assertLocalhostWriteAllowed` tjekkede kun Host-headeren (som
// browseren selv sætter til serverens loopback-adresse), og body-læseren
// validerede ikke Content-Type. Et ondsindet website kunne derfor sende en
// CORS-"simple request" (text/plain) med JSON-body — uden preflight — og
// udføre writes inkl. confirm:true mod localhost-API'et.
//
// Forsvaret (to lag, begge i withCompanyMutation):
//   1. Content-Type-gate: en mutation MED en Content-Type-header kræver
//      application/json (stabil subcode INVALID_CONTENT_TYPE). En browser kan
//      ikke sende en bodied cross-origin POST uden Content-Type, så
//      text/plain-vektoren er lukket. En HELT fraværende Content-Type
//      tillades fortsat — det er CLI/curl/ikke-browser-klienter.
//   2. Origin-gate: en mutation med en Origin-header kræver en loopback-
//      origin (http(s)://localhost|127.0.0.1|[::1], vilkårlig port — dækker
//      Bun-dev på 5319, jf. app/scripts/serve.ts). Manglende Origin tillades
//      (ikke-browser-klienter sender ingen). Alt andet afvises med stabil
//      subcode FORBIDDEN_ORIGIN. Gaten træder til side når authRequired er
//      sat — dér er bearer-tokenet gaten (et cross-site angreb kan ikke
//      sætte Authorization-headeren i en simple request).
import { describe, expect, test } from "bun:test";
import {
  config,
  handleRequest,
  makeWorkspace,
  rmSync,
  seedException,
  companyRootForSlug,
  companyPaths,
  openDb,
  migrate,
} from "./_shared";

/** Slug for et workspace-selskab oprettet med navnet "Acme ApS". */
const SLUG = "acme-aps";

function makeCase(label: string) {
  const ws = makeWorkspace(label, ["Acme ApS"]);
  seedException(ws, SLUG, "UNMATCHED_BANK_TRANSACTION", "Banktransaktion mangler afstemning");
  const db = openDb(companyPaths(companyRootForSlug(ws, SLUG)).db);
  let exceptionId: number;
  try {
    migrate(db);
    exceptionId = (db.query("SELECT id FROM exceptions ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
  } finally {
    db.close();
  }
  return { ws, path: `/api/companies/${SLUG}/exceptions/${exceptionId}/resolve`, exceptionId };
}

function exceptionStatus(ws: string, id: number): string {
  const db = openDb(companyPaths(companyRootForSlug(ws, SLUG)).db);
  try {
    migrate(db);
    return (db.query("SELECT status FROM exceptions WHERE id = ?").get(id) as { status: string }).status;
  } finally {
    db.close();
  }
}

async function post(ws: string, path: string, headers: Record<string, string>, body?: string, authRequired = false) {
  const cfg = config({
    workspaceRoot: ws,
    ...(authRequired ? { authRequired: true, authToken: "s3cret" } : {}),
  });
  const init: RequestInit = { method: "POST", headers: { host: "127.0.0.1", ...headers } };
  if (body !== undefined) init.body = body;
  const res = await handleRequest(new Request(`http://localhost${path}`, init), cfg);
  return { status: res.status, body: await res.json() };
}

describe("Cockpit write — Content-Type-gate (SEC-1)", () => {
  test("(a) en text/plain-mutation afvises med INVALID_CONTENT_TYPE og skriver intet", async () => {
    const { ws, path, exceptionId } = makeCase("csrf-textplain");
    try {
      const res = await post(ws, path, { "content-type": "text/plain" }, JSON.stringify({ note: "csrf" }));
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.subcode).toBe("INVALID_CONTENT_TYPE");
      expect(exceptionStatus(ws, exceptionId)).toBe("open");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(e) en almindelig JSON-mutation med application/json virker stadig", async () => {
    const { ws, path } = makeCase("csrf-json-ok");
    try {
      const res = await post(
        ws,
        path,
        { "content-type": "application/json" },
        JSON.stringify({ note: "Afstemt" }),
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("application/json med charset-parameter accepteres", async () => {
    const { ws, path } = makeCase("csrf-json-charset");
    try {
      const res = await post(
        ws,
        path,
        { "content-type": "application/json; charset=utf-8" },
        JSON.stringify({ note: "Afstemt" }),
      );
      expect(res.status).toBe(200);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("fraværende Content-Type tillades fortsat (CLI/curl-klienter, ikke en browser-vektor)", async () => {
    const { ws, path } = makeCase("csrf-no-ct");
    try {
      // Bun's Request auto-sætter IKKE content-type for en string-body, så
      // dette er præcis den header-løse mutation eksisterende klienter sender.
      const res = await post(ws, path, {}, JSON.stringify({ note: "Afstemt" }));
      expect(res.status).toBe(200);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("Cockpit write — Origin-gate (SEC-1)", () => {
  test("(b) Origin: https://evil.example afvises med FORBIDDEN_ORIGIN og skriver intet", async () => {
    const { ws, path, exceptionId } = makeCase("csrf-evil-origin");
    try {
      const res = await post(
        ws,
        path,
        { "content-type": "application/json", origin: "https://evil.example" },
        JSON.stringify({ note: "csrf" }),
      );
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.subcode).toBe("FORBIDDEN_ORIGIN");
      expect(exceptionStatus(ws, exceptionId)).toBe("open");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(c) Origin: http://localhost:5319 (Bun-dev) tillades", async () => {
    const { ws, path } = makeCase("csrf-bun-origin");
    try {
      const res = await post(
        ws,
        path,
        { "content-type": "application/json", origin: "http://localhost:5319" },
        JSON.stringify({ note: "Afstemt" }),
      );
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("loopback-origins på enhver port tillades (127.0.0.1 og [::1])", async () => {
    const { ws, path } = makeCase("csrf-loopback-origins");
    try {
      // To gates, samme exception: første kald skriver, andet er idempotent —
      // begge skal passere Origin-gaten med 200.
      const r1 = await post(
        ws,
        path,
        { "content-type": "application/json", origin: "http://127.0.0.1:60999" },
        JSON.stringify({}),
      );
      expect(r1.status).toBe(200);
      const r2 = await post(
        ws,
        path,
        { "content-type": "application/json", origin: "http://[::1]:4319" },
        JSON.stringify({}),
      );
      expect(r2.status).toBe(200);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("(d) ingen Origin-header tillades (CLI/curl/ikke-browser)", async () => {
    const { ws, path } = makeCase("csrf-no-origin");
    try {
      const res = await post(ws, path, { "content-type": "application/json" }, JSON.stringify({}));
      expect(res.status).toBe(200);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("Origin: null (sandboxed iframe) afvises", async () => {
    const { ws, path } = makeCase("csrf-null-origin");
    try {
      const res = await post(
        ws,
        path,
        { "content-type": "application/json", origin: "null" },
        JSON.stringify({}),
      );
      expect(res.status).toBe(401);
      expect(res.body.subcode).toBe("FORBIDDEN_ORIGIN");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("med authRequired træder Origin-gaten til side — bearer-tokenet er gaten", async () => {
    const { ws, path } = makeCase("csrf-auth-origin");
    try {
      const res = await post(
        ws,
        path,
        {
          "content-type": "application/json",
          origin: "https://cockpit.example.com",
          host: "cockpit.example.com",
          authorization: "Bearer s3cret",
        },
        JSON.stringify({}),
        true,
      );
      expect(res.status).toBe(200);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
