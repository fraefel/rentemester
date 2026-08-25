import { verifyAuditChain } from "../core/ledger";
import { inspectOpenLedger, openLedgerReadOnly } from "../core/ledger-inspection";
import { companyPaths } from "../core/paths";
import type { CommandDispatch } from "../cli-dispatch";
import type { Database } from "bun:sqlite";

export function register(dispatch: CommandDispatch): void {
  dispatch.on("audit", "verify", (ctx) => {
    let db: Database | undefined;
    try {
      db = openLedgerReadOnly(companyPaths(ctx.companyRoot()).db);
      const schema = inspectOpenLedger(db);
      if (schema.status !== "current") ctx.emitResult({ ok: false, errors: [schema.status === "pending" ? `schema_outdated: current=${schema.currentVersion} required=${schema.requiredVersion}` : schema.error], schema });
      else ctx.emitResult(verifyAuditChain(db) as Record<string, unknown>);
    } catch (error) {
      ctx.emitResult({ ok: false, errors: [error instanceof Error ? error.message : String(error)] });
    } finally { db?.close(); }
  });
}
