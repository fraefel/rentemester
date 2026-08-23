import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../../src/core/workspace";
import { startCockpitServer } from "../../src/server/app";
import { resolveServerConfig } from "../../src/server/config";

const AUTH_ENV = {
  RENTEMESTER_DEPLOYMENT_PROFILE: "hosted",
  RENTEMESTER_AUTH_SECRET: "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ",
  RENTEMESTER_AUTH_BASE_URL: "https://cockpit.example.test",
  RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://cockpit.example.test",
  RENTEMESTER_AUTH_EMAIL_PROVIDER: "http-json-v1",
  RENTEMESTER_AUTH_EMAIL_URL: "https://mail-gateway.example.test/send",
  RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN: "synthetic-test-token",
  RENTEMESTER_AUTH_EMAIL_FROM: "auth@rentemester.example.test",
  RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-real-ip",
  RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "proxy-overwrites-client-ip-header-v1",
};

describe("hosted cockpit composition", () => {
  test("opens Better Auth only for a validated hosted profile and closes it with the server", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rentemester-hosted-profile-"));
    try {
      initWorkspace(workspace);
      const cockpit = startCockpitServer(resolveServerConfig({
        workspaceRoot: workspace,
        host: "127.0.0.1",
        port: 0,
        env: AUTH_ENV,
      }));
      try {
        expect(cockpit.config.deploymentProfile).toBe("hosted");
        expect(cockpit.config.authRequired).toBe(true);
        expect(cockpit.config.betterAuthProvider).toBeDefined();
        const health = await fetch(`${cockpit.url}/api/health`);
        expect(health.status).toBe(200);
        const healthBody = await health.text();
        expect(JSON.parse(healthBody)).toMatchObject({ deploymentProfile: "hosted" });
        expect(healthBody).not.toContain(AUTH_ENV.RENTEMESTER_AUTH_SECRET);
        expect(healthBody).not.toContain(AUTH_ENV.RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN);
      } finally {
        cockpit.stop();
        cockpit.stop();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
