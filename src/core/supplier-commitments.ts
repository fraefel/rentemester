/** Reviewed supplier commitments are planning evidence, never invoices,
 * payables, payments or ledger postings. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { addDays, isValidIsoDate } from "./dates";
import { addMonths } from "./recurring-invoices";

type Status = "active"|"paused"|"ended"|"unresolved";
type Frequency = "weekly"|"monthly"|"quarterly"|"yearly";
export type CommitmentInput = { commitmentId:string; vendorPartyId:string; vendorSnapshot?:string; type:string; description:string; businessPurpose:string; amount:number; currency:string; frequency:Frequency; nextDate:string; startDate?:string; renewalDate?:string; noticeDate?:string; endDate?:string; evidenceRefs:string[]; vatProposal?:string; status?:Status };
export type CommitmentProposal = Omit<CommitmentInput,"vendorSnapshot"|"status"|"startDate"|"renewalDate"|"noticeDate"|"endDate"|"vatProposal"> & { status:Status; vendorSnapshot:string|null; startDate:string|null; renewalDate:string|null; noticeDate:string|null; endDate:string|null; vatProposal:string|null; payloadHash:string; schedule:Array<{date:string; amount:number; currency:string}>; warnings:string[] };
const canonical=(v:unknown):string=>v===null||typeof v!=="object"?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(",")}]`:`{${Object.keys(v as object).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
const digest=(v:unknown)=>createHash("sha256").update(canonical(v)).digest("hex");
const validText=(v:unknown,max=500)=>typeof v==="string"&&v.trim().length>0&&v.trim().length<=max;
const validFrequency=(v:unknown):v is Frequency=>v==="weekly"||v==="monthly"||v==="quarterly"||v==="yearly";
const next=(date:string, frequency:Frequency)=>frequency==="weekly"?addDays(date,7):addMonths(date,frequency==="monthly"?1:frequency==="quarterly"?3:12);

export function planSupplierCommitment(input:CommitmentInput, horizonDays=91):{ok:true;proposal:CommitmentProposal}|{ok:false;errors:string[]} {
  const errors:string[]=[];
  if(!validText(input.commitmentId,96)||!validText(input.vendorPartyId,96)) errors.push("commitmentId and canonical vendorPartyId are required");
  if(!validText(input.type)||!validText(input.description,2000)||!validText(input.businessPurpose,2000)) errors.push("type, description and businessPurpose are required");
  if(!Number.isFinite(input.amount)||input.amount<=0) errors.push("amount must be positive");
  if(!/^[A-Z]{3}$/.test(input.currency)) errors.push("currency must be ISO-4217 uppercase");
  if(!validFrequency(input.frequency)||!isValidIsoDate(input.nextDate)) errors.push("frequency and nextDate are invalid");
  if(!Array.isArray(input.evidenceRefs)||input.evidenceRefs.length===0||input.evidenceRefs.some(r=>!validText(r,500))) errors.push("at least one source evidence reference is required");
  for(const d of [input.startDate,input.renewalDate,input.noticeDate,input.endDate]) if(d!==undefined&&!isValidIsoDate(d)) errors.push("commitment dates must be YYYY-MM-DD");
  if(errors.length) return {ok:false,errors};
  const status=input.status??"active"; const schedule:CommitmentProposal["schedule"]=[]; let cursor=input.nextDate;
  const until=addDays(input.nextDate,horizonDays);
  while(cursor<=until){ if(!input.endDate||cursor<=input.endDate) schedule.push({date:cursor,amount:input.amount,currency:input.currency}); cursor=next(cursor,input.frequency); }
  const {commitmentId,vendorPartyId,vendorSnapshot,type,description,businessPurpose,amount,currency,frequency,nextDate,startDate,renewalDate,noticeDate,endDate,evidenceRefs,vatProposal}=input;
  const payload={commitmentId,vendorPartyId,status,vendorSnapshot:vendorSnapshot??null,type,description,businessPurpose,amount,currency,frequency,nextDate,startDate:startDate??null,renewalDate:renewalDate??null,noticeDate:noticeDate??null,endDate:endDate??null,evidenceRefs,vatProposal:vatProposal??null};
  return {ok:true,proposal:{...payload,payloadHash:digest(payload),schedule,warnings:["VAT treatment is a proposal only; invoice evidence and VAT preflight remain required."]}};
}
export function applySupplierCommitment(db:Database,input:CommitmentInput & {payloadHash:string;confirm:boolean;actor?:string;principal?:string;idempotencyKey?:string}){
  if(!input.confirm) return {ok:false,errors:["CONFIRMATION_REQUIRED"]}; if(!validText(input.actor,160)||!validText(input.principal,160)) return {ok:false,errors:["ACTOR_AND_PRINCIPAL_REQUIRED"]};
  const plan=planSupplierCommitment(input); if(!plan.ok)return plan; if(plan.proposal.payloadHash!==input.payloadHash)return {ok:false,errors:["PLAN_HASH_MISMATCH"]};
  const existing=input.idempotencyKey?db.query("SELECT payload_hash FROM supplier_commitment_events WHERE idempotency_key=?").get(input.idempotencyKey) as any:null;
  if(existing&&existing.payload_hash!==input.payloadHash)return {ok:false,errors:["IDEMPOTENCY_CONFLICT"]}; if(existing)return {ok:true,idempotent:true,commitmentId:input.commitmentId,payloadHash:input.payloadHash};
  const same=db.query("SELECT 1 FROM supplier_commitment_events WHERE commitment_id=? AND event_type='approved' AND payload_hash=?").get(input.commitmentId,input.payloadHash); if(same)return {ok:true,idempotent:true,commitmentId:input.commitmentId,payloadHash:input.payloadHash};
  db.query("INSERT INTO supplier_commitment_events(commitment_id,event_type,payload_json,payload_hash,idempotency_key,actor,principal,created_at) VALUES(?,?,?,?,?,?,?,?)").run(input.commitmentId,"approved",canonical(plan.proposal),input.payloadHash,input.idempotencyKey??null,input.actor!,input.principal!,new Date().toISOString());
  return {ok:true,idempotent:false,commitmentId:input.commitmentId,payloadHash:input.payloadHash};
}
export function changeSupplierCommitment(db:Database,input:{commitmentId:string;action:"paused"|"ended"|"superseded";reason:string;confirm:boolean;actor?:string;principal?:string}){
 if(!input.confirm)return {ok:false,errors:["CONFIRMATION_REQUIRED"]};if(!validText(input.actor,160)||!validText(input.principal,160)||!validText(input.reason,2000))return {ok:false,errors:["ACTOR_PRINCIPAL_AND_REASON_REQUIRED"]};
 const current=db.query("SELECT payload_hash,payload_json FROM current_supplier_commitments WHERE commitment_id=? ORDER BY id DESC LIMIT 1").get(input.commitmentId) as any;if(!current)return {ok:false,errors:["COMMITMENT_NOT_ACTIVE"]}; const payload={commitmentId:input.commitmentId,reason:input.reason,previousPayloadHash:current.payload_hash};const h=digest(payload);
 const prior=db.query("SELECT 1 FROM supplier_commitment_events WHERE commitment_id=? AND event_type=? AND payload_hash=?").get(input.commitmentId,input.action,h);if(prior)return {ok:true,idempotent:true,payloadHash:h};
 db.query("INSERT INTO supplier_commitment_events(commitment_id,event_type,payload_json,payload_hash,previous_payload_hash,actor,principal,created_at) VALUES(?,?,?,?,?,?,?,?)").run(input.commitmentId,input.action,canonical(payload),h,current.payload_hash,input.actor,input.principal,new Date().toISOString());return {ok:true,idempotent:false,payloadHash:h};
}
export function listSupplierCommitments(db:Database){return db.query("SELECT commitment_id,payload_json,payload_hash,created_at FROM current_supplier_commitments ORDER BY commitment_id").all() as Array<{commitment_id:string;payload_json:string;payload_hash:string;created_at:string}>;}
export function plannedCommitmentOccurrences(db:Database,startDate:string,weeks=13){const end=addDays(startDate,weeks*7-1);const result:Array<{commitmentId:string;date:string;amount:number;currency:string;payloadHash:string}>=[];for(const row of listSupplierCommitments(db)){let p:CommitmentProposal;try{p=JSON.parse(row.payload_json);}catch{continue;}if(p.status!=="active")continue;for(const o of p.schedule){if(o.date>=startDate&&o.date<=end)result.push({commitmentId:row.commitment_id,date:o.date,amount:o.amount,currency:o.currency,payloadHash:row.payload_hash});}}return result.sort((a,b)=>a.date.localeCompare(b.date)||a.commitmentId.localeCompare(b.commitmentId));}
