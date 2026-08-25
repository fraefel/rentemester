// Immutable evidence-file snapshots for HTTP download routes.
//
// A GET must never use Bun.file(path): that defers the open until response
// consumption and reintroduces a path TOCTOU after validation.  This module
// opens the final entry with O_NOFOLLOW, verifies the inode is a regular file,
// copies a bounded byte snapshot from that descriptor, and hashes those exact
// bytes before the descriptor is closed.

import { snapshotRegisteredDocumentEvidence } from "../../core/document-storage";

export type EvidenceFileSnapshot = {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
};

export class EvidenceFileUnavailable extends Error {
  constructor() {
    super("evidence file is unavailable");
  }
}

function safeMimeType(value: string | null): string {
  const normalized = (value ?? "").trim().toLowerCase();
  // MIME is presentation metadata only.  Reject control characters and
  // absurdly long values before putting it in a response header.
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=[a-z0-9._-]+)?$/.test(normalized)) {
    return "application/octet-stream";
  }
  return normalized;
}

/** A conservative filename prevents header injection and browser ambiguity. */
export function evidenceDownloadFilename(id: number, extension: string): string {
  const safeId = Number.isInteger(id) && id > 0 ? String(id) : "file";
  const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "";
  return `rentemester-evidence-${safeId}${safeExtension}`;
}

/**
 * Return a verified in-memory byte snapshot of a persisted evidence artifact.
 * No caller receives a filesystem path, so it cannot validate one inode and
 * stream another one later.  Errors deliberately carry no path/hash details.
 */
export function readVerifiedEvidenceFile(input: {
  companyRoot: string;
  storedPath: string;
  expectedSha256: string;
  documentType: string;
  mimeType: string | null;
  filename: string;
}): EvidenceFileSnapshot {
  try {
    const snapshot = snapshotRegisteredDocumentEvidence(input.companyRoot, {
      storedPath: input.storedPath,
      expectedSha256: input.expectedSha256,
      documentType: input.documentType,
    });
    return { bytes: snapshot.bytes, mimeType: safeMimeType(input.mimeType), filename: input.filename };
  } catch {
    throw new EvidenceFileUnavailable();
  }
}
