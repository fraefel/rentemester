// Remote backup providers are deliberately injected. This module never reads
// credentials, environment variables, or provider SDK globals: the host owns
// authentication and the core only receives the evidence it can verify.

import { createHash } from "node:crypto";

export type RemoteBackupProviderFailure = "missing" | "revoked" | "error";

export type RemoteBackupObjectMetadata = {
  objectId: string;
  name: string;
  parentId: string;
  sizeBytes: number;
  checksumSha256: string;
  // The provider must state when it obtained this metadata. This makes cached
  // metadata detectable instead of silently treating it as current evidence.
  observedAt: string;
};

export type RemoteBackupObjectLookup =
  | { ok: true; metadata: RemoteBackupObjectMetadata }
  | { ok: false; failure: RemoteBackupProviderFailure };

export type RemoteBackupProviderAdapter = {
  provider: string;
  getObject(objectId: string): Promise<RemoteBackupObjectLookup>;
  readObjectContent(objectId: string): Promise<Uint8Array>;
};

export type ExpectedRemoteBackupObject = {
  provider: string;
  objectId: string;
  name: string;
  parentId: string;
  sizeBytes: number;
  checksumSha256: string;
};

export type RemoteBackupEvidence = {
  provider: string;
  objectId: string;
  name: string;
  parentId: string;
  sizeBytes: number;
  checksumSha256: string;
  metadataObservedAt: string;
  verifiedAt: string;
};

export type VerifyRemoteBackupEvidenceInput = {
  expected: ExpectedRemoteBackupObject;
  verifiedAt: string;
  // Five minutes limits a provider cache from becoming backup evidence while
  // allowing a normal API response to travel through an integration host.
  maxMetadataAgeMs?: number;
};

export type VerifyRemoteBackupEvidenceResult =
  | { ok: true; evidence: RemoteBackupEvidence }
  | { ok: false; errors: string[] };

function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function validExpectedObject(expected: ExpectedRemoteBackupObject): string[] {
  const errors: string[] = [];
  if (!expected.provider.trim()) errors.push("remote provider is required");
  if (!expected.objectId.trim()) errors.push("remote object id is required");
  if (!expected.name.trim()) errors.push("remote object name is required");
  if (!expected.parentId.trim()) errors.push("remote parent id is required");
  if (!Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes < 0) {
    errors.push("remote object size must be a non-negative integer");
  }
  if (!validSha256(expected.checksumSha256)) errors.push("remote object checksum must be a sha256 digest");
  return errors;
}

// Verify both provider metadata and independently downloaded content. Provider
// checksums alone are not enough: a stale or incorrect provider response must
// not upgrade a backup from declared to verified.
export async function verifyRemoteBackupEvidence(
  adapter: RemoteBackupProviderAdapter,
  input: VerifyRemoteBackupEvidenceInput,
): Promise<VerifyRemoteBackupEvidenceResult> {
  const errors = validExpectedObject(input.expected);
  const verifiedAtMs = Date.parse(input.verifiedAt);
  if (Number.isNaN(verifiedAtMs)) errors.push("verifiedAt must be a valid ISO-8601 datetime");
  const maxMetadataAgeMs = input.maxMetadataAgeMs ?? 5 * 60 * 1000;
  if (!Number.isSafeInteger(maxMetadataAgeMs) || maxMetadataAgeMs < 0) {
    errors.push("maxMetadataAgeMs must be a non-negative integer");
  }
  if (adapter.provider !== input.expected.provider) {
    errors.push(`remote provider mismatch: expected ${input.expected.provider}, got ${adapter.provider}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  let lookup: RemoteBackupObjectLookup;
  try {
    lookup = await adapter.getObject(input.expected.objectId);
  } catch {
    return { ok: false, errors: ["remote provider error while reading backup metadata"] };
  }
  if (!lookup.ok) {
    const message = lookup.failure === "revoked"
      ? "remote provider access has been revoked"
      : lookup.failure === "missing"
        ? "remote backup object is missing"
        : "remote provider error while reading backup metadata";
    return { ok: false, errors: [message] };
  }

  const { metadata } = lookup;
  const observedAtMs = Date.parse(metadata.observedAt);
  const observationSkewMs = 1_000;
  if (Number.isNaN(observedAtMs) || verifiedAtMs - observedAtMs > maxMetadataAgeMs || observedAtMs > verifiedAtMs + observationSkewMs) {
    return { ok: false, errors: ["remote backup metadata is stale or has an invalid observation time"] };
  }
  const expected = input.expected;
  if (
    metadata.objectId !== expected.objectId ||
    metadata.name !== expected.name ||
    metadata.parentId !== expected.parentId ||
    metadata.sizeBytes !== expected.sizeBytes ||
    metadata.checksumSha256.toLowerCase() !== expected.checksumSha256.toLowerCase()
  ) {
    return { ok: false, errors: ["remote backup metadata does not match the expected object"] };
  }

  let content: Uint8Array;
  try {
    content = await adapter.readObjectContent(expected.objectId);
  } catch {
    return { ok: false, errors: ["remote provider error while reading backup content"] };
  }
  const contentChecksum = createHash("sha256").update(content).digest("hex");
  if (content.byteLength !== expected.sizeBytes || contentChecksum !== expected.checksumSha256.toLowerCase()) {
    return { ok: false, errors: ["remote backup content does not match the expected size and checksum"] };
  }

  return {
    ok: true,
    evidence: {
      provider: expected.provider,
      objectId: expected.objectId,
      name: expected.name,
      parentId: expected.parentId,
      sizeBytes: expected.sizeBytes,
      checksumSha256: expected.checksumSha256.toLowerCase(),
      metadataObservedAt: new Date(observedAtMs).toISOString(),
      verifiedAt: new Date(Math.max(verifiedAtMs, observedAtMs)).toISOString(),
    },
  };
}

// Google Drive's HTTP client is intentionally supplied by the embedding host.
// It is the implementation boundary for Drive without putting OAuth tokens or
// network configuration in the accounting core.
export type GoogleDriveBackupApi = {
  getFile(fileId: string): Promise<
    | {
        ok: true;
        id: string;
        name: string;
        parentId: string;
        sizeBytes: number;
        checksumSha256: string;
        observedAt: string;
      }
    | { ok: false; failure: RemoteBackupProviderFailure }
  >;
  downloadFile(fileId: string): Promise<Uint8Array>;
};

export class GoogleDriveRemoteBackupProvider implements RemoteBackupProviderAdapter {
  readonly provider = "google-drive";

  constructor(private readonly api: GoogleDriveBackupApi) {}

  async getObject(objectId: string): Promise<RemoteBackupObjectLookup> {
    const response = await this.api.getFile(objectId);
    if (!response.ok) return response;
    return {
      ok: true,
      metadata: {
        objectId: response.id,
        name: response.name,
        parentId: response.parentId,
        sizeBytes: response.sizeBytes,
        checksumSha256: response.checksumSha256,
        observedAt: response.observedAt,
      },
    };
  }

  readObjectContent(objectId: string): Promise<Uint8Array> {
    return this.api.downloadFile(objectId);
  }
}

/** A deliberately tiny fetch seam: callers inject short-lived access tokens. */
export type GoogleDriveFetch = (input: string, init?: RequestInit) => Promise<Response>;

export class NativeGoogleDriveBackupApi implements GoogleDriveBackupApi {
  constructor(
    private readonly accessToken: () => Promise<string | undefined>,
    private readonly fetcher: GoogleDriveFetch = fetch,
  ) {}

  private async request(fileId: string, query: string): Promise<Response | null> {
    const token = await this.accessToken();
    if (!token) return null;
    return this.fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async getFile(fileId: string): Promise<Awaited<ReturnType<GoogleDriveBackupApi["getFile"]>>> {
    let response: Response | null;
    try {
      response = await this.request(fileId, "fields=id,name,parents,size,sha256Checksum,mimeType,capabilities(canDownload)&supportsAllDrives=true");
    } catch { return { ok: false, failure: "error" }; }
    if (!response) return { ok: false, failure: "revoked" };
    if (response.status === 401 || response.status === 403) return { ok: false, failure: "revoked" };
    if (response.status === 404) return { ok: false, failure: "missing" };
    if (!response.ok) return { ok: false, failure: "error" };
    let data: any;
    try { data = await response.json(); } catch { return { ok: false, failure: "error" }; }
    const sizeBytes = typeof data.size === "string" ? Number(data.size) : data.size;
    if (
      typeof data.id !== "string" || typeof data.name !== "string" || !Array.isArray(data.parents) || data.parents.length !== 1 ||
      typeof data.parents[0] !== "string" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 ||
      typeof data.sha256Checksum !== "string" || !/^[0-9a-f]{64}$/i.test(data.sha256Checksum) ||
      !["application/x-tar", "application/octet-stream"].includes(data.mimeType) || data.capabilities?.canDownload !== true
    ) return { ok: false, failure: "error" };
    return { ok: true, id: data.id, name: data.name, parentId: data.parents[0], sizeBytes, checksumSha256: data.sha256Checksum, observedAt: new Date().toISOString() };
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    let response: Response | null;
    try { response = await this.request(fileId, "alt=media&supportsAllDrives=true"); } catch { throw new Error("Drive download failed"); }
    if (!response || !response.ok) throw new Error("Drive download failed");
    return new Uint8Array(await response.arrayBuffer());
  }
}

export type RemoteBackupProviderResolver = {
  resolve(companyRoot: string, provider: string): RemoteBackupProviderAdapter | undefined;
};

/** Default host composition: no credential is persisted or logged. */
export function defaultRemoteBackupProviderResolver(fetcher?: GoogleDriveFetch): RemoteBackupProviderResolver {
  return {
    resolve(_companyRoot, provider) {
      if (provider !== "google-drive") return undefined;
      const api = new NativeGoogleDriveBackupApi(async () => process.env.RENTEMESTER_GOOGLE_DRIVE_ACCESS_TOKEN, fetcher);
      return new GoogleDriveRemoteBackupProvider(api);
    },
  };
}
