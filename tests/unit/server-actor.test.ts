import { describe, expect, test } from "bun:test";
import { resolveCockpitActor } from "../../src/server/actor";
import { ApiError } from "../../src/server/errors";

describe("cockpit actor attribution", () => {
  test("preserves a canonical Better Auth user identity for core audit payloads", () => {
    expect(resolveCockpitActor({
      id: "user:synthetic_user-42",
      via: "better-auth",
      sessionId: "opaque-session",
      sessionCreatedAt: new Date(),
    })).toEqual({
      createdBy: "user:synthetic_user-42",
      createdByProgram: "rentemester-cockpit",
      auditActor: "user:synthetic_user-42 via rentemester-cockpit",
    });
  });

  test("fails closed instead of accepting injected agent/system syntax from a malformed provider", () => {
    for (const id of ["agent:injected", "system:injected", "user:agent:injected", "user:bad space"]) {
      try {
        resolveCockpitActor({ id, via: "better-auth" });
        throw new Error("expected malformed Better Auth principal to be denied");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe("unauthorized");
      }
    }
  });

  test("keeps local and shared-secret cockpit writes on the legacy system actor", () => {
    for (const via of ["localhost-trusted", "shared-secret"] as const) {
      expect(resolveCockpitActor({ id: "system:local", via })).toMatchObject({
        createdBy: "system:cockpit",
        createdByProgram: "rentemester-cockpit",
        auditActor: "system:cockpit via rentemester-cockpit",
      });
    }
  });
});
