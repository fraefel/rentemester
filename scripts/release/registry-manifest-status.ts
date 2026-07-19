#!/usr/bin/env bun

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type FetchLike = typeof fetch;

/** Return only authoritative GHCR presence/absence; every other status fails. */
export async function getGhcrManifestStatus(
  repository: string,
  reference: string,
  actor: string,
  credential: string,
  request: FetchLike = fetch,
): Promise<200 | 404> {
  const parsed = new URL(repository);
  if (parsed.protocol !== "https:" || parsed.hostname !== "ghcr.io") {
    throw new Error("repository must be an https://ghcr.io image repository");
  }
  const repositoryPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (!repositoryPath || !reference || !actor || !credential) {
    throw new Error("repository, reference, actor and GHCR credential are required");
  }

  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set("service", "ghcr.io");
  tokenUrl.searchParams.set("scope", `repository:${repositoryPath}:pull`);
  const tokenResponse = await request(tokenUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${actor}:${credential}`, "utf8").toString("base64")}`,
    },
  });
  if (!tokenResponse.ok) {
    throw new Error(`GHCR token request failed with HTTP ${tokenResponse.status}`);
  }
  const tokenBody = (await tokenResponse.json()) as {
    token?: unknown;
    access_token?: unknown;
  };
  const token =
    typeof tokenBody.token === "string"
      ? tokenBody.token
      : typeof tokenBody.access_token === "string"
        ? tokenBody.access_token
        : null;
  if (!token) throw new Error("GHCR token response did not contain a bearer token");

  const manifestUrl = new URL(
    `/v2/${repositoryPath}/manifests/${encodeURIComponent(reference)}`,
    "https://ghcr.io",
  );
  const manifestResponse = await request(manifestUrl, {
    method: "HEAD",
    headers: {
      Accept: MANIFEST_ACCEPT,
      Authorization: `Bearer ${token}`,
    },
  });
  if (manifestResponse.status === 200 || manifestResponse.status === 404) {
    return manifestResponse.status;
  }
  throw new Error(
    `GHCR manifest lookup failed with HTTP ${manifestResponse.status}; refusing to classify it as absent`,
  );
}

if (import.meta.main) {
  const repository = process.argv[2];
  const reference = process.argv[3];
  const actor = process.env.GITHUB_ACTOR ?? "";
  const credential = process.env.GHCR_TOKEN ?? "";
  if (!repository || !reference) {
    throw new Error("usage: registry-manifest-status.ts <https://ghcr.io/owner/image> <tag-or-digest>");
  }
  const normalizedRepository = repository.startsWith("ghcr.io/")
    ? `https://${repository}`
    : repository;
  process.stdout.write(
    `${await getGhcrManifestStatus(normalizedRepository, reference, actor, credential)}\n`,
  );
}
