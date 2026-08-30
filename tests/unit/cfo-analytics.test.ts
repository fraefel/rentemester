import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { queryCfoAnalytics } from "../../src/core/cfo-analytics";
import { companyPaths } from "../../src/core/paths";
import { companyRootForSlug } from "../../src/core/workspace";
import { makeWorkspace, openDb, postPnlEntry, seedArchiveYear } from "./server-api/_shared";

const digest=(file:string)=>createHash("sha256").update(readFileSync(file)).digest("hex");

/** The link event is intentionally inserted as immutable fixture evidence.
 * Analytics must consume the *current* ledger projection; it must never look
 * up party names in the mutable workspace registry. */
function appendPartyLink(db:any, documentId:number, input:{partyId:string;name:string;role?:string;plan?:string;event?:"linked"|"superseded"}) {
  const document=db.query("SELECT sha256_hash,payload_json FROM documents WHERE id=?").get(documentId) as {sha256_hash:string;payload_json:string};
  const payloadHash=createHash("sha256").update(document.payload_json).digest("hex");
  const plan=input.plan??createHash("sha256").update(`${input.partyId}:${input.name}:${input.role??"vendor"}`).digest("hex");
  db.query("INSERT INTO document_party_link_events(document_id,party_id,party_role,event_type,evidence_kind,evidence_json,document_sha256,document_payload_sha256,party_snapshot_json,plan_hash,reason,actor,principal,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    documentId,input.partyId,input.role??"vendor",input.event??"linked","exact_identifier",JSON.stringify({kind:"synthetic_test_evidence"}),document.sha256_hash,payloadHash,JSON.stringify({partyId:input.partyId,kind:"organization",name:input.name}),plan,input.event==="superseded"?"Synthetic replacement":null,"user:test","user:test","2026-08-30T00:00:00.000Z",
  );
  return plan;
}

function firstDocumentId(ws:string, slug:string) {
  const db=openDb(companyPaths(companyRootForSlug(ws,slug)).db);
  try { return (db.query("SELECT id FROM documents ORDER BY id LIMIT 1").get() as {id:number}).id; } finally { db.close(); }
}

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
  test("filters deterministically, keeps currencies separate, and returns no rows for an unassigned dimension",()=>{
    const ws=makeWorkspace("cfo-filters",["Alpha ApS"]);
    try { postPnlEntry(ws,"alpha-aps","2026-02-10",500,125);
      const result=queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2026-01-01",to:"2026-12-31",account:"1000",currency:"DKK"});
      expect((result as any).rows).toHaveLength(1); expect((result as any).reconciliation.amountByCurrency).toEqual({DKK:-500});
      expect((queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2026-01-01",to:"2026-12-31",dimension:"region"}) as any).rows).toEqual([]);
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
        expect.objectContaining({sourceType:"ledger",sourceId:expect.stringMatching(/^journal:/),journalEntryId:expect.any(Number),documentId:expect.any(Number),documentHash:expect.stringMatching(/^[a-f0-9]{64}$/),partyId:null,partyName:null,documentPartyName:"Leverandør ApS"}),
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
  test("uses the current immutable document-party snapshot without name inference",()=>{
    const ws=makeWorkspace("cfo-party-current",["Alpha ApS"]);
    try {
      postPnlEntry(ws,"alpha-aps","2026-02-10",0,125);
      const db=openDb(companyPaths(companyRootForSlug(ws,"alpha-aps")).db);
      try { appendPartyLink(db,firstDocumentId(ws,"alpha-aps"),{partyId:"party-canonical",name:"Canonical supplier name"}); } finally { db.close(); }
      const rows=(queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2026-01-01",to:"2026-12-31"}) as any).rows.filter((row:any)=>row.sourceType==="ledger");
      expect(rows).not.toHaveLength(0);
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({partyId:"party-canonical",partyName:"Canonical supplier name",documentPartyName:"Leverandør ApS",partyLinkProvenance:expect.objectContaining({role:"vendor",evidenceKind:"exact_identifier"})})]));
    } finally { rmSync(ws,{recursive:true,force:true}); }
  });
  test("ignores superseded links and selects one current link without duplicate journal rows",()=>{
    const ws=makeWorkspace("cfo-party-superseded",["Alpha ApS"]);
    try {
      postPnlEntry(ws,"alpha-aps","2026-02-10",0,125);
      const db=openDb(companyPaths(companyRootForSlug(ws,"alpha-aps")).db);
      try {
        const documentId=firstDocumentId(ws,"alpha-aps");
        const retired=appendPartyLink(db,documentId,{partyId:"party-retired",name:"Retired supplier",plan:"a".repeat(64)});
        appendPartyLink(db,documentId,{partyId:"party-retired",name:"Retired supplier",plan:retired,event:"superseded"});
        appendPartyLink(db,documentId,{partyId:"party-current",name:"Current supplier",role:"supplier",plan:"b".repeat(64)});
      } finally { db.close(); }
      const rows=(queryCfoAnalytics(ws,{scope:"company",companySlug:"alpha-aps",from:"2026-01-01",to:"2026-12-31"}) as any).rows.filter((row:any)=>row.sourceType==="ledger");
      expect(rows).toHaveLength(3);
      expect(rows.every((row:any)=>row.partyId==="party-current"&&row.partyName==="Current supplier")).toBeTrue();
      expect(new Set(rows.map((row:any)=>row.sourceId)).size).toBe(rows.length);
    } finally { rmSync(ws,{recursive:true,force:true}); }
  });
  test("does not leak a linked party from another legal company",()=>{
    const ws=makeWorkspace("cfo-party-isolation",["Alpha ApS","Hidden ApS"]);
    try {
      postPnlEntry(ws,"alpha-aps","2026-02-10",0,125); postPnlEntry(ws,"hidden-aps","2026-02-10",0,125);
      for (const [slug,partyId,name] of [["alpha-aps","party-alpha","Alpha canonical"],["hidden-aps","party-hidden","Hidden canonical"]] as const) {
        const db=openDb(companyPaths(companyRootForSlug(ws,slug)).db); try { appendPartyLink(db,firstDocumentId(ws,slug),{partyId,name}); } finally { db.close(); }
      }
      const result=queryCfoAnalytics(ws,{scope:"portfolio",companySlugs:["alpha-aps","hidden-aps"],from:"2026-01-01",to:"2026-12-31"},["alpha-aps"]);
      expect(JSON.stringify(result)).toContain("party-alpha");
      expect(JSON.stringify(result)).not.toContain("party-hidden");
      expect(JSON.stringify(result)).not.toContain("Hidden canonical");
    } finally { rmSync(ws,{recursive:true,force:true}); }
  });
});
