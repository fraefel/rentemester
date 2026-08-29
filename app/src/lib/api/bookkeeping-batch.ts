import { request } from "./_shared";
const path=(slug:string)=>`/api/companies/${encodeURIComponent(slug)}/bookkeeping-batch`;
export type BatchScope={companyId:number;accountingFrom:string;accountingTo:string;bankFrom:string;bankTo:string};
export const bookkeepingBatchApi={
 bookkeepingBatchPlan:(slug:string,input:BatchScope)=>request<any>(`${path(slug)}?${new URLSearchParams(Object.entries(input).map(([key,value])=>[key,String(value)]))}`),
 bookkeepingBatchPersist:(slug:string,input:BatchScope&{runKey:string})=>request<any>(`${path(slug)}/persist`,{method:"POST",body:JSON.stringify({...input,confirm:true})}),
 bookkeepingBatchApprove:(slug:string,input:{runId:number;planHash:string})=>request<any>(`${path(slug)}/approve`,{method:"POST",body:JSON.stringify({...input,confirm:true})}),
 bookkeepingBatchApply:(slug:string,input:{runId:number;planHash:string})=>request<any>(`${path(slug)}/apply`,{method:"POST",body:JSON.stringify({...input,confirm:true})}),
 bookkeepingBatchStatus:(slug:string,runId:number)=>request<any>(`${path(slug)}/runs/${runId}`),
};
