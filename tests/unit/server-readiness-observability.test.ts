import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openWorkspaceControlDb, workspaceControlPaths } from "../../src/core/workspace-control";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug, loadWorkspaceManifest, saveWorkspaceManifest } from "../../src/core/workspace";
import { observeRequest, type RequestLogEvent } from "../../src/server/observability";
import { startCockpitServer } from "../../src/server/app";
import { handleRequest } from "../../src/server/router";
import { config, get, makeWorkspace } from "./server-api/_shared";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function prepareReadyWorkspace(label: string, companies = ["Ready Example ApS"]): string {
  const workspace = makeWorkspace(label, companies);
  const control = openWorkspaceControlDb(workspace);
  control.close();
  return workspace;
}

describe("workspace readiness", () => {
  test("is public, verifies all registered ledgers read-only, and never discovers directories", async () => {
    const workspace = prepareReadyWorkspace("ready-clean");
    try {
      const manifest = loadWorkspaceManifest(workspace);
      // The populated company remains on disk but deliberately unlisted.
      saveWorkspaceManifest(workspace, { ...manifest, companies: [] });
      const beforeManifest = sha256(join(workspace, "workspace.json"));
      const ledger = companyPaths(companyRootForSlug(workspace, "ready-example-aps")).db;
      const beforeLedger = sha256(ledger);
      const beforeControl = sha256(workspaceControlPaths(workspace).db);

      const result = await get(config({ workspaceRoot: workspace }), "/api/ready");

      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        ok: true,
        ready: true,
        checks: {
          workspaceManifest: "ok",
          workspaceControl: "ok",
          companyLedgers: "ok",
        },
        companyCount: 0,
      });
      expect(sha256(join(workspace, "workspace.json"))).toBe(beforeManifest);
      expect(sha256(ledger)).toBe(beforeLedger);
      expect(sha256(workspaceControlPaths(workspace).db)).toBe(beforeControl);
      expect(loadWorkspaceManifest(workspace).companies).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fails closed without creating a missing control database or leaking diagnostics", async () => {
    const workspace = makeWorkspace("ready-missing-control", ["Private Example ApS"]);
    try {
      const controlPath = workspaceControlPaths(workspace).db;
      expect(existsSync(controlPath)).toBe(false);

      const result = await get(config({ workspaceRoot: workspace }), "/api/ready");
      const serialized = JSON.stringify(result.body);

      expect(result.status).toBe(503);
      expect(result.body).toEqual({
        ok: false,
        ready: false,
        checks: {
          workspaceManifest: "ok",
          workspaceControl: "failed",
          companyLedgers: "ok",
        },
        companyCount: 1,
      });
      expect(existsSync(controlPath)).toBe(false);
      expect(serialized).not.toContain(workspace);
      expect(serialized).not.toContain("private-example-aps");
      expect(serialized).not.toContain("Private Example ApS");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("fails as one aggregate when a registered ledger is absent", async () => {
    const workspace = prepareReadyWorkspace("ready-missing-ledger");
    try {
      const manifest = loadWorkspaceManifest(workspace);
      saveWorkspaceManifest(workspace, {
        ...manifest,
        companies: manifest.companies.map((company) => ({ ...company, archived: true })),
      });
      unlinkSync(companyPaths(companyRootForSlug(workspace, "ready-example-aps")).db);
      const result = await get(config({ workspaceRoot: workspace }), "/api/ready");
      expect(result.status).toBe(503);
      expect(result.body.checks).toEqual({
        workspaceManifest: "ok",
        workspaceControl: "ok",
        companyLedgers: "failed",
      });
      expect(JSON.stringify(result.body)).not.toContain("ready-example-aps");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("request completion observability", () => {
  test("Bun.serve composition emits the same single safe completion event", async () => {
    const workspace = prepareReadyWorkspace("request-log-app");
    const events: RequestLogEvent[] = [];
    try {
      const cockpit = startCockpitServer(config({
        workspaceRoot: workspace,
        port: 0,
        requestIdFactory: () => "app-request-789",
        requestLogSink: { emit: (event) => events.push(event) },
      }));
      try {
        const response = await fetch(`${cockpit.url}/api/ready`);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-request-id")).toBe("app-request-789");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          event: "http_request_complete",
          pathTemplate: "/api/ready",
          requestId: "app-request-789",
          status: 200,
        });
      } finally {
        cockpit.stop();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("emits one allowlisted event, sanitises the route, and echoes only a valid request id", async () => {
    const workspace = prepareReadyWorkspace("request-log");
    const events: RequestLogEvent[] = [];
    let tick = 1_700_000_000_000;
    try {
      const response = await observeRequest(
        new Request("http://localhost/api/health?email=private@example.test&token=top-secret", {
          headers: { "x-request-id": "trace-123" },
        }),
        config({
          workspaceRoot: workspace,
          requestLogSink: { emit: (event) => events.push(event) },
          requestLogClock: () => (tick += 7),
        }),
        handleRequest,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("trace-123");
      expect(events).toEqual([{
        timestamp: new Date(1_700_000_000_007).toISOString(),
        level: "info",
        event: "http_request_complete",
        requestId: "trace-123",
        method: "GET",
        pathTemplate: "/api/health",
        status: 200,
        durationMs: 7,
        deploymentProfile: "local",
      }]);
      expect(JSON.stringify(events)).not.toContain("private@example.test");
      expect(JSON.stringify(events)).not.toContain("top-secret");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("invalid inbound ids are replaced, unknown paths are bucketed, and a sink failure is harmless", async () => {
    const workspace = prepareReadyWorkspace("request-log-safe");
    const events: RequestLogEvent[] = [];
    try {
      const response = await observeRequest(
        new Request("http://localhost/api/not-a-route/private@example.test", {
          headers: { "x-request-id": "invalid request id" },
        }),
        config({
          workspaceRoot: workspace,
          requestIdFactory: () => "generated-456",
          requestLogSink: { emit: (event) => events.push(event) },
        }),
        handleRequest,
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("x-request-id")).toBe("generated-456");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        level: "warn",
        requestId: "generated-456",
        pathTemplate: "/api/*",
        status: 404,
      });
      expect(JSON.stringify(events)).not.toContain("private@example.test");

      const stillServed = await observeRequest(
        new Request("http://localhost/api/health"),
        config({ workspaceRoot: workspace, requestLogSink: { emit: () => { throw new Error("sink unavailable"); } } }),
        handleRequest,
      );
      expect(stillServed.status).toBe(200);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("buckets non-standard HTTP methods instead of copying attacker-controlled tokens into logs", async () => {
    const workspace = prepareReadyWorkspace("request-log-method");
    const events: RequestLogEvent[] = [];
    try {
      const serverConfig = config({
        workspaceRoot: workspace,
        requestLogSink: { emit: (event: RequestLogEvent) => events.push(event) },
        requestIdFactory: () => "generated-method-id",
      });
      // Bun's Request constructor normalises some non-standard tokens, so use
      // the narrow structural surface consumed by observeRequest here.
      const request = {
        method: "BREW",
        url: "http://localhost/api/unknown",
        headers: new Headers(),
      } as Request;

      await observeRequest(request, serverConfig, async () => new Response(null, { status: 405 }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ method: "OTHER", pathTemplate: "/api/*", status: 405 });
      expect(JSON.stringify(events)).not.toContain("BREW");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
