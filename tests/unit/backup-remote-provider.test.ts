import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  verifyRemoteBackupEvidence,
  NativeGoogleDriveBackupApi,
  GoogleDriveRemoteBackupProvider,
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

describe("#547 native Google Drive fetch adapter", () => {
  const metadata = {
    id: "drive-file-547", name: "backup-20260718.tar", parents: ["drive-folder-eu"], size: String(CONTENT.byteLength),
    sha256Checksum: CHECKSUM, mimeType: "application/octet-stream", capabilities: { canDownload: true },
  };
  test("uses explicit metadata fields, accepts a binary tar blob, and never exposes its token", async () => {
    const urls: string[] = [];
    const api = new NativeGoogleDriveBackupApi(async () => "secret-token", async (url) => {
      urls.push(url); return new Response(JSON.stringify(metadata), { status: 200 });
    });
    const result = await api.getFile("drive-file-547");
    expect(result.ok).toBe(true);
    expect(urls[0]).toContain("fields=id,name,parents,size,sha256Checksum,mimeType,capabilities(canDownload)");
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  test("maps revoked/missing and malformed or native-document metadata fail closed", async () => {
    for (const [status, expected] of [[401, "revoked"], [403, "revoked"], [404, "missing"]] as const) {
      const api = new NativeGoogleDriveBackupApi(async () => "x", async () => new Response("secret provider body", { status }));
      expect(await api.getFile("x")).toEqual({ ok: false, failure: expected });
    }
    for (const bad of [{ ...metadata, mimeType: "application/vnd.google-apps.document" }, { ...metadata, parents: ["a", "b"] }, { ...metadata, capabilities: { canDownload: false } }]) {
      const api = new NativeGoogleDriveBackupApi(async () => "x", async () => new Response(JSON.stringify(bad)));
      expect(await api.getFile("x")).toEqual({ ok: false, failure: "error" });
    }
  });

  test("native metadata observation immediately after a supplied verification clock is accepted without leaking token", async () => {
    let calls = 0;
    const api = new NativeGoogleDriveBackupApi(async () => "clock-race-secret", async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify(metadata))
        : new Response(CONTENT);
    });
    const result = await verifyRemoteBackupEvidence(new GoogleDriveRemoteBackupProvider(api), {
      expected: { provider: "google-drive", objectId: "drive-file-547", name: "backup-20260718.tar", parentId: "drive-folder-eu", sizeBytes: CONTENT.byteLength, checksumSha256: CHECKSUM },
      verifiedAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("clock-race-secret");
    if (result.ok) expect(Date.parse(result.evidence.verifiedAt)).toBeGreaterThanOrEqual(Date.parse(result.evidence.metadataObservedAt));
  });
});
