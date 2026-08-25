import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { applyPostingRuleEvaluation, approvePostingRuleVersion, createManualPostingProposal, evaluatePostingRules, linkDocumentVendorIdentity } from "../../src/core/posting-rules";

function setup() {
  const db = new Database(":memory:"); migrate(db);
  db.exec("INSERT INTO companies(id,name,country,currency) VALUES(1,'Alpha','DK','DKK'),(2,'Beta','DK','DKK'); INSERT INTO documents(id,source,sha256_hash) VALUES(1,'test','document-one'),(2,'test','document-two'); INSERT INTO vendors(id,name) VALUES(1,'Synthetic vendor');");
  return db;
}
const proposal = (companyId: number, ruleId = "software") => ({ ruleId, companyId, effectiveFrom: "2026-01-01", conditions: { company: companyId, supplierIdentity: "DK12345678", documentType: "purchase_sale", currency: "DKK", vat: "positive" as const, attributes: { channel: "invoice" } }, outcome: { account: "7410", vatTreatment: "dk_purchase_25", textTemplate: "{supplier}", dimensions: { department: "admin" } }, provenance: "synthetic-test", rationale: "Synthetic deterministic rule", creator: "user:maker", createdAt: "2026-01-01T00:00:00.000Z" });

describe("posting rules", () => {
  test("are company-local, hash-bound and deterministic without priorities", () => {
    const db = setup();
    const alpha = createManualPostingProposal(db, proposal(1));
    const beta = createManualPostingProposal(db, proposal(2));
    expect(alpha.ok && beta.ok).toBe(true);
    expect(approvePostingRuleVersion(db, { companyId: 1, ruleId: "software", version: 1, actor: "user:approver", rationale: "reviewed", provenance: "review", expectedPayloadHash: alpha.payloadHash!, effectiveAt: "2026-01-02" }).ok).toBe(true);
    expect(approvePostingRuleVersion(db, { companyId: 1, ruleId: "software", version: 1, actor: "user:approver", rationale: "reviewed", provenance: "review", expectedPayloadHash: "x".repeat(64), effectiveAt: "2026-01-02" }).ok).toBe(false);
    const facts = { company: 1, supplierIdentity: "DK12345678", documentType: "purchase_sale", currency: "DKK", vatAmount: 25, attributes: { channel: "invoice" } };
    expect(evaluatePostingRules(db, facts, { at: "2026-01-03" }).decision).toBe("proposed");
    expect(evaluatePostingRules(db, { ...facts, company: 2 }, { at: "2026-01-03" }).decision).toBe("human_decision");
    const duplicate = createManualPostingProposal(db, proposal(1));
    expect(duplicate).toMatchObject({ ok: true, duplicate: true, version: 1 });
    db.close();
  });

  test("fails closed and writes one immutable application and deduplicated exception", () => {
    const db = setup(); const made = createManualPostingProposal(db, proposal(1));
    approvePostingRuleVersion(db, { companyId: 1, ruleId: "software", version: 1, actor: "user:approver", rationale: "reviewed", provenance: "review", expectedPayloadHash: made.payloadHash!, effectiveAt: "2026-01-02" });
    const context = { company: 1, documentId: 1, supplierIdentity: "DK12345678", documentType: "purchase_sale", currency: "DKK", vatAmount: 25, attributes: { channel: "invoice" }, changedCurrency: true };
    const first = applyPostingRuleEvaluation(db, context, { applicationKey: "application-1", at: "2026-01-03" });
    const second = applyPostingRuleEvaluation(db, context, { applicationKey: "application-2", at: "2026-01-03" });
    expect(first.decision).toBe("human_decision"); expect(second.exceptionId).toBe(first.exceptionId);
    expect(db.query("SELECT COUNT(*) AS n FROM posting_rule_applications").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM exceptions WHERE type='POSTING_RULE_HUMAN_DECISION'").get()).toEqual({ n: 1 });
    expect(() => db.run("UPDATE posting_rule_applications SET decision='proposed' WHERE id=1")).toThrow("immutable");
    db.close();
  });

  test("stores company-local document/vendor identity links immutably", () => {
    const db = setup();
    expect(linkDocumentVendorIdentity(db, { companyId: 1, documentId: 1, vendorId: 1, supplierIdentity: "DK12345678", provenance: "invoice", rationale: "identified", creator: "user:maker", createdAt: "2026-01-01" }).ok).toBe(true);
    expect(linkDocumentVendorIdentity(db, { companyId: 2, documentId: 1, supplierIdentity: "DK12345678", provenance: "invoice", rationale: "separate company", creator: "user:maker", createdAt: "2026-01-01" }).ok).toBe(true);
    expect(() => db.run("DELETE FROM document_vendor_identity_links WHERE company_id=1")).toThrow("append-only");
    db.close();
  });
});
