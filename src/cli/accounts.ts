import { migrate } from "../core/db";
import { createAccount } from "../core/chart-of-accounts";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("accounts", "list", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const rows = db
      .query("SELECT account_no, name, type, default_vat_code FROM accounts ORDER BY account_no")
      .all() as Array<Record<string, unknown>>;
    // `docs/cli-contract.md` promises every result is available as JSON. The
    // accounts list used to always print a console.table, ignoring --json /
    // --format json — so an agent could not parse the chart of accounts. (#231)
    if (ctx.outputFormat === "json") {
      console.log(JSON.stringify({ ok: true, count: rows.length, rows }, null, 2));
      db.close();
      return;
    }
    // `console.table` prepends a raw 0,1,2… array-index column — developer
    // noise on an owner-facing list. Render the chart of accounts as an
    // aligned text table keyed on the account number instead. (#246)
    console.log(renderAccountsTable(rows));
    db.close();
  });

  dispatch.on("accounts", "add", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);

    const rawDirectPosting = ctx.arg("--allow-direct-posting");
    let allowDirectPosting: boolean | undefined;
    if (rawDirectPosting != null) {
      const lower = rawDirectPosting.toLowerCase();
      if (lower === "true") allowDirectPosting = true;
      else if (lower === "false") allowDirectPosting = false;
      else {
        ctx.emitResult({
          ok: false,
          errors: [
            `--allow-direct-posting must be 'true' or 'false' (got '${rawDirectPosting}')`,
          ],
        });
        db.close();
        process.exit(1);
      }
    }

    const result = createAccount(db, {
      accountNo: ctx.arg("--account-no") ?? "",
      name: ctx.arg("--name") ?? "",
      type: ctx.arg("--type") ?? "",
      normalBalance: ctx.arg("--normal-balance"),
      defaultVatCode: ctx.arg("--default-vat-code"),
      allowDirectPosting,
    });
    ctx.emitResult(result as Record<string, unknown>);
    db.close();
    if (!result.ok) process.exit(1);
  });
}

/** Render the chart of accounts as a Danish aligned text table, no index column. (#246) */
function renderAccountsTable(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "Ingen konti i kontoplanen.";
  const cell = (value: unknown): string =>
    value == null || value === "" ? "—" : String(value);
  const headers = ["Kontonr.", "Navn", "Type", "Moms-kode"];
  const body = rows.map((row) => [
    cell(row.account_no),
    cell(row.name),
    cell(row.type),
    cell(row.default_vat_code),
  ]);
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...body.map((line) => line[col]!.length)),
  );
  const formatLine = (cells: string[]): string =>
    cells.map((value, col) => value.padEnd(widths[col]!)).join("  ").trimEnd();
  const lines = [
    `Kontoplan (${rows.length} ${rows.length === 1 ? "konto" : "konti"})`,
    "",
    formatLine(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...body.map(formatLine),
  ];
  return lines.join("\n");
}
