import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  verifyRemoteBackupEvidence,
  type RemoteBackupProviderAdapter,
} from "../../src/core/backup-remote-provider";

const CONTENT = new TextEncoder().encode("deterministic remote backup archive");
const CHECKSUM = createHash("sha256").update(CONTENT).digest("hex");
const VERIFIED_AT = "2026-07-18T12:00:00.000Z";

function mockAdapter(overrides: Partial<RemoteBackupProviderAdapter> = {}): RemoteBackupProviderAdapter {
  return {
    provider: "google-drive",
    async getObject() {
      return {
        ok: true,
        metadata: {
          objectId: "drive-file-547",
          name: "backup-20260718.tar",
          parentId: "drive-folder-eu",
          sizeBytes: CONTENT.byteLength,
          checksumSha256: CHECKSUM,
          observedAt: "2026-07-18T11:59:30.000Z",
        },
      };
    },
    async readObjectContent() {
      return CONTENT;
    },
    ...overrides,
  };
}

function verify(adapter: RemoteBackupProviderAdapter) {
  return verifyRemoteBackupEvidence(adapter, {
    expected: {
      provider: "google-drive",
      objectId: "drive-file-547",
      name: "backup-20260718.tar",
      parentId: "drive-folder-eu",
      sizeBytes: CONTENT.byteLength,
      checksumSha256: CHECKSUM,
    },
    verifiedAt: VERIFIED_AT,
  });
}

describe("#547 remote backup provider evidence", () => {
  test("records only checked metadata after deterministic provider metadata and content verification", async () => {
    const result = await verify(mockAdapter());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toEqual({
      provider: "google-drive",
      objectId: "drive-file-547",
      name: "backup-20260718.tar",
      parentId: "drive-folder-eu",
      sizeBytes: CONTENT.byteLength,
      checksumSha256: CHECKSUM,
      metadataObservedAt: "2026-07-18T11:59:30.000Z",
      verifiedAt: VERIFIED_AT,
    });
    expect(JSON.stringify(result.evidence)).not.toContain("deterministic remote backup archive");
  });

  test("fails closed when provider metadata does not match the expected object", async () => {
    const result = await verify(mockAdapter({
      async getObject() {
        return {
          ok: true,
          metadata: {
            objectId: "drive-file-547",
            name: "different.tar",
            parentId: "drive-folder-eu",
            sizeBytes: CONTENT.byteLength,
            checksumSha256: CHECKSUM,
            observedAt: "2026-07-18T11:59:30.000Z",
          },
        };
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("remote backup metadata does not match the expected object");
  });

  test("fails closed for stale provider metadata", async () => {
    const result = await verify(mockAdapter({
      async getObject() {
        return {
          ok: true,
          metadata: {
            objectId: "drive-file-547",
            name: "backup-20260718.tar",
            parentId: "drive-folder-eu",
            sizeBytes: CONTENT.byteLength,
            checksumSha256: CHECKSUM,
            observedAt: "2026-07-18T11:54:59.999Z",
          },
        };
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("metadata is stale");
  });

  test("fails closed when provider access is revoked", async () => {
    const result = await verify(mockAdapter({
      async getObject() {
        return { ok: false, failure: "revoked" };
      },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("remote provider access has been revoked");
  });
});
