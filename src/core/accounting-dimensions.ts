/**
 * Company-ledger accounting dimensions.  These records deliberately sit next
 * to, rather than inside, immutable journal lines: classifications can be
 * corrected without changing legal accounting evidence or its hash chain.
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

const text = (v: unknown, max = 160) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max ? v.trim() : null;
const canonical = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
const hash = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const fail = (code: string) => ({ ok: false as const, errors: [code] });
const actor = (v: unknown) => text(v, 160);

export const ACCOUNTING_DIMENSION_SCHEMA_VERSION = "rentemester-accounting-dimensions-v1";
export type DimensionAllocation = { dimensionId: string; memberId: string; amountMinor: number; currency: string };
export type DimensionAssignmentInput = { journalLineId: number; allocations: DimensionAllocation[]; source?: "reviewed" | "imported"; reviewedImport?: boolean };

export function createDimensionDefinition(db: Database, input: { dimensionId: string; kind: string; name: string; actor?: string; principal?: string; confirm: boolean }) {
  if (!input.confirm) return fail("CONFIRMATION_REQUIRED");
  const dimensionId = text(input.dimensionId, 64), kind = text(input.kind, 64), name = text(input.name, 160), by = actor(input.actor), principal = text(input.principal, 160);
  if (!dimensionId || !/^[a-z][a-z0-9_-]*$/.test(dimensionId) || !kind || !name) return fail("INVALID_DIMENSION");
  if (!by || !principal) return fail("ACTOR_AND_PRINCIPAL_REQUIRED");
  const current = db.query("SELECT * FROM current_accounting_dimension_definitions WHERE dimension_id=?").get(dimensionId) as any;
  if (current) return current.kind === kind && current.name === name ? { ok:true as const, id:current.id, idempotent:true } : fail("DIMENSION_CONFLICT");
  const row = db.query("INSERT INTO accounting_dimension_definition_events(dimension_id,kind,name,event_type,actor,principal,created_at) VALUES(?,?,?,'defined',?,?,?) RETURNING id").get(dimensionId,kind,name,by,principal,new Date().toISOString()) as any;
  return { ok:true as const, id:row.id, idempotent:false };
}

export function createDimensionMember(db: Database, input: { dimensionId:string; memberId:string; name:string; status?:"active"|"inactive"; effectiveFrom?:string; effectiveTo?:string; actor?:string; principal?:string; confirm:boolean }) {
  if (!input.confirm) return fail("CONFIRMATION_REQUIRED");
  const dimensionId=text(input.dimensionId,64), memberId=text(input.memberId,64), name=text(input.name,160), status=input.status??"active", by=actor(input.actor), principal=text(input.principal,160);
  if(!dimensionId||!memberId||!name||!by||!principal||!db.query("SELECT 1 FROM current_accounting_dimension_definitions WHERE dimension_id=?").get(dimensionId)) return fail("INVALID_MEMBER");
  if(status!=="active"&&status!=="inactive") return fail("INVALID_MEMBER");
  const current=db.query("SELECT * FROM current_accounting_dimension_members WHERE dimension_id=? AND member_id=?").get(dimensionId,memberId) as any;
  if(current) return current.name===name&&current.status===status ? {ok:true as const,id:current.id,idempotent:true}:{...fail("MEMBER_CONFLICT")};
  const row=db.query("INSERT INTO accounting_dimension_member_events(dimension_id,member_id,name,status,effective_from,effective_to,event_type,actor,principal,created_at) VALUES(?,?,?,?,?,?,'defined',?,?,?) RETURNING id").get(dimensionId,memberId,name,status,input.effectiveFrom??null,input.effectiveTo??null,by,principal,new Date().toISOString()) as any;
  return {ok:true as const,id:row.id,idempotent:false};
}

/** Pure proposal.  It reads the immutable line and binds the exact line and
 * entry hashes; it never creates a draft or changes a journal. */
export function planDimensionAssignment(db: Database, input: DimensionAssignmentInput) {
  const line=db.query(`SELECT jl.id,jl.debit_amount,jl.credit_amount,jl.currency,je.id AS entry_id,je.entry_hash FROM journal_lines jl JOIN journal_entries je ON je.id=jl.journal_entry_id WHERE jl.id=?`).get(input.journalLineId) as any;
  if(!line) return fail("JOURNAL_LINE_NOT_FOUND");
  if(!Array.isArray(input.allocations)||!input.allocations.length) return fail("ALLOCATIONS_REQUIRED");
  const minor=Math.round(Math.abs((Number(line.debit_amount)-Number(line.credit_amount))*100));
  if(!Number.isSafeInteger(minor)) return fail("LINE_AMOUNT_INVALID");
  const allocations=input.allocations.map(a=>({dimensionId:text(a.dimensionId,64),memberId:text(a.memberId,64),amountMinor:a.amountMinor,currency:text(a.currency,3)?.toUpperCase()}));
  if(allocations.some(a=>!a.dimensionId||!a.memberId||!Number.isSafeInteger(a.amountMinor)||a.amountMinor<=0||a.currency!==line.currency)) return fail("INVALID_ALLOCATION");
  const groups=new Map<string,number>();
  for(const allocation of allocations) groups.set(allocation.dimensionId!, (groups.get(allocation.dimensionId!)??0)+allocation.amountMinor);
  if([...groups.values()].some(value=>value!==minor)) return fail("ALLOCATION_DOES_NOT_RECONCILE");
  for(const allocation of allocations) {
    const member=db.query("SELECT status,effective_from,effective_to FROM current_accounting_dimension_members WHERE dimension_id=? AND member_id=?").get(allocation.dimensionId,allocation.memberId) as any;
    if(!member) return fail("MEMBER_NOT_FOUND");
    if(member.status!=="active") return fail("INACTIVE_MEMBER_REQUIRES_REVIEWED_OVERRIDE");
  }
  if(input.source==="imported"&&!input.reviewedImport) return fail("IMPORTED_PROVENANCE_REQUIRES_REVIEW");
  const plan={schemaVersion:ACCOUNTING_DIMENSION_SCHEMA_VERSION,journalLineId:line.id,journalEntryId:line.entry_id,journalEntryHash:line.entry_hash,lineCurrency:line.currency,lineAmountMinor:minor,allocations:allocations.map(a=>({dimensionId:a.dimensionId!,memberId:a.memberId!,amountMinor:a.amountMinor,currency:a.currency!})).sort((a,b)=>canonical(a).localeCompare(canonical(b))),source:input.source??"reviewed"};
  return {ok:true as const,plan:{...plan,planHash:hash(plan)}};
}

export function applyDimensionAssignment(db: Database, input: DimensionAssignmentInput & { planHash:string; actor?:string; principal?:string; confirm:boolean; idempotencyKey?:string }) {
  if(!input.confirm) return fail("CONFIRMATION_REQUIRED"); const by=actor(input.actor), principal=text(input.principal,160); if(!by||!principal)return fail("ACTOR_AND_PRINCIPAL_REQUIRED");
  const planned=planDimensionAssignment(db,input); if(!planned.ok)return planned; if(planned.plan.planHash!==input.planHash)return fail("PLAN_HASH_MISMATCH");
  const old=input.idempotencyKey?db.query("SELECT id,plan_hash FROM accounting_dimension_assignment_events WHERE idempotency_key=?").get(input.idempotencyKey) as any:null;
  if(old) return old.plan_hash===input.planHash?{ok:true as const,id:old.id,idempotent:true,planHash:input.planHash}:fail("IDEMPOTENCY_CONFLICT");
  const row=db.query("INSERT INTO accounting_dimension_assignment_events(journal_line_id,journal_entry_id,journal_entry_hash,line_currency,line_amount_minor,allocations_json,source,plan_hash,event_type,idempotency_key,actor,principal,created_at) VALUES(?,?,?,?,?,?,?,?, 'assigned',?,?,?,?) RETURNING id").get(planned.plan.journalLineId,planned.plan.journalEntryId,planned.plan.journalEntryHash,planned.plan.lineCurrency,planned.plan.lineAmountMinor,canonical(planned.plan.allocations),planned.plan.source,input.planHash,input.idempotencyKey??null,by,principal,new Date().toISOString()) as any;
  return {ok:true as const,id:row.id,idempotent:false,planHash:input.planHash};
}

export function supersedeDimensionAssignment(db: Database,input:{assignmentId:number;reason:string;actor?:string;principal?:string;confirm:boolean}) {
  if(!input.confirm)return fail("CONFIRMATION_REQUIRED"); const by=actor(input.actor),principal=text(input.principal,160),reason=text(input.reason,1000);if(!by||!principal||!reason)return fail("ACTOR_AND_PRINCIPAL_REQUIRED");
  const row=db.query("SELECT * FROM current_accounting_dimension_assignments WHERE id=?").get(input.assignmentId) as any;if(!row)return fail("ASSIGNMENT_NOT_FOUND");
  const event=db.query("INSERT OR IGNORE INTO accounting_dimension_assignment_events(journal_line_id,journal_entry_id,journal_entry_hash,line_currency,line_amount_minor,allocations_json,source,plan_hash,event_type,supersedes_assignment_id,reason,actor,principal,created_at) VALUES(?,?,?,?,?,?,?,?, 'superseded',?,?,?,?,?) RETURNING id").get(row.journal_line_id,row.journal_entry_id,row.journal_entry_hash,row.line_currency,row.line_amount_minor,row.allocations_json,row.source,row.plan_hash,row.id,reason,by,principal,new Date().toISOString()) as any;
  return {ok:true as const,id:event?.id??null,idempotent:!event};
}

export function listDimensionAssignments(db:Database,journalLineId:number) { return db.query("SELECT * FROM accounting_dimension_assignment_events WHERE journal_line_id=? ORDER BY id").all(journalLineId); }
