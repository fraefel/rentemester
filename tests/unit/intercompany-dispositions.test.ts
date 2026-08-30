import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../../src/core/workspace";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { createParty } from "../../src/core/party-registry";
import { ingestCorporateRecord } from "../../src/core/corporate-records";
import { approveIntercompanyDisposition, inspectIntercompanyDisposition, proposeIntercompanyDisposition } from "../../src/core/intercompany-dispositions";

const roots:string[]=[];
function setup(){const root=mkdtempSync(join(tmpdir(),"rm-disposition-"));roots.push(root);initWorkspace(root);const db=openWorkspaceControlDb(root);const party=createParty(db,{partyId:"party-synthetic",kind:"organization",name:"Synthetic group",source:"synthetic",observedAt:"2026-01-01T00:00:00Z",reviewAssertion:"reviewed",actor:"user:maker"});const record=ingestCorporateRecord(db,{recordId:"record-synthetic",type:"intercompany_agreement",bytes:new TextEncoder().encode("synthetic evidence"),filename:"agreement.txt",source:"synthetic",receivedAt:"2026-01-01T00:00:00Z",uploader:"synthetic",actor:"user:maker"});return {db,party,record};}
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const payload=(partyId:string,recordId:string)=>({dispositionId:"disp-synthetic",type:"loan",economicDate:"2026-02-01",amount:125.5,currency:"DKK",partyIds:[partyId],evidenceRecordIds:[recordId],left:{companySlug:"alpha",role:"lender",expectedSide:"receivable"},right:{companySlug:"beta",role:"borrower",expectedSide:"payable"}});

describe("#578 intercompany dispositions",()=>{
  test("keeps proposal and approval append-only with stable-principal separation",()=>{const {db,party,record}=setup();const proposed=proposeIntercompanyDisposition(db,payload(party.partyId,record.recordId),{actor:"agent:plan",principal:{kind:"service",id:"service-plan"}});expect(proposed.status).toBe("proposed");expect(()=>approveIntercompanyDisposition(db,"disp-synthetic",proposed.payloadHash,{actor:"user:review",principal:{kind:"service",id:"service-plan"}})).toThrow("distinct stable principal");const approved=approveIntercompanyDisposition(db,"disp-synthetic",proposed.payloadHash,{actor:"user:review",principal:{kind:"user",id:"user-review"}});expect(approved.status).toBe("approved");expect(inspectIntercompanyDisposition(db,"disp-synthetic")?.events.map((event:any)=>event.event_type)).toEqual(["proposed","approved"]);expect(()=>db.run("DELETE FROM rm_intercompany_disposition_events")).toThrow("append-only");db.close();});
  test("rejects incomplete evidence and asymmetric economic sides",()=>{const {db}=setup();expect(()=>proposeIntercompanyDisposition(db,{...payload("missing","missing"),right:{companySlug:"alpha",role:"same",expectedSide:"payable"}},{actor:"user:maker",principal:{kind:"user",id:"maker"}})).toThrow("distinct legal companies");expect(()=>proposeIntercompanyDisposition(db,payload("missing","missing"),{actor:"user:maker",principal:{kind:"user",id:"maker"}})).toThrow("party does not exist");db.close();});
});
