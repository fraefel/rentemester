import { request } from "./_shared";
const path=(slug:string,suffix="")=>`/api/companies/${encodeURIComponent(slug)}/dimensions${suffix}`;
export type DimensionEvent={id:number;dimension_id:string;member_id?:string;name:string;status:string;event_type:string;created_at:string};
export const dimensionsApi={
  dimensionDefinitions:(slug:string)=>request<{ok:true;definitions:DimensionEvent[]}>(path(slug)).then(x=>x.definitions),
  dimensionMembers:(slug:string,dimensionId?:string)=>request<{ok:true;members:DimensionEvent[]}>(`${path(slug,"/members")}${dimensionId?`?dimensionId=${encodeURIComponent(dimensionId)}`:""}`).then(x=>x.members),
};
