import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { suggestBankMatches } from "./bank-suggest-matches";
import { applyPostingRuleEvaluationInCurrentTransaction, evaluatePostingRules, type PostingRuleContext } from "./posting-rules";
import { applyStoredPurchaseVatPreflightInCurrentTransaction, inspectPurchaseVatPreflight } from "./purchase-vat-preflight";
import { bookExpenseFromBankInCurrentTransaction } from "./expense-booking";
import { verifyAuditChain } from "./ledger";
import { buildTrialBalance } from "./financial-statements";
import { buildBankReconciliationReport } from "./reconciliation";
import { buildVatReport } from "./vat";

export type BookkeepingBatchPartition = "ready" | "suggestedMatch" | "missingDocument" | "humanDecision";
export type BookkeepingBatchItem = { actionKey: string; evidenceHash: string; partition: BookkeepingBatchPartition; documentId?: number; bankTransactionId?: number; ruleApplication?: { ruleVersionId: number; payloadHash: string }; detail: Record<string, unknown> };
export type BookkeepingBatchPlan = { companyId: number; accountingFrom: string; accountingTo: string; bankFrom: string; bankTo: string; items: BookkeepingBatchItem[]; sourceIdentities: Record<string, unknown>; planHash: string };
export type BatchActor = { actor: string };
export type FinalCheckName = "audit_chain" | "trial_balance" | "reconciliation" | "vat";
export type FinalCheckDetail = Record<string, unknown> | { ok: boolean };

const date = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`; return JSON.stringify(value); }
function hash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function validActor(actor: string | undefined): actor is string { return typeof actor === "string" && /^(user|agent|system):[^\s]+$/.test(actor); }
function selectedCompanyId(db: Database): number { const rows = db.query("SELECT id FROM companies ORDER BY id").all() as Array<{ id: number }>; if (rows.length !== 1) throw new Error("selected ledger must contain exactly one company"); return rows[0]!.id; }
function scope(db: Database, input: { companyId?: number; accountingFrom: string; accountingTo: string; bankFrom: string; bankTo: string }) { const companyId = selectedCompanyId(db); if (input.companyId !== undefined && input.companyId !== companyId) throw new Error("company identity is derived from the selected ledger"); const result = { companyId, accountingFrom: input.accountingFrom, accountingTo: input.accountingTo, bankFrom: input.bankFrom, bankTo: input.bankTo }; if (![result.accountingFrom, result.accountingTo, result.bankFrom, result.bankTo].every(date) || result.accountingFrom > result.accountingTo || result.bankFrom > result.bankTo) throw new Error("ordered explicit ISO accounting and bank date ranges are required"); return result; }

type PurchaseEvidence = { document: { id: number; invoice_date: string | null; sender_name: string | null; sender_vat_cvr: string | null; supplier_country_code: string | null; document_type: string; currency: string; amount_inc_vat: number | null; vat_amount: number | null; sha256_hash: string | null }; bank: { id: number; transaction_date: string; amount: number; currency: string; transaction_hash: string | null; text: string }; context: PostingRuleContext };
/** Canonical loader shared by planning, stale detection, and real application. */
function loadPurchaseEvidence(db: Database, companyId: number, documentId: number, bankTransactionId: number): PurchaseEvidence | null {
  const document = db.query("SELECT id,invoice_date,sender_name,sender_vat_cvr,supplier_country_code,document_type,currency,amount_inc_vat,vat_amount,sha256_hash FROM documents WHERE id=?").get(documentId) as PurchaseEvidence["document"] | null;
  const bank = db.query("SELECT id,transaction_date,amount,currency,transaction_hash,text FROM bank_transactions WHERE id=?").get(bankTransactionId) as PurchaseEvidence["bank"] | null;
  if (!document || !bank) return null;
  return { document, bank, context: { company: companyId, documentId, supplierIdentity: document.sender_name ?? undefined, supplierCountry: document.supplier_country_code ?? undefined, supplierVat: document.sender_vat_cvr ?? undefined, documentType: document.document_type, currency: document.currency, amount: Number(document.amount_inc_vat ?? 0), vatAmount: Number(document.vat_amount ?? 0) } };
}
function evidenceHash(evidence: PurchaseEvidence) { return hash({ document: evidence.document, bank: evidence.bank }); }
function sourceIdentities(db: Database, plan: Omit<BookkeepingBatchPlan, "sourceIdentities" | "planHash">) {
  const ready = plan.items.filter((item) => item.partition === "ready").map((item) => {
    const evidence = item.documentId && item.bankTransactionId ? loadPurchaseEvidence(db, plan.companyId, item.documentId, item.bankTransactionId) : null;
    const rule = evidence ? evaluatePostingRules(db, evidence.context, { at: evidence.document.invoice_date ?? plan.accountingTo }) : null;
    const vat = item.documentId ? inspectPurchaseVatPreflight(db, item.documentId) : null;
    const reconciliation = item.bankTransactionId ? db.query("SELECT bank_transaction_id FROM bank_journal_reconciliations WHERE bank_transaction_id=? LIMIT 1").get(item.bankTransactionId) : null;
    return { actionKey: item.actionKey, evidenceHash: evidence ? evidenceHash(evidence) : null, reconciliation: reconciliation ? "reconciled" : "unreconciled", rule: rule?.decision === "proposed" ? { ruleVersionId: rule.ruleVersionId, payloadHash: rule.payloadHash } : { decision: rule?.decision ?? "missing" }, vat: vat ? { ok: vat.ok, classification: vat.classification, evidenceExpiresAt: vat.evidenceExpiresAt } : null };
  });
  const head = db.query("SELECT entry_hash FROM journal_entries ORDER BY id DESC LIMIT 1").get() as { entry_hash: string } | null;
  return { ledgerHeadHash: head?.entry_hash ?? "GENESIS", ready };
}

/** Read-only planning creates a purchase action only for one unambiguous bank/document pair. */
export type BookkeepingBatchScope = Omit<BookkeepingBatchPlan, "items" | "planHash" | "sourceIdentities">;
export function planBookkeepingBatch(db: Database, input: BookkeepingBatchScope): BookkeepingBatchPlan {
  const s = scope(db, input);
  const banks = db.query(`SELECT bt.id
    FROM bank_transactions bt
    WHERE bt.transaction_date BETWEEN ? AND ?
      AND NOT EXISTS (
        SELECT 1
        FROM bank_journal_reconciliations reconciliation
        WHERE reconciliation.bank_transaction_id = bt.id
      )
    ORDER BY bt.id`).all(s.bankFrom, s.bankTo) as Array<{ id: number }>;
  const pairs = banks.flatMap((bank) => { const suggested = suggestBankMatches(db, { bankTransactionId: bank.id, max: 2 }); const match = suggested.ok ? suggested.rows[0]?.suggestions[0] : undefined; return match?.documentId ? [{ bankId: bank.id, documentId: match.documentId, suggestion: match }] : []; });
  const perDocument = new Map<number, number>(); for (const pair of pairs) perDocument.set(pair.documentId, (perDocument.get(pair.documentId) ?? 0) + 1);
  const items: BookkeepingBatchItem[] = [];
  for (const pair of pairs) {
    const evidence = loadPurchaseEvidence(db, s.companyId, pair.documentId, pair.bankId); if (!evidence) continue;
    const rule = evaluatePostingRules(db, evidence.context, { at: evidence.document.invoice_date ?? s.accountingTo });
    const unambiguous = perDocument.get(pair.documentId) === 1;
    const vat = inspectPurchaseVatPreflight(db, pair.documentId);
    const ready = unambiguous && rule.decision === "proposed" && typeof rule.outcome.account === "string" && vat?.ok === true;
    items.push({ actionKey: `purchase:${pair.documentId}:bank:${pair.bankId}`, evidenceHash: evidenceHash(evidence), partition: ready ? "ready" : "humanDecision", documentId: pair.documentId, bankTransactionId: pair.bankId, ruleApplication: rule.decision === "proposed" ? { ruleVersionId: rule.ruleVersionId, payloadHash: rule.payloadHash } : undefined, detail: { suggestion: pair.suggestion, unambiguous, vatReady: vat?.ok === true, rule: rule.decision === "proposed" ? { ruleVersionId: rule.ruleVersionId, payloadHash: rule.payloadHash, outcome: rule.outcome } : { reasons: rule.reasons } } });
  }
  for (const bank of banks) if (!pairs.some(pair => pair.bankId === bank.id)) items.push({ actionKey: `bank:${bank.id}`, evidenceHash: hash({ bankId: bank.id }), partition: "missingDocument", bankTransactionId: bank.id, detail: {} });
  items.sort((a, b) => a.actionKey.localeCompare(b.actionKey));
  const draft = { ...s, items };
  const identities = sourceIdentities(db, draft);
  return { ...draft, sourceIdentities: identities, planHash: hash({ ...draft, sourceIdentities: identities }) };
}

function event(db: Database, runId: number, type: "planned" | "approved" | "apply_started" | "final_checks" | "completed", planHash: string, actor: string, detail: unknown = {}) { db.query("INSERT INTO bookkeeping_batch_events(run_id,event_type,plan_hash,actor,detail_json,created_at) VALUES(?,?,?,?,?,?)").run(runId, type, planHash, actor, canonical(detail), new Date().toISOString()); }
export function createBookkeepingBatchRun(db: Database, input: BookkeepingBatchPlan & BatchActor & { runKey?: string }) {
  if (!validActor(input.actor) || !input.runKey?.trim()) throw new Error("actor and runKey are required");
  const runKey = input.runKey;
  const stored = canonical(input); if (hash({ companyId: input.companyId, accountingFrom: input.accountingFrom, accountingTo: input.accountingTo, bankFrom: input.bankFrom, bankTo: input.bankTo, items: input.items, sourceIdentities: input.sourceIdentities }) !== input.planHash || JSON.parse(stored).planHash !== input.planHash) throw new Error("invalid canonical plan JSON or planHash");
  return db.transaction(() => { const old = db.query("SELECT id,plan_hash,plan_json FROM bookkeeping_batch_runs WHERE run_key=?").get(runKey) as any; if (old) { if (old.plan_hash !== input.planHash) throw new Error("runKey already binds another plan"); return { runId: old.id, duplicate: true, plan: JSON.parse(old.plan_json) as BookkeepingBatchPlan }; } const row = db.query("INSERT INTO bookkeeping_batch_runs(run_key,company_id,accounting_from,accounting_to,bank_from,bank_to,plan_hash,plan_json,created_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id").get(runKey, input.companyId, input.accountingFrom, input.accountingTo, input.bankFrom, input.bankTo, input.planHash, stored, new Date().toISOString()) as { id: number }; event(db, row.id, "planned", input.planHash, input.actor, { sourceIdentities: input.sourceIdentities }); return { runId: row.id, duplicate: false, plan: input }; }).immediate();
}
export function approveBookkeepingBatchPlan(db: Database, input: BatchActor & { runId: number; planHash: string }) { if (!validActor(input.actor)) throw new Error("actor is required"); return db.transaction(() => { const run = db.query("SELECT plan_hash FROM bookkeeping_batch_runs WHERE id=?").get(input.runId) as any; if (!run || run.plan_hash !== input.planHash) throw new Error("exact pending plan was not found"); const planner = db.query("SELECT actor FROM bookkeeping_batch_events WHERE run_id=? AND event_type='planned' ORDER BY id LIMIT 1").get(input.runId) as { actor: string } | null; const policy = db.query("SELECT self_approval_allowed FROM bookkeeping_batch_approval_policy WHERE id=1").get() as { self_approval_allowed: number } | null; if (planner?.actor === input.actor && policy?.self_approval_allowed !== 1) throw new Error("SELF_APPROVAL_FORBIDDEN"); if (!db.query("SELECT 1 FROM bookkeeping_batch_events WHERE run_id=? AND event_type='approved' AND plan_hash=?").get(input.runId, input.planHash)) event(db, input.runId, "approved", input.planHash, input.actor, { approvedAt: new Date().toISOString() }); return { ok: true as const }; }).immediate(); }

function applyPurchaseAction(db: Database, plan: BookkeepingBatchPlan, item: BookkeepingBatchItem, actor: string) {
  if (!item.documentId || !item.bankTransactionId) throw new Error("purchase action lacks exact document and bank evidence");
  const evidence = loadPurchaseEvidence(db, plan.companyId, item.documentId, item.bankTransactionId); if (!evidence || evidenceHash(evidence) !== item.evidenceHash) return { outcome: "stale" as const, error: "evidence changed" };
  const rule = applyPostingRuleEvaluationInCurrentTransaction(db, evidence.context, { applicationKey: `${item.actionKey}:rule`, at: evidence.document.invoice_date ?? plan.accountingTo });
  if (rule.decision !== "proposed" || !rule.applicationId || typeof rule.outcome.account !== "string") throw new Error(rule.reasons.join("; ") || "posting rule blocked purchase application");
  const vat = applyStoredPurchaseVatPreflightInCurrentTransaction(db, item.documentId, { actor });
  if (!vat.ok || !vat.vatPreflightId) throw new Error(vat.errors.join("; ") || "VAT preflight blocked purchase application");
  const posted = bookExpenseFromBankInCurrentTransaction(db, { documentId: item.documentId, bankTransactionId: item.bankTransactionId, expenseAccountNo: rule.outcome.account, vatTreatment: rule.outcome.vatTreatment as any, createdBy: actor, createdByProgram: "bookkeeping-batch" });
  if (!posted.ok || !posted.entryId) throw new Error(posted.errors.join("; ") || "purchase posting failed");
  const purchase = db.query("INSERT INTO purchase_posting_applications(document_id,application_key,journal_entry_id,bank_transaction_id,status) VALUES(?,?,?,?,?) RETURNING id").get(item.documentId, `${item.actionKey}:purchase`, posted.entryId, item.bankTransactionId, "posted") as { id: number };
  return { outcome: "applied" as const, documentId: item.documentId, bankTransactionId: item.bankTransactionId, journalEntryId: Number(posted.entryId), vatPreflightId: vat.vatPreflightId, postingRuleApplicationId: rule.applicationId, purchaseApplicationId: purchase.id };
}

export function applyBookkeepingBatch(db: Database, input: BatchActor & { runId: number; planHash: string; finalChecks?: Partial<Record<FinalCheckName, () => { ok: boolean; detail?: FinalCheckDetail }>> }) {
  if (!validActor(input.actor)) throw new Error("actor is required for apply");
  const run = db.query("SELECT * FROM bookkeeping_batch_runs WHERE id=?").get(input.runId) as any; if (!run || run.plan_hash !== input.planHash) throw new Error("approved planHash is required"); if (!db.query("SELECT 1 FROM bookkeeping_batch_events WHERE run_id=? AND event_type='approved' AND plan_hash=?").get(input.runId, input.planHash)) throw new Error("approved planHash is required");
  const plan = JSON.parse(run.plan_json) as BookkeepingBatchPlan;
  if (!plan.sourceIdentities) return { ok: false, errors: ["STALE_PLAN"], error: { code: "STALE_PLAN", cause: "LEGACY_PLAN" }, results: [], checks: [] };
  const actual = sourceIdentities(db, plan);
  const expected = plan.sourceIdentities as { ledgerHeadHash?: string; ready?: unknown[] };
  const sameInputs = canonical({ ready: actual.ready }) === canonical({ ready: expected.ready ?? [] });
  const receiptJournalIds = new Set((db.query("SELECT journal_entry_id FROM bookkeeping_batch_applied_links WHERE run_id=? AND journal_entry_id IS NOT NULL").all(input.runId) as Array<{ journal_entry_id: number }>).map((row) => row.journal_entry_id));
  const ledgerChangedOnlyByReceipts = (() => {
    if (actual.ledgerHeadHash === expected.ledgerHeadHash) return true;
    let cursor = actual.ledgerHeadHash as string;
    while (cursor !== expected.ledgerHeadHash && cursor !== "GENESIS") {
      const row = db.query("SELECT id,previous_hash FROM journal_entries WHERE entry_hash=?").get(cursor) as { id: number; previous_hash: string } | null;
      if (!row || !receiptJournalIds.has(row.id)) return false;
      cursor = row.previous_hash;
    }
    return cursor === expected.ledgerHeadHash;
  })();
  if (!sameInputs || !ledgerChangedOnlyByReceipts) {
    const cause = !sameInputs ? "SOURCE_EVIDENCE_CHANGED" : "LEDGER_HEAD_CHANGED";
    event(db, input.runId, "apply_started", input.planHash, input.actor, { stale: true, cause });
    return { ok: false, errors: ["STALE_PLAN"], error: { code: "STALE_PLAN", cause }, results: [], checks: [] };
  }
  event(db, input.runId, "apply_started", input.planHash, input.actor);
  const results: Array<{ actionKey: string; outcome: string; error?: string }> = [];
  for (const item of plan.items.filter(x => x.partition === "ready")) {
    try { const result = db.transaction(() => { if (db.query("SELECT 1 FROM bookkeeping_batch_applied_links WHERE run_id=? AND action_key=?").get(input.runId, item.actionKey)) return { outcome: "duplicate" as const }; db.query("INSERT INTO bookkeeping_batch_item_attempts(run_id,action_key,evidence_hash,outcome,created_at) VALUES(?,?,?,?,?)").run(input.runId, item.actionKey, item.evidenceHash, "started", new Date().toISOString()); const applied = applyPurchaseAction(db, plan, item, input.actor); if (applied.outcome !== "applied") { db.query("INSERT INTO bookkeeping_batch_item_attempts(run_id,action_key,evidence_hash,outcome,error_text,created_at) VALUES(?,?,?,?,?,?)").run(input.runId, item.actionKey, item.evidenceHash, "stale", applied.error, new Date().toISOString()); return applied; } if (![applied.journalEntryId, applied.vatPreflightId, applied.postingRuleApplicationId, applied.purchaseApplicationId].every(Number.isInteger)) throw new Error("purchase application did not produce immutable evidence ids"); db.query("INSERT INTO bookkeeping_batch_applied_links(run_id,action_key,document_id,journal_entry_id,bank_transaction_id,vat_preflight_id,posting_rule_application_id,purchase_application_id,evidence_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(input.runId,item.actionKey,applied.documentId,applied.journalEntryId,applied.bankTransactionId,applied.vatPreflightId,applied.postingRuleApplicationId,applied.purchaseApplicationId,item.evidenceHash,new Date().toISOString()); db.query("INSERT INTO bookkeeping_batch_item_receipts(run_id,action_key,receipt_json,created_at) VALUES(?,?,?,?)").run(input.runId,item.actionKey,canonical(applied),new Date().toISOString()); db.query("INSERT INTO bookkeeping_batch_item_attempts(run_id,action_key,evidence_hash,outcome,created_at) VALUES(?,?,?,?,?)").run(input.runId,item.actionKey,item.evidenceHash,"applied",new Date().toISOString()); return applied; }).immediate(); results.push({ actionKey: item.actionKey, outcome: result.outcome, error: "error" in result ? result.error : undefined }); } catch (error) { const message = error instanceof Error ? error.message : String(error); db.query("INSERT INTO bookkeeping_batch_item_attempts(run_id,action_key,evidence_hash,outcome,error_text,created_at) VALUES(?,?,?,?,?,?)").run(input.runId,item.actionKey,item.evidenceHash,"failed",message,new Date().toISOString()); results.push({ actionKey:item.actionKey,outcome:"failed",error:message }); }
  }
  const defaults: Record<FinalCheckName, () => { ok: boolean; detail?: FinalCheckDetail }> = { audit_chain: () => ({ ok: verifyAuditChain(db).ok }), trial_balance: () => { const x = buildTrialBalance(db, plan.accountingFrom, plan.accountingTo); return { ok: x.ok && x.balanced, detail: x }; }, reconciliation: () => { const x = buildBankReconciliationReport(db, plan.bankFrom, plan.bankTo); return { ok: x.ok && x.unmatchedCount === 0, detail: x }; }, vat: () => { const x = buildVatReport(db, plan.accountingFrom, plan.accountingTo); return { ok: x.ok, detail: x }; } };
  const checks = (Object.keys(defaults) as FinalCheckName[]).map(name => { const existing = db.query("SELECT ok,detail_json FROM bookkeeping_batch_final_checks WHERE run_id=? AND check_name=? ORDER BY id DESC LIMIT 1").get(input.runId, name) as { ok: number; detail_json: string } | null; if (existing) return { name, ok: existing.ok === 1, detail: JSON.parse(existing.detail_json) }; const checked = (input.finalChecks?.[name] ?? defaults[name])(); db.query("INSERT INTO bookkeeping_batch_final_checks(run_id,check_name,ok,detail_json,created_at) VALUES(?,?,?,?,?)").run(input.runId,name,checked.ok ? 1 : 0,canonical(checked.detail ?? {}),new Date().toISOString()); return { name, ...checked }; });
  event(db,input.runId,"final_checks",input.planHash,input.actor,{ checks }); event(db,input.runId,"completed",input.planHash,input.actor,{ results }); return { ok: results.every(r => r.outcome === "applied" || r.outcome === "duplicate") && checks.every(x => x.ok), results, checks };
}
