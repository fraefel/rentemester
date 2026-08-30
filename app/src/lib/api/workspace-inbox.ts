import { request } from "./_shared";

const base=(slug:string)=>`/api/companies/${encodeURIComponent(slug)}/workspace-inbox`;
export type InboxSource={sourceId:string;sha256:string;filename:string;transport:string;receivedAt:string;exception?:{code:string}|null;assignments:Array<{companySlug:string;state:string;documentNo?:string|null}>};
export const workspaceInboxApi={
  list:(slug:string)=>request<{rows:InboxSource[]}>(base(slug)),
  inspect:(slug:string,sourceId:string)=>request<{source:InboxSource}>(`${base(slug)}/${encodeURIComponent(sourceId)}`),
  ingest:(slug:string,body:Record<string,unknown>)=>request<{source:InboxSource}>(base(slug),{method:"POST",body:JSON.stringify({...body,confirm:true})}),
  assign:(slug:string,sourceId:string,companySlug:string)=>request<{source:InboxSource}>(`${base(slug)}/${encodeURIComponent(sourceId)}/assign`,{method:"POST",body:JSON.stringify({companySlug,confirm:true})}),
  complete:(slug:string,sourceId:string,companySlug:string)=>request<{source:InboxSource}>(`${base(slug)}/${encodeURIComponent(sourceId)}/complete`,{method:"POST",body:JSON.stringify({companySlug,confirm:true})}),
};
