/**
 * MCP-tool: `expense_book` (write-irreversible).
 *
 * 1:1-mapping af CLI-kommandoen `expense book`. Bogfører en leverandørudgift
 * direkte fra et bilag + en bankpost.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bookExpenseFromBankInCurrentTransaction } from "../../core/expense-booking";
import { withActor } from "../actor";
import { envelopeShape, wrapCoreResult } from "../envelope";
import { withCompanyDbConfirmed, confirmField, idempotencyKeyField, withCompanyReadOnlyDb } from "../tool-runtime";
import { applyPurchaseVatPreflight, purchaseVatPreflightSnapshot } from "../../cli/purchase-vat-preflight";

const vatTreatmentEnum = z
  .enum(["standard", "reverse_charge", "representation", "exempt", "non_deductible"])
  .optional()
  .describe(
    "How VAT on the expense is treated. " +
      "'standard' = ordinary Danish purchase VAT, deducted as input VAT (default for a registered company). " +
      "'reverse_charge' = foreign service purchase (EU or non-EU) where the buyer self-accounts for VAT; persisted supplier identity selects the correct treatment " +
      "(omvendt betalingspligt). " +
      "'representation' = entertainment/representation costs with the statutory " +
      "limited VAT deduction. " +
      "'exempt' = the expense carries no deductible VAT. " +
      "'non_deductible' = VAT with no deduction right (for example foreign local tax, " +
      "or a purchase at a NOT VAT-registered company under Momsloven § 37) — the " +
      "entire VAT is absorbed into the cost basis and no 4000 input-VAT line is " +
      "written. It may also be selected explicitly by a VAT-registered company. " +
      "When omitted, the treatment is INFERRED from the expense account's " +
      "default_vat_code AND the company's VAT registration. For a VAT-registered " +
      "company: DK 25 % → 'standard', EU-service → 'reverse_charge', " +
      "representation → 'representation'. For a NOT VAT-registered company " +
      "(§ 37, no deduction): DK 25 % AND representation both → 'non_deductible' " +
      "(the VAT is absorbed; the § 42 partial representation deduction does not " +
      "apply), while EU-service reverse charge is REFUSED — it triggers a " +
      "separate § 50 b erhvervelsesmoms registration that is out of scope. " +
      "An account with no recognised default_vat_code is refused; pass an " +
      "explicit vatTreatment in that case.",
  );

export function registerExpenseTools(server: McpServer): void {
  server.registerTool(
    "expense_vat_preflight",
    {
      title: "Inspect purchase VAT preflight",
      description: "Read-only dry-run for a purchase document. Shows derived region, required validation, evidence freshness/cache reuse and whether apply would contact the VAT provider. It never writes or calls a provider.",
      inputSchema: { company: z.string().min(1), documentId: z.number().int().positive() }, outputSchema: envelopeShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    withCompanyReadOnlyDb<{ company: string; documentId: number }>(({ db, args }) => wrapCoreResult(purchaseVatPreflightSnapshot(db, args.documentId))),
  );
  server.registerTool(
    "expense_vat_preflight_apply",
    {
      title: "Apply purchase VAT preflight",
      description: "Obtains required EU VAT validation evidence before purchase posting. Requires confirm:true and actor attribution; records safe durable evidence and a resumable exception when blocked. write-reversible.",
      inputSchema: { company: z.string().min(1), documentId: z.number().int().positive(), confirm: confirmField }, outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    withCompanyDbConfirmed<{ company: string; documentId: number; confirm?: boolean }>(server, "expense_vat_preflight_apply", async ({ db, actor, args }) => wrapCoreResult(await applyPurchaseVatPreflight(db, args.documentId, actor.createdBy))),
  );

  server.registerTool(
    "expense_book",
    {
      title: "Book expense from bank + document",
      description:
        "Bogfører leverandørudgift fra bilag + bankpost i ét tag. write-irreversible.",
      inputSchema: {
        company: z.string().min(1).describe("Absolute path to the company directory, or a workspace slug."),
        documentId: z
          .number()
          .int()
          .positive()
          .describe(
            "ID of the ingested document (bilag) the expense is booked from. " +
              "Find it with documents_list.",
          ),
        bankTransactionId: z
          .number()
          .int()
          .positive()
          .describe(
            "ID of the imported bank transaction that paid the expense. " +
              "Find it with bank_list.",
          ),
        expenseAccount: z
          .string()
          .min(1)
          .describe(
            "Account number from the chart of accounts the expense is posted to, " +
              "e.g. '3000' (Software og SaaS). See accounts_list.",
          ),
        vatTreatment: vatTreatmentEnum,
        paymentAccount: z
          .string()
          .optional()
          .describe(
            "Account number the payment is credited to. Defaults to the confirmed bank role; " +
              "set it only when the payment came from a different account.",
          ),
        date: z
          .string()
          .optional()
          .describe(
            "Posting date in YYYY-MM-DD format. When omitted, the bank " +
              "transaction's own date is used.",
          ),
        text: z
          .string()
          .optional()
          .describe("Optional free-text description of the expense posting."),
        confirm: confirmField,
        idempotencyKey: idempotencyKeyField,
      },
      outputSchema: envelopeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withCompanyDbConfirmed<{
      company: string;
      documentId: number;
      bankTransactionId: number;
      expenseAccount: string;
      vatTreatment?: "standard" | "reverse_charge" | "representation" | "exempt" | "non_deductible";
      paymentAccount?: string;
      date?: string;
      text?: string;
      confirm?: boolean;
      idempotencyKey?: string;
    }>(server, "expense_book", ({ db, actor, args }) => {
      // Actor-invariant (#63/#76): thread the MCP-client identity into the
      // hash-chained ledger so created_by/created_by_program + audit_log.actor
      // are attributed to the booking agent, not the OS user (resolveActor's
      // process.env.USER fallback). withActor never overwrites explicit values.
      const result = bookExpenseFromBankInCurrentTransaction(
        db,
        withActor(
          {
            documentId: args.documentId,
            bankTransactionId: args.bankTransactionId,
            expenseAccountNo: args.expenseAccount,
            vatTreatment: args.vatTreatment,
            paymentAccountNo: args.paymentAccount,
            transactionDate: args.date,
            text: args.text,
          },
          actor,
        ),
      );
      return wrapCoreResult(result);
    }, { keyIdempotent: "expense_book" }),
  );
}
