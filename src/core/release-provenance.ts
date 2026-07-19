import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuildIdentity } from "./build-identity";
import { isValidSemVer } from "./semver";
import {
  BASELINE_MIGRATION_CHECKSUM,
  CURRENT_SCHEMA_VERSION,
} from "./schema-version";

const DEFAULT_REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
let cachedDefaultDigest: string | null = null;

function listFilesRecursively(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? listFilesRecursively(path) : [path];
    })
    .filter((path) => statSync(path).isFile());
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Content address for every input that can influence regulatory behaviour.
 * Paths and bytes are both hashed, in POSIX-style lexical order, so renames
 * and content edits are visible and the result is independent of filesystem
 * enumeration order.
 */
export function computeRuleSetDigest(
  repositoryRoot: string = DEFAULT_REPOSITORY_ROOT,
): string {
  const root = resolve(repositoryRoot);
  if (root === resolve(DEFAULT_REPOSITORY_ROOT) && cachedDefaultDigest) {
    return cachedDefaultDigest;
  }
  const files = [
    ...listFilesRecursively(join(root, "rules", "dk")),
    ...listFilesRecursively(join(root, "sources")),
  ].sort((left, right) =>
    compareCodeUnits(
      relative(root, left).replaceAll("\\", "/"),
      relative(root, right).replaceAll("\\", "/"),
    ),
  );

  const hash = createHash("sha256");
  for (const path of files) {
    const portablePath = relative(root, path).replaceAll("\\", "/");
    const content = readFileSync(path);
    hash.update(portablePath, "utf8");
    hash.update("\0");
    hash.update(String(content.byteLength), "utf8");
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  const digest = `sha256:${hash.digest("hex")}`;
  if (root === resolve(DEFAULT_REPOSITORY_ROOT)) cachedDefaultDigest = digest;
  return digest;
}

export type ReleaseProvenance = {
  product: ReturnType<typeof getBuildIdentity>;
  schema: {
    version: number;
    baselineChecksum: string;
  };
  rules: {
    digest: string;
  };
};

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Runtime guard for provenance read back from signed export manifests. */
export function isReleaseProvenance(value: unknown): value is ReleaseProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const product = candidate.product as Record<string, unknown> | undefined;
  const schema = candidate.schema as Record<string, unknown> | undefined;
  const rules = candidate.rules as Record<string, unknown> | undefined;
  if (!product || !schema || !rules) return false;
  return (
    typeof product.version === "string" &&
    isValidSemVer(product.version) &&
    isNullableString(product.gitCommit) &&
    (product.gitCommit === null || /^[0-9a-f]{7,64}$/i.test(product.gitCommit)) &&
    isNullableString(product.builtAt) &&
    (product.builtAt === null || !Number.isNaN(Date.parse(product.builtAt))) &&
    Number.isInteger(schema.version) &&
    (schema.version as number) > 0 &&
    typeof schema.baselineChecksum === "string" &&
    /^[0-9a-f]{64}$/i.test(schema.baselineChecksum) &&
    typeof rules.digest === "string" &&
    /^sha256:[0-9a-f]{64}$/i.test(rules.digest)
  );
}

export function getReleaseProvenance(): ReleaseProvenance {
  return {
    product: getBuildIdentity(),
    schema: {
      version: CURRENT_SCHEMA_VERSION,
      baselineChecksum: BASELINE_MIGRATION_CHECKSUM,
    },
    rules: {
      digest: computeRuleSetDigest(),
    },
  };
}
