import { request } from "./_shared";
const path=(slug:string)=>`/api/companies/${encodeURIComponent(slug)}/bookkeeping-batch`;
export type BatchScope={companyId:number;accountingFrom:string;accountingTo:string;bankFrom:string;bankTo:string};
export const bookkeepingBatchApi={
 bookkeepingBatchDryRun:(slug:string,input:BatchScope&{runKey:string})=>request<any>(`${path(slug)}/dry-run`,{method:"POST",body:JSON.stringify({...input,confirm:true})}),
 bookkeepingBatchApprove:(slug:string,input:{runId:number;planHash:string})=>request<any>(`${path(slug)}/approve`,{method:"POST",body:JSON.stringify({...input,confirm:true})}),
 bookkeepingBatchApply:(slug:string,input:{runId:number;planHash:string})=>request<any>(`${path(slug)}/apply`,{method:"POST",body:JSON.stringify({...input,confirm:true})}),
 bookkeepingBatchStatus:(slug:string,runId:number)=>request<any>(`${path(slug)}/runs/${runId}`),
};
