import packageJson from "../../package.json" with { type: "json" };
import { isValidSemVer } from "./semver";

const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

export type BuildIdentity = {
  version: string;
  gitCommit: string | null;
  builtAt: string | null;
  bunVersion: string | null;
  baseImageDigest: string | null;
};

function optionalBuildValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Identity embedded in every supported runtime surface.
 *
 * The product SemVer comes from the root package manifest. Container builds
 * add an immutable commit and build timestamp through environment variables;
 * local source runs deliberately report those two fields as null.
 */
export function getBuildIdentity(
  env: NodeJS.ProcessEnv = process.env,
): BuildIdentity {
  if (!isValidSemVer(packageJson.version)) {
    throw new Error(`package.json contains invalid SemVer: ${packageJson.version}`);
  }

  const declaredVersion = optionalBuildValue(env.RENTEMESTER_VERSION);
  if (declaredVersion && declaredVersion !== packageJson.version) {
    throw new Error(
      `RENTEMESTER_VERSION ${declaredVersion} does not match packaged version ${packageJson.version}`,
    );
  }

  const gitCommit = optionalBuildValue(env.RENTEMESTER_GIT_COMMIT);
  if (gitCommit && !GIT_COMMIT_PATTERN.test(gitCommit)) {
    throw new Error("RENTEMESTER_GIT_COMMIT must be a 7-64 character hexadecimal commit id");
  }

  const builtAt = optionalBuildValue(env.RENTEMESTER_BUILT_AT);
  if (builtAt && Number.isNaN(Date.parse(builtAt))) {
    throw new Error("RENTEMESTER_BUILT_AT must be an ISO-8601 timestamp");
  }

  const bunVersion = optionalBuildValue(env.RENTEMESTER_BUN_VERSION);
  if (bunVersion && !isValidSemVer(bunVersion)) {
    throw new Error("RENTEMESTER_BUN_VERSION must be a SemVer version");
  }

  const baseImageDigest = optionalBuildValue(env.RENTEMESTER_BASE_IMAGE_DIGEST);
  if (baseImageDigest && !/^sha256:[0-9a-f]{64}$/i.test(baseImageDigest)) {
    throw new Error("RENTEMESTER_BASE_IMAGE_DIGEST must be a sha256 digest");
  }

  return {
    version: packageJson.version,
    gitCommit,
    builtAt,
    bunVersion,
    baseImageDigest,
  };
}

export const PRODUCT_VERSION = getBuildIdentity({}).version;
