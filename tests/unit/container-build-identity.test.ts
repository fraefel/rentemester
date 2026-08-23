import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveContainerBuildIdentity } from "../../scripts/release/container-build-identity";

const root = join(import.meta.dir, "..", "..");
const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;

describe("container build identity", () => {
  test("binds container gates to a synthetic future package version", () => {
    expect(resolveContainerBuildIdentity({
      packageVersion: "2.3.4",
      env: {
        RELEASE_VERSION: "2.3.4",
        RELEASE_GIT_COMMIT: commit,
        RELEASE_BUILT_AT: "2026-08-23T12:34:56Z",
        SOURCE_DATE_EPOCH: "1787488496",
        RENTEMESTER_BUN_VERSION: "1.4.0",
        RENTEMESTER_BASE_IMAGE_DIGEST: digest,
      },
    })).toEqual({
      version: "2.3.4",
      commit,
      builtAt: "2026-08-23T12:34:56Z",
      sourceDateEpoch: "1787488496",
      bunVersion: "1.4.0",
      baseImageDigest: digest,
    });
  });

  test("refuses a release identity that differs from the packaged version", () => {
    expect(() => resolveContainerBuildIdentity({
      packageVersion: "2.3.4",
      env: { RELEASE_VERSION: "0.1.0" },
      git: () => commit,
    })).toThrow("must match package.json 2.3.4");
  });

  test("container gate scripts contain no fixed surrogate product identity", () => {
    for (const relative of [
      "scripts/release/test-local-container.ts",
      "scripts/release/verify-container-reproducibility.ts",
    ]) {
      const source = readFileSync(join(root, relative), "utf8");
      expect(source).toContain("resolveContainerBuildIdentity");
      expect(source).not.toContain('RENTEMESTER_VERSION=0.1.0');
      expect(source).not.toContain("0000000000000000000000000000000000000000");
    }
  });
});
