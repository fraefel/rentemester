// Financial statements (#176): the `report` CLI command group.
//
// `report trial-balance|profit-loss --company <c> --from --to` and
// `report balance --company <c> --as-of` emit the deterministic JSON produced
// by src/core/financial-statements.ts. The same core functions feed the
// dashboard and the cockpit API; this command is a thin CLI wrapper.

import { migrate } from "../core/db";
import { queryCfoAnalytics } from "../core/cfo-analytics";
import {
  buildBalanceSheet,
  buildProfitAndLoss,
  buildTrialBalance,
} from "../core/financial-statements";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";
import { emitHumanReport } from "../cli-format";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("report", "analytics", (ctx) => {
    const workspace=ctx.arg("--workspace"), scope=ctx.arg("--scope"), from=ctx.arg("--from"), to=ctx.arg("--to");
    if (!workspace || !from || !to || (scope!=="company"&&scope!=="portfolio"&&scope!=="group")) ctx.fatal("report analytics requires --workspace, --scope company|portfolio|group, --from and --to");
    const companySlugs=ctx.arg("--company-slugs")?.split(",").map(value=>value.trim()).filter(Boolean);
    const rawLimit=ctx.arg("--limit"); const limit=rawLimit===undefined?undefined:Number(rawLimit);
    if(limit!==undefined&&(!Number.isInteger(limit)||limit<1||limit>200))ctx.fatal("--limit must be an integer from 1 through 200");
    try { ctx.emitResult({ok:true,analytics:queryCfoAnalytics(workspace!,{scope:scope as "company"|"portfolio"|"group",companySlug:ctx.arg("--company-slug"),companySlugs,groupProfileId:ctx.arg("--group-profile-id"),from:from!,to:to!,account:ctx.arg("--account"),party:ctx.arg("--party"),currency:ctx.arg("--currency"),cursor:ctx.arg("--cursor"),limit})},"report-analytics"); }
    catch(error){ctx.emitResult({ok:false,errors:[error instanceof Error?error.message:String(error)]},"report-analytics");}
  });
  dispatch.on("report", "trial-balance", (ctx) => {
    const from = ctx.arg("--from");
    const to = ctx.arg("--to");
    if (!from || !to) {
      console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildTrialBalance(db, from, to);
    emitHumanReport("report-trial-balance", result as unknown as Record<string, unknown>, ctx.outputFormat);
    db.close();
  });

  dispatch.on("report", "profit-loss", (ctx) => {
    const from = ctx.arg("--from");
    const to = ctx.arg("--to");
    if (!from || !to) {
      console.error("Missing required --from <YYYY-MM-DD> or --to <YYYY-MM-DD>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildProfitAndLoss(db, from, to);
    emitHumanReport("report-profit-loss", result as unknown as Record<string, unknown>, ctx.outputFormat);
    db.close();
  });

  dispatch.on("report", "balance", (ctx) => {
    const asOf = ctx.arg("--as-of");
    if (!asOf) {
      console.error("Missing required --as-of <YYYY-MM-DD>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildBalanceSheet(db, asOf);
    emitHumanReport("report-balance", result as unknown as Record<string, unknown>, ctx.outputFormat);
    db.close();
  });
}
