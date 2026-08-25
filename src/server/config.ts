// Cockpit backend configuration (#170).
//
// The bind address is config-driven so the local-only Phase 1 default can be
// changed without touching code. Everything is resolved from the environment
// here, in one place, so the rest of the server is pure.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfiguredWorkspaceRoot } from "../core/workspace";
import type { Principal } from "./auth";
import type {
  BetterAuthRequestProvider,
  BetterAuthVersionedSecret,
  HostedRateLimitIpHeader,
  PrivateInvitationIdentityService,
} from "./better-auth";
import {
  assertInjectedBetterAuthSecret,
  HOSTED_RATE_LIMIT_IP_HEADERS,
} from "./better-auth";
import { validateAuthEmailHttpJsonV1Config, type AuthEmailSender } from "./auth-email";
import type { RequestLogSink } from "./observability";
import type { DocumentScanner } from "../core/documents";
import type { HttpJsonV1DocumentScannerConfig } from "./document-scanner";
import type { InvoiceExtractor } from "../core/invoice-extraction";

export const DEFAULT_APP_HOST = "127.0.0.1";
export const DEFAULT_APP_PORT = 4319;
export const DEPLOYMENT_PROFILES = ["local", "local-container", "hosted"] as const;
export type DeploymentProfile = typeof DEPLOYMENT_PROFILES[number];

/** Names are deliberately centralized so operators never have to infer them. */
export const HOSTED_AUTH_ENV = {
  profile: "RENTEMESTER_DEPLOYMENT_PROFILE",
  secret: "RENTEMESTER_AUTH_SECRET",
  secrets: "RENTEMESTER_AUTH_SECRETS",
  baseURL: "RENTEMESTER_AUTH_BASE_URL",
  trustedOrigins: "RENTEMESTER_AUTH_TRUSTED_ORIGINS",
  emailProvider: "RENTEMESTER_AUTH_EMAIL_PROVIDER",
  emailUrl: "RENTEMESTER_AUTH_EMAIL_URL",
  emailBearerToken: "RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN",
  emailFrom: "RENTEMESTER_AUTH_EMAIL_FROM",
  rateLimitIpHeader: "RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER",
  rateLimitProxyContract: "RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT",
} as const;

/** Scanner settings are separate from auth, but use the same no-echo rule. */
export const DOCUMENT_SCANNER_ENV = {
  policy: "RENTEMESTER_DOCUMENT_SCANNER_POLICY",
  provider: "RENTEMESTER_DOCUMENT_SCANNER_PROVIDER",
  url: "RENTEMESTER_DOCUMENT_SCANNER_URL",
  bearerToken: "RENTEMESTER_DOCUMENT_SCANNER_BEARER_TOKEN",
  timeoutMs: "RENTEMESTER_DOCUMENT_SCANNER_TIMEOUT_MS",
} as const;

/** Explicit acknowledgement of the reverse-proxy requirement documented below. */
export const RATE_LIMIT_PROXY_CONTRACT = "proxy-overwrites-client-ip-header-v1";

/** True only for addresses which cannot expose the unauthenticated cockpit. */
export function isLoopbackBindAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "[0:0:0:0:0:0:0:1]";
}

function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackBindAddress(hostname);
}

export type HostedBetterAuthConfig = {
  /** Active key; never emit it in health, CLI, logs, or error responses. */
  secret: string;
  /** First entry is active, following entries are Better Auth decryption-only. */
  secrets: readonly BetterAuthVersionedSecret[];
  /** Only for Better Auth's pre-versioned payloads during a rotation window. */
  legacySecret?: string;
  baseURL: string;
  trustedOrigins: readonly string[];
  authEmail: HostedAuthEmailConfig;
  /** Single edge-owned header Better Auth may use for rate-limit IP keys. */
  rateLimitIpHeader: HostedRateLimitIpHeader;
};

export type HostedAuthEmailConfig = {
  provider: "http-json-v1";
  url: string;
  bearerToken: string;
  from: string;
};

export type HostedDocumentScanningConfig = {
  policy: "off" | "required";
  provider?: HttpJsonV1DocumentScannerConfig;
};

/**
 * Absolute path of the built cockpit SPA. The repo layout is `<root>/app/dist`
 * and this file lives at `<root>/src/server/config.ts`, so the dist directory
 * is two levels up plus `app/dist`. Overridable via `RENTEMESTER_APP_STATIC`.
 */
function resolveStaticRoot(env: Record<string, string | undefined>): string {
  const override = env.RENTEMESTER_APP_STATIC?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "app", "dist");
}

export type ServerConfig = {
  /** Explicit deployment boundary. `local` may never expose Better Auth. */
  deploymentProfile?: DeploymentProfile;
  /** Interface to bind. Defaults to 127.0.0.1 (localhost-only). */
  host: string;
  /** TCP port to listen on. */
  port: number;
  /** Workspace root the API serves. */
  workspaceRoot: string;
  /**
   * When true, the auth middleware enforces a shared-secret check via the
   * `RENTEMESTER_APP_TOKEN` env var. Phase 1 leaves this off (localhost-trusted)
   * — it exists so the seam can be exercised by tests and flipped on later.
   */
  authRequired: boolean;
  /** Optional shared secret consulted only when `authRequired` is true. */
  authToken: string | null;
  /** Present only for a validated hosted deployment; never serialised. */
  hostedBetterAuth?: HostedBetterAuthConfig;
  /** Hosted ingress policy and, when required, a validated provider config. */
  hostedDocumentScanning?: HostedDocumentScanningConfig;
  /** Runtime scanner seam. Local deployments intentionally leave this absent. */
  documentScanner?: DocumentScanner;
  documentScannerPolicy?: "off" | "required";
  /** Optional explicit extraction provider; absence means extraction is unavailable. */
  invoiceExtractor?: InvoiceExtractor;
  /**
   * Hosted identity provider. Its presence selects Better Auth sessions for
   * protected API routes; public routes remain anonymous. This is injected by
   * the serving composition root, never constructed from a fallback secret.
   */
  betterAuthProvider?: BetterAuthRequestProvider;
  /** Test/composition seam; production derives it from the validated hosted mail configuration. */
  authEmailSender?: AuthEmailSender;
  /** Test/composition seam for private invitation identity creation. */
  invitationIdentityService?: PrivateInvitationIdentityService;
  /**
   * Per-request authentication result. `handleRequest` creates an immutable
   * config copy carrying this value after its one auth evaluation; it is never
   * populated by environment/config resolution.
   */
  requestPrincipal?: Principal;
  /** Validated request correlation ID, attached only by the server edge. */
  requestId?: string;
  /** Test/provider seam; never resolved from environment and invoked only by the router. */
  authenticateRequest?: (request: Request, config: ServerConfig) => Principal | Promise<Principal>;
  /** Test/composition seam for allowlisted request-completion records. Never env-derived. */
  requestLogSink?: RequestLogSink;
  /** Test seam for deterministic, validated response correlation IDs. */
  requestIdFactory?: () => string;
  /** Test seam for deterministic request timestamps and durations. */
  requestLogClock?: () => number;
  /**
   * Absolute path to the built cockpit SPA (`app/dist`). When the directory
   * exists, the server serves it for every non-`/api` route. Resolved here so
   * the rest of the server stays pure. Optional: when absent the server is a
   * pure JSON API (the shape used by API-only tests).
   */
  staticRoot?: string;
};

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `RENTEMESTER_APP_PORT must be an integer between 1 and 65535, got: ${raw}`,
    );
  }
  return port;
}

function readDeploymentProfile(env: Record<string, string | undefined>): DeploymentProfile {
  const raw = (env[HOSTED_AUTH_ENV.profile] ?? "local").trim().toLowerCase();
  if ((DEPLOYMENT_PROFILES as readonly string[]).includes(raw)) return raw as DeploymentProfile;
  throw new Error(`${HOSTED_AUTH_ENV.profile} must be 'local', 'local-container', or 'hosted'`);
}

function parseHostedOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS origin`);
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || isLoopbackHostname(url.hostname)) {
    throw new Error(`${label} must be a non-loopback HTTPS origin without path, query, or fragment`);
  }
  return url.origin;
}

function parseVersionedHostedSecrets(env: Record<string, string | undefined>): {
  secret: string;
  secrets: readonly BetterAuthVersionedSecret[];
  legacySecret?: string;
} {
  const rawSecrets = env[HOSTED_AUTH_ENV.secrets];
  const singleSecret = env[HOSTED_AUTH_ENV.secret]?.trim() ?? "";
  if (rawSecrets === undefined) {
    assertInjectedBetterAuthSecret(singleSecret);
    // Single-key installations are deliberately represented as version 1 so
    // Better Auth cannot read its process-global secrets environment.
    return { secret: singleSecret, secrets: [{ version: 1, value: singleSecret }] };
  }

  const entries = rawSecrets.split(",");
  const seen = new Set<number>();
  const secrets: BetterAuthVersionedSecret[] = [];
  for (const entry of entries) {
    // Do not normalize malformed input: whitespace/empty items make rotation
    // configuration ambiguous and therefore fail before a socket is opened.
    const match = /^(0|[1-9][0-9]*):([A-Za-z0-9_-]+)$/.exec(entry);
    if (!match) throw new Error(`${HOSTED_AUTH_ENV.secrets} must contain version:base64url entries`);
    const version = Number(match[1]);
    const value = match[2]!;
    if (!Number.isSafeInteger(version) || seen.has(version)) {
      throw new Error(`${HOSTED_AUTH_ENV.secrets} must use unique non-negative versions`);
    }
    seen.add(version);
    assertInjectedBetterAuthSecret(value);
    secrets.push({ version, value });
  }
  if (secrets.length === 0) throw new Error(`${HOSTED_AUTH_ENV.secrets} requires at least one versioned secret`);
  if (singleSecret) assertInjectedBetterAuthSecret(singleSecret);
  return {
    secret: secrets[0]!.value,
    secrets,
    ...(singleSecret ? { legacySecret: singleSecret } : {}),
  };
}

function parseHostedRateLimitIpHeader(env: Record<string, string | undefined>): HostedRateLimitIpHeader {
  const header = env[HOSTED_AUTH_ENV.rateLimitIpHeader]?.trim().toLowerCase() ?? "";
  if (!HOSTED_RATE_LIMIT_IP_HEADERS.includes(header as HostedRateLimitIpHeader)) {
    throw new Error(`${HOSTED_AUTH_ENV.rateLimitIpHeader} must be an approved proxy client-IP header`);
  }
  if (env[HOSTED_AUTH_ENV.rateLimitProxyContract]?.trim() !== RATE_LIMIT_PROXY_CONTRACT) {
    throw new Error(`${HOSTED_AUTH_ENV.rateLimitProxyContract} must acknowledge the required reverse-proxy contract`);
  }
  return header as HostedRateLimitIpHeader;
}

function resolveHostedBetterAuth(env: Record<string, string | undefined>): HostedBetterAuthConfig {
  const secretConfig = parseVersionedHostedSecrets(env);
  const baseURL = parseHostedOrigin(env[HOSTED_AUTH_ENV.baseURL]?.trim() ?? "", HOSTED_AUTH_ENV.baseURL);
  const trustedOrigins = (env[HOSTED_AUTH_ENV.trustedOrigins] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => parseHostedOrigin(origin, HOSTED_AUTH_ENV.trustedOrigins));
  if (trustedOrigins.length === 0) {
    throw new Error(`${HOSTED_AUTH_ENV.trustedOrigins} requires at least one explicit HTTPS origin`);
  }
  if (!trustedOrigins.includes(baseURL)) {
    throw new Error(`${HOSTED_AUTH_ENV.trustedOrigins} must include ${HOSTED_AUTH_ENV.baseURL}`);
  }
  const provider = (env[HOSTED_AUTH_ENV.emailProvider] ?? "disabled").trim().toLowerCase();
  if (provider !== "http-json-v1") {
    throw new Error(`${HOSTED_AUTH_ENV.emailProvider} must be 'http-json-v1' for hosted deployments`);
  }
  const authEmail: HostedAuthEmailConfig = {
    provider,
    url: env[HOSTED_AUTH_ENV.emailUrl]?.trim() ?? "",
    bearerToken: env[HOSTED_AUTH_ENV.emailBearerToken]?.trim() ?? "",
    from: env[HOSTED_AUTH_ENV.emailFrom]?.trim() ?? "",
  };
  // Validate before the app binds. Configuration errors name only fields, not values.
  validateAuthEmailHttpJsonV1Config({ ...authEmail, idempotencySecret: secretConfig.secret });
  return {
    ...secretConfig,
    baseURL,
    trustedOrigins: [...new Set(trustedOrigins)],
    authEmail,
    rateLimitIpHeader: parseHostedRateLimitIpHeader(env),
  };
}

function parseScannerTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 15_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 120_000) {
    throw new Error(`${DOCUMENT_SCANNER_ENV.timeoutMs} must be an integer between 100 and 120000`);
  }
  return value;
}

/**
 * An explicit required policy is a startup gate.  `off` is deliberately the
 * local/default behavior; deployments cannot accidentally configure a token
 * that is then silently ignored.
 */
function resolveHostedDocumentScanning(env: Record<string, string | undefined>): HostedDocumentScanningConfig {
  const policy = (env[DOCUMENT_SCANNER_ENV.policy] ?? "off").trim().toLowerCase();
  if (policy !== "off" && policy !== "required") {
    throw new Error(`${DOCUMENT_SCANNER_ENV.policy} must be 'off' or 'required'`);
  }
  const provider = (env[DOCUMENT_SCANNER_ENV.provider] ?? "disabled").trim().toLowerCase();
  if (policy === "off") {
    if (provider !== "disabled" || [DOCUMENT_SCANNER_ENV.url, DOCUMENT_SCANNER_ENV.bearerToken, DOCUMENT_SCANNER_ENV.timeoutMs].some((name) => Boolean(env[name]?.trim()))) {
      throw new Error(`${DOCUMENT_SCANNER_ENV.policy}=off must not configure a document scanner provider`);
    }
    return { policy: "off" };
  }
  if (provider !== "http-json-v1") {
    throw new Error(`${DOCUMENT_SCANNER_ENV.provider} must be 'http-json-v1' when scanning is required`);
  }
  let url: URL;
  try {
    url = new URL(env[DOCUMENT_SCANNER_ENV.url]?.trim() ?? "");
  } catch {
    throw new Error(`${DOCUMENT_SCANNER_ENV.url} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || isLoopbackHostname(url.hostname) || !url.hostname) {
    throw new Error(`${DOCUMENT_SCANNER_ENV.url} must be a non-loopback HTTPS URL`);
  }
  const bearerToken = env[DOCUMENT_SCANNER_ENV.bearerToken]?.trim() ?? "";
  if (!bearerToken) throw new Error(`${DOCUMENT_SCANNER_ENV.bearerToken} is required when scanning is required`);
  return {
    policy: "required",
    provider: {
      provider: "http-json-v1",
      url: url.toString(),
      bearerToken,
      timeoutMs: parseScannerTimeout(env[DOCUMENT_SCANNER_ENV.timeoutMs]),
    },
  };
}

export type ResolveServerConfigOptions = {
  /** Explicit overrides (e.g. from CLI flags) take precedence over env. */
  host?: string;
  port?: number;
  workspaceRoot?: string;
  /** Read environment from here instead of `process.env` (testability). */
  env?: Record<string, string | undefined>;
};

/**
 * Resolves the server configuration from CLI overrides + environment.
 *
 * A workspace root is required: the API is workspace-scoped, so it must know
 * which workspace to serve. Throws a clear error when none is configured.
 */
export function resolveServerConfig(
  options: ResolveServerConfigOptions = {},
): ServerConfig {
  const env = options.env ?? process.env;

  const host =
    options.host?.trim() ||
    (env.RENTEMESTER_APP_HOST?.trim() ?? "") ||
    DEFAULT_APP_HOST;

  const port =
    options.port ?? parsePort(env.RENTEMESTER_APP_PORT, DEFAULT_APP_PORT);
  const deploymentProfile = readDeploymentProfile(env);

  let workspaceRoot = options.workspaceRoot?.trim() || null;
  if (!workspaceRoot) {
    // resolveConfiguredWorkspaceRoot reads RENTEMESTER_WORKSPACE from
    // process.env; honour an injected env map for testability.
    const fromEnv = env.RENTEMESTER_WORKSPACE;
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
      const prev = process.env.RENTEMESTER_WORKSPACE;
      process.env.RENTEMESTER_WORKSPACE = fromEnv;
      try {
        workspaceRoot = resolveConfiguredWorkspaceRoot();
      } finally {
        if (prev === undefined) delete process.env.RENTEMESTER_WORKSPACE;
        else process.env.RENTEMESTER_WORKSPACE = prev;
      }
    } else {
      workspaceRoot = resolveConfiguredWorkspaceRoot();
    }
  }
  if (!workspaceRoot) {
    throw new Error(
      "no workspace configured: set RENTEMESTER_WORKSPACE or pass --workspace <dir>",
    );
  }

  const authToken = env.RENTEMESTER_APP_TOKEN?.trim() || null;
  const authRequired =
    (env.RENTEMESTER_APP_AUTH?.trim().toLowerCase() ?? "") === "required";

  if (deploymentProfile === "local" && !isLoopbackBindAddress(host)) {
    throw new Error(
      "local deployment profile may only bind a loopback address; use RENTEMESTER_DEPLOYMENT_PROFILE=hosted",
    );
  }
  if (deploymentProfile === "local-container" && host.trim() !== "0.0.0.0") {
    throw new Error(
      "local-container deployment profile must bind 0.0.0.0 inside the container and be published on host loopback only",
    );
  }
  const hostedBetterAuth = deploymentProfile === "hosted" ? resolveHostedBetterAuth(env) : undefined;
  const hostedDocumentScanning = deploymentProfile === "hosted" ? resolveHostedDocumentScanning(env) : undefined;
  if (deploymentProfile !== "hosted" && [
    HOSTED_AUTH_ENV.secret, HOSTED_AUTH_ENV.secrets, HOSTED_AUTH_ENV.baseURL, HOSTED_AUTH_ENV.trustedOrigins,
    HOSTED_AUTH_ENV.emailProvider, HOSTED_AUTH_ENV.emailUrl,
    HOSTED_AUTH_ENV.emailBearerToken, HOSTED_AUTH_ENV.emailFrom,
    HOSTED_AUTH_ENV.rateLimitIpHeader, HOSTED_AUTH_ENV.rateLimitProxyContract,
    DOCUMENT_SCANNER_ENV.policy, DOCUMENT_SCANNER_ENV.provider, DOCUMENT_SCANNER_ENV.url,
    DOCUMENT_SCANNER_ENV.bearerToken, DOCUMENT_SCANNER_ENV.timeoutMs,
  ].some((name) => Boolean(env[name]?.trim()))) {
    throw new Error("local deployment profiles must not configure Better Auth; use RENTEMESTER_DEPLOYMENT_PROFILE=hosted");
  }

  return {
    deploymentProfile,
    host,
    port,
    workspaceRoot,
    // Hosted access is Better Auth-only regardless of the legacy bearer flag.
    authRequired: deploymentProfile === "hosted" ? true : authRequired,
    authToken,
    hostedBetterAuth,
    hostedDocumentScanning,
    documentScannerPolicy: hostedDocumentScanning?.policy ?? "off",
    staticRoot: resolveStaticRoot(env),
  };
}
