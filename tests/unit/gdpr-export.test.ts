// Tests: src/core/gdpr.ts (GDPR data-subject export — #184)
import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntry } from "../../src/core/ledger";
import { ingestDocument } from "../../src/core/documents";
import { createCustomer, createVendor } from "../../src/core/master-data";
import {
  buildGdprSubjectExport,
  eraseGdprSubject,
  findGdprSubject,
} from "../../src/core/gdpr";
import { verifyAuditLogIntegrity } from "../../src/core/audit-log";

function freshCompany() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-gdpr-export-"));
  const company = join(root, "company");
  const db = openDb(ensureCompanyDirs(company).db);
  migrate(db);
  seedAccounts(db);
  db.run(
    `INSERT INTO companies (id, name, cvr, fiscal_year_start_month, fiscal_year_label_strategy)
     VALUES (1, 'Rentemester ApS', 'DK12345678', 1, 'end-year')`,
  );
  return { root, company, db };
}

function withToday<T>(date: string, run: () => T): T {
  setSystemTime(new Date(`${date}T12:00:00.000Z`));
  try {
    return run();
  } finally {
    setSystemTime();
  }
}

describe("GDPR data-subject export", () => {
  test("gathers all personal data Rentemester holds about a customer", () => {
    const { root, db } = freshCompany();

    const created = createCustomer(db, {
      name: "Persson Privat",
      address: "Privatvej 7, 2200 København N",
      vatOrCvr: "DK55667788",
      email: "persson@example.com",
    });
    expect(created.ok).toBe(true);

    const report = buildGdprSubjectExport(db, { cvr: "DK55667788" });
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(report.ok).toBe(true);
    expect(report.subject.cvr).toBe("DK55667788");
    // The customer master-data record must appear in the export.
    const customerRecords = report.records.filter((r) => r.source === "customers");
    expect(customerRecords.length).toBe(1);
    expect(customerRecords[0]!.personalData).toMatchObject({
      name: "Persson Privat",
      address: "Privatvej 7, 2200 København N",
      email: "persson@example.com",
      vatOrCvr: "DK55667788",
    });
    // Every record carries a retention verdict so the data subject knows why
    // data is kept.
    expect(typeof customerRecords[0]!.retainUntil === "string" || customerRecords[0]!.retainUntil === null).toBe(true);
  });

  test("binds cvr and name to the same party before export, discovery or erasure", () => {
    const { root, db } = freshCompany();
    createCustomer(db, { name: "Alice Andersen", vatOrCvr: "DK11112222" });
    createCustomer(db, { name: "Bob Bertelsen", vatOrCvr: "DK33334444" });

    const mismatchedKey = { cvr: "DK11112222", name: "Bob Bertelsen" };
    const exported = buildGdprSubjectExport(db, mismatchedKey);
    const discovered = findGdprSubject(db, mismatchedKey);
    const erased = withToday("2026-07-18", () =>
      eraseGdprSubject(db, mismatchedKey),
    );
    expect(exported).toMatchObject({ ok: false, records: [] });
    expect(discovered).toMatchObject({ ok: false, rows: [] });
    expect(erased).toMatchObject({ ok: false, erasedCount: 0, refusedCount: 0 });
    expect(exported.errors[0]).toContain("same GDPR subject");

    const auditCount = db
      .query(
        "SELECT COUNT(*) AS n FROM audit_log WHERE event_type LIKE 'gdpr_%'",
      )
      .get() as { n: number };
    const tombstoneCount = db
      .query("SELECT COUNT(*) AS n FROM gdpr_erasures")
      .get() as { n: number };
    expect(auditCount.n).toBe(0);
    expect(tombstoneCount.n).toBe(0);

    const matched = buildGdprSubjectExport(db, {
      cvr: "DK11112222",
      name: "Alice Andersen",
    });
    expect(matched.ok).toBe(true);
    expect(matched.records.filter((row) => row.source === "customers")).toHaveLength(1);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("cvr-only scope resolves structured names for bank, journal and audit text", () => {
    const { root, db } = freshCompany();
    createVendor(db, { name: "Navn Fra CVR", vatOrCvr: "DK55556666" });
    db.run(
      `INSERT INTO bank_transactions
         (transaction_date, text, amount, currency, transaction_hash)
       VALUES ('2026-04-01', 'Betaling Navn Fra CVR', -100, 'DKK', 'gdpr-cvr-bank')`,
    );
    const posted = postJournalEntry(db, {
      transactionDate: "2026-04-01",
      text: "Journal for Navn Fra CVR",
      lines: [
        { accountNo: "1100", debitAmount: 100, text: "Linje Navn Fra CVR" },
        { accountNo: "2000", creditAmount: 100 },
      ],
    });
    expect(posted.ok).toBe(true);
    db.run(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor)
       VALUES ('note', 'vendor', 'DK55556666', 'Note om Navn Fra CVR', 'agent:test')`,
    );

    const report = buildGdprSubjectExport(db, { cvr: "DK55556666" });
    const discovered = findGdprSubject(db, { cvr: "DK55556666" });
    const sources = new Set(report.records.map((row) => row.source));
    expect(report.ok).toBe(true);
    expect(sources).toEqual(
      new Set([
        "vendors",
        "bank_transactions",
        "journal_entries",
        "journal_lines",
        "audit_log",
      ]),
    );
    expect(discovered.ok).toBe(true);
    expect(discovered.byTable.bank_transactions).toBe(1);
    expect(discovered.byTable.journal_entries).toBe(1);
    expect(discovered.byTable.journal_lines).toBe(1);
    expect(discovered.byTable.audit_log).toBeGreaterThanOrEqual(1);

    const laterReport = buildGdprSubjectExport(db, { cvr: "DK55556666" });
    const gdprAuditRows = laterReport.records.filter(
      (row) =>
        row.source === "audit_log" &&
        (row.label === "gdpr_export" || row.label === "gdpr_discover"),
    );
    expect(gdprAuditRows.length).toBeGreaterThanOrEqual(2);
    expect(gdprAuditRows.every((row) => row.retainUntil !== null)).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects an invalid export asOf before reading or audit-logging subject data", () => {
    const { root, db } = freshCompany();
    createCustomer(db, { name: "Dato Kunde", vatOrCvr: "DK77778888" });
    const report = buildGdprSubjectExport(db, {
      cvr: "DK77778888",
      asOf: "2026-02-30",
    });
    const auditCount = db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'gdpr_export'")
      .get() as { n: number };
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(report.ok).toBe(false);
    expect(report.records).toEqual([]);
    expect(report.errors[0]).toContain("valid YYYY-MM-DD");
    expect(auditCount.n).toBe(0);
  });

  test("includes vendor master-data, ingested documents and bank text", () => {
    const { root, company, db } = freshCompany();
    const docFile = join(root, "vendor.txt");
    writeFileSync(docFile, "Vendor invoice\n");

    const vendor = createVendor(db, {
      name: "Leverandør Lind",
      address: "Sælgervej 1, 8000 Aarhus C",
      vatOrCvr: "DK11223344",
    });
    expect(vendor.ok).toBe(true);

    const ingested = ingestDocument(db, company, docFile, {
      source: "email",
      issueDate: "2026-03-01",
      invoiceNo: "GDPR-DOC-1",
      deliveryDescription: "Bogføring",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Leverandør Lind", address: "Sælgervej 1, 8000 Aarhus C", vatOrCvr: "DK11223344" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
    });
    expect(ingested.ok).toBe(true);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, text, amount, currency, transaction_hash)
       VALUES ('2026-03-05', 'Betaling til Leverandør Lind', -1250, 'DKK', 'gdpr-bank-hash-1')`,
    );

    const report = buildGdprSubjectExport(db, { name: "Leverandør Lind" });
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(report.ok).toBe(true);
    const sources = new Set(report.records.map((r) => r.source));
    expect(sources.has("vendors")).toBe(true);
    expect(sources.has("documents")).toBe(true);
    expect(sources.has("bank_transactions")).toBe(true);
    // Document personal data must surface the vendor's name/address.
    const docRecord = report.records.find((r) => r.source === "documents");
    expect(docRecord!.personalData.name).toBe("Leverandør Lind");
  });

  // JUR-8 — the Art. 15 export must also cover the append-only ledger's own
  // free-text: journal_entries.text, journal_lines.text and audit_log.message.
  test("includes ledger free-text (journal entry/line text, audit message)", () => {
    const { root, company, db } = freshCompany();
    const docFile = join(root, "ledgertext.txt");
    writeFileSync(docFile, "Ledger text bilag\n");

    createVendor(db, { name: "Frida Fritekst", vatOrCvr: "DK44556677" });
    const ingested = ingestDocument(db, company, docFile, {
      source: "email",
      issueDate: "2026-03-01",
      invoiceNo: "GDPR-LEDGERTEXT-1",
      deliveryDescription: "Bogføring",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Frida Fritekst", address: "Sælgervej 3", vatOrCvr: "DK44556677" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
    });
    expect(ingested.ok).toBe(true);

    // The subject's name appears in BOTH the entry text and a line text.
    const posted = postJournalEntry(db, {
      transactionDate: "2026-03-02",
      text: "Udlæg refunderet til Frida Fritekst",
      documentId: ingested.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25", text: "Honorar Frida Fritekst" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 },
      ],
    });
    expect(posted.ok).toBe(true);

    const report = buildGdprSubjectExport(db, { name: "Frida Fritekst" });
    expect(report.ok).toBe(true);

    const sources = new Set(report.records.map((r) => r.source));
    expect(sources.has("journal_entries")).toBe(true);
    expect(sources.has("journal_lines")).toBe(true);
    // ingestDocument + the posting both write audit_log messages naming nothing
    // by default, so assert the export at least surfaces ledger text fields it
    // matched on.
    const entryRec = report.records.find((r) => r.source === "journal_entries");
    expect(entryRec!.personalData.name).toContain("Frida Fritekst");
    const lineRec = report.records.find((r) => r.source === "journal_lines");
    expect(lineRec!.personalData.name).toContain("Frida Fritekst");

    // An audit_log message naming the subject is also surfaced.
    db.run(
      `INSERT INTO audit_log (event_type, entity_type, entity_id, message, actor)
       VALUES ('note', 'gdpr_subject', 'DK44556677', 'Manuel note om Frida Fritekst', 'agent:test')`,
    );
    const report2 = buildGdprSubjectExport(db, { name: "Frida Fritekst" });
    const auditRec = report2.records.find((r) => r.source === "audit_log");
    expect(auditRec).toBeDefined();
    expect(auditRec!.personalData.name).toContain("Frida Fritekst");

    // The audit overlay follows the linked bookkeeping retention deadline;
    // once that deadline has passed, its immutable raw row is hidden from
    // future subject exports without changing the audit bytes.
    const erasure = withToday("2032-01-01", () =>
      eraseGdprSubject(db, { name: "Frida Fritekst" }),
    );
    expect(erasure.erased.some((row) => row.source === "audit_log")).toBe(true);
    const afterErasure = buildGdprSubjectExport(db, { name: "Frida Fritekst" });
    const redactedAudit = afterErasure.records.find(
      (row) => row.source === "audit_log" && row.sourceRowId === auditRec!.sourceRowId,
    );
    expect(redactedAudit).toBeDefined();
    expect(redactedAudit!.erased).toBe(true);
    expect(redactedAudit!.personalData.name).not.toContain("Frida Fritekst");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // JUR-8 — erasure must NEVER tombstone hash-chained journal free-text. Audit
  // rows stay immutable too, but may be hidden by an append-only overlay.
  test("erasure never redacts ledger free-text and keeps the audit chain valid", () => {
    const { root, company, db } = freshCompany();
    const docFile = join(root, "erase-ledgertext.txt");
    writeFileSync(docFile, "Erase ledger text bilag\n");

    createVendor(db, { name: "Gustav Gammel", vatOrCvr: "DK66778899" });
    const ingested = ingestDocument(db, company, docFile, {
      source: "email",
      issueDate: "2020-01-02",
      invoiceNo: "GDPR-ERASE-LEDGER-1",
      deliveryDescription: "Bogføring",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Gustav Gammel", address: "Sælgervej 4", vatOrCvr: "DK66778899" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
    });
    postJournalEntry(db, {
      transactionDate: "2020-01-03",
      text: "Gammel postering Gustav Gammel",
      documentId: ingested.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25", text: "Note Gustav Gammel" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 },
      ],
    });

    const result = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: "Gustav Gammel" }),
    );
    expect(result.ok).toBe(true);
    // No ledger-text source may ever appear among the erased records.
    for (const e of result.erased) {
      expect(["journal_entries", "journal_lines"]).not.toContain(e.source);
    }

    // The audit chain stays verifiable after erasure.
    expect(verifyAuditLogIntegrity(db).ok).toBe(true);

    // The ledger text is still present in a fresh export (never mutated).
    const after = buildGdprSubjectExport(db, { name: "Gustav Gammel" });
    const entryRec = after.records.find((r) => r.source === "journal_entries");
    expect(entryRec!.personalData.name).toContain("Gustav Gammel");
    expect(entryRec!.erased).toBe(false);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("reports an empty record set for an unknown subject", () => {
    const { root, db } = freshCompany();
    const report = buildGdprSubjectExport(db, { cvr: "DK99999999" });
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(report.ok).toBe(true);
    expect(report.records.length).toBe(0);
  });

  test("retention verdict reflects a still-retained ingested document", () => {
    const { root, company, db } = freshCompany();
    const docFile = join(root, "vendor.txt");
    writeFileSync(docFile, "Vendor invoice retained\n");

    createVendor(db, { name: "Retent Lev", vatOrCvr: "DK22334455" });
    const ingested = ingestDocument(db, company, docFile, {
      source: "email",
      issueDate: "2026-03-01",
      invoiceNo: "GDPR-RET-1",
      deliveryDescription: "Bogføring",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Retent Lev", address: "Sælgervej 9", vatOrCvr: "DK22334455" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
    });
    postJournalEntry(db, {
      transactionDate: "2026-03-02",
      text: "GDPR retained expense",
      documentId: ingested.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 },
      ],
    });

    const report = buildGdprSubjectExport(db, { cvr: "DK22334455", asOf: "2027-01-01" });
    db.close();
    rmSync(root, { recursive: true, force: true });

    const docRecord = report.records.find((r) => r.source === "documents");
    expect(docRecord).toBeDefined();
    expect(docRecord!.underRetention).toBe(true);
    expect(docRecord!.retainUntil).not.toBeNull();
    expect(docRecord!.retainUntil! > "2027-01-01").toBe(true);
  });
});
