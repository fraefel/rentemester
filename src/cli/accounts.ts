import { migrate } from "../core/db";
import { openCommandDb } from "../cli-dispatch";
import type { CommandDispatch } from "../cli-dispatch";
import { accountRoleStatus, resolveAccountRole, ACCOUNT_ROLES } from "../core/account-roles";

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
  dispatch.on("accounts", "roles-status", (ctx) => {
    const db = openCommandDb(ctx);
    migrate(db);
    const status = accountRoleStatus(db);
    const roles = ACCOUNT_ROLES.map((role) => resolveAccountRole(db, role));
    console.log(JSON.stringify({ ok: true, ...status, roles }, null, 2));
    db.close();
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
