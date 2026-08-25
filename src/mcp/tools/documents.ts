/**
 * MCP-tools for bilag.
 *
 *  - `documents_list` (read)
 *  - `documents_ingest` (write-reversible — indlæser et bilag fra disk)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PDF_EVIDENCE_TAMPERED, PdfParseError, parseRegisteredPdfBatch, parseRegisteredPdfDocument, planCurrentPdfParses } from "../../core/document-pdf-parser";
import { type DocumentMetadata, ingestDocument, purchaseVatLinesFromPayload } from "../../core/documents";
import { recordException } from "../../core/exceptions";
import { resolveDocumentMasterData } from "../../core/master-data";
import { extractDocumentInvoice, invoiceExtractionSurface } from "../../server/invoice-extraction-surface";
import { resolveConfiguredInvoiceExtractor } from "../../server/invoice-extractor";
import { documentPdfParsedText, documentPdfParseStatus } from "../../server/router/documents";
import { envelopeShape, errorEnvelope, successEnvelope, wrapCoreResult } from "../envelope";
import { applyPagination, paginationDescriptionSuffix, paginationFields } from "../pagination";
import { confirmField, withCompanyDb, withCompanyDbConfirmed, withCompanyReadOnlyDb } from "../tool-runtime";

const parseSummary = (run: any, documentId?: number) => ({ documentId, status: run?.status, errorCode: run?.errorCode ?? null, cached: Boolean(run?.cached), pageCount: Array.isArray(run?.pages) ? run.pages.length : 0, itemCount: Array.isArray(run?.pages) ? run.pages.reduce((n: number, p: any) => n + (p.layout?.length ?? 0), 0) : 0, textLength: Array.isArray(run?.pages) ? run.pages.reduce((n: number, p: any) => n + (p.text?.length ?? 0), 0) : 0, resultHash: run?.resultHash });

const documentPartySchema = z.object({
  name: z.string().optional().describe("Party name."),
  address: z.string().optional().describe("Party postal address."),
  vatOrCvr: z.string().optional().describe("Party VAT or CVR number, e.g. 'DK12345678'."),
  countryCode: z.string().length(2).optional().describe("Supplier ISO 3166-1 alpha-2 country evidence, e.g. 'US'. Required with identifierKind."),
  identifierKind: z.enum(["dk_cvr", "eu_vat", "non_eu"]).optional().describe("Typed supplier identifier. non_eu permits no identifier when country evidence is non-EU."),
});

/**
 * The named `DocumentMetadata` fields shared by `documents_ingest` and the
 * bilagsmail intake tools (`imap_intake_poll`, `mail_intake_ingest`).
 *
 * Exported as a bare shape (not a `z.object`) so the intake tools — which do
 * NOT take `source` (the pipeline sets it) — can build their own object from
 * the SAME field definitions, guaranteeing the two schemas cannot drift
 * apart (#274).
 */
export const documentMetadataFields = {
  documentType: z
      .enum(["purchase_sale", "cash_register_receipt", "internal_voucher"])
      .optional()
      .describe("Document type (default 'purchase_sale')."),
    issueDate: z.string().optional().describe("Document/invoice date in YYYY-MM-DD format."),
    invoiceNo: z.string().optional().describe("Invoice or receipt number printed on the document."),
    deliveryDescription: z
      .string()
      .optional()
      .describe("Free-text description of the goods or services."),
    amountIncVat: z
      .number()
      .optional()
      .describe("Total amount including VAT, in kroner (decimal DKK, 2 decimals — NOT øre)."),
    currency: z
      .string()
      .optional()
      .describe("3-letter ISO currency code (default 'DKK')."),
    sender: documentPartySchema.optional().describe("Sender/supplier details."),
    recipient: documentPartySchema.optional().describe("Recipient/buyer details."),
    vatAmount: z
      .number()
      .optional()
      .describe("VAT amount, in kroner (decimal DKK, 2 decimals — NOT øre)."),
    purchaseVatLines: z.array(z.object({
      classification: z.enum(["dk_purchase_25", "exempt"]),
      netAmount: z.number().nonnegative().describe("Tax base in kroner."),
      vatAmount: z.number().nonnegative().optional().describe("VAT amount in kroner; 25% for dk_purchase_25, otherwise zero."),
    })).min(1).optional().describe("Optional durable purchase VAT split. Its net and VAT totals must reconcile exactly with the document totals."),
    reverseChargeWordingConfirmed: z
      .boolean()
      .optional()
      .describe("True only when a human has confirmed that the supplier invoice contains reverse-charge wording; required with the other invoice evidence before non-EU input-VAT deduction."),
    paymentDetails: z
      .string()
      .optional()
      .describe("Free-text payment details, e.g. 'Bankoverførsel 2026-05-17'."),
    exemptionCode: z
      .literal("FOREIGN_PHYSICAL_ONLY")
      .nullable()
      .optional()
      .describe("Set to 'FOREIGN_PHYSICAL_ONLY' for a foreign physical-only receipt; otherwise omit."),
    sourceBankTransactionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Required for internal_voucher: the imported bank transaction that is its primary evidence."),
    accountingRationale: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe("Required for internal_voucher: the accounting reason for the posting."),
} as const;

/**
 * The `documents_ingest` metadata schema: the shared `DocumentMetadata`
 * fields PLUS the required `source` field (how the document arrived).
 */
const documentMetadataSchema = z
  .object({
    source: z
      .string()
      .describe("How the document arrived, e.g. 'email', 'photo-upload', 'mobile-scan'. Required."),
    ...documentMetadataFields,
  })
  .describe(
    "Document (bilag) metadata. amountIncVat and vatAmount are in kroner " +
      "(decimal DKK, 2 decimals — NOT øre).",
  );

export function registerDocumentTools(server: McpServer): void {
  server.registerTool("documents_parse", { title: "Parse PDF document", description: "Offline, deterministic PDF text parse of an already stored document. Requires confirm:true; it has no bookkeeping authority. write-reversible.", inputSchema: { company: z.string().min(1), documentId: z.number().int().positive(), confirm: confirmField.optional() }, outputSchema: envelopeShape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, withCompanyDbConfirmed<{ company: string; documentId: number; confirm?: boolean }>(server, "documents_parse", async ({ db, actor, args }) => { try { return successEnvelope({ parse: parseSummary(await parseRegisteredPdfDocument(db, args.company, { documentId: args.documentId, createdBy: actor.createdBy, createdByProgram: actor.createdByProgram }), args.documentId) }); } catch { return errorEnvelope(["PDF_PARSE_FAILED"]); } }));
  server.registerTool("documents_parse_pending", { title: "Parse pending PDFs", description: "Parses up to 100 stored PDFs that have no parse result. Requires confirm:true; no ingest or bookkeeping is performed. write-reversible.", inputSchema: { company: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), cursor: z.number().int().min(0).optional(), confirm: confirmField.optional() }, outputSchema: envelopeShape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, withCompanyDbConfirmed<{ company: string; limit?: number; cursor?: number; confirm?: boolean }>(server, "documents_parse_pending", async ({ db, actor, args }) => { const plan=planCurrentPdfParses(db,{limit:args.limit,cursor:args.cursor}); const parses = await parseRegisteredPdfBatch(db, args.company, plan.documentIds, { createdBy: actor.createdBy, createdByProgram: actor.createdByProgram }); const failed = parses.filter((p: any) => !p.ok); return successEnvelope({ batch: { requested: plan.documentIds.length, parsed: parses.length - failed.length, failed: failed.length, cursor:plan.cursor, nextCursor:plan.nextCursor, resume: failed.length ? { documentIds: failed.map((p: any) => p.documentId) } : null } }); }));
  server.registerTool("documents_parse_status", { title: "Read PDF parse status", description: "Read-only latest parser status and metrics; never exposes paths, raw child stderr, or secrets.", inputSchema: { company: z.string().min(1), documentId: z.number().int().positive() }, outputSchema: envelopeShape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, withCompanyReadOnlyDb<{ company: string; documentId: number }>(({ db, args }) => { try { return successEnvelope({ parse: documentPdfParseStatus(db, args.company, args.documentId) }); } catch (error) { return errorEnvelope([error instanceof PdfParseError && error.code === "tampered_result" ? PDF_EVIDENCE_TAMPERED : "PDF_PARSE_FAILED"], { code: error instanceof PdfParseError && error.code === "tampered_result" ? PDF_EVIDENCE_TAMPERED : undefined }); } }));
  server.registerTool("documents_parsed_text", { title: "Read parsed PDF text", description: "Read-only parsed text pages. At most 10 pages per call; never exposes paths, raw child stderr, or secrets.", inputSchema: { company: z.string().min(1), documentId: z.number().int().positive(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(10).optional() }, outputSchema: envelopeShape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, withCompanyReadOnlyDb<{ company: string; documentId: number; offset?: number; limit?: number }>(({ db, args }) => { try { return successEnvelope(documentPdfParsedText(db, args.company, args.documentId, args.offset ?? 0, args.limit ?? 10)); } catch (error) { return errorEnvelope([error instanceof PdfParseError && error.code === "tampered_result" ? PDF_EVIDENCE_TAMPERED : "PDF_PARSE_FAILED"], { code: error instanceof PdfParseError && error.code === "tampered_result" ? PDF_EVIDENCE_TAMPERED : undefined }); } }));
  server.registerTool("documents_invoice_extraction", { title: "Read invoice extraction", description: "Returns cited invoice values, confidence, provenance, conflicts, hash, resolutions and exception state; no paths or secrets.", inputSchema: { company: z.string().min(1), documentId: z.number().int().positive() }, outputSchema: envelopeShape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, withCompanyDb<{ company: string; documentId: number }>(server, ({ db, args }) => successEnvelope({ extraction: invoiceExtractionSurface(db, args.documentId) })));
  server.registerTool("documents_extract_invoice", { title: "Extract invoice", description: "Extracts cited evidence from a stored PDF. Requires confirm:true and a configured production extraction provider. write-reversible.", inputSchema: { company: z.string().min(1), documentId: z.number().int().positive(), confirm: confirmField.optional() }, outputSchema: envelopeShape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, withCompanyDbConfirmed<{ company: string; documentId: number; confirm?: boolean }>(server, "documents_extract_invoice", async ({ db, actor, args }) => { const extractor = resolveConfiguredInvoiceExtractor(); if (!extractor) return errorEnvelope(["EXTRACTION_PROVIDER_UNAVAILABLE"]); try { await extractDocumentInvoice(db, args.company, args.documentId, extractor, actor.createdBy); return successEnvelope({ extraction: invoiceExtractionSurface(db, args.documentId) }); } catch (error) { return errorEnvelope([error instanceof Error && /^EXTRACTION_[A-Z_]+$/.test(error.message) ? error.message : "EXTRACTION_FAILED"]); } }));
  server.registerTool(
    "documents_list",
    {
      title: "List documents",
      description:
        "Lister gemte bilag i virksomhedsmappen. Read-only. " +
        "Rækkefølge: id DESC (nyeste først, deterministisk)." +
        paginationDescriptionSuffix,
      inputSchema: {
        company: z.string().min(1).describe("Absolute path to the company directory, or a workspace slug."),
        ...paginationFields,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyDb<{ company: string; limit?: number; offset?: number }>(server, ({ db, args }) => {
      const rows = db
        .query(
          `SELECT d.id, d.document_no, d.source, d.original_filename,
                  d.document_type, d.invoice_date, d.amount_inc_vat,
                  d.currency, d.status, d.stored_path, d.payload_json,
                  d.sender_vat_cvr, d.supplier_country_code,
                  d.supplier_identifier_kind, d.supplier_identity_status,
                  ive.bank_transaction_id AS source_bank_transaction_id,
                  ive.accounting_rationale, ive.prepared_by,
                  ive.prepared_by_program
             FROM documents d
             LEFT JOIN internal_voucher_evidence ive ON ive.document_id = d.id
            ORDER BY d.id DESC`,
        )
        .all() as Array<{
          id: number;
          document_no: string | null;
          source: string;
          original_filename: string;
          document_type: string;
          invoice_date: string | null;
          amount_inc_vat: number | null;
          currency: string | null;
          status: string;
          stored_path: string | null;
          payload_json: string | null;
          sender_vat_cvr: string | null; supplier_country_code: string | null; supplier_identifier_kind: string | null; supplier_identity_status: string | null;
          source_bank_transaction_id: number | null;
          accounting_rationale: string | null;
          prepared_by: string | null;
          prepared_by_program: string | null;
        }>;
      const mapped = rows.map((row) => ({
        id: row.id,
        documentNo: row.document_no,
        source: row.source,
        originalFilename: row.original_filename,
        documentType: row.document_type,
        invoiceDate: row.invoice_date,
        amountIncVat: row.amount_inc_vat,
        currency: row.currency,
        status: row.status,
        storedPath: row.stored_path,
        purchaseVatLines: purchaseVatLinesFromPayload(row.payload_json),
        senderVatOrCvr: row.sender_vat_cvr,
        supplierCountryCode: row.supplier_country_code,
        supplierIdentifierKind: row.supplier_identifier_kind,
        supplierIdentityStatus: row.supplier_identity_status,
        sourceBankTransactionId: row.source_bank_transaction_id,
        accountingRationale: row.accounting_rationale,
        preparedBy: row.prepared_by,
        preparedByProgram: row.prepared_by_program,
      }));
      const { pageRows, meta } = applyPagination(mapped, { limit: args.limit, offset: args.offset });
      return successEnvelope({ documents: pageRows, ...meta });
    }),
  );

  server.registerTool(
    "documents_ingest",
    {
      title: "Ingest document",
      description:
        "Indlæser og hash-lagrer et bilag med metadata. Kræver confirm:true. " +
        "BIVIRKNING ved fejl: hver gang ingest blokeres (fx duplicate, manglende " +
        "fil, valideringsfejl) skrives en `DOCUMENT_INGEST_BLOCKED` exception-række. " +
        "Skrivningen er idempotent på (type, filePath, requiredAction): gentagne " +
        "retries af præcis samme fejlende input opretter IKKE duplikat-exceptions " +
        "— de matcher den eksisterende åbne række og no-op'er. Brug `exceptions_list` " +
        "for at se de afledte exceptions agenten har efterladt. " +
        "VIGTIGT: filePath er en sti på MCP-serverens eget filsystem — bilaget skal allerede " +
        "ligge på serveren. Klienten/agenten kan IKKE uploade en fil her, og der findes (i " +
        "modsætning til bank_import's csvContent) ingen inline-content-variant: filen kan kun " +
        "angives via sti. Alle beløb i metadata er i kroner (decimal DKK, ikke øre). " +
        "write-reversible.",
      inputSchema: {
        company: z.string().min(1).describe("Absolute path to the company directory, or a workspace slug."),
        filePath: z
          .string()
          .min(1)
          .describe(
            "Absolute path to the document file ON THE MCP SERVER'S FILESYSTEM. The file " +
              "must already exist on the server — this tool does not accept uploaded or " +
              "inline file content (no csvContent-style alternative exists, unlike bank_import).",
          ),
        metadata: documentMetadataSchema,
        vendorId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional ID of an existing vendor to associate with the document. See vendor_list."),
        force: z
          .boolean()
          .optional()
          .describe(
            "Set true to bypass duplicate detection and force ingest even when a " +
              "document with the same logical identity already exists. When omitted " +
              "(or false), a duplicate is blocked and an exception is recorded.",
          ),
        confirm: confirmField,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      filePath: string;
      metadata: DocumentMetadata;
      vendorId?: number;
      force?: boolean;
      confirm?: boolean;
    }>(server, "documents_ingest", ({ db, actor, args }) => {
      const resolved = resolveDocumentMasterData(db, args.metadata, { vendorId: args.vendorId });
      if (!resolved.ok) return errorEnvelope(resolved.errors ?? ["resolveDocumentMasterData failed"]);
      const result = ingestDocument(db, args.company, args.filePath, resolved.metadata, {
        forceDuplicateLogicalIdentity: args.force === true,
        createdBy: actor.createdBy,
        createdByProgram: actor.createdByProgram,
      });
      if (!result.ok) {
        recordException(db, {
          type: "DOCUMENT_INGEST_BLOCKED",
          severity: "medium",
          message: `Document ingest blocked for ${args.filePath}`,
          requiredAction: "Fix document metadata or duplicate handling, then retry ingest.",
          sourceEvidence: { file: args.filePath, errors: result.errors ?? [] },
          postingPreview: { retryCommand: "documents_ingest" },
        });
      }
      return wrapCoreResult(result);
    }),
  );
}
