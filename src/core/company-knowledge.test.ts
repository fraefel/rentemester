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
});
