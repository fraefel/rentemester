// Cockpit write-actor attribution (#213).
//
// A Cockpit mutation is a *third* write-stack alongside the CLI (`src/cli.ts`)
// and the MCP server (`src/mcp/registry.ts`). Each stack owns its own actor
// policy: the CLI resolves an actor from `--actor`/env, MCP derives one from
// the client handshake. The server is neither — it must map the request
// `Principal` (from `authMiddleware`) to a core `ActorContext` so an
// append-only `audit_log` row can be traced back to "a human acting in the
// Cockpit".
//
// Local/shared-secret operation remains a fixed web actor. A hosted Better
// Auth principal is different: its canonical `user:<opaque-id>` must flow
// unchanged to the core, otherwise append-only audit evidence loses who made
// the mutation.
//
// IMPORTANT: like the MCP actor, the resolved actor is passed to core as an
// EXPLICIT payload parameter (`createdBy` / `createdByProgram`) — never via a
// process env var, which is race-prone when requests are handled in parallel.

import type { ActorContext } from "../core/actor";
import type { Principal } from "./auth";
import { ApiError } from "./errors";

/** The fixed Phase-1 Cockpit actor id. */
export const COCKPIT_ACTOR_ID = "system:cockpit";
/** The fixed Phase-1 Cockpit program tag (lands in `created_by_program`). */
export const COCKPIT_ACTOR_PROGRAM = "rentemester-cockpit";

/**
 * Maps an authenticated `Principal` to a core `ActorContext`.
 *
 * Hosted Better Auth identities are accepted only in the canonical opaque-id
 * shape emitted by `authMiddleware`. Do not turn arbitrary `agent:` or
 * `system:` strings into a trusted web actor if a provider seam is malformed.
 */
export function resolveCockpitActor(principal: Principal): ActorContext {
  if (principal.via === "better-auth" || principal.via === "service-principal") {
    if (!isCanonicalBetterAuthActorId(principal.id)) {
      throw ApiError.unauthorized("missing or invalid credentials");
    }
    return {
      createdBy: principal.id,
      createdByProgram: COCKPIT_ACTOR_PROGRAM,
      auditActor: `${principal.id} via ${COCKPIT_ACTOR_PROGRAM}`,
    };
  }
  return {
    createdBy: COCKPIT_ACTOR_ID,
    createdByProgram: COCKPIT_ACTOR_PROGRAM,
    auditActor: `${COCKPIT_ACTOR_ID} via ${COCKPIT_ACTOR_PROGRAM}`,
  };
}

/** Better Auth's default opaque IDs are URL-safe tokens, never actor syntax. */
function isCanonicalBetterAuthActorId(value: string): boolean {
  return /^user:[A-Za-z0-9_-]{1,191}$/.test(value);
}

/**
 * Folds the resolved actor into a core payload as explicit `createdBy` /
 * `createdByProgram` fields, without overwriting any value the caller set.
 * Mirrors `withActor` in `src/mcp/actor.ts`.
 */
export function withCockpitActor<T extends object>(
  payload: T & { createdBy?: string; createdByProgram?: string },
  actor: ActorContext,
): T & { createdBy: string; createdByProgram: string } {
  return {
    ...payload,
    createdBy: payload.createdBy ?? actor.createdBy,
    createdByProgram: payload.createdByProgram ?? actor.createdByProgram,
  };
}
