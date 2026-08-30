import type { CommandDispatch } from "../cli-dispatch";
import { openCommandDb } from "../cli-dispatch";
import { migrate } from "../core/db";
import { applyDimensionAssignment, createDimensionDefinition, createDimensionMember, listDimensionAssignments, planDimensionAssignment, supersedeDimensionAssignment } from "../core/accounting-dimensions";
const json=(v:string|undefined)=>{try{return v?JSON.parse(v):undefined;}catch{throw new Error("--allocations must be JSON");}};
export function register(dispatch:CommandDispatch) {
  const identity=(ctx:any)=>({actor:ctx.cliActor??ctx.inferredMutationActor()??undefined,principal:ctx.arg("--principal"),confirm:ctx.arg("--confirm")==="yes"});
  dispatch.on("dimensions","define",ctx=>{const db=openCommandDb(ctx);try{migrate(db);ctx.emitResult(createDimensionDefinition(db,{...identity(ctx),dimensionId:ctx.arg("--dimension-id")!,kind:ctx.arg("--kind")!,name:ctx.arg("--name")!}));}finally{db.close();}});
  dispatch.on("dimensions","member",ctx=>{const db=openCommandDb(ctx);try{migrate(db);ctx.emitResult(createDimensionMember(db,{...identity(ctx),dimensionId:ctx.arg("--dimension-id")!,memberId:ctx.arg("--member-id")!,name:ctx.arg("--name")!,status:ctx.arg("--status") as any}));}finally{db.close();}});
  dispatch.on("dimensions","plan",ctx=>{const db=openCommandDb(ctx);try{migrate(db);ctx.emitResult(planDimensionAssignment(db,{journalLineId:Number(ctx.arg("--journal-line-id")),allocations:json(ctx.arg("--allocations"))??[],source:ctx.arg("--source") as any,reviewedImport:ctx.arg("--reviewed-import")==="yes"}));}finally{db.close();}});
  dispatch.on("dimensions","apply",ctx=>{const db=openCommandDb(ctx);try{migrate(db);ctx.emitResult(applyDimensionAssignment(db,{...identity(ctx),journalLineId:Number(ctx.arg("--journal-line-id")),allocations:json(ctx.arg("--allocations"))??[],source:ctx.arg("--source") as any,reviewedImport:ctx.arg("--reviewed-import")==="yes",planHash:ctx.arg("--plan-hash")!,idempotencyKey:ctx.arg("--idempotency-key")}));}finally{db.close();}});
  dispatch.on("dimensions","supersede",ctx=>{const db=openCommandDb(ctx);try{migrate(db);ctx.emitResult(supersedeDimensionAssignment(db,{...identity(ctx),assignmentId:Number(ctx.arg("--assignment-id")),reason:ctx.arg("--reason")!}));}finally{db.close();}});
  dispatch.on("dimensions","list",ctx=>{const db=openCommandDb(ctx);try{migrate(db);ctx.emitResult({ok:true,assignments:listDimensionAssignments(db,Number(ctx.arg("--journal-line-id")))});}finally{db.close();}});
}
