import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { companyPaths } from "./paths";
import { insertAuditLog } from "./actor";
import { companySequenceScope, currentUtcIsoDate, fiscalYearLabelFromDate, nextSequenceValue } from "./sequences";
import { isValidIsoDate as looksLikeIsoDate } from "./dates";
import { retainUntilForDate } from "./retention";
import { asDocumentId, type DocumentId } from "./ids";
import { resolveLegacySupplierIdentity, resolveSupplierIdentity, type SupplierIdentifierKind } from "./supplier-identity";
import { compareDkk, percentOfDkk, roundDkk, sumDkk } from "./money";
import { strengthenGdprErasureAliasesForIdentity } from "./gdpr";

export type DocumentType = "purchase_sale" | "cash_register_receipt" | "issued_invoice_pdf";
export type DocumentExemptionCode = "FOREIGN_PHYSICAL_ONLY" | null;
export type PurchaseVatClassification = "dk_purchase_25" | "exempt";
export type PurchaseVatLine = { classification: PurchaseVatClassification; netAmount: number; vatAmount?: number };

export type DocumentMetadata = {
  source: string;
  documentType?: DocumentType;
  issueDate?: string;
  invoiceNo?: string;
  deliveryDescription?: string;
  amountIncVat?: number;
  currency?: string;
  sender?: { name?: string; address?: string; vatOrCvr?: string; countryCode?: string; identifierKind?: SupplierIdentifierKind };
  recipient?: { name?: string; address?: string; vatOrCvr?: string };
  vatAmount?: number;
  /** Purchase tax bases, retained verbatim with the voucher.  Omit for legacy uniform VAT documents. */
  purchaseVatLines?: PurchaseVatLine[];
  /** Human-confirmed invoice evidence required before a non-EU service can be
   * posted with automatic reverse-charge input-VAT deduction. */
  reverseChargeWordingConfirmed?: boolean;
  paymentDetails?: string;
  exemptionCode?: DocumentExemptionCode;
};

export type DocumentValidationResult = {
  ok: boolean;
  appliedRules: string[];
  errors: string[];
};

export type IngestDocumentResult = {
  ok: boolean;
  documentId?: DocumentId;
  documentNo?: string;
  sha256?: string;
  storedPath?: string;
  errors?: string[];
};

export type IngestDocumentOptions = {
  forceDuplicateLogicalIdentity?: boolean;
  createdBy?: string;
  createdByProgram?: string;
  /** Internal bulk-import use only: the enclosing import writes one audit event. */
  suppressAudit?: boolean;
};

const RULES = {
  STORAGE: "DK-DOCUMENT-STORAGE-001",
  CASH_RECEIPT: "DK-DOCUMENT-CASH-RECEIPT-001",
  FOREIGN_PHYSICAL: "DK-DOCUMENT-FOREIGN-PHYSICAL-001",
  INTEGRITY: "DK-DOCUMENT-INTEGRITY-001",
} as const;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validatePurchaseVatLines(metadata: Pick<DocumentMetadata, "amountIncVat" | "vatAmount" | "purchaseVatLines">): string[] {
  const lines = metadata.purchaseVatLines;
  if (lines === undefined) return [];
  if (!Array.isArray(lines) || lines.length === 0) return ["purchaseVatLines must be a non-empty array when present"];
  const errors: string[] = [];
  if (!hasNonNegativeNumber(metadata.amountIncVat)) errors.push("purchaseVatLines requires amountIncVat");
  if (!hasNonNegativeNumber(metadata.vatAmount)) errors.push("purchaseVatLines requires vatAmount");
  const allowed = new Set<PurchaseVatClassification>(["dk_purchase_25", "exempt"]);
  let net = 0;
  let vat = 0;
  for (const [index, line] of lines.entries()) {
    if (!line || typeof line !== "object" || !allowed.has(line.classification)) {
      errors.push(`purchaseVatLines[${index}].classification must be dk_purchase_25 or exempt`);
      continue;
    }
    if (!hasNonNegativeNumber(line.netAmount)) errors.push(`purchaseVatLines[${index}].netAmount must be a non-negative number`);
    const lineVat = line.vatAmount ?? 0;
    if (!hasNonNegativeNumber(lineVat)) errors.push(`purchaseVatLines[${index}].vatAmount must be a non-negative number when present`);
    if (line.classification === "dk_purchase_25" && hasNonNegativeNumber(line.netAmount) && compareDkk(roundDkk(lineVat), percentOfDkk(line.netAmount, 25)) !== 0) {
      errors.push(`purchaseVatLines[${index}] dk_purchase_25 vatAmount must equal 25% of netAmount (${percentOfDkk(line.netAmount, 25)})`);
    }
    if (line.classification !== "dk_purchase_25" && compareDkk(roundDkk(lineVat), 0) !== 0) errors.push(`purchaseVatLines[${index}] ${line.classification} vatAmount must be 0`);
    net = sumDkk([net, Number(line.netAmount ?? 0)]);
    vat = sumDkk([vat, Number(lineVat)]);
  }
  if (hasNonNegativeNumber(metadata.vatAmount) && compareDkk(vat, metadata.vatAmount) !== 0) errors.push(`purchaseVatLines VAT ${vat} must equal vatAmount ${roundDkk(metadata.vatAmount)}`);
  const gross = sumDkk([net, vat]);
  if (hasNonNegativeNumber(metadata.amountIncVat) && compareDkk(gross, metadata.amountIncVat) !== 0) errors.push(`purchaseVatLines net + VAT ${gross} must equal amountIncVat ${roundDkk(metadata.amountIncVat)}`);
  return errors;
}

export type PurchaseVatLinesPayloadResult =
  | { status: "absent"; lines: null; errors: [] }
  | { status: "valid"; lines: PurchaseVatLine[]; errors: [] }
  | { status: "invalid"; lines: null; errors: string[] };

/**
 * Parse a persisted purchase split without collapsing corrupt structured tax
 * data into the legacy "no split" state. Mutating consumers must reject the
 * invalid branch; read views may use the compatibility wrapper below.
 */
export type CanonicalPurchaseVatTotals = {
  amountIncVat: number | null | undefined;
  vatAmount: number | null | undefined;
};

export function parsePurchaseVatLinesPayload(
  payloadJson: string | null | undefined,
  canonicalTotals?: CanonicalPurchaseVatTotals,
): PurchaseVatLinesPayloadResult {
  if (!payloadJson) return { status: "absent", lines: null, errors: [] };
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "invalid", lines: null, errors: ["document payload_json must contain a metadata object"] };
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "purchaseVatLines")) {
      return { status: "absent", lines: null, errors: [] };
    }
    const metadata = parsed as DocumentMetadata;
    const errors: string[] = [];
    if (canonicalTotals) {
      if (!hasNonNegativeNumber(canonicalTotals.amountIncVat)) {
        errors.push("persisted purchaseVatLines requires canonical documents.amount_inc_vat");
      }
      if (!hasNonNegativeNumber(canonicalTotals.vatAmount)) {
        errors.push("persisted purchaseVatLines requires canonical documents.vat_amount");
      }
      if (!hasNonNegativeNumber(metadata.amountIncVat)) {
        errors.push("persisted purchaseVatLines payload requires amountIncVat");
      } else if (hasNonNegativeNumber(canonicalTotals.amountIncVat) && compareDkk(metadata.amountIncVat, canonicalTotals.amountIncVat) !== 0) {
        errors.push(`payload amountIncVat ${roundDkk(metadata.amountIncVat)} must equal canonical documents.amount_inc_vat ${roundDkk(canonicalTotals.amountIncVat)}`);
      }
      if (!hasNonNegativeNumber(metadata.vatAmount)) {
        errors.push("persisted purchaseVatLines payload requires vatAmount");
      } else if (hasNonNegativeNumber(canonicalTotals.vatAmount) && compareDkk(metadata.vatAmount, canonicalTotals.vatAmount) !== 0) {
        errors.push(`payload vatAmount ${roundDkk(metadata.vatAmount)} must equal canonical documents.vat_amount ${roundDkk(canonicalTotals.vatAmount)}`);
      }
    }
    errors.push(...validatePurchaseVatLines(canonicalTotals
      ? { ...metadata, amountIncVat: canonicalTotals.amountIncVat ?? undefined, vatAmount: canonicalTotals.vatAmount ?? undefined }
      : metadata));
    if (errors.length > 0) return { status: "invalid", lines: null, errors };
    return { status: "valid", lines: metadata.purchaseVatLines!, errors: [] };
  } catch {
    return { status: "invalid", lines: null, errors: ["document payload_json is not valid JSON"] };
  }
}

/** Compatibility reader for list/UI surfaces. Invalid data remains hidden but
 * can never become posting input because mutations use the strict parser. */
export function purchaseVatLinesFromPayload(payloadJson: string | null | undefined): PurchaseVatLine[] | null {
  const parsed = parsePurchaseVatLinesPayload(payloadJson);
  return parsed.status === "valid" ? parsed.lines : null;
}


function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Allow-list of ingestable document types. Plain-text receipts are
 * legitimate (the smoke ingests several `.txt` files), so `text/plain`
 * and `application/json` are included alongside PDF/PNG/JPEG.
 */
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
  "application/json",
  // Received e-invoices (Digisense MODTAG, #efaktura) arrive as UBL XML and are
  // legitimate bilag, so application/xml is ingestable like the other text formats.
  "application/xml",
]);

const EXTENSION_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
  ".json": "application/json",
  ".xml": "application/xml",
};

function startsWithBytes(buf: Buffer, signature: number[]): boolean {
  if (buf.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (buf[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Sniffs the leading magic bytes of a file and returns the MIME type
 * they indicate, or `null` for content with no recognised binary
 * signature (treated as plain text).
 */
function sniffMimeType(path: string): string | null {
  const buf = readFileSync(path).subarray(0, 16);
  if (startsWithBytes(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithBytes(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

const BINARY_MIME_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);

/**
 * Resolves the MIME type for an ingested file by combining the file
 * extension with magic-byte content sniffing. Throws if the bytes
 * contradict the extension, or if the type is outside the allow-list.
 */
function detectMimeType(path: string): string {
  const ext = extname(path).toLowerCase();
  const expected = EXTENSION_MIME[ext];
  const sniffed = sniffMimeType(path);

  if (!expected) {
    throw new Error(`unsupported document type for extension '${ext || "(none)"}'`);
  }

  if (BINARY_MIME_TYPES.has(expected)) {
    // Binary formats must carry their signature.
    if (sniffed !== expected) {
      throw new Error(
        `file content does not match its '${ext}' extension (expected ${expected})`,
      );
    }
  } else if (sniffed && sniffed !== expected) {
    // A .txt/.json file must not actually contain binary document bytes.
    throw new Error(
      `file content does not match its '${ext}' extension (looks like ${sniffed})`,
    );
  }

  if (!ALLOWED_MIME_TYPES.has(expected)) {
    throw new Error(`document type ${expected} is not on the ingestion allow-list`);
  }
  return expected;
}

function nextDocumentNo(db: Database, issueDate?: string) {
  const scope = fiscalYearLabelFromDate(db, issueDate ?? currentUtcIsoDate(db));
  const row = db.query(`SELECT COALESCE(MAX(CAST(substr(document_no, -6) AS INTEGER)), 0) AS n FROM documents WHERE document_no GLOB ?`).get(`DOC-${scope}-[0-9][0-9][0-9][0-9][0-9][0-9]`) as { n: number };
  const nextValue = nextSequenceValue(db, "document", companySequenceScope(db, scope), Number(row.n ?? 0));
  return `DOC-${scope}-${String(nextValue).padStart(6, "0")}`;
}

export function validateDocumentMetadata(metadata: DocumentMetadata): DocumentValidationResult {
  const errors: string[] = [];
  const documentType = metadata.documentType ?? "purchase_sale";
  const exemptionCode = metadata.exemptionCode ?? null;
  const currency = (metadata.currency ?? "DKK").trim().toUpperCase();
  const appliedRules = [RULES.STORAGE, RULES.INTEGRITY];

  if (!hasText(metadata.source)) errors.push("source is required");
  if (metadata.reverseChargeWordingConfirmed !== undefined && typeof metadata.reverseChargeWordingConfirmed !== "boolean") {
    errors.push("reverseChargeWordingConfirmed must be a boolean when present");
  }
  if (!/^[A-Z]{3}$/.test(currency)) errors.push("currency must be a 3-letter ISO code");
  if (documentType === "cash_register_receipt") appliedRules.splice(1, 0, RULES.CASH_RECEIPT);
  if (exemptionCode === "FOREIGN_PHYSICAL_ONLY") appliedRules.splice(appliedRules.length - 1, 0, RULES.FOREIGN_PHYSICAL);
  // A statutory-field exemption never exempts supplied structured tax data
  // from internal consistency checks. If a receipt carries a split, validate
  // it before any document-type shortcut can accept malformed amounts.
  errors.push(...validatePurchaseVatLines(metadata));

  const exemptFromMinimumFields = documentType === "cash_register_receipt" || documentType === "issued_invoice_pdf" || exemptionCode === "FOREIGN_PHYSICAL_ONLY";
  if (!exemptFromMinimumFields) {
    if (!looksLikeIsoDate(metadata.issueDate)) errors.push("issueDate must be present in YYYY-MM-DD format");
    if (!hasText(metadata.deliveryDescription)) errors.push("deliveryDescription is required");
    if (!hasNonNegativeNumber(metadata.amountIncVat)) errors.push("amountIncVat is required");
    if (!hasText(metadata.sender?.name)) errors.push("sender.name is required");
    if (!hasText(metadata.sender?.address)) errors.push("sender.address is required");
    const suppliedIdentity = metadata.sender?.countryCode !== undefined || metadata.sender?.identifierKind !== undefined;
    const identity = suppliedIdentity
      ? resolveSupplierIdentity({ country: metadata.sender?.countryCode ?? "", identifier: metadata.sender?.vatOrCvr, identifierKind: metadata.sender?.identifierKind })
      : resolveLegacySupplierIdentity(metadata.sender?.vatOrCvr);
    if (!identity.ok) errors.push(...identity.errors.map((error) => `sender: human_resolution_required: ${error}`));
    if (!hasText(metadata.recipient?.name)) errors.push("recipient.name is required");
    if (!hasText(metadata.recipient?.address)) errors.push("recipient.address is required");
    if (!hasText(metadata.recipient?.vatOrCvr)) errors.push("recipient.vatOrCvr is required");
    if (!hasNonNegativeNumber(metadata.vatAmount)) errors.push("vatAmount is required");
  }

  return { ok: errors.length === 0, appliedRules, errors };
}

export function ingestDocument(db: Database, companyRoot: string, filePath: string, metadata: DocumentMetadata, options: IngestDocumentOptions = {}): IngestDocumentResult {
  const validation = validateDocumentMetadata(metadata);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  if (!existsSync(filePath)) return { ok: false, errors: [`file does not exist: ${filePath}`] };

  let mimeType: string;
  try {
    mimeType = detectMimeType(filePath);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  const sha256 = sha256File(filePath);
  const existing = db.query("SELECT id, document_no, stored_path FROM documents WHERE sha256_hash = ?").get(sha256) as { id: number; document_no: string; stored_path: string } | null;
  if (existing) {
    return { ok: false, errors: [`duplicate document content already ingested as ${existing.document_no}`] };
  }

  const docType = metadata.documentType ?? "purchase_sale";
  const senderIdentity = docType === "purchase_sale"
    ? (metadata.sender?.countryCode !== undefined || metadata.sender?.identifierKind !== undefined
      ? resolveSupplierIdentity({ country: metadata.sender?.countryCode ?? "", identifier: metadata.sender?.vatOrCvr, identifierKind: metadata.sender?.identifierKind })
      : resolveLegacySupplierIdentity(metadata.sender?.vatOrCvr))
    : null;
  const senderVatOrCvr = senderIdentity?.ok ? senderIdentity.identifier : metadata.sender?.vatOrCvr?.trim();
  const invoiceNo = metadata.invoiceNo?.trim();
  if (!options.forceDuplicateLogicalIdentity && docType === "purchase_sale" && invoiceNo) {
    const senderName = metadata.sender?.name?.trim();
    const existingByIdentifier = senderVatOrCvr
      ? db.query(
          `SELECT id, document_no
           FROM documents
           WHERE document_type = 'purchase_sale'
             AND sender_vat_cvr = ?
             AND invoice_no = ?
           LIMIT 1`,
        ).get(senderVatOrCvr, invoiceNo) as { id: number; document_no: string } | null
      : null;
    // A non-EU supplier may be ingested before its home-country registration
    // number is known and enriched later (or the reverse). Always check the
    // stable country + normalized name + invoice key as well as the identifier
    // key, so adding/removing that evidence cannot create a second voucher.
    const existingByNonEuCountryAndName = senderIdentity?.ok && senderIdentity.identifierKind === "non_eu" && senderName
      ? db.query(
          `SELECT id, document_no
           FROM documents
           WHERE document_type = 'purchase_sale'
             AND supplier_country_code = ?
             AND lower(trim(sender_name)) = lower(trim(?))
             AND invoice_no = ?
           LIMIT 1`,
        ).get(senderIdentity.country, senderName, invoiceNo) as { id: number; document_no: string } | null
      : null;
    const existingLogical = existingByIdentifier ?? existingByNonEuCountryAndName;
    if (existingLogical) {
      const supplierKey = senderVatOrCvr ?? `${senderIdentity && senderIdentity.ok ? senderIdentity.country : "unknown"}:${senderName ?? "unknown"}`;
      return { ok: false, errors: [`a document from ${supplierKey} with invoice ${invoiceNo} is already ingested as ${existingLogical.document_no}. Use --force to add another scan.`] };
    }
  }

  const p = companyPaths(companyRoot);
  mkdirSync(p.documentsOriginals, { recursive: true });
  const ext = extname(filePath).toLowerCase() || ".bin";
  const storedPath = join(p.documentsOriginals, `${sha256}${ext}`);

  const currency = (metadata.currency ?? "DKK").trim().toUpperCase();
  const retentionBasisDate = metadata.issueDate ?? currentUtcIsoDate(db);
  let copied = false;

  try {
    const result = db.transaction(() => {
      const documentNo = nextDocumentNo(db, metadata.issueDate);
      copyFileSync(filePath, storedPath);
      copied = true;

      const inserted = db.query(
        `INSERT INTO documents (
          document_no, source, original_filename, stored_path, mime_type, sha256_hash,
          supplier_name, invoice_no, invoice_date, amount_inc_vat, currency, status,
          document_type, delivery_description, sender_name, sender_address, sender_vat_cvr, supplier_country_code, supplier_identifier_kind, supplier_identity_status,
          recipient_name, recipient_address, recipient_vat_cvr, vat_amount, payment_details, exemption_code, payload_json, retain_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id`
      ).get(
        documentNo,
        metadata.source,
        basename(filePath),
        storedPath,
        mimeType,
        sha256,
        metadata.sender?.name ?? null,
        metadata.invoiceNo ?? null,
        metadata.issueDate ?? null,
        metadata.amountIncVat ?? null,
        currency,
        docType,
        metadata.deliveryDescription ?? null,
        metadata.sender?.name ?? null,
        metadata.sender?.address ?? null,
        senderVatOrCvr ?? null,
        senderIdentity?.ok ? senderIdentity.country : null,
        senderIdentity?.ok ? senderIdentity.identifierKind : null,
        senderIdentity?.ok ? senderIdentity.status : null,
        metadata.recipient?.name ?? null,
        metadata.recipient?.address ?? null,
        metadata.recipient?.vatOrCvr ?? null,
        metadata.vatAmount ?? null,
        metadata.paymentDetails ?? null,
        metadata.exemptionCode ?? null,
        JSON.stringify(metadata),
        retainUntilForDate(db, retentionBasisDate),
      ) as { id: number };

      strengthenGdprErasureAliasesForIdentity(db, {
        name: metadata.sender?.name,
        cvr: senderVatOrCvr,
      });
      strengthenGdprErasureAliasesForIdentity(db, {
        name: metadata.recipient?.name,
        cvr: metadata.recipient?.vatOrCvr,
      });

      if (!options.suppressAudit) {
        insertAuditLog(db, {
          eventType: "document_ingest",
          entityType: "document",
          entityId: inserted.id,
          message: `Ingested supporting document ${documentNo} (${sha256})`,
          createdBy: options.createdBy,
          createdByProgram: options.createdByProgram,
        });
      }

      return { id: asDocumentId(inserted.id), documentNo };
    }, { immediate: true })();

    return { ok: true, documentId: result.id, documentNo: result.documentNo, sha256, storedPath };
  } catch (error) {
    if (copied) {
      try { unlinkSync(storedPath); } catch {}
    }
    throw error;
  }
}

/** A stored bilag file resolved for read-only serving. */
export type ResolvedDocumentFile = {
  /** Absolute path to the file on disk. */
  path: string;
  /** Stored MIME type, or a safe default when none was recorded. */
  mimeType: string;
  /** A human-friendly download name. */
  filename: string;
};

/**
 * Resolves the stored file of an ingested document so a caller (the cockpit's
 * read route) can serve it back to a human.
 *
 * The file is resolved by its basename inside THIS company's
 * `documents/originals` store — robust if the workspace directory moved since
 * ingest, and inherently free of path traversal because a basename cannot
 * carry a directory separator. Returns an error (never throws) when the
 * document is unknown, never had a stored file, or the file is gone from disk.
 */
export function resolveDocumentFile(
  db: Database,
  companyRoot: string,
  documentId: number,
):
  | { ok: true; file: ResolvedDocumentFile }
  | { ok: false; error: string } {
  const row = db
    .query(
      `SELECT stored_path AS storedPath, mime_type AS mimeType,
              original_filename AS filename, document_no AS documentNo
         FROM documents WHERE id = ?`,
    )
    .get(documentId) as
    | {
        storedPath: string | null;
        mimeType: string | null;
        filename: string | null;
        documentNo: string | null;
      }
    | null;
  if (!row) {
    return { ok: false, error: `document ${documentId} does not exist` };
  }
  if (!row.storedPath) {
    return { ok: false, error: `document ${documentId} has no stored file` };
  }
  const path = join(
    companyPaths(companyRoot).documentsOriginals,
    basename(row.storedPath),
  );
  if (!existsSync(path)) {
    return { ok: false, error: `document ${documentId} file is missing on disk` };
  }
  return {
    ok: true,
    file: {
      path,
      mimeType: row.mimeType ?? "application/octet-stream",
      filename: row.filename ?? row.documentNo ?? `bilag-${documentId}`,
    },
  };
}
