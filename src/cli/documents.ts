import { readFileSync } from "node:fs";
import { companyPaths } from "../core/paths";
import { openDb, migrate } from "../core/db";
import { ingestDocument, purchaseVatLinesFromPayload } from "../core/documents";
import { recordException } from "../core/exceptions";
import { resolveDocumentMasterData } from "../core/master-data";
import { openCommandDb } from "../cli-dispatch";
import { formatKroner } from "../cli-format";
import type { CommandDispatch } from "../cli-dispatch";

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
}
