/** Pure period-close readiness plus explicit, append-only review evidence. */
import { createHash } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { verifyAuditChain } from "./ledger";
import { verifyAuditLogIntegrity } from "./audit-log";
import { buildTrialBalance } from "./financial-statements";
import { buildVatReport } from "./vat";
import { resolveAccountRole } from "./account-roles";

export type CloseControlStatus = "passed" | "warning" | "blocked" | "unavailable";
export type CloseReadinessItem = { code: string; status: CloseControlStatus; waivable: boolean; count: number; amount: number; evidence: readonly Record<string, unknown>[]; sourceHash: string };
export type CloseReadinessPacket = { version: 3; periodStart: string; periodEnd: string; cutoff: string; controlsRun: readonly string[]; items: readonly CloseReadinessItem[]; blockers: number; warnings: number; hash: string };
export type CloseReviewPrincipal = { kind: "user" | "service-account" | "local-trusted"; subjectId: string };
export type PeriodCloseReview = { id: number; packet: CloseReadinessPacket; reviewerActor: string; reviewerPrincipal: CloseReviewPrincipal | null; createdAt: string };

export function canonicalCloseReadiness(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalCloseReadiness).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonicalCloseReadiness((value as Record<string, unknown>)[k])}`).join(",")}}`; return JSON.stringify(value); }
export function closeReadinessDigest(value: unknown): string { return createHash("sha256").update(canonicalCloseReadiness(value)).digest("hex"); }
function exists(db: Database, name: string): boolean { return db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(name) !== null; }
function has(db: Database, name: string, column: string): boolean { return exists(db,name) && (db.query(`PRAGMA table_info(${name})`).all() as Array<{name:string}>).some(row => row.name === column); }
function rows(db: Database, sql: string, ...params: SQLQueryBindings[]): Array<Record<string, unknown>> { return db.query(sql).all(...params) as Array<Record<string, unknown>>; }
function control(code: string, status: CloseControlStatus, waivable: boolean, evidence: readonly Record<string, unknown>[], amount = 0): CloseReadinessItem { const ordered=[...evidence].sort((a,b)=>canonicalCloseReadiness(a).localeCompare(canonicalCloseReadiness(b))); return {code,status,waivable,count:ordered.length,amount,evidence:ordered,sourceHash:closeReadinessDigest(ordered)}; }
function unavailable(code: string, detail: string): CloseReadinessItem { return control(code,"unavailable",false,[{detail}]); }
function protect(code: string, run: () => CloseReadinessItem): CloseReadinessItem { try { return run(); } catch { return unavailable(code,"control execution failed"); } }
export function periodCloseReviewSchemaAvailable(db: Database): boolean { return exists(db,"period_close_readiness_packets") && exists(db,"period_close_reviews"); }

/** Read-only: no `migrate`, DDL, packet persistence, audit write or WAL write. */
export function computePeriodCloseReadiness(db: Database, input: { periodStart: string; periodEnd: string; cutoff?: string }): CloseReadinessPacket {
  const cutoff=input.cutoff ?? input.periodEnd;
  const items: CloseReadinessItem[]=[];
  // A readiness packet can be inspected against an older ledger, but it can
  // never be silently treated as closable: the review/decision evidence is a
  // mandatory v25 contract.
  if (!periodCloseReviewSchemaAvailable(db)) items.push(unavailable("PERIOD_CLOSE_REVIEW_SCHEMA","period-close review schema v25 is unavailable; migrate before review or close"));
  items.push(protect("PERIOD_LIFECYCLE",()=>{
    if (!has(db,"accounting_periods","period_start") || !has(db,"accounting_periods","period_end") || !has(db,"accounting_periods","status")) return unavailable("PERIOD_LIFECYCLE","accounting period schema unavailable");
    const all=rows(db,`SELECT p.id,p.period_start,p.period_end,p.kind,p.status,p.reference,
      (SELECT a.event_type FROM audit_log a WHERE a.entity_type='accounting_period' AND a.entity_id=CAST(p.id AS TEXT) ORDER BY a.id DESC LIMIT 1) AS lifecycle_event
      FROM accounting_periods p WHERE NOT (p.period_end < ? OR p.period_start > ?) ORDER BY p.id`,input.periodStart,cutoff);
    // A reopen is append-only: the immutable period row remains closed, while
    // its last lifecycle event makes the effective state open again.
    const evidence=all.filter(row=>row.lifecycle_event!=="period_reopen");
    return control("PERIOD_LIFECYCLE",evidence.length?"blocked":"passed",false,evidence);
  }));
  items.push(protect("BANK_UNRECONCILED",()=>{
    if (!has(db,"bank_transactions","transaction_date") || !has(db,"bank_transactions","amount") || !has(db,"bank_journal_reconciliations","bank_transaction_id") || !has(db,"bank_journal_reconciliations","journal_entry_id")) return unavailable("BANK_UNRECONCILED","required bank reconciliation schema unavailable");
    const evidence=rows(db,`SELECT bt.id,bt.transaction_date,bt.amount,bt.currency FROM bank_transactions bt LEFT JOIN bank_journal_reconciliations br ON br.bank_transaction_id=bt.id WHERE br.journal_entry_id IS NULL AND (bt.transaction_date BETWEEN ? AND ? OR bt.transaction_date IS NULL) ORDER BY bt.transaction_date,bt.id`,input.periodStart,cutoff); return control("BANK_UNRECONCILED",evidence.length?"blocked":"passed",true,evidence,evidence.reduce((n,r)=>n+Math.abs(Number(r.amount??0)),0));
  }));
  items.push(protect("EXCEPTIONS_OPEN",()=>{
    if (!has(db,"exceptions","status") || !has(db,"exceptions","severity")) return unavailable("EXCEPTIONS_OPEN","required exception schema unavailable");
    if (!has(db,"exceptions","related_bank_transaction_id") || !has(db,"exceptions","related_document_id") || !has(db,"documents","invoice_date") || !has(db,"bank_transactions","transaction_date")) return unavailable("EXCEPTIONS_OPEN","exception date scope cannot be determined");
    const evidence=rows(db,`SELECT e.id,e.type,e.severity,bt.transaction_date,d.invoice_date FROM exceptions e LEFT JOIN bank_transactions bt ON bt.id=e.related_bank_transaction_id LEFT JOIN documents d ON d.id=e.related_document_id WHERE e.status='open' AND e.severity IN ('high','medium') AND ((bt.transaction_date BETWEEN ? AND ?) OR (d.invoice_date BETWEEN ? AND ?)) ORDER BY e.id`,input.periodStart,cutoff,input.periodStart,cutoff); return control("EXCEPTIONS_OPEN",evidence.length?"blocked":"passed",true,evidence);
  }));
  items.push(protect("EXCEPTION_SCOPE_UNKNOWN",()=>{
    if (!has(db,"exceptions","status") || !has(db,"exceptions","severity") || !has(db,"exceptions","related_bank_transaction_id") || !has(db,"exceptions","related_document_id") || !has(db,"documents","invoice_date") || !has(db,"bank_transactions","transaction_date")) return unavailable("EXCEPTION_SCOPE_UNKNOWN","exception scope schema unavailable");
    const evidence=rows(db,`SELECT e.id,e.type,e.severity FROM exceptions e LEFT JOIN bank_transactions bt ON bt.id=e.related_bank_transaction_id LEFT JOIN documents d ON d.id=e.related_document_id WHERE e.status='open' AND e.severity IN ('high','medium') AND bt.transaction_date IS NULL AND d.invoice_date IS NULL ORDER BY e.id`); return control("EXCEPTION_SCOPE_UNKNOWN",evidence.length?"blocked":"passed",false,evidence);
  }));
  items.push(protect("BATCH_UNPOSTED_OR_FAILED",()=>{
    if (!has(db,"bookkeeping_batch_runs","accounting_from") || !has(db,"bookkeeping_batch_revisions","run_id") || !has(db,"bookkeeping_batch_apply_attempts_v2","revision_id") || !has(db,"bookkeeping_batch_apply_events_v2","event_type") || !has(db,"bookkeeping_batch_final_checks_v2","ok")) return unavailable("BATCH_UNPOSTED_OR_FAILED","durable batch revision/apply schema unavailable");
    const evidence=rows(db,`SELECT r.id AS run_id,rev.id AS revision_id,a.id AS attempt_id,
      (SELECT e.event_type FROM bookkeeping_batch_apply_events_v2 e WHERE e.apply_attempt_id=a.id ORDER BY e.id DESC LIMIT 1) AS final_event,
      (SELECT COUNT(*) FROM bookkeeping_batch_apply_events_v2 e WHERE e.apply_attempt_id=a.id AND e.event_type IN ('item_failed','source_stale')) AS failed_events,
      (SELECT COUNT(*) FROM bookkeeping_batch_final_checks_v2 c WHERE c.apply_attempt_id=a.id AND c.ok=0) AS failed_checks
      FROM bookkeeping_batch_runs r
      LEFT JOIN bookkeeping_batch_revisions rev ON rev.id=(SELECT r2.id FROM bookkeeping_batch_revisions r2 WHERE r2.run_id=r.id ORDER BY r2.id DESC LIMIT 1)
      LEFT JOIN bookkeeping_batch_apply_attempts_v2 a ON a.id=(SELECT a2.id FROM bookkeeping_batch_apply_attempts_v2 a2 WHERE a2.revision_id=rev.id ORDER BY a2.id DESC LIMIT 1)
      WHERE NOT (r.accounting_to < ? OR r.accounting_from > ?)
      AND (a.id IS NULL OR final_event!='completed' OR failed_events>0 OR failed_checks>0) ORDER BY r.id`,input.periodStart,cutoff); return control("BATCH_UNPOSTED_OR_FAILED",evidence.length?"blocked":"passed",true,evidence);
  }));
  items.push(protect("DOCUMENT_OUTSTANDING",()=>{
    if (!has(db,"documents","status") || !has(db,"documents","invoice_date")) return unavailable("DOCUMENT_OUTSTANDING","document status/date schema unavailable");
    const evidence=rows(db,"SELECT id,status,invoice_date FROM documents WHERE status IN ('pending','failed','needs_review') AND (invoice_date BETWEEN ? AND ? OR invoice_date IS NULL) ORDER BY id",input.periodStart,cutoff); return control("DOCUMENT_OUTSTANDING",evidence.length?"blocked":"passed",true,evidence);
  }));
  items.push(protect("PAYABLE_OUTSTANDING",()=>{
    if (!has(db,"payables","due_date") || !has(db,"payables","gross_amount") || !has(db,"payable_payments","payable_id") || !has(db,"payable_payments","amount")) return unavailable("PAYABLE_OUTSTANDING","payable/payment schema unavailable");
    const evidence=rows(db,`SELECT p.id,p.due_date,p.gross_amount,COALESCE(SUM(pp.amount),0) AS paid_amount FROM payables p LEFT JOIN payable_payments pp ON pp.payable_id=p.id AND pp.payment_date<=? WHERE p.due_date<=? GROUP BY p.id HAVING COALESCE(SUM(pp.amount),0)<p.gross_amount ORDER BY p.id`,cutoff,cutoff); return control("PAYABLE_OUTSTANDING",evidence.length?"warning":"passed",true,evidence,evidence.reduce((n,r)=>n+Math.abs(Number(r.gross_amount??0)-Number(r.paid_amount??0)),0));
  }));
  items.push(protect("RECEIVABLE_OUTSTANDING",()=>{
    // This ledger has no canonical issued-invoice balance model. Record that
    // explicit product boundary rather than inventing receivables from uploads.
    if (!exists(db,"invoices")) return unavailable("RECEIVABLE_OUTSTANDING","canonical receivable subledger is not available");
    if (!has(db,"documents","due_date") || !has(db,"documents","total_amount") || !has(db,"documents","document_type")) return unavailable("RECEIVABLE_OUTSTANDING","receivable document schema unavailable");
    const evidence=rows(db,"SELECT id,due_date,total_amount FROM documents WHERE document_type='invoice' AND due_date<=? ORDER BY id",cutoff); return control("RECEIVABLE_OUTSTANDING",evidence.length?"warning":"passed",true,evidence,evidence.reduce((n,r)=>n+Math.abs(Number(r.total_amount??0)),0));
  }));
  items.push(protect("DKK_CONTROL_ACCOUNTS",()=>{
    // A control-account assertion is meaningful only for explicitly confirmed
    // semantic roles.  Never infer an account number from its name.
    const bank=resolveAccountRole(db,"bank"), debtors=resolveAccountRole(db,"debtors"), creditors=resolveAccountRole(db,"creditors");
    if(!bank.ok || !debtors.ok || !creditors.ok) return unavailable("DKK_CONTROL_ACCOUNTS",[bank,debtors,creditors].filter(role=>!role.ok).map(role=>!role.ok?role.error:"").join("; "));
    if(!has(db,"journal_lines","account_id")||!has(db,"journal_entries","transaction_date")||!has(db,"accounts","account_no")) return unavailable("DKK_CONTROL_ACCOUNTS","journal control-account schema unavailable");
    const accounts=[bank.accountNo,debtors.accountNo,creditors.accountNo];
    const evidence=rows(db,`SELECT a.account_no, ROUND(SUM(jl.debit_amount-jl.credit_amount),2) AS balance_dkk
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN accounts a ON a.id=jl.account_id
      WHERE a.account_no IN (?,?,?) AND je.transaction_date<=?
      GROUP BY a.account_no ORDER BY a.account_no`,accounts[0],accounts[1],accounts[2],cutoff);
    // Ledger balances alone are not a reconciliation.  Do not turn a missing
    // debtor/creditor subledger comparison into a green control.
    return unavailable("DKK_CONTROL_ACCOUNTS",`ledger-only balances available for ${evidence.length} control account(s); independent DKK reconciliation is unavailable`);
  }));
  items.push(protect("LEDGER_AUDIT_CHAIN",()=>{const r=verifyAuditChain(db);return control("LEDGER_AUDIT_CHAIN",r.ok?"passed":"blocked",false,r.errors.map(error=>({error})));}));
  items.push(protect("AUDIT_LOG_INTEGRITY",()=>{const r=verifyAuditLogIntegrity(db,{journalCrossCheck:false});return control("AUDIT_LOG_INTEGRITY",r.ok?"passed":"blocked",false,r.errors.map(error=>({error})));}));
  items.push(protect("TRIAL_BALANCE",()=>{const r=buildTrialBalance(db,input.periodStart,cutoff);return control("TRIAL_BALANCE",r.ok&&r.balanced?"passed":"blocked",false,r.ok&&r.balanced?[]:[{ok:r.ok,balanced:r.balanced}]);}));
  items.push(protect("VAT_PREFLIGHT",()=>{const r=buildVatReport(db,input.periodStart,cutoff);return control("VAT_PREFLIGHT",r.ok?"passed":"blocked",false,[...r.errors.map(error=>({error})),{filingReceipt:"not-modelled; this is a calculation/preflight, not evidence of submission"}]);}));
  items.push(protect("SQLITE_INTEGRITY",()=>{const result=db.query("PRAGMA integrity_check").all() as Array<{integrity_check?:string}>;const ok=result.length===1&&result[0]?.integrity_check==="ok";return control("SQLITE_INTEGRITY",ok?"passed":"blocked",false,ok?[]:result.map(row=>({result:row.integrity_check??null})));}));
  const sorted=items.sort((a,b)=>a.code.localeCompare(b.code));
  const body={version:3 as const,periodStart:input.periodStart,periodEnd:input.periodEnd,cutoff,controlsRun:sorted.map(item=>item.code),items:sorted,blockers:sorted.filter(item=>item.status==="blocked"||item.status==="unavailable").length,warnings:sorted.filter(item=>item.status==="warning").length};
  return {...body,hash:closeReadinessDigest(body)};
}
export const createPeriodCloseReadinessPacket=computePeriodCloseReadiness;
function assertReviewSchema(db:Database):void { if(!periodCloseReviewSchemaAvailable(db)) throw new Error("period close review schema migration is required; run migrate first"); }
function principalJson(principal:CloseReviewPrincipal|undefined|null):string|null { if(!principal)return null;if(!principal.subjectId.trim())throw new Error("reviewer principal subject is required");return canonicalCloseReadiness(principal); }
function parsePrincipal(raw:string|null):CloseReviewPrincipal|null { if(!raw)return null;const v=JSON.parse(raw) as CloseReviewPrincipal;if(!["user","service-account","local-trusted"].includes(v.kind)||!v.subjectId)return null;return v; }
export function reviewPeriodCloseReadiness(db:Database,input:{packet:CloseReadinessPacket;reviewerActor:string;reviewerPrincipal?:CloseReviewPrincipal|null}):PeriodCloseReview { assertReviewSchema(db);const actor=input.reviewerActor.trim();if(!actor)throw new Error("reviewer actor is required");db.query("INSERT OR IGNORE INTO period_close_readiness_packets(packet_hash,period_start,period_end,cutoff,packet_json) VALUES(?,?,?,?,?)").run(input.packet.hash,input.packet.periodStart,input.packet.periodEnd,input.packet.cutoff,canonicalCloseReadiness(input.packet));const p=db.query("SELECT id FROM period_close_readiness_packets WHERE packet_hash=?").get(input.packet.hash) as {id:number};const row=db.query("INSERT INTO period_close_reviews(packet_id,packet_hash,reviewer_actor,reviewer_principal) VALUES(?,?,?,?) RETURNING id,created_at").get(p.id,input.packet.hash,actor,principalJson(input.reviewerPrincipal)) as {id:number;created_at:string};return{id:row.id,packet:input.packet,reviewerActor:actor,reviewerPrincipal:input.reviewerPrincipal??null,createdAt:row.created_at}; }
export function loadPeriodCloseReview(db:Database,id:number):PeriodCloseReview|null { if(!exists(db,"period_close_reviews"))return null;const row=db.query("SELECT r.id,r.reviewer_actor,r.reviewer_principal,r.created_at,p.packet_json FROM period_close_reviews r JOIN period_close_readiness_packets p ON p.id=r.packet_id WHERE r.id=?").get(id) as {id:number;reviewer_actor:string;reviewer_principal:string|null;created_at:string;packet_json:string}|null;return row?{id:row.id,packet:JSON.parse(row.packet_json) as CloseReadinessPacket,reviewerActor:row.reviewer_actor,reviewerPrincipal:parsePrincipal(row.reviewer_principal),createdAt:row.created_at}:null; }
export function recordPeriodCloseDecision(db:Database,input:{periodId:number;packet:CloseReadinessPacket;decision:"closed"|"forced_closed"|"reopened";actor:string;reason?:string;supersedesDecisionId?:number}):number{return(db.query("INSERT INTO period_close_decisions(period_id,packet_hash,decision,actor,reason,supersedes_decision_id) VALUES(?,?,?,?,?,?) RETURNING id").get(input.periodId,input.packet.hash,input.decision,input.actor,input.reason?.trim()||null,input.supersedesDecisionId??null)as{id:number}).id;}
export function recordForcedPeriodCloseOpenItems(db:Database,periodId:number,decisionId:number,packet:CloseReadinessPacket,reason:string,actor:string):void{for(const open of packet.items.filter(item=>item.waivable&&item.status==="blocked"))db.query("INSERT INTO period_close_open_items(decision_id,period_id,packet_hash,code,severity,count,amount,evidence_json,reason,actor) VALUES(?,?,?,?,?,?,?,?,?,?)").run(decisionId,periodId,packet.hash,open.code,"blocker",open.count,open.amount,canonicalCloseReadiness(open.evidence),reason,actor);}
export function latestPeriodCloseDecision(db:Database,periodId:number):number|undefined{return(db.query("SELECT id FROM period_close_decisions WHERE period_id=? ORDER BY id DESC LIMIT 1").get(periodId)as{id:number}|null)?.id;}
export function listPeriodCloseOpenItems(db:Database,periodId:number){return db.query("SELECT id,decision_id,packet_hash,code,severity,count,amount,evidence_json,reason,actor,created_at FROM period_close_open_items WHERE period_id=? ORDER BY id").all(periodId);}
