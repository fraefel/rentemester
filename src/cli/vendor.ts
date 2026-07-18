import { migrate } from "../core/db";
import {
  createVendor,
  listVendors,
  vendorInputFromCvr,
  type CreateVendorInput,
} from "../core/master-data";
import { openCommandDb } from "../cli-dispatch";
import { renderContactList } from "../cli-format";
import type { CommandDispatch } from "../cli-dispatch";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("vendor", "create", async (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const base: CreateVendorInput = {
      name: ctx.arg("--name") ?? "",
      address: ctx.arg("--address") ?? undefined,
      vatOrCvr: ctx.arg("--cvr") ?? undefined,
      countryCode: ctx.arg("--country") ?? undefined,
      identifierKind: ctx.arg("--identifier-kind") as CreateVendorInput["identifierKind"],
      defaultExpenseAccount: ctx.arg("--expense-account") ?? undefined,
      defaultVatTreatment: ctx.arg("--default-vat") ?? undefined,
      notes: ctx.arg("--notes") ?? undefined,
    };

    // --from-cvr fills any field the caller left unset from the CVR register.
    let input = base;
    const fromCvr = ctx.arg("--from-cvr");
    if (fromCvr) {
      const resolved = await vendorInputFromCvr(db, fromCvr, base);
      if (!resolved.ok) {
        ctx.emitResult({ ok: false, errors: resolved.errors });
        db.close();
        process.exit(1);
      }
      input = resolved.input;
    }

    const result = createVendor(db, input);
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("vendor", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = listVendors(db, { archived: ctx.hasFlag("--archived") });
    if (ctx.outputFormat === "json") {
      ctx.emitResult(result as Record<string, unknown>);
    } else {
      console.log(
        renderContactList(result as Record<string, unknown>, "Leverandører", "Ingen leverandører registreret."),
      );
    }
    db.close();
  });
}
