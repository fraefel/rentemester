import { request } from "./_shared";
export type RegistryList<T>={rows:T[];count:number;nextCursor:number|null};
export const workspaceRegistryApi={
  workspaceParties:(slug:string)=>request<RegistryList<{partyId:string;name:string;kind:string;roles:Array<{companySlug:string;role:string}>}>>(`/api/companies/${encodeURIComponent(slug)}/workspace-parties`),
  corporateRecords:(slug:string)=>request<RegistryList<{recordId:string;type:string;filename:string;sha256:string;sensitivity:string}>>(`/api/companies/${encodeURIComponent(slug)}/corporate-records`),
  companyKnowledge:(slug:string)=>request<{context:{assertions:Array<{assertionId:string;predicate:string;reviewState:string;source:{kind:string}}>;conflicts:string[]}}>(`/api/companies/${encodeURIComponent(slug)}/knowledge`),
};
