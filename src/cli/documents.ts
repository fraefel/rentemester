import { readFileSync } from "node:fs";
import type { CommandDispatch } from "../cli-dispatch";
import { openCommandDb } from "../cli-dispatch";
import { formatKroner } from "../cli-format";
import { migrate, openDb } from "../core/db";
import { parseRegisteredPdfBatch, parseRegisteredPdfDocument } from "../core/document-pdf-parser";
import { ingestDocument, purchaseVatLinesFromPayload } from "../core/documents";
import { recordException } from "../core/exceptions";
import { resolveDocumentMasterData } from "../core/master-data";
import { companyPaths } from "../core/paths";
import { extractDocumentInvoice, invoiceExtractionSurface } from "../server/invoice-extraction-surface";
import { resolveConfiguredInvoiceExtractor } from "../server/invoice-extractor";

function parseStatus(db: any, documentId: number) {
  return db.query(`SELECT id, document_id AS documentId, source_sha256_hash AS sourceSha256, parser_id AS parserId, parser_version AS parserVersion, contract_version AS contractVersion, status, error_code AS errorCode, page_count AS pageCount, item_count AS itemCount, text_length AS textLength, result_sha256_hash AS resultHash, created_at AS createdAt FROM document_pdf_parses WHERE document_id=? ORDER BY id DESC LIMIT 1`).get(documentId) ?? null;
}

export function register(dispatch: CommandDispatch): void {
  dispatch.on("documents", "ingest", (ctx) => {
    const file = ctx.arg("--file");
    const metadataFile = ctx.arg("--metadata");
    if (!file || !metadataFile) {
      console.error("Missing required --file <path> or --metadata <file.json>");
      process.exit(2);
    }
    const root = ctx.companyRoot();
    const db = openDb(companyPaths(root).db);
    migrate(db);
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"));
    const vendorIdRaw = ctx.arg("--vendor-id");
    const vendorId = vendorIdRaw === undefined ? undefined : Number(vendorIdRaw);
    const resolved = resolveDocumentMasterData(db, metadata, {
      vendorId:
        typeof vendorId === "number" && Number.isInteger(vendorId) && vendorId > 0
          ? vendorId
          : undefined,
    });
    if (!resolved.ok) {
      ctx.emitResult(resolved as Record<string, unknown>);
      db.close();
      process.exit(1);
      return;
    }
    const result = ingestDocument(db, root, file, resolved.metadata, {
      forceDuplicateLogicalIdentity: ctx.hasFlag("--force"),
      createdBy:
        ctx.cliActor ??
        process.env.RENTEMESTER_ACTOR ??
        ctx.inferredMutationActor() ??
        undefined,
      createdByProgram:
        ctx.cliActorVia ??
        process.env.RENTEMESTER_ACTOR_VIA ??
        "rentemester-cli",
    });
    if (!result.ok) {
      recordException(db, {
        type: "DOCUMENT_INGEST_BLOCKED",
        severity: "medium",
        message: `Bilaget ${file} kunne ikke indlæses`,
        requiredAction: "Ret bilagets metadata eller dublethåndtering, og prøv at indlæse igen.",
        sourceEvidence: {
          file,
          metadataFile,
          errors: result.errors ?? [],
        },
        postingPreview: {
          retryCommand:
            "documents ingest --company <path> --file <file> --metadata <file.json>",
        },
      });
    }
    // EJER-17: a success confirmation, not the command description. Without a
    // `message` the human renderer falls back to printing the command's help
    // text ("✔ Indlæser og validerer et bilag") as the heading, which reads as
    // a description of what the command does — not what it just did.
    const confirmed = result.ok
      ? {
          ...(result as Record<string, unknown>),
          message: `Bilag ${result.documentNo ?? ""}`.trim() + " er indlæst.",
        }
      : (result as Record<string, unknown>);
    ctx.emitResult(confirmed);
    db.close();
  });

  dispatch.on("documents", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const rows = db
      .query(
        `SELECT d.id, d.document_no, d.source, d.original_filename,
                d.document_type, d.invoice_date, d.amount_inc_vat, d.currency,
                d.status, d.stored_path, d.sender_vat_cvr,
                d.supplier_country_code, d.supplier_identifier_kind,
                d.supplier_identity_status, d.payload_json,
                ive.bank_transaction_id AS source_bank_transaction_id,
                ive.accounting_rationale, ive.prepared_by,
                ive.prepared_by_program
           FROM documents d
           LEFT JOIN internal_voucher_evidence ive ON ive.document_id = d.id
          ORDER BY d.id DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    if (ctx.outputFormat === "json") {
      console.log(JSON.stringify(rows.map((row) => ({
        ...row,
        purchase_vat_lines: purchaseVatLinesFromPayload(typeof row.payload_json === "string" ? row.payload_json : null),
        payload_json: undefined,
      })), null, 2));
      db.close();
      return;
    }
    console.log(`Bilag (${rows.length})`);
    if (rows.length === 0) {
      console.log("Ingen bilag gemt.");
    }
    for (const row of rows) {
      const currency = String(row.currency ?? "DKK").toUpperCase();
      console.log("");
      console.log(`#${row.document_no ?? row.id} — ${row.original_filename ?? "—"}`);
      console.log(`  Bilagsdato: ${row.invoice_date ?? "—"} | Kilde: ${row.source ?? "—"}`);
      if (row.document_type === "internal_voucher") {
        console.log(
          `  Internt bilag: bankpost #${row.source_bank_transaction_id ?? "—"} | Udarbejdet af: ${row.prepared_by ?? "—"}`,
        );
        console.log(`  Begrundelse: ${row.accounting_rationale ?? "—"}`);
      }
      if (row.supplier_country_code || row.supplier_identifier_kind || row.supplier_identity_status) {
        console.log(`  Leverandøridentitet: ${row.supplier_country_code ?? "—"} · ${row.supplier_identifier_kind ?? "—"} · ${row.supplier_identity_status ?? "—"}`);
      }
      let amountLine = `  Beløb (inkl. moms): ${formatKroner(row.amount_inc_vat)}`;
      if (currency !== "DKK") amountLine += ` ${currency}`;
      console.log(amountLine);
      console.log(`  Status: ${row.status ?? "—"}`);
    }
    db.close();
  });

  dispatch.on("documents", "extract-invoice", async (ctx) => {
    const id = Number(ctx.arg("--document-id"));
    if (!Number.isInteger(id) || id <= 0) ctx.fatal("Missing required --document-id <n>");
    const extractor = resolveConfiguredInvoiceExtractor();
    if (!extractor) { ctx.fatal("invoice extraction requires a configured production provider"); return; }
    const db = openCommandDb(ctx); migrate(db);
    try { await extractDocumentInvoice(db, id, extractor, ctx.cliActor ?? ctx.inferredMutationActor() ?? "system:invoice-extraction"); ctx.emitResult({ ok: true, extraction: invoiceExtractionSurface(db, id) }); }
    catch (error) { ctx.emitResult({ ok: false, errors: [error instanceof Error && /^EXTRACTION_[A-Z_]+$/.test(error.message) ? error.message : "EXTRACTION_FAILED"] }); }
    finally { db.close(); }
  });

  dispatch.on("documents", "invoice-extraction", (ctx) => {
    const id = Number(ctx.arg("--document-id"));
    if (!Number.isInteger(id) || id <= 0) ctx.fatal("Missing required --document-id <n>");
    const db = openCommandDb(ctx); migrate(db);
    try { ctx.emitResult({ ok: true, extraction: invoiceExtractionSurface(db, id) }); } finally { db.close(); }
  });

  dispatch.on("documents", "parse", async (ctx) => {
    const id = Number(ctx.arg("--document-id")); if (!Number.isInteger(id) || id <= 0) ctx.fatal("Missing required --document-id <n>");
    const db = openCommandDb(ctx); migrate(db); try { const result = await parseRegisteredPdfDocument(db, ctx.companyRoot(), { documentId: id, createdBy: ctx.cliActor ?? ctx.inferredMutationActor() ?? undefined, createdByProgram: "rentemester-cli" }); ctx.emitResult({ ok: true, parse: result }); } catch { ctx.emitResult({ ok: false, errors: ["PDF_PARSE_FAILED"] }); } finally { db.close(); }
  });
  dispatch.on("documents", "parse-pending", async (ctx) => {
    const limit = ctx.arg("--limit") === undefined ? 100 : Number(ctx.arg("--limit")); if (!Number.isInteger(limit) || limit < 1 || limit > 100) ctx.fatal("--limit must be an integer between 1 and 100");
    const db = openCommandDb(ctx); migrate(db); try { const ids = (db.query(`SELECT d.id FROM documents d WHERE d.mime_type='application/pdf' AND d.stored_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM document_pdf_parses p WHERE p.document_id=d.id) ORDER BY d.id LIMIT ?`).all(limit) as Array<{ id: number }>).map((x) => x.id); const parses = await parseRegisteredPdfBatch(db, ctx.companyRoot(), ids, { createdBy: ctx.cliActor ?? ctx.inferredMutationActor() ?? undefined, createdByProgram: "rentemester-cli" }); ctx.emitResult({ ok: true, parses }); } finally { db.close(); }
  });
  dispatch.on("documents", "parse-status", (ctx) => { const id = Number(ctx.arg("--document-id")); if (!Number.isInteger(id) || id <= 0) ctx.fatal("Missing required --document-id <n>"); const db = openCommandDb(ctx); migrate(db); try { ctx.emitResult({ ok: true, parse: parseStatus(db, id) }); } finally { db.close(); } });
  dispatch.on("documents", "parsed-text", (ctx) => { const id = Number(ctx.arg("--document-id")); const offset = Number(ctx.arg("--offset") ?? 0); const limit = Number(ctx.arg("--limit") ?? 10); if (!Number.isInteger(id) || id <= 0) ctx.fatal("Missing required --document-id <n>"); if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10) ctx.fatal("--offset >= 0 and --limit 1..10 are required"); const db = openCommandDb(ctx); migrate(db); try { const parse = parseStatus(db, id); const pages = parse ? db.query(`SELECT page_number AS pageNumber, width, height, rotation, text, item_count AS itemCount FROM document_pdf_parse_pages WHERE parse_id=? ORDER BY page_number LIMIT ? OFFSET ?`).all(parse.id, limit, offset) : []; ctx.emitResult({ ok: true, parse, pages, offset, limit, nextOffset: pages.length === limit ? offset + limit : null }); } finally { db.close(); } });
}
