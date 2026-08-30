import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { queryCfoAnalytics } from "../../src/core/cfo-analytics";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug } from "../../src/core/workspace";
import { makeWorkspace, openDb, postPnlEntry, seedArchiveYear } from "./server-api/_shared";

const digest=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex");

describe("#581 source-linked CFO analytics",()=>{
  test("combines live history and archive rows deterministically without mutating a ledger",()=>{
    const ws=makeWorkspace("cfo-analytics",["Alpha ApS"]);
    try { seedArchiveYear(ws,"alpha-aps",2025,[["3000","Supplier spend",120]]); const archiveDb=openDb(companyPaths(companyRootForSlug(ws,"alpha-aps")).db); try { const year=archiveDb.query("SELECT id FROM import_archive_years WHERE fiscal_year=2025").get() as {id:number}; archiveDb.query("INSERT INTO import_archive_postings(archive_year_id,line_no,account_no,account_name,transaction_date,voucher,text,amount) VALUES(?,?,?,?,?,?,?,?)").run(year.id,1,"3000","Supplier spend","2025-06-01","A-1","Synthetic supplier",120); } finally { archiveDb.close(); } postPnlEntry(ws,"alpha-aps","2026-02-10",500,125);
      const db=companyPaths(companyRootForSlug(ws,"alpha-aps")).db, before=digest(db);
      const one=queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2025-01-01",to:"2026-12-31",limit:1});
      const two=queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2025-01-01",to:"2026-12-31",cursor:(one as any).page.nextCursor,limit:200});
      expect((one as any).schemaVersion).toBe("rentemester-cfo-analytics-v1"); expect((one as any).rows[0]).toMatchObject({companySlug:"alpha-aps",sourceType:"archive",journalEntryId:null,documentId:null});
      expect((two as any).rows.some((row:any)=>row.sourceType==="ledger"&&row.journalEntryId!==null&&row.sourceHash)).toBeTrue();
      expect(digest(db)).toBe(before);
    } finally { rmSync(ws,{recursive:true,force:true}); }
  });
  test("portfolio hides inaccessible companies before aggregation and labels the result incomplete",()=>{
    const ws=makeWorkspace("cfo-partial",["Alpha ApS","Hidden ApS"]);
    try { postPnlEntry(ws,"alpha-aps","2026-02-10",500,125); postPnlEntry(ws,"hidden-aps","2026-02-10",900,225);
      const result=queryCfoAnalytics(ws,{scope:"portfolio",companySlugs:["alpha-aps","hidden-aps"],from:"2026-01-01",to:"2026-12-31"},["alpha-aps"]);
      expect(result).toMatchObject({scope:"portfolio",status:"incomplete",partial:true,companies:["alpha-aps"],mode:"juxtaposed-non-consolidated"}); expect((result as any).reconciliation.omitted).toContain("aggregate"); expect(JSON.stringify(result)).not.toContain("hidden-aps");
    } finally { rmSync(ws,{recursive:true,force:true}); }
  });
  test("rejects hidden company scope and malformed cursors without returning a fabricated zero",()=>{
    const ws=makeWorkspace("cfo-reject",["Alpha ApS","Hidden ApS"]);
    try { expect(()=>queryCfoAnalytics(ws,{scope:"company",companySlug:"hidden-aps",from:"2026-01-01",to:"2026-12-31"},["alpha-aps"])).toThrow("not accessible"); expect(()=>queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2026-01-01",to:"2026-12-31",cursor:"bad"})).toThrow("cursor"); }
    finally { rmSync(ws,{recursive:true,force:true}); }
  });
  test("filters deterministically, keeps currencies separate, and fails closed for unsupported dimensions",()=>{
    const ws=makeWorkspace("cfo-filters",["Alpha ApS"]);
    try { postPnlEntry(ws,"alpha-aps","2026-02-10",500,125);
      const result=queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2026-01-01",to:"2026-12-31",account:"1000",currency:"DKK"});
      expect((result as any).rows).toHaveLength(1); expect((result as any).reconciliation.amountByCurrency).toEqual({DKK:-500});
      expect(()=>queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2026-01-01",to:"2026-12-31",dimension:"region"})).toThrow("dimension filtering is unsupported");
    } finally { rmSync(ws,{recursive:true,force:true}); }
  });
  test("reconciles multi-year supplier spend to immutable journal, document and archive sources without duplication",()=>{
    const ws=makeWorkspace("cfo-reconciliation",["Alpha ApS"]);
    try {
      seedArchiveYear(ws,"alpha-aps",2025,[["3000","Supplier spend",120],["2000","Bank",-120]]);
      const archiveDb=openDb(companyPaths(companyRootForSlug(ws,"alpha-aps")).db);
      try {
        const year=archiveDb.query("SELECT id FROM import_archive_years WHERE fiscal_year=2025").get() as {id:number};
        archiveDb.query("INSERT INTO import_archive_postings(archive_year_id,line_no,account_no,account_name,transaction_date,voucher,text,amount) VALUES(?,?,?,?,?,?,?,?)").run(year.id,1,"3000","Supplier spend","2025-06-01","ARCH-1","Synthetic supplier",120);
        archiveDb.query("INSERT INTO import_archive_postings(archive_year_id,line_no,account_no,account_name,transaction_date,voucher,text,amount) VALUES(?,?,?,?,?,?,?,?)").run(year.id,2,"2000","Bank","2025-06-01","ARCH-1","Synthetic supplier",-120);
      } finally { archiveDb.close(); }
      postPnlEntry(ws,"alpha-aps","2026-02-10",0,125);
      const db=companyPaths(companyRootForSlug(ws,"alpha-aps")).db, before=digest(db);
      const input={scope:"company" as const,companySlug:"alpha-aps",from:"2025-01-01",to:"2026-12-31",account:"3000"};
      const first=queryCfoAnalytics(ws,input) as any;
      const second=queryCfoAnalytics(ws,input) as any;
      expect(first).toEqual(second);
      expect(first.reconciliation).toMatchObject({rowCount:2,amountByCurrency:{DKK:245}});
      expect(first.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({sourceType:"archive",sourceId:expect.stringMatching(/^archive:/),journalEntryId:null,documentId:null}),
        expect.objectContaining({sourceType:"ledger",sourceId:expect.stringMatching(/^journal:/),journalEntryId:expect.any(Number),documentId:expect.any(Number),documentHash:expect.stringMatching(/^[a-f0-9]{64}$/),partyName:"Leverandør ApS"}),
      ]));
      // All double-entry ledger rows reconcile to zero when no account filter
      // is applied. Archive and live identities remain distinct and are never
      // deduplicated by a lossy text/date heuristic.
      const trial=queryCfoAnalytics(ws,{...input,account:undefined}) as any;
      expect(trial.reconciliation.amountByCurrency).toEqual({DKK:0});
      expect(new Set(trial.rows.map((row:any)=>row.sourceId)).size).toBe(trial.rows.length);
      expect(digest(db)).toBe(before);
    } finally { rmSync(ws,{recursive:true,force:true}); }
  });
});
