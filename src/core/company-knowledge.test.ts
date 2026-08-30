import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceControlDb } from "./workspace-control";
import { proposeCompanyKnowledge, queryCompanyKnowledge, reviewCompanyKnowledge, supersedeCompanyKnowledge } from "./company-knowledge";

const roots:string[]=[]; const root=()=>{const p=mkdtempSync(join(tmpdir(),"rm-knowledge-"));roots.push(p);return p;};
const principal={kind:"local_operator" as const,id:"test-operator"};
afterEach(()=>{for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});});
describe("company knowledge assertions",()=>{
  test("is dated, canonical and fails closed on conflicting approved singleton facts",()=>{const db=openWorkspaceControlDb(root());try{
    const a=proposeCompanyKnowledge(db,{companySlug:"synthetic-a",predicate:"operating_status",value:{state:"active"},source:{kind:"user",ref:"owner-note-1"},validFrom:"2026-01-01",actor:"user:test",principal});
    reviewCompanyKnowledge(db,{assertionId:a.assertionId,decision:"approved",actor:"user:review",principal});
    const b=proposeCompanyKnowledge(db,{companySlug:"synthetic-a",predicate:"operating_status",value:{state:"dormant"},source:{kind:"registry",ref:"snapshot-2"},validFrom:"2026-01-01",actor:"user:test",principal});
    reviewCompanyKnowledge(db,{assertionId:b.assertionId,decision:"approved",actor:"user:review",principal});
    const context=queryCompanyKnowledge(db,{companySlug:"synthetic-a",asOf:"2026-02-01"});
    expect(context.conflicts).toEqual(["operating_status"]);expect(context.safeForProductBehavior).toBeFalse();expect(context.assertions.every(x=>x.reviewState==="conflict")).toBeTrue();
  }finally{db.close();}});
  test("is idempotent and supersedes without rewriting history",()=>{const db=openWorkspaceControlDb(root());try{
    const input={companySlug:"synthetic-a",predicate:"products_services" as const,value:["service"],source:{kind:"user" as const,ref:"brief-1"},validFrom:"2026-01-01",actor:"user:test",principal};
    const first=proposeCompanyKnowledge(db,input),again=proposeCompanyKnowledge(db,input);expect(again.assertionId).toBe(first.assertionId);
    reviewCompanyKnowledge(db,{assertionId:first.assertionId,decision:"approved",actor:"user:review",principal});
    const changed=supersedeCompanyKnowledge(db,{assertionId:first.assertionId,replacement:{predicate:"products_services",value:["service","support"],source:{kind:"user",ref:"brief-2"},validFrom:"2026-02-01"},actor:"user:test",principal});
    expect(changed.superseded.reviewState).toBe("superseded");expect(changed.replacement.reviewState).toBe("proposed");
    expect(()=>db.exec("DELETE FROM rm_company_knowledge_assertions")).toThrow();
  }finally{db.close();}});
  test("keeps current and historical facts separate and a stale registry proposal cannot replace an approved user fact",()=>{const db=openWorkspaceControlDb(root());try{
    const approved=proposeCompanyKnowledge(db,{companySlug:"synthetic-a",predicate:"business_description",value:{text:"Current activity"},source:{kind:"user",ref:"owner-brief"},validFrom:"2026-02-01",actor:"user:author",principal});reviewCompanyKnowledge(db,{assertionId:approved.assertionId,decision:"approved",actor:"user:review",principal});
    const stale=proposeCompanyKnowledge(db,{companySlug:"synthetic-a",predicate:"business_description",value:{text:"Old registry activity"},source:{kind:"registry",ref:"registry-snapshot-2025"},validFrom:"2025-01-01",validToExclusive:"2026-02-01",actor:"agent:registry",principal});
    expect(queryCompanyKnowledge(db,{companySlug:"synthetic-a",asOf:"2025-06-01"}).assertions).toEqual([]);
    const current=queryCompanyKnowledge(db,{companySlug:"synthetic-a",asOf:"2026-03-01",includeProposed:true});expect(current.assertions).toHaveLength(1);expect(current.assertions[0]!.source).toEqual({kind:"user",ref:"owner-brief"});expect(stale.reviewState).toBe("proposed");
  }finally{db.close();}});
  test("rejects missing audit actor and does not duplicate an identical retry",()=>{const db=openWorkspaceControlDb(root());try{
    const input={companySlug:"synthetic-a",predicate:"markets" as const,value:["DK"],source:{kind:"user" as const,ref:"brief"},validFrom:"2026-01-01",actor:"user:author",principal};const first=proposeCompanyKnowledge(db,input);expect(proposeCompanyKnowledge(db,input).assertionId).toBe(first.assertionId);expect(()=>proposeCompanyKnowledge(db,{...input,actor:""})).toThrow("actor");
  }finally{db.close();}});
});
