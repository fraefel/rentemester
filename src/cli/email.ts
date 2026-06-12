/**
 * Email delivery CLI (#180): `invoice send`.
 *
 * Sends an issued invoice or a reminder to the customer's email via SMTP,
 * with the rendered PDF attached, and records an append-only send-log row.
 *
 * SMTP config is read from `config/smtp.json` inside the company directory —
 * NEVER from the ledger DB — mirroring the PEPPOL access-point config trust
 * boundary. The default transport runs in `dryRun` unless the operator wires
 * a live transport; this keeps the CLI deterministic and testable.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../core/db";
import { companyPaths } from "../core/paths";
import { createSmtpTransport, sendInvoiceEmail, type EmailKind, type SmtpConfig } from "../core/email";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch, CommandContext } from "../cli-dispatch";

function loadSmtpConfig(companyRoot: string): { ok: true; config: SmtpConfig } | { ok: false; error: string } {
  const path = join(companyPaths(companyRoot).config, "smtp.json");
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `manglende SMTP-opsætning: opret config/smtp.json (host, port, fromAddress) her: ${path}`,
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SmtpConfig>;
    return {
      ok: true,
      config: {
        host: parsed.host ?? "",
        port: typeof parsed.port === "number" ? parsed.port : Number(parsed.port ?? 0),
        fromAddress: parsed.fromAddress ?? "",
        fromName: parsed.fromName,
        username: parsed.username,
        password: parsed.password,
        dryRun: parsed.dryRun,
      },
    };
  } catch (error) {
    return { ok: false, error: `could not read config/smtp.json: ${(error as Error).message}` };
  }
}

function resolveInvoiceDocumentId(db: ReturnType<typeof openCommandDb>, ctx: CommandContext): number | null {
  const documentId = Number(ctx.arg("--document-id"));
  if (Number.isInteger(documentId) && documentId > 0) return documentId;
  const invoiceNumber = ctx.arg("--invoice-number")?.trim();
  if (invoiceNumber) {
    const row = db
      .query(
        `SELECT id FROM documents WHERE document_type = 'issued_invoice' AND invoice_no = ? LIMIT 1`,
      )
      .get(invoiceNumber) as { id: number } | null;
    return row?.id ?? null;
  }
  return null;
}

export function register(dispatch: CommandDispatch): void {
  // `invoice send`: emails an issued invoice / reminder PDF to the customer.
  dispatch.on("invoice", "send", (ctx) => {
    const kindRaw = (ctx.arg("--kind") ?? "invoice").trim();
    if (kindRaw !== "invoice" && kindRaw !== "reminder") {
      console.error("--kind must be either 'invoice' or 'reminder'");
      process.exit(2);
    }
    const kind = kindRaw as EmailKind;

    const root = ctx.companyRoot();
    const smtp = loadSmtpConfig(root);
    if (!smtp.ok) {
      console.error(smtp.error);
      process.exit(2);
    }

    const db = openCommandDb(ctx);
    migrate(db);
    const documentId = resolveInvoiceDocumentId(db, ctx);
    if (!documentId) {
      db.close();
      console.error("Missing required --document-id <n> or --invoice-number <no>");
      process.exit(2);
    }

    const result = sendInvoiceEmail(db, root, {
      invoiceDocumentId: documentId,
      kind,
      to: ctx.arg("--to"),
      smtp: smtp.config,
      transport: createSmtpTransport(smtp.config),
    });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });
}
