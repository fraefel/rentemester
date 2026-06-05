// Tests: src/cli-actor.ts and src/core/actor.ts — covers issue #325.
//
// On Windows there is no USER or LOGNAME environment variable; the logged-in
// account name lives in USERNAME instead. Both the CLI mutation gate
// (inferredMutationActor) and the ledger attribution path (resolveActor) must
// derive the same OS-user actor from USERNAME, otherwise mutating commands on
// Windows either fail closed with "actor required for mutations" or — if the
// gate were fixed alone — would silently record `system` in the audit trail
// while the gate reported a real user. The two must agree.
import { afterEach, describe, expect, test } from "bun:test";
import { inferredMutationActor } from "../../src/cli-actor";
import { resolveActor } from "../../src/core/actor";

// The env vars these functions read, so a test can isolate exactly one source.
const ACTOR_ENV_KEYS = [
  "OPENCLAW_AGENT",
  "RENTEMESTER_AGENT",
  "RENTEMESTER_USER",
  "RENTEMESTER_ACTOR",
  "RENTEMESTER_ACTOR_VIA",
  "USER",
  "LOGNAME",
  "USERNAME",
] as const;

const saved = new Map<string, string | undefined>();

function isolateActorEnv(overrides: Record<string, string>) {
  for (const key of ACTOR_ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (key in overrides) process.env[key] = overrides[key];
    else delete process.env[key];
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("#325 — Windows USERNAME is a valid OS-user actor source", () => {
  test("inferredMutationActor() derives user:<USERNAME> when only USERNAME is set", () => {
    isolateActorEnv({ USERNAME: "Troels" });
    expect(inferredMutationActor()).toBe("user:Troels");
  });

  test("resolveActor() attributes the ledger entry to user:<USERNAME> on Windows", () => {
    isolateActorEnv({ USERNAME: "Troels" });
    expect(resolveActor().createdBy).toBe("user:Troels");
  });

  test("explicit Unix USER still wins over Windows USERNAME (no behavior change off Windows)", () => {
    isolateActorEnv({ USER: "mikkel", USERNAME: "DESKTOP-fallback" });
    expect(inferredMutationActor()).toBe("user:mikkel");
    expect(resolveActor().createdBy).toBe("user:mikkel");
  });
});
