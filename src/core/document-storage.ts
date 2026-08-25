/**
 * Low-level, fail-closed storage for voucher originals.
 *
 * This module deliberately handles the source exactly once.  Calling code
 * must derive every content property (hash, MIME and scanner input) from the
 * returned snapshot, never by opening the caller-controlled path again.
 */
import { constants, closeSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
/** PDF parsing deliberately has a tighter cap than general voucher storage. */
export const MAX_PDF_PARSE_BYTES = 10 * 1024 * 1024;

export type DocumentSnapshot = {
  bytes: Buffer;
  sha256: string;
  filename: string;
};

type StableStat = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };

function stableStat(fd: number, maxBytes = MAX_DOCUMENT_BYTES): StableStat {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new Error("document source is not a regular file");
  if (stat.size <= 0) throw new Error("document source is empty");
  if (stat.size > maxBytes) throw new Error(`document source exceeds ${maxBytes} byte limit`);
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameStat(a: StableStat, b: StableStat): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Open once with O_NOFOLLOW, fstat and snapshot the exact bounded bytes. */
export function snapshotDocumentSource(path: string, maxBytes = MAX_DOCUMENT_BYTES): DocumentSnapshot {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = stableStat(fd, maxBytes);
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw new Error("document source changed while being read");
      offset += count;
    }
    const after = stableStat(fd, maxBytes);
    if (!sameStat(before, after)) throw new Error("document source changed while being read");
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), filename: basename(path) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ELOOP") {
      throw new Error("document source must not be a symbolic link");
    }
    if (error instanceof Error && /^(document source|document store|invalid document)/.test(error.message)) throw error;
    throw new Error("document source cannot be safely opened");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Resolve an already registered PDF solely below this company's originals
 * directory.  Historical stored_path is treated as metadata, never as an
 * authority to open an arbitrary host path.
 */
export function snapshotRegisteredPdfDocument(db: Database, companyRoot: string, documentId: number): DocumentSnapshot {
  const row = db.query(`SELECT stored_path, sha256_hash, mime_type FROM documents WHERE id = ?`).get(documentId) as {
    stored_path: string | null; sha256_hash: string | null; mime_type: string | null;
  } | null;
  if (!row) throw new Error("registered PDF document does not exist");
  if (row.mime_type !== "application/pdf") throw new Error("registered document is not a PDF");
  if (!row.stored_path || !/^[a-f0-9]{64}$/i.test(row.sha256_hash ?? "")) throw new Error("registered PDF document has invalid evidence metadata");
  const root = realpathSync(resolve(companyRoot));
  const store = join(root, "documents", "originals");
  const storeInfo = lstatSync(store);
  if (storeInfo.isSymbolicLink() || !storeInfo.isDirectory()) throw new Error("PDF originals store is not a regular directory");
  const canonicalStore = realpathSync(store);
  if (!contained(root, canonicalStore)) throw new Error("PDF originals store escapes company root");
  const name = basename(row.stored_path);
  if (!name || name !== row.stored_path.split(/[\\/]/).at(-1)) throw new Error("registered PDF path is invalid");
  const candidate = join(canonicalStore, name);
  const info = lstatSync(candidate);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("registered PDF source is not a regular file");
  if (info.size > MAX_PDF_PARSE_BYTES) throw new Error(`registered PDF source exceeds ${MAX_PDF_PARSE_BYTES} byte limit`);
  const snapshot = snapshotDocumentSource(candidate, MAX_PDF_PARSE_BYTES);
  if (snapshot.sha256 !== row.sha256_hash!.toLowerCase()) throw new Error("registered PDF source sha256 does not match document register");
  return snapshot;
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith("..") && !value.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/**
 * Build/check a private canonical store below a real company root.  Every
 * existing segment is lstat'ed before it is trusted; a symlink is never a
 * valid directory in the evidence path.
 */
export function ensureCanonicalDocumentStore(companyRoot: string, relativeStore: string): string {
  // Preserve the lexical root in stored_path for portable, existing callers
  // (macOS commonly spells the same volume as /var and /private/var), while
  // making every containment decision against canonical paths.
  const lexicalRoot = resolve(companyRoot);
  const root = realpathSync(lexicalRoot);
  const requested = resolve(lexicalRoot, relativeStore);
  if (!contained(lexicalRoot, requested)) throw new Error("document store escapes company root");
  const segments = relativeStore.split(/[\\/]+/).filter(Boolean);
  let current = lexicalRoot;
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new Error("invalid document store path");
    current = join(current, segment);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("document store must be a non-symlink directory");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
      mkdirSync(current, { mode: 0o700 });
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("document store must be a non-symlink directory");
    }
  }
  const canonical = realpathSync(current);
  if (!contained(root, canonical)) throw new Error("document store escapes company root");
  return requested;
}

export type PublishDocumentResult = { path: string; published: boolean };

/**
 * Atomically publish immutable bytes without ever replacing a target.  A
 * concurrent same-content writer may reuse the final file; a conflicting or
 * symlink destination is rejected.  Only this call's private temp is removed.
 */
export function publishDocumentSnapshot(store: string, filename: string, snapshot: DocumentSnapshot): PublishDocumentResult {
  const target = join(store, filename);
  const temp = join(store, `.${filename}.${randomBytes(16).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let offset = 0;
    while (offset < snapshot.bytes.length) offset += writeSync(fd, snapshot.bytes, offset, snapshot.bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    try {
      linkSync(temp, target); // atomic create-if-absent; never replace
      unlinkSync(temp);
      return { path: target, published: true };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST")) throw error;
      const existing = lstatSync(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("document evidence destination is not a regular file");
      const actual = snapshotDocumentSource(target);
      if (actual.sha256 !== snapshot.sha256 || actual.bytes.length !== snapshot.bytes.length) {
        throw new Error("document evidence destination already exists with conflicting bytes");
      }
      return { path: target, published: false };
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* private temp may already be gone */ }
  }
}

/** Remove only a known final evidence file and only if its bytes still match. */
export function removePublishedSnapshot(path: string, snapshot: DocumentSnapshot): void {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) return;
    if (snapshotDocumentSource(path).sha256 === snapshot.sha256) unlinkSync(path);
  } catch { /* cleanup is best effort; caller retains database consistency checks */ }
}
