import { describe, expect, test } from "bun:test";
import { isValidSemVer } from "../../src/core/semver";

describe("SemVer validation", () => {
  test.each([
    "0.1.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x.7.z.92",
    "1.0.0+build.11.e0f985a",
  ])("accepts %s", (version) => {
    expect(isValidSemVer(version)).toBe(true);
  });

  test.each([
    "1",
    "1.0",
    "01.0.0",
    "1.01.0",
    "1.0.00",
    "1.0.0-01",
    "1.0.0-..",
    "1.0.0-",
    "v1.0.0",
  ])("rejects %s", (version) => {
    expect(isValidSemVer(version)).toBe(false);
  });
});
