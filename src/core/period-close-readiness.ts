/** Immutable, hash-bound evidence for a deliberate accounting-period close. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { verifyAuditChain } from "./ledger";
import { verifyAuditLogIntegrity } from "./audit-log";
import { buildTrialBalance } from "./financial-statements";
import { buildVatReport } from "./vat";

export type CloseReadinessItem = { code: string; severity: "blocker" | "warning"; count: number; amount: number; evidence: readonly Record<string, unknown>[] };
export type CloseReadinessPacket = { version: 2; periodStart: string; periodEnd: string; cutoff: string; identities: Record<string, unknown>; controlsRun: readonly string[]; items: CloseReadinessItem[]; blockers: number; warnings: number; hash: string };

function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`; return JSON.stringify(value); }
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function table(db: Database, name: string): boolean { return db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name) !== null; }
function columns(db: Database, name: string): Set<string> { return new Set((db.query(`PRAGMA table_info(${name})`).all() as Array<{name:string}>).map(x => x.name)); }
function item(code: string, severity: "blocker" | "warning", evidence: Array<Record<string, unknown>>, amount = 0): CloseReadinessItem | null { return evidence.length ? { code, severity, count: evidence.length, amount, evidence } : null; }
function requireSchema(db: Database): void { if (!table(db, "period_close_readiness_packets") || !table(db, "period_close_decisions")) throw new Error("period close readiness schema migration is required; run migrate first"); }

/** Runs only controls this ledger supports and names every one it actually ran. */
export function createPeriodCloseReadinessPacket(db: Database, input: { periodStart: string; periodEnd: string; cutoff?: string }): CloseReadinessPacket {
  requireSchema(db);
  const cutoff = input.cutoff ?? input.periodEnd;
  const controlsRun: string[] = ["ledger_audit_chain", "audit_log_integrity", "trial_balance", "vat_report", "sqlite_integrity"];
  const bank = table(db, "bank_transactions") && table(db, "bank_journal_reconciliations") ? db.query(`SELECT bt.id,bt.transaction_date,bt.amount,bt.currency FROM bank_transactions bt LEFT JOIN bank_journal_reconciliations br ON br.bank_transaction_id=bt.id WHERE br.journal_entry_id IS NULL AND bt.transaction_date BETWEEN ? AND ? ORDER BY bt.transaction_date,bt.id`).all(input.periodStart, cutoff) as Array<Record<string, unknown>> : [];
  if (table(db, "bank_transactions") && table(db, "bank_journal_reconciliations")) controlsRun.push("bank_reconciliation");
  const exceptions = table(db, "exceptions") ? db.query(`SELECT id,type,severity FROM exceptions WHERE status='open' AND severity IN ('high','medium') ORDER BY id`).all() as Array<Record<string, unknown>> : [];
  if (table(db, "exceptions")) controlsRun.push("open_exceptions");
  const batches = table(db, "bookkeeping_batch_final_checks") ? db.query("SELECT run_id,check_name,detail_json FROM bookkeeping_batch_final_checks WHERE ok=0 ORDER BY run_id,check_name,id").all() as Array<Record<string, unknown>> : [];
  if (table(db, "bookkeeping_batch_final_checks")) controlsRun.push("batch_final_checks");
  const docCols = table(db, "documents") ? columns(db, "documents") : new Set<string>();
  const documents = docCols.has("status") ? db.query("SELECT id,status,invoice_date FROM documents WHERE status IN ('pending','failed','needs_review') AND invoice_date BETWEEN ? AND ? ORDER BY id").all(input.periodStart, cutoff) as Array<Record<string, unknown>> : [];
  if (docCols.has("status")) controlsRun.push("outstanding_documents");
  const payableCols = table(db, "payables") ? columns(db, "payables") : new Set<string>();
  const payables = payableCols.has("status") && payableCols.has("due_date") ? db.query("SELECT id,status,due_date,amount FROM payables WHERE status NOT IN ('paid','cancelled') AND due_date <= ? ORDER BY id").all(cutoff) as Array<Record<string, unknown>> : [];
  if (payableCols.has("status") && payableCols.has("due_date")) controlsRun.push("outstanding_payables");
  const invoiceCols = table(db, "invoices") ? columns(db, "invoices") : new Set<string>();
  const receivables = invoiceCols.has("status") && invoiceCols.has("due_date") ? db.query("SELECT id,status,due_date,total_amount FROM invoices WHERE status NOT IN ('paid','void','draft') AND due_date <= ? ORDER BY id").all(cutoff) as Array<Record<string, unknown>> : [];
  if (invoiceCols.has("status") && invoiceCols.has("due_date")) controlsRun.push("outstanding_receivables");
  const ledgerAudit = verifyAuditChain(db); const auditLog = verifyAuditLogIntegrity(db, { journalCrossCheck: false }); const balance = buildTrialBalance(db, input.periodStart, cutoff); const vat = buildVatReport(db, input.periodStart, cutoff);
  const integrity = db.query("PRAGMA integrity_check").all() as Array<{integrity_check?:string}>;
  const items = [item("BANK_UNRECONCILED", "blocker", bank, bank.reduce((n, r) => n + Math.abs(Number(r.amount ?? 0)), 0)), item("EXCEPTIONS_OPEN", "blocker", exceptions), item("BATCH_FINAL_CHECK_FAILED", "blocker", batches), item("DOCUMENT_OUTSTANDING", "warning", documents), item("PAYABLE_OUTSTANDING", "warning", payables), item("RECEIVABLE_OUTSTANDING", "warning", receivables), !ledgerAudit.ok ? { code: "LEDGER_AUDIT_CHAIN_INVALID", severity: "blocker" as const, count: ledgerAudit.errors.length, amount: 0, evidence: ledgerAudit.errors.map(error => ({error})) } : null, !auditLog.ok ? { code: "AUDIT_CHAIN_INVALID", severity: "blocker" as const, count: auditLog.errors.length, amount: 0, evidence: auditLog.errors.map(error => ({error})) } : null, !balance.ok || !balance.balanced ? { code: "TRIAL_BALANCE_UNBALANCED", severity: "blocker" as const, count: 1, amount: 0, evidence: [{ok:balance.ok, balanced:balance.balanced}] } : null, !vat.ok ? { code: "VAT_INVALID", severity: "blocker" as const, count: vat.errors.length || 1, amount: 0, evidence: vat.errors.map(error => ({error})) } : null, integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" ? { code: "SQLITE_INTEGRITY_INVALID", severity: "blocker" as const, count: integrity.length, amount: 0, evidence: integrity.map(row => ({result: row.integrity_check ?? null})) } : null].filter((x): x is CloseReadinessItem => x !== null).sort((a,b) => a.code.localeCompare(b.code));
  const identities = { ledgerHead: (db.query("SELECT entry_hash FROM journal_entries ORDER BY id DESC LIMIT 1").get() as {entry_hash?:string}|null)?.entry_hash ?? "GENESIS", auditRows: (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as {n:number}).n, sqliteSchema: (db.query("PRAGMA schema_version").get() as {schema_version:number}).schema_version, migrations: (db.query("SELECT group_concat(id || ':' || checksum, ',') AS v FROM (SELECT id,checksum FROM schema_migrations ORDER BY id)").get() as {v:string|null}).v ?? "" };
  const body = { version: 2 as const, periodStart: input.periodStart, periodEnd: input.periodEnd, cutoff, identities, controlsRun: controlsRun.sort(), items, blockers: items.filter(x => x.severity === "blocker").length, warnings: items.filter(x => x.severity === "warning").length };
  const packet = {...body, hash: digest(body)}; db.query("INSERT OR IGNORE INTO period_close_readiness_packets(packet_hash,period_start,period_end,cutoff,packet_json) VALUES(?,?,?,?,?)").run(packet.hash,input.periodStart,input.periodEnd,cutoff,canonical(packet)); return packet;
}

export function recordPeriodCloseDecision(db: Database, input: {periodId:number; packet:CloseReadinessPacket; decision:"closed"|"forced_closed"|"reopened"; actor:string; reason?:string; supersedesDecisionId?:number}): number { requireSchema(db); return (db.query("INSERT INTO period_close_decisions(period_id,packet_hash,decision,actor,reason,supersedes_decision_id) VALUES(?,?,?,?,?,?) RETURNING id").get(input.periodId,input.packet.hash,input.decision,input.actor,input.reason?.trim() || null,input.supersedesDecisionId ?? null) as {id:number}).id; }
export function recordForcedPeriodCloseOpenItems(db: Database, periodId: number, decisionId: number, packet: CloseReadinessPacket, reason: string, actor: string): void { for (const open of packet.items) db.query("INSERT INTO period_close_open_items(decision_id,period_id,packet_hash,code,severity,count,amount,evidence_json,reason,actor) VALUES(?,?,?,?,?,?,?,?,?,?)").run(decisionId,periodId,packet.hash,open.code,open.severity,open.count,open.amount,canonical(open.evidence),reason,actor); }
export function latestPeriodCloseDecision(db: Database, periodId: number): number | undefined { const row = db.query("SELECT id FROM period_close_decisions WHERE period_id=? ORDER BY id DESC LIMIT 1").get(periodId) as {id:number}|null; return row?.id; }
export function listPeriodCloseOpenItems(db: Database, periodId: number) { requireSchema(db); return db.query("SELECT id,decision_id,packet_hash,code,severity,count,amount,evidence_json,reason,actor,created_at FROM period_close_open_items WHERE period_id=? ORDER BY id").all(periodId); }
