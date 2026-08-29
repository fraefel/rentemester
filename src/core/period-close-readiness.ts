/** Deterministic, immutable evidence used to decide whether a period may close. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { verifyAuditChain } from "./ledger";
import { verifyAuditLogIntegrity } from "./audit-log";
import { buildTrialBalance } from "./financial-statements";
import { buildVatReport } from "./vat";

export type CloseReadinessItem = { code: string; severity: "blocker" | "warning"; count: number; amount: number; evidence: readonly Record<string, unknown>[] };
export type CloseReadinessPacket = { version: 1; periodStart: string; periodEnd: string; cutoff: string; identities: Record<string, unknown>; items: CloseReadinessItem[]; blockers: number; warnings: number; hash: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function hasTable(db: Database, name: string) { return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) != null; }
function item(code: string, severity: "blocker" | "warning", rows: Array<Record<string, unknown>>, amount = 0): CloseReadinessItem | null { return rows.length ? { code, severity, count: rows.length, amount, evidence: rows } : null; }

export function ensurePeriodCloseReadinessSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS period_close_readiness_packets (
    id INTEGER PRIMARY KEY, packet_hash TEXT NOT NULL UNIQUE CHECK(length(packet_hash)=64), period_start TEXT NOT NULL, period_end TEXT NOT NULL, cutoff TEXT NOT NULL,
    packet_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS period_close_open_items (
    id INTEGER PRIMARY KEY, period_id INTEGER NOT NULL REFERENCES accounting_periods(id), packet_hash TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL,
    count INTEGER NOT NULL, amount NUMERIC NOT NULL, evidence_json TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status='open'), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TRIGGER IF NOT EXISTS period_close_readiness_packets_no_update BEFORE UPDATE ON period_close_readiness_packets BEGIN SELECT RAISE(ABORT, 'close readiness packets are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS period_close_readiness_packets_no_delete BEFORE DELETE ON period_close_readiness_packets BEGIN SELECT RAISE(ABORT, 'close readiness packets are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS period_close_open_items_no_update BEFORE UPDATE ON period_close_open_items BEGIN SELECT RAISE(ABORT, 'period close open items are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS period_close_open_items_no_delete BEFORE DELETE ON period_close_open_items BEGIN SELECT RAISE(ABORT, 'period close open items are append-only'); END;`);
}

export function createPeriodCloseReadinessPacket(db: Database, input: { periodStart: string; periodEnd: string; cutoff?: string }): CloseReadinessPacket {
  ensurePeriodCloseReadinessSchema(db);
  const cutoff = input.cutoff ?? input.periodEnd;
  const bank = db.query(`SELECT id, transaction_date, amount, currency FROM bank_transactions bt LEFT JOIN bank_journal_reconciliations br ON br.bank_transaction_id=bt.id WHERE br.journal_entry_id IS NULL AND bt.transaction_date BETWEEN ? AND ? ORDER BY bt.transaction_date,id`).all(input.periodStart, cutoff) as Array<Record<string, unknown>>;
  const exceptions = db.query(`SELECT e.id,e.type,e.severity FROM exceptions e LEFT JOIN bank_transactions bt ON bt.id=e.related_bank_transaction_id LEFT JOIN documents d ON d.id=e.related_document_id WHERE e.status='open' AND e.severity IN ('high','medium') AND ((bt.transaction_date BETWEEN ? AND ?) OR (d.invoice_date BETWEEN ? AND ?)) ORDER BY e.id`).all(input.periodStart, cutoff, input.periodStart, cutoff) as Array<Record<string, unknown>>;
  const audit = verifyAuditChain(db); const auditLog = verifyAuditLogIntegrity(db, { journalCrossCheck: false });
  const balance = buildTrialBalance(db, input.periodStart, cutoff); const vat = buildVatReport(db, input.periodStart, cutoff);
  const integrity = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  const batches = hasTable(db, "bookkeeping_batch_final_checks") ? db.query("SELECT f.run_id,f.check_name FROM bookkeeping_batch_final_checks f WHERE f.ok=0 ORDER BY f.run_id,f.check_name").all() as Array<Record<string, unknown>> : [];
  const items = [
    item("BANK_UNRECONCILED", "blocker", bank, bank.reduce((sum, row) => sum + Math.abs(Number(row.amount ?? 0)), 0)),
    item("EXCEPTIONS_OPEN", "blocker", exceptions),
    !audit.ok ? { code: "LEDGER_AUDIT_CHAIN_INVALID", severity: "blocker" as const, count: audit.errors.length, amount: 0, evidence: audit.errors.map((error) => ({ error })) } : null,
    !auditLog.ok ? { code: "AUDIT_CHAIN_INVALID", severity: "blocker" as const, count: auditLog.errors.length, amount: 0, evidence: auditLog.errors.map((error) => ({ error })) } : null,
    !balance.ok || !balance.balanced ? { code: "TRIAL_BALANCE_UNBALANCED", severity: "blocker" as const, count: 1, amount: 0, evidence: [{ ok: balance.ok, balanced: balance.balanced }] } : null,
    !vat.ok ? { code: "VAT_INVALID", severity: "blocker" as const, count: vat.errors.length || 1, amount: 0, evidence: vat.errors.map((error) => ({ error })) } : null,
    integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" ? { code: "SQLITE_INTEGRITY_INVALID", severity: "blocker" as const, count: integrity.length, amount: 0, evidence: integrity.map((row) => ({ result: row.integrity_check ?? null })) } : null,
    item("BATCH_FINAL_CHECK_FAILED", "warning", batches),
  ].filter((x): x is CloseReadinessItem => x !== null).sort((a, b) => a.code.localeCompare(b.code));
  const identities = {
    ledgerHead: (db.query("SELECT entry_hash FROM journal_entries ORDER BY id DESC LIMIT 1").get() as { entry_hash?: string } | null)?.entry_hash ?? "GENESIS",
    auditRows: (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n,
    sqliteSchema: (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version,
    migrations: (db.query("SELECT group_concat(id || ':' || checksum, ',') AS v FROM (SELECT id,checksum FROM schema_migrations ORDER BY id)").get() as { v: string | null }).v ?? "",
    bankCount: bank.length,
  };
  const body = { version: 1 as const, periodStart: input.periodStart, periodEnd: input.periodEnd, cutoff, identities, items, blockers: items.filter((x) => x.severity === "blocker").length, warnings: items.filter((x) => x.severity === "warning").length };
  const packet = { ...body, hash: digest(body) };
  db.query("INSERT OR IGNORE INTO period_close_readiness_packets(packet_hash,period_start,period_end,cutoff,packet_json) VALUES(?,?,?,?,?)").run(packet.hash, input.periodStart, input.periodEnd, cutoff, canonical(packet));
  return packet;
}

export function recordForcedPeriodCloseOpenItems(db: Database, periodId: number, packet: CloseReadinessPacket, reason: string, actor: string): void {
  for (const open of packet.items) db.query("INSERT INTO period_close_open_items(period_id,packet_hash,code,severity,count,amount,evidence_json,reason,actor) VALUES(?,?,?,?,?,?,?,?,?)").run(periodId, packet.hash, open.code, open.severity, open.count, open.amount, canonical(open.evidence), reason, actor);
}

export function listPeriodCloseOpenItems(db: Database, periodId: number) { ensurePeriodCloseReadinessSchema(db); return db.query("SELECT id,packet_hash,code,severity,count,amount,evidence_json,reason,actor,created_at FROM period_close_open_items WHERE period_id=? ORDER BY id").all(periodId); }
