// Import framework — the Dinero export's bilag (receipts). Issue #196
// (epic #173, the final piece).
//
// A Dinero export ships the actual supporting documents:
//
//  - `<year>/Bilag/<year>-Bilag-<n>.{pdf,jpg,png}` — the booked receipts. The
//    `<n>` is the voucher number, matching the `Bilag` column the year-to-date
//    postings (#195) were grouped by, so each receipt belongs to a voucher that
//    was replayed as a journal entry.
//  - `Ikke-bogførte-bilag/<files>` — receipts that were never booked in Dinero.
//
// This module brings them over so the imported books have their supporting
// documents and the agent has document↔posting evidence to match on:
//
//  1. Each `<cut-over year>/Bilag/*` file is ingested through the EXISTING
//     documents pipeline (`ingestDocument` — SHA-256, retention, originals
//     storage). Idempotent: the content is hashed first, and an already-stored
//     hash is reused rather than re-ingested.
//  2. Each ingested document is LINKED to its voucher's journal entry. The
//     voucher number is matched against `ImportResult.historicalEntriesPosted`
//     (#195); the link is written to the `import_document_links` table.
//     `journal_entries` is append-only and locked — its `document_id` cannot be
//     set after posting — so the link is a dedicated, additive table, never a
//     mutation of the posted entry.
//  3. Each `Ikke-bogførte-bilag/*` file is ingested as a document too, flagged
//     unbooked: an exception-queue entry ("receipt present, not yet booked") is
//     raised for each via `recordException`, so a human sees the loose receipt.
//
// Everything is deterministic: files are visited in sorted order. The module is
// SELF-CONTAINED — it touches only `documents`, `import_document_links` and
// `exceptions`, never the hash-chained live journal.

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ingestDocument } from "../documents";
import { recordException } from "../exceptions";
import type { ImportArtifact, ImportResult, MultiArtifactSource } from "./types";
import { removePathWithRetry } from "../fs-cleanup";

const SYSTEM = "dinero";

/** The `documents.source` stamped on a receipt ingested from a Dinero export. */
export const BILAG_SOURCE = "dinero-import-bilag";

/** The exception type raised for a receipt that was never booked in Dinero. */
export const UNBOOKED_RECEIPT_EXCEPTION = "IMPORTED_RECEIPT_NOT_BOOKED";

/** The file extensions a Dinero bilag receipt may carry. */
const RECEIPT_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);

/** One bilag receipt linked to the journal entry its voucher was posted as. */
export type LinkedBilag = {
  /** Export-root-relative name of the receipt file. */
  fileName: string;
  /** The Dinero voucher number (`Bilag`) the file name carried. */
  voucherRef: string;
  documentId: number;
  documentNo: string;
  sha256: string;
  journalEntryId: number;
  journalEntryNo: string;
};

/** One unbooked receipt — ingested as a document, flagged in the exceptions. */
export type UnbookedBilag = {
  fileName: string;
  documentId: number;
  documentNo: string;
  sha256: string;
  exceptionId: number;
};

/** The outcome of ingesting a Dinero export's bilag. */
export type BilagIngestResult = {
  ok: boolean;
  /** Booked receipts ingested and linked to their voucher's journal entry. */
  linked: LinkedBilag[];
  /** Booked receipts ingested whose voucher number matched no journal entry. */
  unmatched: Array<{ fileName: string; voucherRef: string }>;
  /** Receipts skipped because their content was already ingested (idempotent). */
  duplicates: string[];
  /** Unbooked receipts ingested and raised in the exception queue. */
  unbooked: UnbookedBilag[];
  /** Ordered, human-readable description of what happened. */
  auditTrail: string[];
  errors: string[];
  /** Newly published originals. The atomic orchestrator removes these on rollback. */
  publishedPaths: string[];
};

/** Pure, fail-closed receipt planning used before an atomic Dinero import mutates. */
export function planDineroBilag(input: MultiArtifactSource, voucherRefs: readonly string[]): string[] {
  const errors: string[] = [];
  const known = new Set(voucherRefs);
  const year = cutOverYearOf(input);
  if (year != null) {
    const prefixes = [`${year}/Bilag/`, `${year}/Faktura/`].map((prefix) => prefix.toLowerCase());
    const bookedNames = Object.keys(input.files)
      .filter((name) => prefixes.some((prefix) => name.toLowerCase().startsWith(prefix)))
      .sort();
    for (const name of bookedNames) {
      if (!RECEIPT_EXTENSIONS.has(extOf(name))) {
        errors.push(`bilag '${name}' has an unsupported receipt extension`);
        continue;
      }
      const artifact = input.files[name]!;
      const ref = voucherRefOf(artifact.name);
      if (!ref) errors.push(`bilag '${artifact.name}' does not carry a '-Bilag-<n>' or '-Faktura-<n>' voucher number in its file name`);
      else if (!known.has(ref)) errors.push(`bilag '${artifact.name}' references voucher ${ref}, which is not present in the cut-over postings`);
    }
  }
  return errors;
}

/** A document that is now present in the ledger — newly ingested or pre-existing. */
type IngestedDocument = {
  documentId: number;
  documentNo: string;
  sha256: string;
  /** True when the content hash was already stored — re-ingest was a no-op. */
  duplicate: boolean;
  storedPath?: string;
};

/** The lowercase file extension of a name, including the dot (e.g. `.pdf`). */
function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot).toLowerCase() : "";
}

/** SHA-256 hex digest of raw bytes — the same hash the documents pipeline uses. */
function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Extracts the voucher number from a Dinero booked-document file name. The
 * export uses `<year>-Bilag-<n>.<ext>` for receipts and
 * `<year>-Faktura-<n>.<ext>` for issued invoices.
 */
function voucherRefOf(fileName: string): string | null {
  const base = fileName.split("/").pop() ?? fileName;
  const match = /-(?:Bilag|Faktura)-(\d+)\.[A-Za-z0-9]+$/i.exec(base);
  return match ? match[1]! : null;
}

/**
 * The cut-over fiscal year of a resolved export — the LATEST `<year>/` folder.
 * The bilag of THAT year are the ones whose vouchers were posted (#195), so it
 * is the only year whose receipts this module ingests. Returns `null` when the
 * export carries no `<year>/` folder.
 */
function cutOverYearOf(input: MultiArtifactSource): number | null {
  const years = new Set<number>();
  for (const name of Object.keys(input.files)) {
    const match = /^(\d{4})\//.exec(name);
    if (match) years.add(Number(match[1]));
  }
  return years.size > 0 ? Math.max(...years) : null;
}

/**
 * Collects the receipt artifacts under a directory prefix, deterministically
 * sorted by their export-root-relative name. Only files with a receipt
 * extension are taken — a stray `.csv`/`.txt` under the folder is ignored.
 */
function receiptsUnder(input: MultiArtifactSource, prefix: string): ImportArtifact[] {
  const lower = prefix.toLowerCase();
  return Object.keys(input.files)
    .filter((name) => name.toLowerCase().startsWith(lower) && RECEIPT_EXTENSIONS.has(extOf(name)))
    .sort()
    .map((name) => input.files[name]!);
}

/**
 * Ingests one receipt artifact through the documents pipeline, idempotently.
 *
 * The content is hashed first: if that hash is already stored the existing
 * document is returned (re-ingest is a no-op — the documents pipeline dedupes
 * on the SHA-256 hash). Otherwise the artifact's bytes are spilled to a temp
 * file and `ingestDocument` stores it (SHA-256, retention, originals storage).
 *
 * Returns `null` only when a genuinely new file is rejected by the pipeline;
 * the rejection reasons are appended to `errors`.
 */
function ingestReceipt(
  db: Database,
  companyRoot: string,
  spillDir: string,
  artifact: ImportArtifact,
  docBySha: ReturnType<Database["query"]>,
  errors: string[],
): IngestedDocument | null {
  const sha256 = sha256Of(artifact.bytes);
  const existing = docBySha.get(sha256) as { id: number; document_no: string } | null;
  if (existing) {
    return { documentId: existing.id, documentNo: existing.document_no, sha256, duplicate: true };
  }
  const base = artifact.name.split("/").pop() ?? "bilag.bin";
  const tempPath = join(spillDir, base);
  writeFileSync(tempPath, artifact.bytes);
  const ingest = ingestDocument(db, companyRoot, tempPath, {
    source: BILAG_SOURCE,
    documentType: /\/Faktura\//i.test(artifact.name) ? "issued_invoice_pdf" : "cash_register_receipt",
  }, { suppressAudit: true });
  if (!ingest.ok || ingest.documentId == null) {
    errors.push(`bilag '${artifact.name}': ${(ingest.errors ?? ["ingest failed"]).join("; ")}`);
    return null;
  }
  return {
    documentId: ingest.documentId as unknown as number,
    documentNo: ingest.documentNo!,
    sha256: ingest.sha256!,
    duplicate: false,
    storedPath: ingest.storedPath,
  };
}

/**
 * Ingests a Dinero export's bilag and links each booked receipt to its
 * voucher's journal entry.
 *
 * `result` is the outcome of the ledger import: its `historicalEntriesPosted`
 * (#195) carries every voucher's `voucherRef` -> journal entry, the handle used
 * to link a receipt to its posting. A receipt whose voucher number matches no
 * posted entry is still ingested (the document is kept) but reported under
 * `unmatched` rather than linked.
 *
 * Deterministic and idempotent: receipts are visited in sorted order, the
 * content is hashed before ingest, and the link/exception writes are guarded —
 * so re-running the import re-ingests nothing and creates no duplicate links or
 * exceptions.
 */
export function ingestDineroBilag(
  db: Database,
  companyRoot: string,
  input: MultiArtifactSource,
  result: ImportResult,
): BilagIngestResult {
  const auditTrail: string[] = [];
  const errors: string[] = [];
  const linked: LinkedBilag[] = [];
  const unmatched: Array<{ fileName: string; voucherRef: string }> = [];
  const duplicates: string[] = [];
  const unbooked: UnbookedBilag[] = [];
  const publishedPaths: string[] = [];

  // Voucher number -> the journal entry it was posted as (#195).
  const entryByVoucher = new Map<string, { entryId: number; entryNo: string }>();
  for (const posted of result.historicalEntriesPosted ?? []) {
    entryByVoucher.set(posted.voucherRef, {
      entryId: posted.entryId,
      entryNo: posted.entryNo,
    });
  }

  const cutOverYear = cutOverYearOf(input);
  const bookedReceipts = cutOverYear == null
    ? []
    : [
        ...receiptsUnder(input, `${cutOverYear}/Bilag/`),
        ...receiptsUnder(input, `${cutOverYear}/Faktura/`),
      ].sort((a, b) => a.name.localeCompare(b.name));
  const unbookedReceipts = receiptsUnder(input, "Ikke-bogførte-bilag/");

  if (bookedReceipts.length === 0 && unbookedReceipts.length === 0) {
    auditTrail.push("Export carries no bilag — no receipts to ingest");
    return { ok: true, linked, unmatched, duplicates, unbooked, auditTrail, errors, publishedPaths };
  }

  const docBySha = db.query("SELECT id, document_no FROM documents WHERE sha256_hash = ?");
  const linkExists = db.query(
    "SELECT id FROM import_document_links WHERE document_id = ? AND journal_entry_id = ?",
  );
  const insertLink = db.query(
    `INSERT INTO import_document_links (source_system, voucher_ref, document_id, journal_entry_id)
     VALUES (?, ?, ?, ?)`,
  );

  const spillDir = mkdtempSync(join(tmpdir(), "rentemester-bilag-"));
  try {
    // --- booked receipts -------------------------------------------------
    for (const artifact of bookedReceipts) {
      const voucherRef = voucherRefOf(artifact.name);
      if (!voucherRef) {
        errors.push(
          `bilag '${artifact.name}' does not carry a '-Bilag-<n>' voucher number in its file name`,
        );
        continue;
      }
      const doc = ingestReceipt(db, companyRoot, spillDir, artifact, docBySha, errors);
      if (!doc) continue;
      if (doc.duplicate) duplicates.push(artifact.name);
      else if (doc.storedPath) publishedPaths.push(doc.storedPath);

      const entry = entryByVoucher.get(voucherRef);
      if (!entry) {
        unmatched.push({ fileName: artifact.name, voucherRef });
        auditTrail.push(
          `Bilag ${voucherRef} (${doc.documentNo}) ingested — no matching journal entry, left unlinked`,
        );
        continue;
      }
      const alreadyLinked = linkExists.get(doc.documentId, entry.entryId) as { id: number } | null;
      if (!alreadyLinked) {
        insertLink.run(SYSTEM, voucherRef, doc.documentId, entry.entryId);
      }
      linked.push({
        fileName: artifact.name,
        voucherRef,
        documentId: doc.documentId,
        documentNo: doc.documentNo,
        sha256: doc.sha256,
        journalEntryId: entry.entryId,
        journalEntryNo: entry.entryNo,
      });
      auditTrail.push(
        `Linked bilag ${voucherRef} (${doc.documentNo}) to journal entry ${entry.entryNo}` +
          (doc.duplicate ? " — receipt already ingested, link reused" : ""),
      );
    }

    // --- unbooked receipts ----------------------------------------------
    for (const artifact of unbookedReceipts) {
      const doc = ingestReceipt(db, companyRoot, spillDir, artifact, docBySha, errors);
      if (!doc) continue;
      if (doc.duplicate) duplicates.push(artifact.name);
      else if (doc.storedPath) publishedPaths.push(doc.storedPath);

      const exception = recordException(db, {
        type: UNBOOKED_RECEIPT_EXCEPTION,
        severity: "medium",
        relatedDocumentId: doc.documentId,
        message: `Imported receipt ${doc.documentNo} is present but was never booked in ${SYSTEM}`,
        requiredAction:
          "Review the receipt and either book a journal entry for it or confirm it is not a business document.",
        sourceEvidence: {
          sourceSystem: SYSTEM,
          fileName: artifact.name,
          documentNo: doc.documentNo,
          sha256: doc.sha256,
        },
      });
      if (!exception.ok || exception.exceptionId == null) {
        errors.push(
          `unbooked bilag '${artifact.name}': could not raise exception — ${exception.errors.join("; ")}`,
        );
        continue;
      }
      unbooked.push({
        fileName: artifact.name,
        documentId: doc.documentId,
        documentNo: doc.documentNo,
        sha256: doc.sha256,
        exceptionId: exception.exceptionId,
      });
      auditTrail.push(
        `Unbooked receipt ${doc.documentNo} ingested — exception raised (receipt present, not yet booked)`,
      );
    }
  } finally {
    removePathWithRetry(spillDir);
  }

  auditTrail.push(
    `Bilag ingest: ${linked.length} receipt(s) linked to a journal entry, ` +
      `${unmatched.length} ingested without a match, ` +
      `${unbooked.length} unbooked receipt(s) flagged, ` +
      `${duplicates.length} already ingested (no-op)`,
  );
  return {
    ok: errors.length === 0,
    linked,
    unmatched,
    duplicates,
    unbooked,
    auditTrail,
    errors,
    publishedPaths,
  };
}
