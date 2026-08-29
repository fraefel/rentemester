import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import {
  applyPostingRuleEvaluationInCurrentTransaction,
  linkDocumentVendorIdentityInCurrentTransaction,
} from "../../src/core/posting-rules";
import { applyStoredPurchaseVatPreflightInCurrentTransaction } from "../../src/core/purchase-vat-preflight";
import { bookExpenseFromBank, bookExpenseFromBankInCurrentTransaction } from "../../src/core/expense-booking";

function count(db: Database, table: string) {
  return Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function fixture() {
  const db = new Database(":memory:");
  migrate(db); seedAccounts(db);
  db.exec(`
    INSERT INTO companies(id,name,country,currency) VALUES(1,'Synthetic','DK','DKK');
    INSERT INTO vendors(id,name) VALUES(1,'Synthetic vendor');
    INSERT INTO documents(
      id,source,sha256_hash,document_type,invoice_date,amount_inc_vat,vat_amount,currency,
      sender_name,sender_vat_cvr,recipient_vat_cvr,supplier_country_code,
      supplier_identifier_kind,supplier_identity_status
    ) VALUES(
      1,'test','transaction-primitives-document','purchase_sale','2026-01-10',100,0,'DKK',
      'Synthetic supplier','DK11223344','DK12345678','DK','dk_cvr','resolved'
    );
    INSERT INTO bank_transactions(id,transaction_date,text,amount,currency,transaction_hash)
      VALUES(1,'2026-01-10','Synthetic payment',-100,'DKK','transaction-primitives-bank');
  `);
  return db;
}

describe("current-transaction bookkeeping primitives", () => {
  test("rolls back rule, identity and VAT evidence when the caller aborts", () => {
    const db = fixture();
    expect(() => db.transaction(() => {
      const rule = applyPostingRuleEvaluationInCurrentTransaction(db, {
        company: 1, documentId: 1, supplierIdentity: "DK11223344", documentType: "purchase_sale", currency: "DKK", vatAmount: 0,
      }, { applicationKey: "synthetic-rule", at: "2026-01-10" });
      expect(rule.decision).toBe("human_decision");
      expect(linkDocumentVendorIdentityInCurrentTransaction(db, {
        companyId: 1, documentId: 1, vendorId: 1, supplierIdentity: "DK11223344", provenance: "synthetic", rationale: "fault injection", creator: "user:synthetic",
      }).ok).toBe(true);
      expect(applyStoredPurchaseVatPreflightInCurrentTransaction(db, 1, { actor: "agent:synthetic" }).ok).toBe(true);
      throw new Error("synthetic outer failure");
    }).immediate()).toThrow("synthetic outer failure");
    expect(count(db, "posting_rule_applications")).toBe(0);
    expect(count(db, "document_vendor_identity_links")).toBe(0);
    expect(count(db, "vat_validation_events")).toBe(0);
    expect(count(db, "exceptions")).toBe(0);
    db.close();
  });

  test("commits all current-transaction effects together without nested transactions", () => {
    const db = fixture();
    db.transaction(() => {
      const rule = applyPostingRuleEvaluationInCurrentTransaction(db, {
        company: 1, documentId: 1, supplierIdentity: "DK11223344", documentType: "purchase_sale", currency: "DKK", vatAmount: 0,
      }, { applicationKey: "synthetic-rule-success", at: "2026-01-10" });
      expect(rule.decision).toBe("human_decision");
      expect(applyStoredPurchaseVatPreflightInCurrentTransaction(db, 1, { actor: "agent:synthetic" }).ok).toBe(true);
      const booked = bookExpenseFromBankInCurrentTransaction(db, {
        documentId: 1, bankTransactionId: 1, expenseAccountNo: "3000", vatTreatment: "exempt", createdBy: "agent:synthetic", createdByProgram: "test",
      });
      expect(booked.ok, JSON.stringify(booked)).toBe(true);
    }).immediate();
    expect(count(db, "posting_rule_applications")).toBe(1);
    expect(count(db, "vat_validation_events")).toBe(1);
    expect(count(db, "journal_entries")).toBe(1);
    expect(count(db, "bank_journal_reconciliations")).toBe(1);
    db.close();
  });

  test("late journal audit failure removes journal, document and bank links from the outer transaction", () => {
    const db = fixture();
    const auditBefore = count(db, "audit_log");
    db.exec("CREATE TRIGGER fail_transaction_primitive_audit BEFORE INSERT ON audit_log WHEN NEW.event_type = 'journal_post' BEGIN SELECT RAISE(ABORT, 'synthetic late journal failure'); END");
    expect(() => db.transaction(() => {
      bookExpenseFromBankInCurrentTransaction(db, {
        documentId: 1, bankTransactionId: 1, expenseAccountNo: "3000", vatTreatment: "exempt", createdBy: "agent:synthetic", createdByProgram: "test",
      });
    }).immediate()).toThrow("synthetic late journal failure");
    expect(count(db, "journal_entries")).toBe(0);
    expect(count(db, "journal_lines")).toBe(0);
    expect(count(db, "audit_log")).toBe(auditBefore);
    expect(count(db, "bank_journal_reconciliations")).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM journal_entries WHERE document_id=1 OR source_bank_transaction_id=1").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("standalone expense booking keeps its existing atomic behavior", () => {
    const db = fixture();
    const booked = bookExpenseFromBank(db, {
      documentId: 1, bankTransactionId: 1, expenseAccountNo: "3000", vatTreatment: "exempt", createdBy: "agent:synthetic", createdByProgram: "test",
    });
    expect(booked.ok, JSON.stringify(booked)).toBe(true);
    expect(count(db, "journal_entries")).toBe(1);
    expect(count(db, "bank_journal_reconciliations")).toBe(1);
    db.close();
  });
});
