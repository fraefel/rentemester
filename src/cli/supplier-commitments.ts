import { openDb, migrate } from "../core/db";
import { companyPaths } from "../core/paths";
import { openLedgerReadOnly } from "../core/ledger-inspection";
import type { CommandDispatch } from "../cli-dispatch";
import { applySupplierCommitment, changeSupplierCommitment, listSupplierCommitments, planSupplierCommitment } from "../core/supplier-commitments";
const json=(s:string|undefined)=>{try{return s?JSON.parse(s):null;}catch{return null;}};
export function register(dispatch:CommandDispatch):void {
 dispatch.on("supplier-commitment","plan",ctx=>{const input=json(ctx.arg("--input"));if(!input)ctx.fatal("--input must be JSON");ctx.emitResult(planSupplierCommitment(input));});
 dispatch.on("supplier-commitment","apply",ctx=>{const input=json(ctx.arg("--input"));const hash=ctx.arg("--plan-hash");if(!input||!hash)ctx.fatal("--input and --plan-hash are required");if(ctx.arg("--confirm")!=="yes")ctx.fatal("--confirm must be yes");const db=openDb(companyPaths(ctx.companyRoot()).db);try{migrate(db);ctx.emitResult(applySupplierCommitment(db,{...input,payloadHash:hash,confirm:true,actor:ctx.cliActor??process.env.RENTEMESTER_ACTOR,principal:ctx.cliActor??process.env.RENTEMESTER_ACTOR,idempotencyKey:ctx.arg("--idempotency-key")}));}finally{db.close();}});
 dispatch.on("supplier-commitment","list",ctx=>{const db=openLedgerReadOnly(companyPaths(ctx.companyRoot()).db);try{ctx.emitResult({ok:true,rows:listSupplierCommitments(db),errors:[]});}finally{db.close();}});
 dispatch.on("supplier-commitment","change",ctx=>{const id=ctx.arg("--id"),action=ctx.arg("--action"),reason=ctx.arg("--reason");if(!id||!reason||(action!=="paused"&&action!=="ended"&&action!=="superseded"))ctx.fatal("--id --action paused|ended|superseded --reason are required");if(ctx.arg("--confirm")!=="yes")ctx.fatal("--confirm must be yes");const db=openDb(companyPaths(ctx.companyRoot()).db);try{migrate(db);ctx.emitResult(changeSupplierCommitment(db,{commitmentId:id!,action:action as "paused"|"ended"|"superseded",reason:reason!,confirm:true,actor:ctx.cliActor??process.env.RENTEMESTER_ACTOR,principal:ctx.cliActor??process.env.RENTEMESTER_ACTOR}));}finally{db.close();}});
}
