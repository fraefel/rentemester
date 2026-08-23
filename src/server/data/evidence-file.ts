// Immutable evidence-file snapshots for HTTP download routes.
//
// A GET must never use Bun.file(path): that defers the open until response
// consumption and reintroduces a path TOCTOU after validation.  This module
// opens the final entry with O_NOFOLLOW, verifies the inode is a regular file,
// copies a bounded byte snapshot from that descriptor, and hashes those exact
// bytes before the descriptor is closed.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;

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

function containedFinalPath(root: string, storedPath: string): string {
  const name = basename(storedPath);
  if (!name || name === "." || name === ".." || storedPath.includes("\0")) {
    throw new EvidenceFileUnavailable();
  }
  // Resolve the trusted evidence directory before accepting the final basename.
  // `basename` prevents a database value from selecting a parent/sibling.
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new EvidenceFileUnavailable();
  }
  const candidate = resolve(realRoot, name);
  const relation = relative(realRoot, candidate);
  if (!relation || relation.startsWith("..") || relation.includes("/..") || relation.includes("\\..")) {
    throw new EvidenceFileUnavailable();
  }
  return candidate;
}

/**
 * Return a verified in-memory byte snapshot of a persisted evidence artifact.
 * No caller receives a filesystem path, so it cannot validate one inode and
 * stream another one later.  Errors deliberately carry no path/hash details.
 */
export function readVerifiedEvidenceFile(input: {
  evidenceRoot: string;
  storedPath: string;
  expectedSha256: string;
  mimeType: string | null;
  filename: string;
}): EvidenceFileSnapshot {
  if (!/^[a-f0-9]{64}$/i.test(input.expectedSha256)) throw new EvidenceFileUnavailable();
  const path = containedFinalPath(input.evidenceRoot, input.storedPath);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const initial = fstatSync(fd);
    if (!initial.isFile() || initial.size < 0 || initial.size > MAX_EVIDENCE_BYTES) {
      throw new EvidenceFileUnavailable();
    }
    const bytes = Buffer.allocUnsafe(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new EvidenceFileUnavailable();
      offset += count;
    }
    const final = fstatSync(fd);
    if (final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size) {
      throw new EvidenceFileUnavailable();
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== input.expectedSha256.toLowerCase()) throw new EvidenceFileUnavailable();
    return { bytes, mimeType: safeMimeType(input.mimeType), filename: input.filename };
  } catch (error) {
    if (error instanceof EvidenceFileUnavailable) throw error;
    throw new EvidenceFileUnavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
