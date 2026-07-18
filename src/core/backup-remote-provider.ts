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
  if (Number.isNaN(observedAtMs) || verifiedAtMs - observedAtMs > maxMetadataAgeMs || observedAtMs > verifiedAtMs) {
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
      verifiedAt: new Date(verifiedAtMs).toISOString(),
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
