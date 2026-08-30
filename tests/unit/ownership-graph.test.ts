import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../../src/core/workspace";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { createParty } from "../../src/core/party-registry";
import { applyOwnershipSnapshot, projectExactCompanyOwnership, proposeOwnershipSnapshot, queryOwnershipGraph, reviewOwnershipSnapshot } from "../../src/core/ownership-graph";

const roots:string[]=[]; const open=()=>{const root=mkdtempSync(join(tmpdir(),"rm-ownership-"));roots.push(root);initWorkspace(root);return openWorkspaceControlDb(root);};
afterEach(()=>{ for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const principal={kind:"user" as const,id:"user-1"};

describe("#576 party-aware ownership graph",()=>{
  test("keeps external owners, intervals and registry changes reviewable before an exact apply",()=>{
    const db=open(); const party=createParty(db,{partyId:"party-owner",kind:"person",name:"Synthetic Person",source:"synthetic",observedAt:"2026-01-01T00:00:00Z",reviewAssertion:"checked",actor:"user:maker"});
    const proposal=proposeOwnershipSnapshot(db,{snapshotId:"snapshot-1",source:"synthetic-registry",observedAt:"2026-02-01T00:00:00Z",actor:"user:maker",principal,facts:[{owner:{kind:"party",partyId:party.partyId},ownedCompanySlug:"alpha",validFrom:"2026-01-01",economicIntervalBasisPoints:{min:2000,max:4000},votingBasisPoints:3500,controlType:"voting",jurisdiction:"DK",evidenceRefs:["record-synthetic"]}]});
    expect(queryOwnershipGraph(db,{asOf:"2026-02-01"}).facts).toEqual([]);
    expect(()=>applyOwnershipSnapshot(db,{snapshotId:proposal.snapshotId,snapshotHash:proposal.snapshotHash,diffHash:proposal.diffHash,actor:"user:maker",principal,authorized:true})).toThrow("approved");
    reviewOwnershipSnapshot(db,{snapshotId:proposal.snapshotId,decision:"approved",actor:"user:reviewer",principal:{kind:"user",id:"user-2"}});
    expect(applyOwnershipSnapshot(db,{snapshotId:proposal.snapshotId,snapshotHash:proposal.snapshotHash,diffHash:proposal.diffHash,actor:"user:reviewer",principal:{kind:"user",id:"user-2"},authorized:true}).status).toBe("applied");
    expect(queryOwnershipGraph(db,{asOf:"2026-02-01"}).consolidation.eligible).toBeFalse();
    expect(queryOwnershipGraph(db,{asOf:"2026-02-01",visibleCompanySlugs:new Set(["beta"])})).toEqual(expect.objectContaining({partial:true,facts:[]}));
    expect(()=>db.run("UPDATE rm_ownership_facts SET owner_id='x'")).toThrow("append-only"); db.close();
  });
  test("does not infer a v1 projection for minority, intervals, cycles or incomplete totals",()=>{
    const db=open(); const make=(id:string,owner:string,child:string,bp:number)=>proposeOwnershipSnapshot(db,{snapshotId:id,source:"synthetic",observedAt:"2026-02-01T00:00:00Z",actor:"user:maker",principal,facts:[{owner:{kind:"company",companySlug:owner},ownedCompanySlug:child,validFrom:"2026-01-01",economicBasisPoints:bp,controlType:"equity",jurisdiction:"DK",evidenceRefs:[id]}]});
    const proposal=make("snapshot-minority","parent","child",4999);reviewOwnershipSnapshot(db,{snapshotId:proposal.snapshotId,decision:"approved",actor:"user:reviewer",principal:{kind:"user",id:"user-2"}});applyOwnershipSnapshot(db,{snapshotId:proposal.snapshotId,snapshotHash:proposal.snapshotHash,diffHash:proposal.diffHash,actor:"user:reviewer",principal:{kind:"user",id:"user-2"},authorized:true});
    expect(projectExactCompanyOwnership(db,"2026-02-01")).toEqual(expect.objectContaining({eligible:false,reason:"incomplete or minority ownership totals"})); db.close();
  });
});
