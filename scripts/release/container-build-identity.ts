import packageJson from "../../package.json" with { type: "json" };
import { isValidSemVer } from "../../src/core/semver";

const DEFAULT_BUN_VERSION = "1.4.0";
const DEFAULT_BASE_IMAGE_DIGEST =
  "sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6";

export type ContainerBuildIdentity = {
  version: string;
  commit: string;
  builtAt: string;
  sourceDateEpoch: string;
  bunVersion: string;
  baseImageDigest: string;
};

type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  packageVersion?: string;
  git?: (format: "%H" | "%cI" | "%ct") => string;
};

function gitValue(format: "%H" | "%cI" | "%ct"): string {
  const result = Bun.spawnSync(["git", "show", "-s", `--format=${format}`, "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`cannot resolve container build identity from git: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function value(explicit: string | undefined, fallback: () => string): string {
  const trimmed = explicit?.trim();
  return trimmed || fallback();
}

/**
 * Resolves the exact identity used by local container gates.
 *
 * Release CI supplies the already-validated identity. A local run derives the
 * same values from package.json and the checked-out commit. This prevents a
 * gate from silently testing a fixed surrogate version such as 0.1.0.
 */
export function resolveContainerBuildIdentity(
  options: ResolveOptions = {},
): ContainerBuildIdentity {
  const env = options.env ?? process.env;
  const expectedVersion = options.packageVersion ?? packageJson.version;
  const git = options.git ?? gitValue;
  const version = value(env.RELEASE_VERSION, () => expectedVersion);
  const commit = value(env.RELEASE_GIT_COMMIT, () => git("%H"));
  const builtAt = value(env.RELEASE_BUILT_AT, () => git("%cI"));
  const sourceDateEpoch = value(env.SOURCE_DATE_EPOCH, () => git("%ct"));
  const bunVersion = value(env.RENTEMESTER_BUN_VERSION, () => DEFAULT_BUN_VERSION);
  const baseImageDigest = value(
    env.RENTEMESTER_BASE_IMAGE_DIGEST,
    () => DEFAULT_BASE_IMAGE_DIGEST,
  );

  if (!isValidSemVer(expectedVersion) || version !== expectedVersion) {
    throw new Error(`container release version ${version} must match package.json ${expectedVersion}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error("container release commit must be a full 40-character hexadecimal Git id");
  }
  if (Number.isNaN(Date.parse(builtAt))) {
    throw new Error("container release builtAt must be an ISO-8601 timestamp");
  }
  if (!/^[1-9][0-9]*$/.test(sourceDateEpoch)) {
    throw new Error("container SOURCE_DATE_EPOCH must be a positive integer");
  }
  if (!isValidSemVer(bunVersion)) {
    throw new Error("container Bun version must be SemVer");
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(baseImageDigest)) {
    throw new Error("container base image digest must be sha256");
  }

  return { version, commit, builtAt, sourceDateEpoch, bunVersion, baseImageDigest };
}
