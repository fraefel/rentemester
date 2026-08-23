import { createHmac } from "node:crypto";
import type { Database } from "bun:sqlite";

export const AUTH_TELEMETRY_ENDPOINTS = ["sign-in-email", "send-verification-email", "verify-email", "request-password-reset", "reset-password", "sign-out", "revoke-session", "revoke-other-sessions", "two-factor-enable", "two-factor-verify", "two-factor-verify-backup-code"] as const;
export type AuthTelemetryEndpoint = typeof AUTH_TELEMETRY_ENDPOINTS[number];
export type AuthTelemetryOutcome = "attempted" | "accepted" | "rejected" | "unknown";

/** Pseudonymises a presented identity; plaintext email/password/token never reaches this table. */
export function authAuditIdentityHash(secret: string, identity: string | null | undefined): string | null {
  if (!identity) return null;
  return createHmac("sha256", secret).update(`rentemester-auth-audit-v1\0${identity.trim().toLowerCase()}`).digest("hex");
}

/** Key version is persisted because auth-secret rotation intentionally breaks old pseudonym correlation. */
export function appendAuthTelemetryEvent(db: Database, input: { endpoint: AuthTelemetryEndpoint; outcome: AuthTelemetryOutcome; userId?: string | null; sessionId?: string | null; identityHash?: string | null; identityKeyVersion?: number }): void {
  db.query(`INSERT INTO rm_workspace_auth_telemetry_events (endpoint, outcome, user_id, session_id, identity_hash, identity_key_version) VALUES (?, ?, ?, ?, ?, ?)`).run(input.endpoint, input.outcome, input.userId ?? null, input.sessionId ?? null, input.identityHash ?? null, input.identityKeyVersion ?? 1);
}
