import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initWorkspace } from "../../src/core/workspace";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import { approvePartyMerge, createParty, linkPartyRole, proposePartyMerge, searchParties } from "../../src/core/party-registry";

const roots: string[] = [];
function db() { const root = mkdtempSync(join(tmpdir(), "rm-party-")); roots.push(root); initWorkspace(root); return openWorkspaceControlDb(root); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("#573 workspace party registry", () => {
  test("supports a single party in customer/vendor roles without leaking defaults", () => {
    const control = db();
    const party = createParty(control, { kind:"organization", name:"Synthetic Shared ApS", identifiers:[{country:"DK",identifier:"12345678",identifierKind:"dk_cvr"}], source:"synthetic",observedAt:"2026-01-01T00:00:00.000Z",reviewAssertion:"checked",actor:"user:maker" });
    linkPartyRole(control,{partyId:party.partyId,companySlug:"alpha",role:"customer",defaults:{currency:"DKK",paymentTermsDays:14},actor:"user:maker"});
    linkPartyRole(control,{partyId:party.partyId,companySlug:"beta",role:"vendor",defaults:{account:"4010",vat:"purchase"},actor:"user:maker"});
    expect(searchParties(control,{companySlugs:new Set(["alpha"])}).rows[0]!.roles).toEqual([{companySlug:"alpha",role:"customer",defaults:{currency:"DKK",paymentTermsDays:14}}]);
    expect(() => linkPartyRole(control,{partyId:party.partyId,companySlug:"alpha",role:"customer",defaults:{currency:"EUR"},actor:"user:maker"})).toThrow("conflicting");
    control.close();
  });
  test("rejects identifier conflicts and requires reviewed append-only merge", () => {
    const control = db();
    const one = createParty(control,{kind:"organization",name:"One",identifiers:[{country:"DK",identifier:"87654321",identifierKind:"dk_cvr"}],source:"synthetic",observedAt:"2026-01-01T00:00:00.000Z",reviewAssertion:"checked",actor:"user:maker"});
    expect(() => createParty(control,{kind:"organization",name:"Duplicate",identifiers:[{country:"DK",identifier:"87654321",identifierKind:"dk_cvr"}],source:"synthetic",observedAt:"2026-01-01T00:00:00.000Z",reviewAssertion:"checked",actor:"user:maker"})).toThrow("conflicts");
    const two = createParty(control,{kind:"person",name:"Two",source:"synthetic",observedAt:"2026-01-01T00:00:00.000Z",reviewAssertion:"checked",actor:"user:maker"});
    const proposal = proposePartyMerge(control,{fromPartyId:two.partyId,intoPartyId:one.partyId,reviewAssertion:"human reviewed",actor:"user:reviewer"});
    expect(approvePartyMerge(control,{fromPartyId:two.partyId,proposalHash:proposal,actor:"user:approver"}).history.map((e:any)=>e.event_type)).toEqual(["created","proposed_merge","approved_merge","superseded"]);
    control.close();
  });
});
