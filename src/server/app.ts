// Bun.serve wiring for the cockpit backend (#170).
//
// This is the only file that touches `Bun.serve`. All request logic lives in
// `router.ts` (a pure `(Request, config) => Promise<Response>`), so the server
// is trivially testable without binding a socket.

import type { ServerConfig } from "./config";
import {
  createBetterAuthRequestProvider,
  openWorkspaceBetterAuth,
  type WorkspaceBetterAuthRuntime,
} from "./better-auth";
import { createHttpJsonV1AuthEmailSender } from "./auth-email";
import { handleRequest } from "./router";
import { observeRequest } from "./observability";
import { createHttpJsonV1DocumentScanner } from "./document-scanner";

/** The concrete `Bun.serve` return type, without needing its generic param. */
type BunServer = ReturnType<typeof Bun.serve>;

export type CockpitServer = {
  server: BunServer;
  config: ServerConfig;
  /** Resolved `http://host:port` base URL. */
  url: string;
  stop: () => void;
};

/**
 * Starts the cockpit backend on the configured bind address.
 *
 * Binds `config.host` (default 127.0.0.1 — localhost-only) so Phase 1 is not
 * reachable off-box without an explicit config change.
 */
export function startCockpitServer(config: ServerConfig): CockpitServer {
  let authRuntime: WorkspaceBetterAuthRuntime | undefined;
  let runtimeConfig = config;
  const deploymentProfile = config.deploymentProfile ?? "local";
  if (deploymentProfile === "hosted") {
    if (!config.hostedBetterAuth) {
      throw new Error("hosted deployment requires validated Better Auth configuration");
    }
    if (config.hostedDocumentScanning?.policy === "required" && !config.hostedDocumentScanning.provider) {
      throw new Error("hosted deployment requires a document scanner provider when scanning is required");
    }
    authRuntime = openWorkspaceBetterAuth(config.workspaceRoot, {
      ...config.hostedBetterAuth,
      deploymentMode: "hosted",
      useSecureCookies: true,
      emailSender: createHttpJsonV1AuthEmailSender({
        ...config.hostedBetterAuth.authEmail,
        idempotencySecret: config.hostedBetterAuth.secret,
      }),
    });
    const scanning = config.hostedDocumentScanning;
    runtimeConfig = {
      ...config,
      authRequired: true,
      betterAuthProvider: createBetterAuthRequestProvider(authRuntime.auth),
      documentScannerPolicy: scanning?.policy ?? "off",
      ...(scanning?.provider ? { documentScanner: createHttpJsonV1DocumentScanner(scanning.provider) } : {}),
    };
  } else if (config.betterAuthProvider) {
    throw new Error("local deployment must not mount a Better Auth provider");
  }

  let server: BunServer;
  try {
    server = Bun.serve({
      hostname: runtimeConfig.host,
      port: runtimeConfig.port,
      fetch(request) {
        return observeRequest(request, runtimeConfig, handleRequest);
      },
    });
  } catch (error) {
    authRuntime?.close();
    throw error;
  }
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return {
    server,
    config: runtimeConfig,
    url: `http://${host}:${server.port}`,
    stop: () => {
      server.stop(true);
      authRuntime?.close();
    },
  };
}
