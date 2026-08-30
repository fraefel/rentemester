import { request } from "./_shared";
export type RegistryList<T>={rows:T[];count:number;nextCursor:number|null};
export const workspaceRegistryApi={
  workspaceParties:(slug:string)=>request<RegistryList<{partyId:string;name:string;kind:string;roles:Array<{companySlug:string;role:string}>}>>(`/api/companies/${encodeURIComponent(slug)}/workspace-parties`),
  corporateRecords:(slug:string)=>request<RegistryList<{recordId:string;type:string;filename:string;sha256:string;sensitivity:string}>>(`/api/companies/${encodeURIComponent(slug)}/corporate-records`),
  companyKnowledge:(slug:string)=>request<{context:{assertions:Array<{assertionId:string;predicate:string;reviewState:string;source:{kind:string}}>;conflicts:string[]}}>(`/api/companies/${encodeURIComponent(slug)}/knowledge`),
  ownership:(slug:string,asOf:string)=>request<{asOf:string;facts:Array<{owner:{kind:string;companySlug?:string;partyId?:string};ownedCompanySlug:string;economicBasisPoints?:number;economicIntervalBasisPoints?:{min:number;max:number};controlType:string}>;partial:boolean;consolidation:{eligible:boolean;reason:string}}>(`/api/companies/${encodeURIComponent(slug)}/ownership?asOf=${encodeURIComponent(asOf)}`),
  ownershipHistory:(slug:string)=>request<{history:Array<{snapshotId:string;state:string;snapshotHash:string;diffHash:string;history:Array<{event_type:string;created_at:string}>}>}>(`/api/companies/${encodeURIComponent(slug)}/ownership/history`),
  ownershipMutate:(slug:string,action:"propose"|"review"|"apply",body:Record<string,unknown>)=>request<{ok:true;snapshot?:unknown;status?:string}>(`/api/companies/${encodeURIComponent(slug)}/ownership/${action}`,{method:"POST",body:JSON.stringify({...body,confirm:true})}),
};
