import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const candidate = readFileSync(
  join(root, ".github", "workflows", "release-candidate.yml"),
  "utf8",
);
const promote = readFileSync(
  join(root, ".github", "workflows", "release-promote.yml"),
  "utf8",
);
const www = readFileSync(join(root, ".github", "workflows", "www.yml"), "utf8");
const registryStatus = readFileSync(
  join(root, "scripts", "release", "registry-manifest-status.ts"),
  "utf8",
);

describe("release workflow security contract", () => {
  test("pins every privileged third-party action to a full commit", () => {
    for (const workflow of [candidate, promote, www]) {
      const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(
        (match) => match[1],
      );
      expect(uses.length).toBeGreaterThan(0);
      expect(uses.every((value) => /@[0-9a-f]{40}$/i.test(value))).toBe(true);
    }
  });

  test("publishes evidence only after the candidate image is attested", () => {
    expect(candidate).toContain('if [ "$commit" != "$GITHUB_SHA" ]');
    expect(candidate.indexOf("name: Attest candidate image provenance")).toBeGreaterThan(
      candidate.indexOf("name: Build and push candidate image"),
    );
    expect(candidate.indexOf("name: Upload candidate evidence for Digisense")).toBeGreaterThan(
      candidate.indexOf("name: Attest candidate image provenance"),
    );
    expect(candidate).toContain("name: release-candidate-evidence");
    expect(candidate).toContain("Review status: **not reviewed by Digisense**");
    expect(candidate).toContain("Immutable digest:");
    expect(candidate).toContain("docker pull $REGISTRY_IMAGE@$DIGEST");
    expect(candidate).not.toContain("Approved bytes:");
    expect(candidate).not.toContain(":latest");
  });

  test("smokes the published digest before attestation and evidence", () => {
    const imageBuild = candidate.indexOf("name: Build and push candidate image");
    const containerSmoke = candidate.indexOf("name: Smoke the published candidate digest");
    const attestation = candidate.indexOf("name: Attest candidate image provenance");
    expect(containerSmoke).toBeGreaterThan(imageBuild);
    expect(attestation).toBeGreaterThan(containerSmoke);
    expect(candidate).toContain('image="$REGISTRY_IMAGE@$IMAGE_DIGEST"');
    expect(candidate).toContain('test "$(id -u)" = 1000');
    expect(candidate).toContain("cockpit asset missing");
  });

  test("binds promotion to one successful trusted run and its attestation", () => {
    for (const required of [
      '.github/workflows/release-candidate.yml',
      'workflow_dispatch',
      'head_branch',
      'conclusion',
      'run_attempt',
      'name: release-candidate-evidence',
      'sha256sum --check release-manifest.json.sha256',
      'gh attestation verify',
      '--signer-workflow',
      '--source-digest',
      '--source-ref refs/heads/main',
      'runDetails.metadata.invocationId',
    ]) {
      expect(promote).toContain(required);
    }
    expect(promote).toContain("ref: ${{ github.sha }}");
    expect(promote).not.toContain("pattern: release-candidate-*");
    expect(promote).not.toContain(":latest");
    expect(promote).toContain("registry-manifest-status.ts");
    expect(candidate).toContain("registry-manifest-status.ts");
    expect(registryStatus).toContain("manifestResponse.status === 200 || manifestResponse.status === 404");
    expect(registryStatus).toContain("refusing to classify it as absent");
  });

  test("completes all immutable preflights before either external write", () => {
    const preflight = promote.indexOf("name: Preflight every release target");
    const imageWrite = promote.indexOf("docker buildx imagetools create --tag");
    const releaseWrite = promote.indexOf('gh release create "v$VERSION"');
    expect(preflight).toBeGreaterThan(0);
    expect(imageWrite).toBeGreaterThan(preflight);
    expect(releaseWrite).toBeGreaterThan(preflight);
    expect(promote.slice(0, preflight)).not.toContain("imagetools create --tag");
    expect(promote.slice(0, preflight)).not.toContain("gh release create");
  });

  test("marks promoted SemVer prereleases as GitHub prereleases", () => {
    expect(promote).toContain('if [[ "$VERSION" == *-* ]]');
    expect(promote).toContain("release_flags+=(--prerelease)");
    expect(promote).toContain('"${release_flags[@]}"');
  });
});

describe("container release inputs", () => {
  const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
  const compose = readFileSync(join(root, "docker-compose.example.yml"), "utf8");

  test("pins the Docker frontend and Bun base and runs non-root", () => {
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:1\.7@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/oven\/bun:1\.3\.14-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("USER bun");
    expect(dockerfile).toContain("RENTEMESTER_APP_AUTH=required");
    expect(dockerfile).toContain("process.env.RENTEMESTER_APP_TOKEN");
    expect(dockerfile).toContain("Authorization:`Bearer ${token}`");
    expect(dockerfile).not.toContain(":latest");
  });

  test("requires a digest pin and keeps the no-login cockpit on host loopback", () => {
    expect(compose).toContain("RENTEMESTER_IMAGE:?");
    expect(compose).toContain('"127.0.0.1:4319:4319"');
    expect(compose).toContain("RENTEMESTER_APP_AUTH: off");
    expect(compose).toContain("rentemester-workspace:/workspace");
    expect(compose).not.toContain("ghcr.io/mikkelkrogsholm/rentemester:v0.1.0");
  });
});
