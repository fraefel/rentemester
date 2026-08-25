import { request } from "./_shared";
const path=(slug:string)=>`/api/companies/${encodeURIComponent(slug)}/bookkeeping-batch`;
export type BatchScope={companyId:number;accountingFrom:string;accountingTo:string;bankFrom:string;bankTo:string};
export const bookkeepingBatchApi={ bookkeepingBatchDryRun:(slug:string,input:BatchScope)=>request<{ok:true;dryRun:true;plan:any}>(`${path(slug)}?${new URLSearchParams(Object.entries(input).map(([k,v])=>[k,String(v)]))}`).then(x=>x.plan), bookkeepingBatchApply:(slug:string,input:BatchScope&{runKey:string})=>request<any>(`${path(slug)}/apply`,{method:"POST",body:JSON.stringify({...input,confirm:true})}) };
