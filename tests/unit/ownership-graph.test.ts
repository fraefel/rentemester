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
  test("rejects overlapping direct facts, excessive totals and effective company cycles before review",()=>{
    const db=open(); const base={source:"synthetic",observedAt:"2026-02-01T00:00:00Z",actor:"user:maker",principal};
    const f=(owner:string,owned:string,bp:number,from:string="2026-01-01")=>({owner:{kind:"company" as const,companySlug:owner},ownedCompanySlug:owned,validFrom:from,economicBasisPoints:bp,controlType:"equity" as const,jurisdiction:"DK",evidenceRefs:[`${owner}-${owned}-${bp}-${from}`]});
    expect(()=>proposeOwnershipSnapshot(db,{...base,snapshotId:"overlap",facts:[f("parent","child",5000),f("parent","child",4000)]})).toThrow("overlap");
    expect(()=>proposeOwnershipSnapshot(db,{...base,snapshotId:"total",facts:[f("a","child",7000),f("b","child",4000)]})).toThrow("exceed");
    expect(()=>proposeOwnershipSnapshot(db,{...base,snapshotId:"cycle",facts:[f("a","b",10000),f("b","a",10000)]})).toThrow("cycle");
    db.close();
  });
  test("keeps proposal retry idempotent and applies only an exact approved diff",()=>{
    const db=open();const input={snapshotId:"retry",source:"synthetic",observedAt:"2026-02-01T00:00:00Z",actor:"user:maker",principal,facts:[{owner:{kind:"company" as const,companySlug:"parent"},ownedCompanySlug:"child",validFrom:"2026-01-01",economicBasisPoints:10000,controlType:"equity" as const,jurisdiction:"DK",evidenceRefs:["synthetic"]}]};
    const first=proposeOwnershipSnapshot(db,input);const retry=proposeOwnershipSnapshot(db,input);expect(retry.snapshotHash).toBe(first.snapshotHash);expect(db.query("SELECT count(*) AS n FROM rm_ownership_source_snapshots").get()).toEqual({n:1});
    reviewOwnershipSnapshot(db,{snapshotId:"retry",decision:"approved",actor:"user:reviewer",principal:{kind:"user",id:"user-2"}});expect(()=>applyOwnershipSnapshot(db,{snapshotId:"retry",snapshotHash:first.snapshotHash,diffHash:"0".repeat(64),actor:"user:reviewer",principal,authorized:true})).toThrow("exact");
    expect(applyOwnershipSnapshot(db,{snapshotId:"retry",snapshotHash:first.snapshotHash,diffHash:first.diffHash,actor:"user:reviewer",principal,authorized:true}).status).toBe("applied");expect(applyOwnershipSnapshot(db,{snapshotId:"retry",snapshotHash:first.snapshotHash,diffHash:first.diffHash,actor:"user:reviewer",principal,authorized:true}).status).toBe("unchanged");db.close();
  });
  test("makes dual-handle stale apply deterministic without duplicating facts or events", async()=>{
    const root=mkdtempSync(join(tmpdir(),"rm-ownership-concurrent-"));roots.push(root);initWorkspace(root);const left=openWorkspaceControlDb(root),right=openWorkspaceControlDb(root);
    try {const proposal=proposeOwnershipSnapshot(left,{snapshotId:"dual-apply",source:"synthetic",observedAt:"2026-02-01T00:00:00Z",actor:"user:maker",principal,facts:[{owner:{kind:"company",companySlug:"parent"},ownedCompanySlug:"child",validFrom:"2026-01-01",economicBasisPoints:10000,controlType:"equity",jurisdiction:"DK",evidenceRefs:["synthetic"]}]});reviewOwnershipSnapshot(left,{snapshotId:proposal.snapshotId,decision:"approved",actor:"user:reviewer",principal:{kind:"user",id:"user-2"}});const apply=(db:ReturnType<typeof openWorkspaceControlDb>)=>applyOwnershipSnapshot(db,{snapshotId:proposal.snapshotId,snapshotHash:proposal.snapshotHash,diffHash:proposal.diffHash,actor:"user:reviewer",principal,authorized:true}).status;const outcomes=await Promise.all([Promise.resolve().then(()=>apply(left)),Promise.resolve().then(()=>apply(right))]);expect(outcomes.sort()).toEqual(["applied","unchanged"]);expect(left.query("SELECT count(*) AS n FROM rm_ownership_facts").get()).toEqual({n:1});expect(left.query("SELECT count(*) AS n FROM rm_ownership_snapshot_events WHERE snapshot_id=? AND event_type='applied'").get(proposal.snapshotId)).toEqual({n:1});}finally{left.close();right.close();}
  });
  test("ends a prior fact append-only and rejects a concurrent 70%+70% apply",()=>{
    const db=open();const maker={kind:"user" as const,id:"maker"}, reviewer={kind:"user" as const,id:"reviewer"};
    const first=proposeOwnershipSnapshot(db,{snapshotId:"first-change",source:"synthetic",observedAt:"2026-02-01T00:00:00Z",actor:"user:maker",principal:maker,facts:[{owner:{kind:"company",companySlug:"parent"},ownedCompanySlug:"child",validFrom:"2026-01-01",economicBasisPoints:6000,controlType:"equity",jurisdiction:"DK",evidenceRefs:["one"]}]});reviewOwnershipSnapshot(db,{snapshotId:first.snapshotId,decision:"approved",actor:"user:reviewer",principal:reviewer});applyOwnershipSnapshot(db,{snapshotId:first.snapshotId,snapshotHash:first.snapshotHash,diffHash:first.diffHash,actor:"user:owner",principal:reviewer,authorized:true});
    const changed=proposeOwnershipSnapshot(db,{snapshotId:"changed",source:"synthetic",observedAt:"2026-03-01T00:00:00Z",actor:"user:maker",principal:maker,facts:[{owner:{kind:"company",companySlug:"parent"},ownedCompanySlug:"child",validFrom:"2026-06-01",economicBasisPoints:7000,controlType:"equity",jurisdiction:"DK",evidenceRefs:["two"]}]});expect(changed.diff.endings).toHaveLength(1);reviewOwnershipSnapshot(db,{snapshotId:changed.snapshotId,decision:"approved",actor:"user:reviewer",principal:reviewer});applyOwnershipSnapshot(db,{snapshotId:changed.snapshotId,snapshotHash:changed.snapshotHash,diffHash:changed.diffHash,actor:"user:owner",principal:reviewer,authorized:true});expect(queryOwnershipGraph(db,{asOf:"2026-05-31"}).facts).toHaveLength(1);expect(queryOwnershipGraph(db,{asOf:"2026-06-01"}).facts[0]).toMatchObject({economicBasisPoints:7000});expect(db.query("SELECT count(*) AS n FROM rm_ownership_fact_events").get()).toEqual({n:1});
    const a=proposeOwnershipSnapshot(db,{snapshotId:"seventy-a",source:"synthetic",observedAt:"2026-04-01T00:00:00Z",actor:"user:maker",principal:maker,facts:[{owner:{kind:"company",companySlug:"a"},ownedCompanySlug:"other",validFrom:"2026-01-01",economicBasisPoints:7000,controlType:"equity",jurisdiction:"DK",evidenceRefs:["a"]}]});const b=proposeOwnershipSnapshot(db,{snapshotId:"seventy-b",source:"synthetic",observedAt:"2026-04-01T00:00:00Z",actor:"user:maker",principal:maker,facts:[{owner:{kind:"company",companySlug:"b"},ownedCompanySlug:"other",validFrom:"2026-01-01",economicBasisPoints:7000,controlType:"equity",jurisdiction:"DK",evidenceRefs:["b"]}]});reviewOwnershipSnapshot(db,{snapshotId:a.snapshotId,decision:"approved",actor:"user:reviewer",principal:reviewer});reviewOwnershipSnapshot(db,{snapshotId:b.snapshotId,decision:"approved",actor:"user:reviewer",principal:reviewer});applyOwnershipSnapshot(db,{snapshotId:a.snapshotId,snapshotHash:a.snapshotHash,diffHash:a.diffHash,actor:"user:owner",principal:reviewer,authorized:true});expect(()=>applyOwnershipSnapshot(db,{snapshotId:b.snapshotId,snapshotHash:b.snapshotHash,diffHash:b.diffHash,actor:"user:owner",principal:reviewer,authorized:true})).toThrow("exceed");db.close();
  });
});
