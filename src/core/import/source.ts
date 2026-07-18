// Import framework — multi-file export resolution. Issue #192.
//
// A real accounting-system export is not a single file. A Dinero export is a
// directory tree (`Firmaoplysninger.csv` and a per-fiscal-year `Kontoplan.csv`,
// `Posteringer.csv`, ...). `resolveSource` walks an export directory into a
// `MultiArtifactSource` — every file keyed by its export-root-relative,
// forward-slash name, with a BOM-stripped UTF-8 text decode and the raw bytes.
//
// The resolution is DETERMINISTIC: directory entries are read in sorted order
// so the resulting `files` map and any derived ordering is reproducible.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchiveIntegrityEvidence, ImportArtifact, MultiArtifactSource } from "./types";

/** Strips a leading UTF-8 BOM (U+FEFF) from a decoded string. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Recursively collects every file under `dir`, keyed by its path relative to
 * `rootDir` using forward slashes. Directory entries are visited in sorted
 * order so the walk is deterministic regardless of filesystem ordering.
 */
function collect(rootDir: string, dir: string, into: Record<string, ImportArtifact>): void {
  const entries = readdirSync(dir).sort();
  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      collect(rootDir, abs, into);
      continue;
    }
    if (!stat.isFile()) continue;
    const rel = abs.slice(rootDir.length).replace(/^[/\\]/, "").split(/[/\\]/).join("/");
    const bytes = new Uint8Array(readFileSync(abs));
    into[rel] = {
      name: rel,
      path: abs,
      bytes,
      text: stripBom(new TextDecoder("utf-8").decode(bytes)),
    };
  }
}

/** True when `path` names a `.zip` file (case-insensitive). */
function isZipPath(path: string): boolean {
  return path.toLowerCase().endsWith(".zip");
}

/**
 * Strips ASCII/C0 control bytes (incl. ANSI escape, NUL, CR/LF) and C1 control
 * bytes from a string destined for an Error message. A malicious zip filename
 * or a hostile unzip stderr line can otherwise inject terminal escape
 * sequences (clear-screen, fake hyperlinks via OSC, ...) into CLI output that
 * gets echoed verbatim by the default Node uncaughtException printer. We
 * collapse the stripped runs into single spaces so the message stays readable
 * and single-line.
 */
function sanitizeForErrorMessage(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Decodes an `unzip -Z -1` filename list without assuming every legacy ZIP
 * filename is UTF-8. UTF-8 is preferred; a one-byte legacy decode keeps
 * listing verification deterministic when a producer used a DOS code page.
 */
function decodeArchiveListing(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  for (const raw of Buffer.from(bytes).toString("binary").split("\n")) {
    const line = Buffer.from(raw, "binary");
    if (line.length === 0) continue;
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      name = new TextDecoder("windows-1252").decode(line);
    }
    // Info-ZIP emits LF-delimited records. Trim the CR only, never whitespace
    // that may be part of a legitimate entry name.
    const normalized = name.endsWith("\r") ? name.slice(0, -1) : name;
    if (!normalized.endsWith("/")) lines.push(normalized);
  }
  return lines.sort();
}

function listArchiveEntries(zipPath: string, safeZipPath: string): { names: string[]; sha256: string } {
  const listed = spawnSync("unzip", ["-Z", "-1", zipPath]);
  if (listed.error) {
    throw new Error(`failed to list ZIP archive '${safeZipPath}': ${sanitizeForErrorMessage(listed.error.message)}`);
  }
  if (listed.status !== 0) {
    const detail = sanitizeForErrorMessage(Buffer.from(listed.stderr ?? []).toString("utf8"));
    throw new Error(
      `failed to list ZIP archive '${safeZipPath}' (exit ${listed.status ?? "unknown"})` +
        (detail ? `: ${detail}` : ""),
    );
  }
  const names = decodeArchiveListing(new Uint8Array(listed.stdout ?? []));
  if (names.length === 0) throw new Error(`ZIP archive '${safeZipPath}' has no file entries`);
  return { names, sha256: sha256(names.join("\n")) };
}

/**
 * Extracts a `.zip` export into a fresh temporary directory and returns it.
 *
 * Uses the system `unzip` (dependency-free, present on macOS and Linux). The
 * archive is listed before extraction and every list, extraction, hash or
 * count discrepancy fails closed. A partial extraction is never an importable
 * source, even when the skipped file is not required by the selected parser.
 */
function unzipToTempDir(zipPath: string): { rootDir: string; archiveIntegrity: Omit<ArchiveIntegrityEvidence, "importedEntryCount"> } {
  const dest = mkdtempSync(join(tmpdir(), "rentemester-import-"));
  // Sanitize the user-controlled zipPath once: every error message below
  // interpolates the safe variant so a malicious filename cannot inject
  // ANSI/OSC terminal escapes (or newlines) into CLI output.
  const safeZipPath = sanitizeForErrorMessage(zipPath);
  try {
    const listing = listArchiveEntries(zipPath, safeZipPath);
    // #199 — Dinero-exports carry some entry names i CP437 (legacy DOS-encoding),
    // især `Ikke-bogførte-bilag/`-mappen. På Info-ZIP-builds (Linux) tager
    // `-O CP437` flaget den encoding og transcoder til filesystem-locale — så
    // de danske tegn overlever som UTF-8. På BSD unzip / Apple's Info-ZIP build
    // honorerer flaget ikke (empirisk: exit 10 med usage-banner, ingen
    // udpakning); vi falder tilbage til plain unzip og tolerer at de få entries
    // med ikke-UTF-8 navne droppes (#192's eksisterende mitigation).
    //
    // Detektering: hvis CP437-forsøget producerede et tomt dest, kører
    // fallback'en. Hvis det producerede indhold, beholder vi det (selv om
    // unzip ekstrahere "uden transcoding", er det funktionelt det samme som
    // fallback'en ville give — plus eventuelt korrekt-transcodede navne på
    // platforme hvor -O virker). A non-zero result is never accepted: any
    // partial tree is cleared before the plain fallback gets a clean attempt.
    const tryWithCharset = spawnSync(
      "unzip",
      ["-q", "-O", "CP437", "-o", zipPath, "-d", dest],
      { encoding: "utf8" },
    );
    const cp437Stderr = (tryWithCharset.stderr ?? "").trim();
    const charsetSucceeded = !tryWithCharset.error && tryWithCharset.status === 0;
    let result = tryWithCharset;
    if (!charsetSucceeded) {
      // CP437-forsøget gav et tomt dest — vi kører fallback'en. Tøm dest IN-PLACE
      // (ikke rm-and-mkdir) for at bevare mkdtempSync's 0o700-mode og undgå
      // TOCTOU-vindue på shared /tmp. I praksis er dest tomt her (verificeret
      // empirisk på macOS), men vi rydder defensivt for at undgå at lade et
      // halvt-pakket træ fra et fremtidigt unzip-build forurene fallback'en.
      // ENOENT (dest racing with an external tmp cleaner) is swallowed to
      // match the old `rmSync(force:true)` semantics — the fallback spawn
      // below will fail clearly if dest is truly gone.
      try {
        for (const entry of readdirSync(dest)) {
          rmSync(join(dest, entry), { recursive: true, force: true });
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") {
          const detail = sanitizeForErrorMessage(
            err instanceof Error ? err.message : String(err),
          );
          throw new Error(
            `failed to prepare fallback directory for '${safeZipPath}': ${detail}`,
          );
        }
      }
      result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", dest], { encoding: "utf8" });
    }
    if (result.error) {
      throw new Error(
        `failed to run 'unzip' for '${safeZipPath}': ${sanitizeForErrorMessage(result.error.message)}`,
      );
    }
    if (result.status !== 0) {
      const detail = sanitizeForErrorMessage((result.stderr || "").trim());
      throw new Error(
        `unzip failed for '${safeZipPath}' (exit ${result.status ?? "unknown"})` +
          (detail ? `: ${detail}` : ""),
      );
    }
    if (readdirSync(dest).length === 0) {
      const fallbackDetailRaw = (result.stderr || "").trim().split(/\r?\n/)[0] ?? "";
      // Begge forsøg fejlede — surface både CP437- og fallback-stderr så
      // operatøren kan diagnosticere root cause uden at miste den ene.
      const cp437DetailRaw = cp437Stderr ? (cp437Stderr.split(/\r?\n/)[0] ?? "") : "";
      const fallbackDetail = sanitizeForErrorMessage(fallbackDetailRaw);
      const cp437Detail = sanitizeForErrorMessage(cp437DetailRaw);
      const detail = [
        fallbackDetail,
        cp437Detail && cp437Detail !== fallbackDetail ? `cp437 attempt: ${cp437Detail}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `unzip extracted nothing from '${safeZipPath}'` +
          (typeof result.status === "number" ? ` (exit ${result.status})` : "") +
          (detail ? `: ${detail}` : ""),
      );
    }
    const extracted: Record<string, ImportArtifact> = {};
    collect(dest, dest, extracted);
    const extractedNames = Object.keys(extracted).sort();
    if (listing.names.length !== extractedNames.length) {
      throw new Error(
        `ZIP archive integrity check failed for '${safeZipPath}': archive lists ${listing.names.length} file entries but extraction produced ${extractedNames.length}`,
      );
    }
    const extractedManifest = extractedNames.map((name) => `${name}:${sha256(extracted[name]!.bytes)}`);
    return {
      rootDir: dest,
      archiveIntegrity: {
        archiveSha256: sha256(new Uint8Array(readFileSync(zipPath))),
        archiveEntryCount: listing.names.length,
        extractedEntryCount: extractedNames.length,
        archiveListingSha256: listing.sha256,
        extractedManifestSha256: sha256(extractedManifest.join("\n")),
      },
    };
  } catch (err) {
    // Clean up the mkdtempSync directory on every failure path so a long-
    // running cockpit/bilagsmail server doesn't leak `/tmp/rentemester-import-*`
    // trees full of partially-extracted Dinero receipts across days. The
    // success path returns above without entering this catch.
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      // Swallow cleanup failures — we're already throwing the primary error.
    }
    throw err;
  }
}

/**
 * Resolves an export `path` into a `MultiArtifactSource`. `path` may point at
 * an export directory, a `.zip` of one (extracted to a temp directory), or a
 * single file (wrapped as a one-artifact source so a single-file format still
 * works through the multi-file seam).
 *
 * Throws if `path` does not exist.
 */
export function resolveSource(path: string): MultiArtifactSource {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const files: Record<string, ImportArtifact> = {};
    collect(path, path, files);
    return { rootDir: path, files };
  }
  if (stat.isFile() && isZipPath(path)) {
    const extracted = unzipToTempDir(path);
    const files: Record<string, ImportArtifact> = {};
    collect(extracted.rootDir, extracted.rootDir, files);
    const importedEntryCount = Object.keys(files).length;
    if (importedEntryCount !== extracted.archiveIntegrity.archiveEntryCount) {
      throw new Error(
        `ZIP archive integrity check failed for '${sanitizeForErrorMessage(path)}': archive, extracted and imported file counts differ`,
      );
    }
    return {
      rootDir: extracted.rootDir,
      files,
      archiveIntegrity: { ...extracted.archiveIntegrity, importedEntryCount },
    };
  }
  // A single file: expose it under its basename.
  const name = path.split(/[/\\]/).pop() ?? path;
  const bytes = new Uint8Array(readFileSync(path));
  return {
    rootDir: path.slice(0, path.length - name.length).replace(/[/\\]$/, "") || ".",
    files: {
      [name]: {
        name,
        path,
        bytes,
        text: stripBom(new TextDecoder("utf-8").decode(bytes)),
      },
    },
  };
}

/**
 * Looks up a required file in a `MultiArtifactSource`. On a miss it appends a
 * clear, named error to `errors` and returns `null`, so a parser can collect
 * every missing file before failing.
 */
export function requireFile(
  input: MultiArtifactSource,
  name: string,
  errors: string[],
): ImportArtifact | null {
  const file = input.files[name];
  if (!file) {
    errors.push(`required export file '${name}' is missing`);
    return null;
  }
  return file;
}
