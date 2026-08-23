import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContainerBuildIdentity } from "./container-build-identity";

function run(command: string[], allowFailure = false): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(`${command.join(" ")} failed (${result.exitCode})\n${stderr || stdout}`);
  }
  return stdout;
}

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const builder = `rentemester-repro-${suffix}`;
const outputRoot = mkdtempSync(join(tmpdir(), "rentemester-oci-repro-"));
const archives = [join(outputRoot, "first.oci.tar"), join(outputRoot, "second.oci.tar")] as const;
const buildkitImage = "moby/buildkit:buildx-stable-1@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8";
const identity = resolveContainerBuildIdentity();
const buildArgs = [
  "--build-arg", `RENTEMESTER_VERSION=${identity.version}`,
  "--build-arg", `RENTEMESTER_GIT_COMMIT=${identity.commit}`,
  "--build-arg", `RENTEMESTER_BUILT_AT=${identity.builtAt}`,
  "--build-arg", `RENTEMESTER_BUN_VERSION=${identity.bunVersion}`,
  "--build-arg", `RENTEMESTER_BASE_IMAGE_DIGEST=${identity.baseImageDigest}`,
  "--build-arg", `SOURCE_DATE_EPOCH=${identity.sourceDateEpoch}`,
];

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

try {
  run(["docker", "buildx", "create", "--name", builder, "--driver", "docker-container", "--driver-opt", `image=${buildkitImage}`]);
  run(["docker", "buildx", "inspect", "--builder", builder, "--bootstrap"]);
  for (const archive of archives) {
    run([
      "docker", "buildx", "build", "--builder", builder, "--no-cache", "--provenance=false",
      "--output", `type=oci,dest=${archive},rewrite-timestamp=true`,
      ...buildArgs, ".",
    ]);
  }
  const hashes = await Promise.all(archives.map(sha256));
  const indexes = archives.map((archive) => JSON.parse(run(["tar", "-xOf", archive, "index.json"])) as {
    manifests?: Array<{ digest?: string }>;
  });
  const digests = indexes.map((index) => index.manifests?.[0]?.digest ?? "");
  if (!/^sha256:[0-9a-f]{64}$/.test(digests[0]!) || hashes[0] !== hashes[1] || digests[0] !== digests[1]) {
    throw new Error(JSON.stringify({ message: "identical clean OCI exports differ", hashes, digests }, null, 2));
  }
  console.log(`reproducible OCI container verified: ${digests[0]} (archive sha256:${hashes[0]})`);
} finally {
  run(["docker", "buildx", "rm", builder], true);
  rmSync(outputRoot, { recursive: true, force: true });
}
