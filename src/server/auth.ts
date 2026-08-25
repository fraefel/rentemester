// The single auth-middleware seam for the cockpit backend (#170).
//
// EVERY request passes through `authMiddleware` exactly once, before any
// handler runs. This is the one and only place auth is decided — no handler
// performs its own check. Phase 2 (Better Auth) is "rewrite this function",
// not a retrofit scattered across the route table.
//
// Phase 1 is localhost-trusted: when `config.authRequired` is false the
// middleware is a pass-through. When it is true (tests, future hardening) a
// shared-secret bearer token is required, proving the seam actually gates.

import type { ServerConfig } from "./config";
import { ApiError } from "./errors";
import { openWorkspaceControlReadOnlyDb } from "../core/workspace-control";
import { hasCurrentBetterAuthSession } from "../core/workspace-access";

/**
 * The authenticated principal handed to handlers. Phase 1 only ever yields the
 * synthetic localhost principal; Phase 2 will populate real identity here.
 */
export type Principal = {
  /** Canonical actor id, e.g. `system:localhost` or `user:<id>`. */
  id: string;
  /** How the principal was established — useful for audit + diagnostics. */
  via: "localhost-trusted" | "shared-secret" | "better-auth";
  /** Present only for a Better Auth principal and safe to include in audit. */
  sessionId?: string;
  /** Session creation time is retained for append-only invalidation checks. */
  sessionCreatedAt?: Date;
};

export const LOCALHOST_PRINCIPAL: Principal = {
  id: "system:localhost",
  via: "localhost-trusted",
};

/**
 * The auth middleware. Returns the authenticated `Principal` on success;
 * throws `ApiError.unauthorized` to reject. It NEVER returns a Response — the
 * caller maps a thrown `ApiError` to the wire, keeping error shaping in one
 * place.
 *
 * @param request the incoming request (Phase 2 reads cookies/headers here)
 * @param config  the resolved server config (carries the auth toggle + token)
 */
export async function authMiddleware(
  request: Request,
  config: ServerConfig,
): Promise<Principal> {
  if (config.betterAuthProvider) {
    const session = await config.betterAuthProvider.getSession(request);
    const userId = session?.user?.id?.trim() ?? "";
    const sessionId = session?.session?.id?.trim() ?? "";
    const createdAt = parseSessionCreatedAt(session?.session?.createdAt);
    if (!userId || !sessionId || !createdAt) {
      throw ApiError.unauthorized("missing or invalid credentials");
    }

    // Cookie cache is disabled. Exact Better Auth session-row membership is
    // the authorization boundary: both emergency invalidation and verified
    // first-MFA enrollment delete rows atomically, avoiding same-second
    // timestamp ambiguity and stale provider-response bypasses.
    const db = openWorkspaceControlReadOnlyDb(config.workspaceRoot);
    try {
      if (!hasCurrentBetterAuthSession(db, userId, sessionId)) {
        throw ApiError.unauthorized("missing or invalid credentials");
      }
    } finally {
      db.close();
    }
    return {
      id: `user:${userId}`,
      via: "better-auth",
      sessionId,
      sessionCreatedAt: createdAt,
    };
  }

  if (!config.authRequired) {
    // Phase 1: localhost-trusted. Pass-through.
    return LOCALHOST_PRINCIPAL;
  }

  // Phase 1.5 / test seam: a shared-secret bearer token. This branch exists so
  // the seam is provably a gate, not decoration. Better Auth replaces it.
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const presented = match?.[1]?.trim() ?? null;

  if (!config.authToken) {
    // Misconfiguration: auth demanded but no secret set. Fail closed.
    throw ApiError.unauthorized("authentication is not configured");
  }
  if (!presented || !timingSafeEqual(presented, config.authToken)) {
    throw ApiError.unauthorized("missing or invalid credentials");
  }
  return { id: "system:cockpit", via: "shared-secret" };
}

function parseSessionCreatedAt(value: Date | string | undefined): Date | null {
  const parsed = value instanceof Date ? value : new Date(typeof value === "string" ? value : "");
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** SQLite CURRENT_TIMESTAMP is UTC but has no trailing `Z`. */
/** Constant-time string compare so token checks don't leak length/prefix. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
