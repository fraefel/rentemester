import { request } from "./_shared";
const path=(slug:string,suffix="")=>`/api/companies/${encodeURIComponent(slug)}/dimensions${suffix}`;
export type DimensionEvent={id:number;dimension_id:string;member_id?:string;name:string;status:string;event_type:string;created_at:string};
/** An append-only assignment event. `allocations_json` is the exact, hashed
 * allocation evidence stored by the ledger; it is never a mutable UI model. */
export type DimensionAssignmentEvent={id:number;journal_line_id:number;journal_entry_id:number;journal_entry_hash:string;line_currency:string;line_amount_minor:number;allocations_json:string;source:string;plan_hash:string;event_type:"assigned"|"superseded";supersedes_assignment_id:number|null;reason:string|null;actor:string;principal:string;created_at:string};
export type DimensionAllocation={dimensionId:string;memberId:string;amountMinor:number;currency:string};
export type DimensionPlan={planHash:string;journalLineId:number;journalEntryId:number;journalEntryHash:string;lineCurrency:string;lineAmountMinor:number;allocations:DimensionAllocation[];source:"reviewed"|"imported";sourceRef:string|null};
type DefinitionInput={dimensionId:string;kind:string;name:string};
type MemberInput={dimensionId:string;memberId:string;name:string;status?:"active"|"inactive"};
type DefinitionLifecycleInput={dimensionId:string;action:"activate"|"deactivate"|"rename";name?:string};
type MemberLifecycleInput={dimensionId:string;memberId:string;action:"activate"|"deactivate"|"rename";name?:string};
const write=(slug:string,suffix:string,body:unknown)=>request<{ok:true}>(path(slug,suffix),{method:"POST",body:JSON.stringify({...body as object,confirm:true})});
export const dimensionsApi={
  dimensionDefinitions:(slug:string)=>request<{ok:true;definitions:DimensionEvent[]}>(path(slug)).then(x=>x.definitions),
  dimensionMembers:(slug:string,dimensionId?:string)=>request<{ok:true;members:DimensionEvent[]}>(`${path(slug,"/members")}${dimensionId?`?dimensionId=${encodeURIComponent(dimensionId)}`:""}`).then(x=>x.members),
  createDimensionDefinition:(slug:string,input:DefinitionInput)=>write(slug,"/define",input),
  createDimensionMember:(slug:string,input:MemberInput)=>write(slug,"/member",input),
  changeDimensionDefinition:(slug:string,input:DefinitionLifecycleInput)=>write(slug,"/definition-lifecycle",input),
  changeDimensionMember:(slug:string,input:MemberLifecycleInput)=>write(slug,"/member-lifecycle",input),
  /** Read the full append-only history for one immutable journal line. */
  dimensionAssignments:(slug:string,journalLineId:number)=>request<{ok:true;assignments:DimensionAssignmentEvent[]}>(path(slug,`/${journalLineId}`)).then(x=>x.assignments),
  /** Pure preflight. The returned hash is mandatory for the subsequent write. */
  planDimensionAssignment:(slug:string,input:{journalLineId:number;allocations:DimensionAllocation[];source?:"reviewed"|"imported";reviewedImport?:boolean;sourceRef?:string})=>request<{ok:boolean;plan?:DimensionPlan;errors?:string[]}>(path(slug,"/plan"),{method:"POST",body:JSON.stringify(input)}),
  /** Applies exactly the reviewed plan. The browser still needs an explicit UI confirmation before calling this. */
  applyDimensionAssignment:(slug:string,input:{journalLineId:number;allocations:DimensionAllocation[];planHash:string;source?:"reviewed"|"imported";reviewedImport?:boolean;sourceRef?:string;idempotencyKey:string})=>write(slug,"/apply",input),
  /** Atomically supersedes the expected current assignment and applies the
   * exact reviewed replacement. No transient unclassified state is possible. */
  replaceDimensionAssignment:(slug:string,input:{journalLineId:number;expectedAssignmentId:number;allocations:DimensionAllocation[];planHash:string;reason:string;source?:"reviewed"|"imported";reviewedImport?:boolean;sourceRef?:string;idempotencyKey:string})=>write(slug,"/replace",input),
  /** Retires an existing classification append-only; it never changes the journal line. */
  supersedeDimensionAssignment:(slug:string,input:{assignmentId:number;reason:string})=>write(slug,"/supersede",input),
};
