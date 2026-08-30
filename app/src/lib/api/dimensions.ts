import { request } from "./_shared";
const path=(slug:string,suffix="")=>`/api/companies/${encodeURIComponent(slug)}/dimensions${suffix}`;
export type DimensionEvent={id:number;dimension_id:string;member_id?:string;name:string;status:string;event_type:string;created_at:string};
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
};
