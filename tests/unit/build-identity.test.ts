import { describe, expect, test } from "bun:test";
import { getBuildIdentity, PRODUCT_VERSION } from "../../src/core/build-identity";

describe("build identity", () => {
  test("uses the package SemVer without local-only metadata", () => {
    expect(PRODUCT_VERSION).toBe("0.1.0");
    expect(getBuildIdentity({})).toEqual({
      version: "0.1.0",
      gitCommit: null,
      builtAt: null,
    });
  });

  test("accepts release build metadata", () => {
    expect(
      getBuildIdentity({
        RENTEMESTER_VERSION: "0.1.0",
        RENTEMESTER_GIT_COMMIT: "81acc2f",
        RENTEMESTER_BUILT_AT: "2026-07-19T12:00:00.000Z",
      }),
    ).toEqual({
      version: "0.1.0",
      gitCommit: "81acc2f",
      builtAt: "2026-07-19T12:00:00.000Z",
    });
  });

  test("rejects ambiguous build metadata", () => {
    expect(() =>
      getBuildIdentity({ RENTEMESTER_GIT_COMMIT: "main" }),
    ).toThrow("hexadecimal commit id");
    expect(() =>
      getBuildIdentity({ RENTEMESTER_BUILT_AT: "not-a-date" }),
    ).toThrow("ISO-8601 timestamp");
    expect(() =>
      getBuildIdentity({ RENTEMESTER_VERSION: "0.2.0" }),
    ).toThrow("does not match packaged version");
  });
});
