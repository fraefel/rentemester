// Tests: src/server/router.ts, src/server/auth.ts, src/server/errors.ts,
// src/server/config.ts — endpoint contracts, the auth seam, and safe errors.
import { describe, expect, test } from "bun:test";
import { resolveServerConfig } from "./_shared";

describe("cockpit API — config", () => {
  test("defaults to the localhost bind address", () => {
    const cfg = resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: {},
    });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(4319);
    expect(cfg.authRequired).toBe(false);
  });

  test("hosted profile is config-driven and requires an explicit Better Auth contract", () => {
    const cfg = resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: {
        RENTEMESTER_DEPLOYMENT_PROFILE: "hosted",
        RENTEMESTER_APP_HOST: "0.0.0.0",
        RENTEMESTER_APP_PORT: "9000",
        RENTEMESTER_AUTH_SECRET: "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ",
        RENTEMESTER_AUTH_BASE_URL: "https://cockpit.example.test",
        RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://cockpit.example.test,https://admin.example.test",
        RENTEMESTER_AUTH_EMAIL_PROVIDER: "http-json-v1",
        RENTEMESTER_AUTH_EMAIL_URL: "https://mail-gateway.example.test/send",
        RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN: "synthetic-test-token",
        RENTEMESTER_AUTH_EMAIL_FROM: "auth@rentemester.example.test",
        RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-real-ip",
        RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "proxy-overwrites-client-ip-header-v1",
      },
    });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(9000);
    expect(cfg.deploymentProfile).toBe("hosted");
    expect(cfg.authRequired).toBe(true);
    expect(cfg.hostedBetterAuth).toMatchObject({
      baseURL: "https://cockpit.example.test",
      trustedOrigins: ["https://cockpit.example.test", "https://admin.example.test"],
      authEmail: { provider: "http-json-v1", from: "auth@rentemester.example.test" },
    });
  });

  test("required hosted document scanning fails before startup without a complete provider, without echoing its token", () => {
    const base = {
      RENTEMESTER_DEPLOYMENT_PROFILE: "hosted",
      RENTEMESTER_AUTH_SECRET: "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ",
      RENTEMESTER_AUTH_BASE_URL: "https://cockpit.example.test",
      RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://cockpit.example.test",
      RENTEMESTER_AUTH_EMAIL_PROVIDER: "http-json-v1",
      RENTEMESTER_AUTH_EMAIL_URL: "https://mail-gateway.example.test/send",
      RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN: "synthetic-email-token",
      RENTEMESTER_AUTH_EMAIL_FROM: "auth@rentemester.example.test",
      RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-real-ip",
      RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "proxy-overwrites-client-ip-header-v1",
      RENTEMESTER_DOCUMENT_SCANNER_POLICY: "required",
    };
    expect(() => resolveServerConfig({ workspaceRoot: "/tmp/ws", env: base })).toThrow(/SCANNER_PROVIDER/);
    let message = "";
    try {
      resolveServerConfig({ workspaceRoot: "/tmp/ws", env: {
        ...base,
        RENTEMESTER_DOCUMENT_SCANNER_PROVIDER: "http-json-v1",
        RENTEMESTER_DOCUMENT_SCANNER_URL: "https://scanner.example.test/v1/scan",
        RENTEMESTER_DOCUMENT_SCANNER_BEARER_TOKEN: "scanner-private-token",
        RENTEMESTER_DOCUMENT_SCANNER_TIMEOUT_MS: "99",
      } });
    } catch (error) { message = String(error); }
    expect(message).toContain("SCANNER_TIMEOUT_MS");
    expect(message).not.toContain("scanner-private-token");
    const config = resolveServerConfig({ workspaceRoot: "/tmp/ws", env: {
      ...base,
      RENTEMESTER_DOCUMENT_SCANNER_PROVIDER: "http-json-v1",
      RENTEMESTER_DOCUMENT_SCANNER_URL: "https://scanner.example.test/v1/scan",
      RENTEMESTER_DOCUMENT_SCANNER_BEARER_TOKEN: "scanner-private-token",
      RENTEMESTER_DOCUMENT_SCANNER_TIMEOUT_MS: "1000",
    } });
    expect(config.hostedDocumentScanning).toMatchObject({ policy: "required", provider: { provider: "http-json-v1", timeoutMs: 1000 } });
  });

  test("local profile cannot bind beyond loopback", () => {
    expect(() => resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: { RENTEMESTER_APP_HOST: "0.0.0.0", RENTEMESTER_APP_AUTH: "required" },
    })).toThrow(/local deployment profile/);
  });

  test("local-container profile permits only the explicit internal Docker bind", () => {
    const config = resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: {
        RENTEMESTER_DEPLOYMENT_PROFILE: "local-container",
        RENTEMESTER_APP_HOST: "0.0.0.0",
        RENTEMESTER_APP_AUTH: "off",
      },
    });
    expect(config.deploymentProfile).toBe("local-container");
    expect(config.host).toBe("0.0.0.0");
    expect(config.authRequired).toBe(false);
    expect(() => resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: {
        RENTEMESTER_DEPLOYMENT_PROFILE: "local-container",
        RENTEMESTER_APP_HOST: "127.0.0.1",
      },
    })).toThrow(/must bind 0\.0\.0\.0/);
  });

  test("allows IPv4 and IPv6 loopback without shared-secret auth", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(() => resolveServerConfig({
        workspaceRoot: "/tmp/ws",
        env: { RENTEMESTER_APP_HOST: host },
      })).not.toThrow();
    }
  });

  test("rejects a non-numeric port", () => {
    expect(() =>
      resolveServerConfig({ workspaceRoot: "/tmp/ws", env: { RENTEMESTER_APP_PORT: "abc" } }),
    ).toThrow(/RENTEMESTER_APP_PORT/);
  });

  test("requires a workspace root", () => {
    expect(() => resolveServerConfig({ env: {} })).toThrow(/workspace/);
  });

  test("hosted profile fails closed on missing secret, insecure origin, or incomplete origin allow-list", () => {
    const common = {
      RENTEMESTER_DEPLOYMENT_PROFILE: "hosted",
      RENTEMESTER_AUTH_BASE_URL: "https://cockpit.example.test",
      RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://cockpit.example.test",
      RENTEMESTER_AUTH_EMAIL_PROVIDER: "http-json-v1",
      RENTEMESTER_AUTH_EMAIL_URL: "https://mail-gateway.example.test/send",
      RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN: "synthetic-test-token",
      RENTEMESTER_AUTH_EMAIL_FROM: "auth@rentemester.example.test",
      RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-real-ip",
      RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "proxy-overwrites-client-ip-header-v1",
    };
    expect(() => resolveServerConfig({ workspaceRoot: "/tmp/ws", env: common })).toThrow(/secret/i);
    expect(() => resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: { ...common, RENTEMESTER_AUTH_SECRET: "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ", RENTEMESTER_AUTH_BASE_URL: "http://localhost:4319" },
    })).toThrow(/HTTPS origin/);
    expect(() => resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: { ...common, RENTEMESTER_AUTH_SECRET: "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ", RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://admin.example.test" },
    })).toThrow(/must include/);
  });

  test("local profile rejects Better Auth environment values rather than silently ignoring them", () => {
    expect(() => resolveServerConfig({
      workspaceRoot: "/tmp/ws",
      env: { RENTEMESTER_AUTH_SECRET: "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ" },
    })).toThrow(/must not configure Better Auth/);
  });

  test("hosted profile fails closed when auth-email is disabled or malformed without reflecting secrets", () => {
    const common = {
      RENTEMESTER_DEPLOYMENT_PROFILE: "hosted",
      RENTEMESTER_AUTH_SECRET: "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ",
      RENTEMESTER_AUTH_BASE_URL: "https://cockpit.example.test",
      RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://cockpit.example.test",
      RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-real-ip",
      RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "proxy-overwrites-client-ip-header-v1",
    };
    expect(() => resolveServerConfig({ workspaceRoot: "/tmp/ws", env: common })).toThrow(/AUTH_EMAIL_PROVIDER/);
    let message = "";
    try {
      resolveServerConfig({
        workspaceRoot: "/tmp/ws",
        env: { ...common, RENTEMESTER_AUTH_EMAIL_PROVIDER: "http-json-v1", RENTEMESTER_AUTH_EMAIL_URL: "http://gateway.example.test", RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN: "private-value", RENTEMESTER_AUTH_EMAIL_FROM: "auth@example.test" },
      });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("gateway URL");
    expect(message).not.toContain("private-value");
  });

  test("hosted secret rotation and client-IP proxy contract fail closed without echoing values", () => {
    const first = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
    const second = "KH5Zcv2oA_oM9kOskr7DcGUGRn9PXsTdxnSqjx083ag";
    const base = {
      RENTEMESTER_DEPLOYMENT_PROFILE: "hosted",
      RENTEMESTER_AUTH_SECRETS: `2:${second},1:${first}`,
      RENTEMESTER_AUTH_SECRET: first,
      RENTEMESTER_AUTH_BASE_URL: "https://cockpit.example.test",
      RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://cockpit.example.test",
      RENTEMESTER_AUTH_EMAIL_PROVIDER: "http-json-v1",
      RENTEMESTER_AUTH_EMAIL_URL: "https://mail-gateway.example.test/send",
      RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN: "synthetic-test-token",
      RENTEMESTER_AUTH_EMAIL_FROM: "auth@rentemester.example.test",
      RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-real-ip",
      RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "proxy-overwrites-client-ip-header-v1",
    };
    const config = resolveServerConfig({ workspaceRoot: "/tmp/ws", env: base });
    expect(config.hostedBetterAuth).toMatchObject({
      secret: second,
      secrets: [{ version: 2, value: second }, { version: 1, value: first }],
      legacySecret: first,
      rateLimitIpHeader: "x-real-ip",
    });
    for (const unsafe of [
      { RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-forwarded-for" },
      { RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "not-acknowledged" },
      { RENTEMESTER_AUTH_SECRETS: `2:${second},2:${first}` },
      { RENTEMESTER_AUTH_SECRETS: `2:${second}, 1:${first}` },
      { RENTEMESTER_AUTH_SECRETS: " " },
    ]) {
      let message = "";
      try { resolveServerConfig({ workspaceRoot: "/tmp/ws", env: { ...base, ...unsafe } }); } catch (error) { message = String(error); }
      expect(message).not.toContain(first);
      expect(message).not.toContain(second);
      expect(message).not.toContain("synthetic-test-token");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
