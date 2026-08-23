import { describe, expect, test } from "bun:test";
import { config, get, makeWorkspace, rmSync } from "./_shared";
import { handleRequest } from "./_shared";
import { LOCALHOST_PRINCIPAL } from "../../../src/server/auth";

describe("cockpit API — auth seam", () => {
  test("phase 1 (localhost-trusted) is a pass-through", async () => {
    const ws = makeWorkspace("auth-passthrough");
    try {
      const res = await get(config({ workspaceRoot: ws }), "/api/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("when auth is enabled the seam rejects an unauthenticated request", async () => {
    const ws = makeWorkspace("auth-reject");
    try {
      const cfg = config({ workspaceRoot: ws, authRequired: true, authToken: "s3cret" });
      const res = await get(cfg, "/api/health");
      expect(res.status).toBe(401);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe("unauthorized");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("when auth is enabled a valid bearer token passes the seam", async () => {
    const ws = makeWorkspace("auth-accept");
    try {
      const cfg = config({ workspaceRoot: ws, authRequired: true, authToken: "s3cret" });
      const res = await get(cfg, "/api/health", {
        headers: { authorization: "Bearer s3cret" },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("an invalid bearer token is rejected", async () => {
    const ws = makeWorkspace("auth-badtoken");
    try {
      const cfg = config({ workspaceRoot: ws, authRequired: true, authToken: "s3cret" });
      const res = await get(cfg, "/api/health", {
        headers: { authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("evaluates authentication exactly once for both a read and mutation", async () => {
    const ws = makeWorkspace("auth-once");
    try {
      let evaluations = 0;
      const cfg = config({
        workspaceRoot: ws,
        authenticateRequest: async () => {
          evaluations += 1;
          return LOCALHOST_PRINCIPAL;
        },
      });
      await handleRequest(new Request("http://localhost/api/health"), cfg);
      expect(evaluations).toBe(1);
      await handleRequest(new Request("http://localhost/api/companies", {
        method: "POST",
        headers: { host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ name: "Once ApS" }),
      }), cfg);
      expect(evaluations).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
