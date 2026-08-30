// Budget + liquidity-forecast CLI commands.
//
// `budget set|list|vs-actual` wraps src/core/budget.ts; `budget forecast`
// wraps src/core/liquidity-forecast.ts. All are thin CLI shells over the
// deterministic core — the JSON envelope is the contract, the human render is
// a convenience.

import { openDb, migrate } from "../core/db";
import { companyPaths } from "../core/paths";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";
import { formatKronerDa } from "../core/money";
import { setBudget, listBudget, buildBudgetVsActual } from "../core/budget";
import { buildLiquidityForecast, buildThirteenWeekLiquidityForecast } from "../core/liquidity-forecast";
import { buildWorkspaceThirteenWeekLiquidityForecast } from "../core/intercompany-liquidity";
import { openLedgerReadOnly } from "../core/ledger-inspection";
import { resolveConfiguredWorkspaceRoot, listWorkspaceCompanies, companyRootForSlug } from "../core/workspace";
import { openWorkspaceControlReadOnlyDb, workspaceControlPaths } from "../core/workspace-control";
import { existsSync } from "node:fs";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("budget", "set", (ctx) => {
    const accountNo = ctx.arg("--account");
    const period = ctx.arg("--period");
    const amountText = ctx.arg("--amount");
    if (!accountNo || !period || amountText === undefined) {
      console.error("Missing required --account <kontonr> --period <YYYY-MM> --amount <kroner>");
      process.exit(2);
    }
    const amount = Number(amountText);
    if (Number.isNaN(amount)) {
      console.error("--amount must be numeric");
      process.exit(2);
    }
    const root = ctx.companyRoot();
    const db = openDb(companyPaths(root).db);
    migrate(db);
    const result = setBudget(db, {
      accountNo,
      period,
      amount,
      notes: ctx.arg("--notes"),
    });
    ctx.emitResult(result as unknown as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });

  dispatch.on("budget", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const result = listBudget(db, {
      period: ctx.arg("--period"),
      accountNo: ctx.arg("--account"),
    });
    if (ctx.outputFormat === "json") {
      ctx.emitResult(result as unknown as Record<string, unknown>);
    } else if (!result.ok) {
      console.error(result.errors.join("\n"));
      db.close();
      process.exit(1);
    } else {
      console.log(`Budget (${result.count})`);
      if (result.count === 0) {
        console.log("Ingen budgetlinjer.");
      } else {
        console.table(
          result.rows.map((row) => ({
            periode: row.period,
            konto: row.accountNo,
            navn: row.accountName ?? "—",
            budget: formatKronerDa(row.amount),
          })),
        );
      }
    }
    db.close();
  });

  dispatch.on("budget", "vs-actual", (ctx) => {
    const from = ctx.arg("--from");
    const to = ctx.arg("--to");
    if (!from || !to) {
      console.error("Missing required --from <YYYY-MM> or --to <YYYY-MM>");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildBudgetVsActual(db, from, to);
    if (ctx.outputFormat === "json") {
      ctx.emitResult(result as unknown as Record<string, unknown>);
    } else if (!result.ok) {
      console.error(result.errors.join("\n"));
      db.close();
      process.exit(1);
    } else {
      console.log(`Budget vs. faktisk ${result.periodStart} – ${result.periodEnd}`);
      if (result.lines.length === 0) {
        console.log("Ingen budgetlinjer eller posteringer i perioden.");
      } else {
        console.table(
          result.lines.map((line) => ({
            periode: line.period,
            konto: line.accountNo,
            navn: line.accountName ?? "—",
            budget: formatKronerDa(line.budget),
            faktisk: formatKronerDa(line.actual),
            afvigelse: formatKronerDa(line.variance),
          })),
        );
        console.log(
          `I alt — budget: ${formatKronerDa(result.totalBudget)}, ` +
            `faktisk: ${formatKronerDa(result.totalActual)}`,
        );
      }
    }
    db.close();
  });

  dispatch.on("budget", "forecast", (ctx) => {
    const startDate = ctx.arg("--start");
    const monthsText = ctx.arg("--months");
    if (!startDate || monthsText === undefined) {
      console.error("Missing required --start <YYYY-MM-DD> or --months <n>");
      process.exit(2);
    }
    const months = Number(monthsText);
    if (Number.isNaN(months)) {
      console.error("--months must be numeric");
      process.exit(2);
    }
    const db = openCommandDb(ctx);
    migrate(db);
    const result = buildLiquidityForecast(db, { startDate, months });
    if (ctx.outputFormat === "json") {
      ctx.emitResult(result as unknown as Record<string, unknown>);
    } else if (!result.ok) {
      console.error(result.errors.join("\n"));
      db.close();
      process.exit(1);
    } else {
      console.log(
        `Likviditetsprognose fra ${result.startDate} (${result.months} måneder)`,
      );
      console.log(`Primosaldo: ${formatKronerDa(result.openingBalance)}`);
      console.table(
        result.periods.map((p) => ({
          periode: p.period,
          primo: formatKronerDa(p.openingBalance),
          fakturaer: formatKronerDa(p.invoiceInflow),
          gentagne: formatKronerDa(p.recurringInflow),
          budgetomkostninger: formatKronerDa(p.budgetedCostOutflow),
          ultimo: formatKronerDa(p.closingBalance),
        })),
      );
      console.log(`Ultimosaldo: ${formatKronerDa(result.closingBalance)}`);
    }
    db.close();
  });

  dispatch.on("budget", "forecast-13-week", (ctx) => {
    const startDate = ctx.arg("--start");
    const weeksText = ctx.arg("--weeks");
    if (!startDate) {
      console.error("Missing required --start <YYYY-MM-DD>");
      process.exit(2);
    }
    const weeks = weeksText === undefined ? undefined : Number(weeksText);
    if (weeksText !== undefined && (!Number.isInteger(weeks) || weeks! < 1 || weeks! > 13)) {
      console.error("--weeks must be an integer from 1 to 13");
      process.exit(2);
    }
    // This command is deliberately read-only: unlike older CLI reads it does
    // not run migrations before opening the ledger.
    const root = ctx.companyRoot();
    const db = openLedgerReadOnly(companyPaths(root).db);
    try {
      const workspace = resolveConfiguredWorkspaceRoot();
      const entry = workspace
        ? listWorkspaceCompanies(workspace).find((item) => item.slug === ctx.arg("--company") || companyRootForSlug(workspace, item.slug) === root)
        : undefined;
      const result = workspace && entry
        ? (() => { const control = existsSync(workspaceControlPaths(workspace).db) ? openWorkspaceControlReadOnlyDb(workspace) : null; try { return buildWorkspaceThirteenWeekLiquidityForecast(control, db, entry.slug, startDate, weeks); } finally { control?.close(); } })()
        : buildThirteenWeekLiquidityForecast(db, { startDate, weeks });
      if (ctx.outputFormat === "json") ctx.emitResult(result as unknown as Record<string, unknown>);
      else if (!result.ok) { console.error(result.errors.join("\n")); process.exitCode = 1; }
      else {
        console.log(`13 ugers likviditetsprognose fra ${result.startDate}`);
        console.table(result.periods.map((period) => ({
          uge: period.weekStart,
          baseUltimo: formatKronerDa(period.closingCash),
          scenarioUltimo: formatKronerDa(period.scenarioClosingCash),
          udateretBudget: formatKronerDa(period.undatedBudgetAssumptions),
        })));
      }
    } finally { db.close(); }
  });
}
