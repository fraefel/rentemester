import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { betterAuth, type Auth, type User } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { openWorkspaceControlDb } from "../core/workspace-control";
import { appendAuthTelemetryEvent, authAuditIdentityHash, type AuthTelemetryEndpoint } from "../core/auth-audit";
import {
  createDisabledAuthEmailSender,
  type AuthEmailSender,
} from "./auth-email";
import {
  AUTH_SESSION_EXPIRES_IN_SECONDS,
  AUTH_SESSION_FRESH_AGE_SECONDS,
} from "./security-policy";

const MINIMUM_AUTH_SECRET_BYTES = 32;

export type BetterAuthDeploymentMode = "local" | "hosted";

/**
 * The only Better Auth diagnostics which may leave this module.  Better Auth
 * passes arbitrary messages and arguments (including Error instances) to its
 * logger, so those values are deliberately not part of this contract.
 */
export type BetterAuthOperationalLogEvent = {
  component: "better-auth";
  event: "better_auth_warning" | "better_auth_error";
  level: "warn" | "error";
};

export type BetterAuthOperationalLogger = {
  emit(event: BetterAuthOperationalLogEvent): void;
};

/** Better Auth 1.7.1's documented versioned-secret contract. */
export type BetterAuthVersionedSecret = {
  version: number;
  value: string;
};

type BetterAuthEmailCallbackData = {
  user: User;
  url: string;
  token: string;
};

/** A single, proxy-overwritten client IP header; never X-Forwarded-For. */
export const HOSTED_RATE_LIMIT_IP_HEADERS = ["cf-connecting-ip", "x-real-ip"] as const;
export type HostedRateLimitIpHeader = typeof HOSTED_RATE_LIMIT_IP_HEADERS[number];

export type BetterAuthRuntimeOptions = {
  /** Active signing/HMAC key. This module never reads an environment fallback. */
  secret: string;
  /** First key is active; following keys are Better Auth decryption-only keys. */
  secrets?: readonly BetterAuthVersionedSecret[];
  /** Optional old single key for Better Auth's pre-versioned legacy payloads. */
  legacySecret?: string;
  /** Explicit origin allow-list. Wildcards and implicit request origins are not used. */
  trustedOrigins: readonly string[];
  /** Absolute Better Auth base URL for links and callbacks. */
  baseURL: string;
  /** Hosted deployments must opt into Secure cookies explicitly. */
  deploymentMode?: BetterAuthDeploymentMode;
  useSecureCookies?: boolean;
  /** Disabled by default and only replaceable by a workspace-level provider. */
  emailSender?: AuthEmailSender;
  /**
   * Receives only fixed Better Auth diagnostic event names. Raw Better Auth
   * messages, arguments, errors and stacks are never forwarded.
   */
  operationalLogger?: BetterAuthOperationalLogger;
  /** Required for hosted rate limiting; proxy reachability remains a deployment gate. */
  rateLimitIpHeader?: HostedRateLimitIpHeader;
};

export type WorkspaceBetterAuthRuntime = {
  auth: Auth<any>;
  /** Closes the workspace-control Bun SQLite connection exactly once. */
  close(): void;
};

/**
 * The deliberately small HTTP-facing contract used by the cockpit.  Keeping
 * this structural prevents the router from depending on Better Auth internals
 * and makes the single-session-read property straightforward to test.
 */
export type BetterAuthRequestProvider = {
  getSession(request: Request): Promise<BetterAuthSession | null>;
  handle(request: Request): Promise<Response>;
};

export type BetterAuthSession = {
  user: { id: string };
  session: { id: string; createdAt: Date | string };
};

/** A CLI-only facility. It intentionally has no HTTP handler property. */
export type PrivateBootstrapService = {
  /** Opaque HMAC for saga reservation/audit; no plaintext email is persisted there. */
  canonicalEmailHash(email: string): string;
  createFirstIdentity(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<{ userId: string; created: boolean }>;
  /** Read-only recovery lookup. Credential rows are never written outside Better Auth. */
  findIdentityByCanonicalEmail(email: string): Promise<{ userId: string } | null>;
  /** Uses Better Auth's documented server endpoint; no action URL is returned. */
  resendVerification(email: string): Promise<void>;
};

export type PrivateInvitationIdentityService = {
  createIdentity(input: {
    name: string;
    email: string;
    password: string;
  }): Promise<{ userId: string; created: boolean }>;
  resendVerification(email: string): Promise<void>;
};

function assertSecureUrl(value: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute origin URL`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an origin without a path, query, or fragment`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http or https`);
  }
  return parsed;
}

/**
 * Reject anything except the canonical unpadded base64url representation of a
 * cryptographically-random secret.  Encoding gives us a machine-verifiable
 * boundary: arbitrary prose and repeated patterns cannot accidentally become
 * a Better Auth signing key. Operators must generate the random bytes before
 * injection; randomness itself cannot be recovered from an encoded string.
 */
export function assertInjectedBetterAuthSecret(secret: string): void {
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error("Better Auth secret must be injected as canonical base64url for at least 32 random bytes");
  }
  const decoded = Buffer.from(secret, "base64url");
  if (
    decoded.length < MINIMUM_AUTH_SECRET_BYTES ||
    decoded.toString("base64url") !== secret
  ) {
    throw new Error("Better Auth secret must be injected as canonical base64url for at least 32 random bytes");
  }
}

function normalizedVersionedSecrets(options: BetterAuthRuntimeOptions): BetterAuthVersionedSecret[] {
  const configured = options.secrets ?? [{ version: 1, value: options.secret }];
  if (configured.length === 0) throw new Error("Better Auth requires at least one versioned secret");
  const seenVersions = new Set<number>();
  const secrets = configured.map(({ version, value }) => {
    if (!Number.isSafeInteger(version) || version < 0 || seenVersions.has(version)) {
      throw new Error("Better Auth secret versions must be unique non-negative integers");
    }
    seenVersions.add(version);
    assertInjectedBetterAuthSecret(value);
    return { version, value };
  });
  if (secrets[0]?.value !== options.secret) {
    throw new Error("Better Auth active secret must be the first versioned secret");
  }
  if (options.legacySecret !== undefined) assertInjectedBetterAuthSecret(options.legacySecret);
  return secrets;
}

function hostedRateLimitIpHeader(options: BetterAuthRuntimeOptions): HostedRateLimitIpHeader | undefined {
  if (options.deploymentMode !== "hosted") return undefined;
  if (!options.rateLimitIpHeader || !HOSTED_RATE_LIMIT_IP_HEADERS.includes(options.rateLimitIpHeader)) {
    throw new Error("hosted Better Auth requires an approved reverse-proxy client IP header");
  }
  return options.rateLimitIpHeader;
}

function normalizeTrustedOrigins(origins: readonly string[]): string[] {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new Error("Better Auth requires at least one explicit trusted origin");
  }
  return [...new Set(origins.map((origin) => assertSecureUrl(origin, "trusted origin").origin))];
}

function secureCookieSetting(options: BetterAuthRuntimeOptions): boolean {
  const mode = options.deploymentMode ?? "local";
  if (mode === "hosted" && options.useSecureCookies !== true) {
    throw new Error("hosted Better Auth requires useSecureCookies: true");
  }
  return options.useSecureCookies === true;
}

function defaultBetterAuthOperationalLogger(): BetterAuthOperationalLogger {
  return {
    emit(event) {
      // This is intentionally an allowlisted JSON record, never Better Auth's
      // raw message/arguments. A future application logger can replace it.
      console.warn(JSON.stringify(event));
    },
  };
}

function createBetterAuthLogger(options: BetterAuthRuntimeOptions): {
  level: "info";
  disableColors: true;
  log(level: "debug" | "info" | "warn" | "error", _message: string, ..._arguments: unknown[]): void;
} {
  const operationalLogger = options.operationalLogger ?? defaultBetterAuthOperationalLogger();
  return {
    // Better Auth 1.7.1 routes API errors to its process-global logger only
    // at error/warn/debug levels. `info` still invokes this custom logger for
    // warnings/errors while keeping raw global error arguments unreachable.
    level: "info",
    disableColors: true,
    log(level, _message, ..._arguments) {
      // Better Auth may hand us an Error, email address, token, URL or provider
      // response in either argument. Do not inspect, serialize or forward it.
      if (level !== "warn" && level !== "error") return;
      try {
        operationalLogger.emit({
          component: "better-auth",
          event: level === "error" ? "better_auth_error" : "better_auth_warning",
          level,
        });
      } catch {
        // Observability must not affect authentication or fall back to a raw log.
      }
    },
  };
}

/**
 * Construct Better Auth against an already-opened workspace-control DB.
 * This keeps the factory testable and makes connection ownership explicit.
 */
function createBetterAuth(
  db: Database,
  options: BetterAuthRuntimeOptions,
  disableSignUp: boolean,
): Auth<any> {
  assertInjectedBetterAuthSecret(options.secret);
  const secrets = normalizedVersionedSecrets(options);
  const trustedOrigins = normalizeTrustedOrigins(options.trustedOrigins);
  const baseURL = assertSecureUrl(options.baseURL, "Better Auth baseURL").origin;
  const emailSender = options.emailSender ?? createDisabledAuthEmailSender();

  // Better Auth's documented endpoint after-hook is the only stable surface
  // that observes both public handler and server-API endpoint dispatches.
  const auditAfterHook = async (ctx: any) => {
    const path = String(ctx.path ?? "");
    const endpoint: AuthTelemetryEndpoint | null = ({
      "/send-verification-email": "send-verification-email",
      "/verify-email": "verify-email", "/request-password-reset": "request-password-reset",
      "/reset-password": "reset-password", "/sign-out": "sign-out",
      "/revoke-session": "revoke-session", "/revoke-other-sessions": "revoke-other-sessions",
      "/two-factor/enable": "two-factor-enable", "/two-factor/verify-totp": "two-factor-verify",
    } as Record<string, AuthTelemetryEndpoint>)[path] ?? null;
    if (!endpoint) return { headers: new Headers() };
    const session = ctx.context?.newSession?.session ?? ctx.context?.session?.session;
    const user = ctx.context?.newSession?.user ?? ctx.context?.session?.user;
    const body = ctx.body as { email?: string } | undefined;
    // BA after-hooks lack a stable status for every APIError. Never infer that
    // a first factor, MFA challenge, sign-out, or revoke *completed* here.
    // SQLite triggers below are the authoritative lifecycle evidence.
    const returned = ctx.context?.returned;
    const status = returned instanceof Response ? returned.status : typeof returned?.status === "number" ? returned.status : null;
    const outcome = status === null ? "unknown" : status >= 200 && status < 300 ? "accepted" : "rejected";
    try {
      appendAuthTelemetryEvent(db, { endpoint, outcome, userId: user?.id ?? null, sessionId: session?.id ?? null, identityHash: authAuditIdentityHash(options.secret, body?.email), identityKeyVersion: secrets[0]!.version });
    } catch {
      // An after-hook cannot roll back a completed BA state mutation. Suppress
      // detail; the caller keeps BA's truthful original response.
      console.error('{"component":"auth-audit","event":"auth_telemetry_write_failed","level":"error"}');
    }
    return { headers: new Headers() };
  };
  const useSecureCookies = secureCookieSetting(options);
  const rateLimitIpHeader = hostedRateLimitIpHeader(options);

  const auth = betterAuth({
    database: db,
    // Always pass `secrets` so Better Auth never falls back to a process-wide
    // BETTER_AUTH_SECRETS value outside Rentemester's validated configuration.
    secrets,
    // Better Auth 1.7.1 uses this only to decrypt pre-envelope legacy data.
    secret: options.legacySecret ?? options.secret,
    baseURL,
    appName: "Rentemester",
    trustedOrigins,
    logger: createBetterAuthLogger(options),
    emailAndPassword: {
      enabled: true,
      disableSignUp,
      // A bootstrap identity must never accidentally establish a usable
      // browser session. The normal runtime is explicit too.
      autoSignIn: false,
      minPasswordLength: 12,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url, token }: BetterAuthEmailCallbackData) {
        await emailSender.send({ kind: "password-reset", recipient: user.email, url, token });
      },
    },
    emailVerification: {
      async sendVerificationEmail({ user, url, token }: BetterAuthEmailCallbackData) {
        await emailSender.send({ kind: "verification", recipient: user.email, url, token });
      },
    },
    session: {
      expiresIn: AUTH_SESSION_EXPIRES_IN_SECONDS,
      freshAge: AUTH_SESSION_FRESH_AGE_SECONDS,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 10,
    },
    hooks: { after: auditAfterHook },
    advanced: {
      // Better Auth 1.7 reads this setting from `advanced`; keeping it here
      // makes the hosted Secure-cookie requirement effective, not decorative.
      useSecureCookies,
      // Better Auth otherwise skips the origin check in its own test runtime.
      // Explicit false is an enablement assertion, never a security bypass.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ...(rateLimitIpHeader ? {
        // A single proxy-overwritten header avoids Better Auth's default
        // X-Forwarded-For handling. trustedProxies cannot verify the direct
        // sender, so it is intentionally not configured here.
        ipAddress: { ipAddressHeaders: [rateLimitIpHeader] },
      } : {}),
    },
    plugins: [
      twoFactor({
        issuer: "Rentemester",
        skipVerificationOnEnable: false,
        backupCodeOptions: { storeBackupCodes: "encrypted" },
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
      }),
    ],
  }) as Auth<any>;

  // Better Auth's after-hook does not expose a stable result status for these
  // endpoints. Audit them at the HTTP Response boundary instead, so accepted
  // and rejected first-factor/recovery attempts are truthful rather than
  // guessed. Only the sign-in email is pseudonymised; passwords and recovery
  // codes are never retained or forwarded.
  const rawHandler = auth.handler.bind(auth);
  const responseAuditedHandler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
    const endpoint: AuthTelemetryEndpoint | null = path === "/sign-in/email"
      ? "sign-in-email"
      : path === "/two-factor/verify-backup-code"
        ? "two-factor-verify-backup-code"
        : null;
    if (!endpoint) return await rawHandler(request);

    let identityHash: string | null = null;
    if (endpoint === "sign-in-email") {
      try {
        const body = await request.clone().json() as { email?: unknown };
        identityHash = authAuditIdentityHash(
          options.secret,
          typeof body.email === "string" ? body.email : null,
        );
      } catch {
        // Malformed input remains Better Auth's responsibility; no raw body is logged.
      }
    }

    let response: Response;
    try {
      response = await rawHandler(request);
    } catch (error) {
      try {
        appendAuthTelemetryEvent(db, {
          endpoint,
          outcome: "unknown",
          identityHash,
          identityKeyVersion: secrets[0]!.version,
        });
      } catch {
        console.error('{"component":"auth-audit","event":"auth_telemetry_write_failed","level":"error"}');
      }
      throw error;
    }
    try {
      appendAuthTelemetryEvent(db, {
        endpoint,
        outcome: response.status >= 200 && response.status < 300 ? "accepted" : "rejected",
        identityHash,
        identityKeyVersion: secrets[0]!.version,
      });
    } catch {
      console.error('{"component":"auth-audit","event":"auth_telemetry_write_failed","level":"error"}');
    }
    return response;
  };

  return Object.assign(auth, { handler: responseAuditedHandler });
}

/** Production runtime: email/password sign-up is never publicly enabled. */
export function createBetterAuthRuntime(
  db: Database,
  options: BetterAuthRuntimeOptions,
): Auth<any> {
  return createBetterAuth(db, options, true);
}

/**
 * Adapt Better Auth's documented server API to the narrow cockpit contract.
 * `getSession` is the only place the session cookie is read for API routes.
 */
export function createBetterAuthRequestProvider(
  auth: Auth<any>,
): BetterAuthRequestProvider {
  return {
    async getSession(request) {
      return await auth.api.getSession({ headers: request.headers }) as BetterAuthSession | null;
    },
    async handle(request) {
      return await auth.handler(request);
    },
  };
}

function bootstrapText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function canonicalBootstrapEmail(email: string): string {
  const normalized = bootstrapText(email, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("email is invalid");
  return normalized;
}

/**
 * Creates exactly one credential identity through Better Auth's supported
 * server API. This object is intentionally private to callers such as a
 * future confirmed CLI command: it is not an HTTP handler and cannot be
 * mounted by the cockpit router.
 */
export function createPrivateBootstrapService(
  db: Database,
  options: BetterAuthRuntimeOptions,
): PrivateBootstrapService {
  const auth = createBetterAuth(db, options, false);
  const lookup = (email: string): { userId: string } | null => {
    const row = db.query('SELECT id FROM "user" WHERE email = ?').get(canonicalBootstrapEmail(email)) as { id: string } | null;
    return row?.id ? { userId: row.id } : null;
  };
  return {
    canonicalEmailHash(email) {
      return createHmac("sha256", options.secret)
        .update(`rentemester-workspace-bootstrap-email-v1\0${canonicalBootstrapEmail(email)}`)
        .digest("hex");
    },
    async findIdentityByCanonicalEmail(email) {
      return lookup(email);
    },
    async createFirstIdentity(input) {
      const email = canonicalBootstrapEmail(input.email);
      const before = lookup(email);
      if (before) return { ...before, created: false };
      const result = await auth.api.signUpEmail({
        body: {
          name: bootstrapText(input.name, "name"),
          email,
          password: bootstrapText(input.password, "password"),
        },
      });
      // `autoSignIn: false` makes a token/session a security regression.
      const actual = lookup(email);
      if (!result?.user?.id || result.token !== null || !actual) {
        throw new Error("private bootstrap did not create a credential-only identity");
      }
      // Better Auth intentionally returns a generic synthetic id for duplicate
      // email sign-ups. Only the read-only canonical lookup is authoritative.
      return { userId: actual.userId, created: actual.userId === result.user.id };
    },
    async resendVerification(email) {
      await auth.api.sendVerificationEmail({ body: { email: canonicalBootstrapEmail(email) } });
    },
  };
}

/** Private invitation identity creation reuses the reviewed no-session bootstrap boundary. */
export function createPrivateInvitationIdentityService(
  db: Database,
  options: BetterAuthRuntimeOptions,
): PrivateInvitationIdentityService {
  const bootstrap = createPrivateBootstrapService(db, options);
  return {
    async createIdentity(input) {
      return await bootstrap.createFirstIdentity(input);
    },
    async resendVerification(email) {
      await bootstrap.resendVerification(email);
    },
  };
}

/** Opens the private workspace-control DB and returns an explicit close handle. */
export function openWorkspaceBetterAuth(
  workspaceRoot: string,
  options: BetterAuthRuntimeOptions,
): WorkspaceBetterAuthRuntime {
  const db = openWorkspaceControlDb(workspaceRoot);
  try {
    const auth = createBetterAuthRuntime(db, options);
    let closed = false;
    return {
      auth,
      close() {
        if (closed) return;
        closed = true;
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
