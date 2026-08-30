import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { importedReceivableBalanceOre, listImportedReceivables, recordImportedReceivableSchedule, validateImportedReceivableSchedule } from "../../src/core/imported-receivables";

const hash = (letter: string) => letter.repeat(64);
function db() { const value = new Database(":memory:"); value.exec("PRAGMA foreign_keys = ON"); migrate(value); seedAccounts(value); value.query("INSERT INTO dinero_import_sources(id,raw_sha256,raw_size_bytes,canonical_listing_sha256,canonical_listing_count) VALUES(1,?,1,?,0)").run(hash("a"),hash("b")); value.query("INSERT INTO dinero_import_inventories(id,source_id,source_raw_sha256,canonical_listing_sha256,canonical_listing_count,entry_count,total_size_bytes) VALUES(1,1,?,?,0,0,0)").run(hash("a"),hash("b")); value.query("INSERT INTO dinero_import_attempts(id,inventory_id,source_id,source_raw_sha256,parser_contract,actor,cutover_date,outcome,result_sha256) VALUES(1,1,1,?,'synthetic-v1','agent:test','2025-01-01','accepted',?)").run(hash("a"),hash("c")); return value; }
const schedule = { contract:"rentemester-imported-receivables-v1" as const, sourceDocumentHash:hash("d"), invoices:[
  { id:"INV-partial",customerId:"customer-1",customerName:"Synthetic customer",invoiceDate:"2025-01-01",dueDate:"2025-01-15",grossAmount:100,controlAccountNo:"1200",recognitionRef:"opening",documentHash:hash("e"),payments:[{id:"PAY-1",paymentDate:"2025-01-10",amount:25,paymentRef:"voucher-1",documentHash:hash("f")}] },
  { id:"INV-paid",invoiceDate:"2025-01-02",grossAmount:20,controlAccountNo:"1200",recognitionRef:"opening",documentHash:hash("1"),payments:[{id:"PAY-2",paymentDate:"2025-01-03",amount:20,paymentRef:"voucher-2",documentHash:hash("2")}] },
  { id:"INV-credit",invoiceDate:"2025-01-04",grossAmount:40,controlAccountNo:"1200",recognitionRef:"opening",documentHash:hash("3"),payments:[{id:"CN-1",eventKind:"credit_note" as const,paymentDate:"2025-01-05",amount:10,paymentRef:"credit-note-1",documentHash:hash("4")}] },
] };

describe("imported receivables v37", () => {
  test("keeps source-evidenced imported invoices and payments exact at arbitrary cutoffs", () => {
    const value=db(); expect(recordImportedReceivableSchedule(value,1,schedule,"2025-01-31")).toMatchObject({ok:true});
    expect(importedReceivableBalanceOre(value,"2025-01-02","1200").total).toBe(12000n);
    expect(importedReceivableBalanceOre(value,"2025-01-10","1200").total).toBe(10500n);
    expect(importedReceivableBalanceOre(value,"2025-01-31","1200").total).toBe(10500n);
    const evidence=importedReceivableBalanceOre(value,"2025-01-31","1200").evidence; expect(evidence).toHaveLength(3); expect(evidence[0]).toMatchObject({externalInvoiceId:"INV-partial",customerExternalId:"customer-1",sourceDocumentHash:hash("e")});
    value.close();
  });
  test("is replay-safe and fails closed on conflicts and amount-only invented data", () => {
    const value=db(); const first=recordImportedReceivableSchedule(value,1,schedule,"2025-01-31"); expect(first.ok).toBe(true); expect(recordImportedReceivableSchedule(value,1,schedule,"2025-01-31")).toMatchObject({ok:true,scheduleHash:first.scheduleHash});
    expect(recordImportedReceivableSchedule(value,1,{...schedule,invoices:[{...schedule.invoices[0]!,grossAmount:101}]},"2025-01-31").errors.join(" ")).toContain("conflicts with accepted source");
    expect(recordImportedReceivableSchedule(value,1,schedule,"2025-02-01").errors.join(" ")).toContain("control date");
    expect(validateImportedReceivableSchedule({contract:"rentemester-imported-receivables-v1",sourceDocumentHash:hash("a"),invoices:[{id:"x",invoiceDate:"2025-01-01",grossAmount:1,controlAccountNo:"1200"}]}).ok).toBe(false); value.close();
  });
  test("keeps the accepted cut-over boundary append-only", () => {
    const value=db(); expect(recordImportedReceivableSchedule(value,1,schedule,"2025-01-31").ok).toBe(true);
    expect(()=>value.run("UPDATE imported_receivable_boundaries SET control_date='2025-02-01' WHERE dinero_import_attempt_id=1")).toThrow("append-only");
    expect(()=>value.run("DELETE FROM imported_receivable_boundaries WHERE dinero_import_attempt_id=1")).toThrow("append-only");
    value.close();
  });
  test("keeps the archive read model separate from native invoices and exposes its evidence boundary", () => {
    const value=db(); expect(recordImportedReceivableSchedule(value,1,schedule,"2025-01-31").ok).toBe(true);
    const read=listImportedReceivables(value,"2025-01-31");
    expect(read).toMatchObject({ok:true,count:3,totalOpen:105,boundary:expect.stringContaining("native")});
    expect(read.rows.map(row=>row.openBalance)).toEqual([75,0,30]);
    expect(read.rows[0]).toMatchObject({source:"imported",externalInvoiceId:"INV-partial",sourceDocumentHash:hash("e"),scheduleHash:expect.any(String)});
    value.close();
  });
  test("rejects future imported claims and events beyond the authoritative cut-over", () => {
    const futureInvoice={...schedule,invoices:[...schedule.invoices,{...schedule.invoices[0]!,id:"INV-future",invoiceDate:"2025-02-01",payments:[]}]};
    const futureInvoiceResult=validateImportedReceivableSchedule(futureInvoice,"2025-01-31");
    expect(futureInvoiceResult.ok).toBe(false);
    if (!futureInvoiceResult.ok) expect(futureInvoiceResult.errors.join(" ")).toContain("after control date");
    const futurePayment={...schedule,invoices:[{...schedule.invoices[0]!,payments:[{...schedule.invoices[0]!.payments![0]!,paymentDate:"2025-02-01"}]}]};
    const futurePaymentResult=validateImportedReceivableSchedule(futurePayment,"2025-01-31");
    expect(futurePaymentResult.ok).toBe(false);
    if (!futurePaymentResult.ok) expect(futurePaymentResult.errors.join(" ")).toContain("after control date");
  });
});
