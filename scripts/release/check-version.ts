#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidSemVer } from "../../src/core/semver";

const root = join(import.meta.dir, "..", "..");

function packageVersion(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || !isValidSemVer(parsed.version)) {
    throw new Error(`${path} does not contain a valid SemVer version`);
  }
  return parsed.version;
}

const productVersion = packageVersion(join(root, "package.json"));
const cockpitVersion = packageVersion(join(root, "app", "package.json"));
if (productVersion !== cockpitVersion) {
  throw new Error(
    `version drift: package.json=${productVersion}, app/package.json=${cockpitVersion}`,
  );
}

const expected = process.argv[2]?.replace(/^v/, "");
if (expected && !isValidSemVer(expected)) {
  throw new Error(`requested release is not valid SemVer: ${expected}`);
}
if (expected?.includes("+")) {
  throw new Error("release versions must not use SemVer build metadata because OCI tags cannot contain '+'");
}
if (expected && expected !== productVersion) {
  throw new Error(
    `requested release ${expected} does not match source version ${productVersion}`,
  );
}

process.stdout.write(`${productVersion}\n`);
