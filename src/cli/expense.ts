import { migrate } from "../core/db";
import { CURRENT_SCHEMA_VERSION } from "../core/schema-version";
import { bookExpenseFromBank } from "../core/expense-booking";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";
import { applyPurchaseVatPreflight, purchaseVatPreflightSnapshot } from "./purchase-vat-preflight";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("expense", "vat-preflight", async (ctx) => {
    const documentId = Number(ctx.arg("--document-id"));
    if (!Number.isInteger(documentId) || documentId <= 0) {
      console.error("Missing required --document-id <n>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    // A dry-run is observational.  It must never bootstrap or upgrade a
    // ledger merely to render a decision.
    if (!ctx.hasFlag("--apply")) {
      const row = db.query("SELECT MAX(id) AS version FROM schema_migrations").get() as { version: number | null };
      if (row.version !== CURRENT_SCHEMA_VERSION) {
        ctx.emitResult({ ok: false, errors: ["migration-required: apply ledger migrations before VAT preflight dry-run"] });
        db.close();
        process.exit(1);
      }
    } else {
      migrate(db);
    }
    const result = ctx.hasFlag("--apply")
      ? await applyPurchaseVatPreflight(db, documentId, ctx.cliActor ?? process.env.RENTEMESTER_ACTOR ?? ctx.inferredMutationActor() ?? "unknown")
      : purchaseVatPreflightSnapshot(db, documentId);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("expense", "book", (ctx) => {
    const documentId = Number(ctx.arg("--document-id"));
    const bankTransactionId = Number(ctx.arg("--bank-transaction-id"));
    const expenseAccountNo = ctx.arg("--expense-account");
    const vatTreatment = ctx.arg("--vat-treatment") as
      | "standard"
      | "reverse_charge"
      | "eu_goods_acquisition"
      | "representation"
      | "exempt"
      | "non_deductible"
      | undefined;
    if (
      !Number.isInteger(documentId) ||
      documentId <= 0 ||
      !Number.isInteger(bankTransactionId) ||
      bankTransactionId <= 0 ||
      !expenseAccountNo
    ) {
      console.error(
        "Missing required --document-id <n>, --bank-transaction-id <n>, or --expense-account <account>",
      );
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = bookExpenseFromBank(db, {
      documentId,
      bankTransactionId,
      expenseAccountNo,
      vatTreatment,
      paymentAccountNo: ctx.arg("--payment-account") ?? undefined,
      transactionDate: ctx.arg("--date") ?? undefined,
      text: ctx.arg("--text") ?? undefined,
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
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });
}
