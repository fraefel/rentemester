import { readFileSync } from "node:fs";
import { companyPaths } from "../core/paths";
import { openDb, migrate } from "../core/db";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";
import {
  createRecurringInvoiceTemplate,
  generateRecurringInvoice,
  listRecurringInvoiceTemplates,
} from "../core/recurring-invoices";
import { runWorkspaceRecurringInvoices } from "../core/recurring-workspace";
import { resolveWorkspaceRoot } from "../core/workspace";

export function register(dispatch: CommandDispatch): void {
  // Scheduler entry point. There is intentionally no built-in cron: an
  // external scheduler invokes this explicit command, normally daily.
  dispatch.on("recurring-invoice", "run-workspace", async (ctx) => {
    if ((ctx.arg("--confirm") ?? "").trim().toLowerCase() !== "yes") {
      ctx.emitResult({ ok: false, errors: ["--confirm yes required to run workspace recurring invoices"] });
      process.exit(1);
    }
    const workspace = ctx.trimToNull(ctx.arg("--workspace"));
    const asOfDate = ctx.trimToNull(ctx.arg("--as-of"));
    const maxGenerationsRaw = ctx.trimToNull(ctx.arg("--max-generations"));
    const maxGenerations = maxGenerationsRaw === null ? undefined : Number(maxGenerationsRaw);
    if (!workspace || !asOfDate) {
      ctx.emitResult({ ok: false, errors: ["Missing required --workspace <dir> or --as-of <YYYY-MM-DD>"] });
      process.exit(2);
    }
    try {
      const createdBy = ctx.cliActor ?? process.env.RENTEMESTER_ACTOR ?? ctx.inferredMutationActor();
      if (!createdBy) throw new Error("actor required for workspace recurring run");
      const createdByProgram = ctx.cliActorVia ?? process.env.RENTEMESTER_ACTOR_VIA ?? "rentemester-cli";
      const result = await runWorkspaceRecurringInvoices(resolveWorkspaceRoot(workspace), {
        asOfDate,
        actor: { createdBy, createdByProgram },
        maxGenerations,
      });
      ctx.emitResult(result as unknown as Record<string, unknown>);
      if (!result.ok) process.exit(1);
    } catch (error) {
      ctx.emitResult({ ok: false, errors: [error instanceof Error ? error.message : String(error)] });
      process.exit(1);
    }
  });
  dispatch.on("recurring-invoice", "create", (ctx) => {
    const input = ctx.arg("--input");
    if (!input) {
      console.error("Missing required --input <file.json>");
      process.exit(2);
    }
    const root = ctx.companyRoot();
    const db = openDb(companyPaths(root).db);
    migrate(db);
    const payload = JSON.parse(readFileSync(input, "utf8"));
    const result = createRecurringInvoiceTemplate(db, payload);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("recurring-invoice", "generate", (ctx) => {
    const templateId = Number(ctx.arg("--template-id"));
    const asOfDate = ctx.arg("--as-of");
    if (!Number.isInteger(templateId) || templateId <= 0 || !asOfDate) {
      console.error("Missing required --template-id <n> or --as-of <YYYY-MM-DD>");
      process.exit(2);
    }
    const root = ctx.companyRoot();
    const db = openDb(companyPaths(root).db);
    migrate(db);
    const result = generateRecurringInvoice(db, root, { templateId, asOfDate });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("recurring-invoice", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = listRecurringInvoiceTemplates(db, {
      includeInactive: ctx.hasFlag("--include-inactive"),
    });
    if (ctx.outputFormat === "json") {
      ctx.emitResult(result as Record<string, unknown>);
    } else {
      console.log(`Recurring invoice templates (${result.count})`);
      if (result.count === 0) {
        console.log("No recurring invoice templates.");
      } else {
        console.table(
          result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            interval: row.interval,
            nextIssueDate: row.nextIssueDate,
            paymentTermsDays: row.paymentTermsDays,
            active: row.active,
          })),
        );
      }
    }
    db.close();
  });
}
