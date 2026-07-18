// Tests: src/core/gdpr.ts (GDPR retention-respecting erasure — #184)
import { describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { openDb, migrate } from "../../src/core/db";
import { seedAccounts, postJournalEntry, verifyAuditChain } from "../../src/core/ledger";
import { ingestDocument } from "../../src/core/documents";
import { createCustomer, createVendor } from "../../src/core/master-data";
import {
  buildGdprSubjectExport,
  eraseGdprSubject,
  findGdprSubject,
} from "../../src/core/gdpr";

function freshCompany(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-${prefix}-`));
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

function subjectReferenceForTest(identity: string): string {
  return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

describe("GDPR erasure respects bookkeeping retention", () => {
  test("refuses to erase a customer whose data is still under retention", () => {
    const { root, company, db } = freshCompany("gdpr-erase-refuse");
    const docFile = join(root, "doc.txt");
    writeFileSync(docFile, "Vendor invoice under retention\n");

    createVendor(db, { name: "Aktiv Lev", vatOrCvr: "DK33445566" });
    const ingested = ingestDocument(db, company, docFile, {
      source: "email",
      issueDate: "2026-03-01",
      invoiceNo: "GDPR-ERASE-1",
      deliveryDescription: "Bogføring",
      amountIncVat: 1250,
      currency: "DKK",
      sender: { name: "Aktiv Lev", address: "Sælgervej 3", vatOrCvr: "DK33445566" },
      recipient: { name: "Rentemester ApS", address: "Testvej 1", vatOrCvr: "DK12345678" },
      vatAmount: 250,
    });
    postJournalEntry(db, {
      transactionDate: "2026-03-02",
      text: "GDPR erase expense",
      documentId: ingested.documentId,
      lines: [
        { accountNo: "3000", debitAmount: 1000, vatCode: "DK_PURCHASE_25" },
        { accountNo: "4000", debitAmount: 250 },
        { accountNo: "2000", creditAmount: 1250 },
      ],
    });

    // A forged future asOf is ignored: erasure uses the trusted application
    // clock, pinned here inside the retention window.
    const result = (() => {
      const previousOverride = process.env.RENTEMESTER_TODAY;
      process.env.RENTEMESTER_TODAY = "2099-01-01";
      try {
        return withToday("2027-06-01", () =>
          eraseGdprSubject(
            db,
            { cvr: "DK33445566", asOf: "2099-01-01" } as unknown as {
              cvr: string;
            },
            { createdBy: "agent:gdpr-test", createdByProgram: "bun-test" },
          ),
        );
      } finally {
        if (previousOverride === undefined) delete process.env.RENTEMESTER_TODAY;
        else process.env.RENTEMESTER_TODAY = previousOverride;
      }
    })();
    const refusalAudit = db
      .query(
        "SELECT actor, entity_id, message FROM audit_log WHERE event_type = 'gdpr_erasure_decision'",
      )
      .all() as Array<{ actor: string; entity_id: string; message: string }>;
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(result.ok).toBe(true);
    expect(result.asOf).toBe("2027-06-01");
    expect(result.erasedCount).toBe(0);
    expect(result.refusedCount).toBeGreaterThan(0);
    const refusedSources = new Set(result.refused.map((r) => r.source));
    expect(refusedSources.has("documents")).toBe(true);
    // Refusals must carry the retention deadline as a clear, legal reason.
    expect(result.refused.every((r) => typeof r.retainUntil === "string")).toBe(true);
    expect(result.refused.every((r) => /retention/i.test(r.reason))).toBe(true);
    expect(refusalAudit.length).toBeGreaterThan(0);
    expect(refusalAudit.every((row) => row.actor === "agent:gdpr-test via bun-test")).toBe(
      true,
    );
    expect(refusalAudit.every((row) => /^sha256:/.test(row.entity_id))).toBe(true);
    expect(refusalAudit.every((row) => !row.message.includes("DK33445566"))).toBe(true);
  });

  test("erases personal data once it is no longer under retention", () => {
    const { root, db } = freshCompany("gdpr-erase-allowed");

    // A customer with no linked documents / bank rows — nothing keeps it.
    const created = createCustomer(db, {
      name: "Forhenværende Kunde",
      address: "Gammelvej 5, 5000 Odense C",
      vatOrCvr: "DK44556677",
      email: "gammel@example.com",
    });
    expect(created.ok).toBe(true);

    const result = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: "Forhenværende Kunde" }),
    );
    expect(result.ok).toBe(true);
    expect(result.erasedCount).toBeGreaterThan(0);
    expect(result.refusedCount).toBe(0);

    // After erasure, the export no longer exposes the personal fields.
    const report = buildGdprSubjectExport(db, { cvr: "DK44556677", asOf: "2099-01-01" });
    const discovery = findGdprSubject(db, { cvr: "DK44556677" });
    db.close();
    rmSync(root, { recursive: true, force: true });

    const customerRecord = report.records.find((r) => r.source === "customers");
    expect(customerRecord).toBeDefined();
    expect(customerRecord!.erased).toBe(true);
    expect(customerRecord!.erasable).toBe(false);
    expect(customerRecord!.label).not.toBe("Forhenværende Kunde");
    expect(customerRecord!.personalData.name).not.toBe("Forhenværende Kunde");
    expect(customerRecord!.personalData.email).toBeNull();
    expect(customerRecord!.personalData.address).toBeNull();
    const discoveredCustomer = discovery.rows.find(
      (row) => row.source === "customers",
    );
    expect(discoveredCustomer!.erased).toBe(true);
    expect(discoveredCustomer!.label).not.toBe("Forhenværende Kunde");
    expect(discoveredCustomer!.personalData.name).not.toBe("Forhenværende Kunde");
  });

  test("refuses ambiguous name-only scopes instead of combining two people", () => {
    const { root, db } = freshCompany("gdpr-erase-ambiguous-name");
    createCustomer(db, { name: "Samme Navn", vatOrCvr: "DK11110000" });
    createCustomer(db, { name: "Samme Navn", vatOrCvr: "DK22220000" });

    const exported = buildGdprSubjectExport(db, { name: "Samme Navn" });
    const discovered = findGdprSubject(db, { name: "Samme Navn" });
    const erased = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: "Samme Navn" }),
    );
    const tombstones = db
      .query("SELECT COUNT(*) AS n FROM gdpr_erasures")
      .get() as { n: number };

    expect(exported.ok).toBe(false);
    expect(discovered.ok).toBe(false);
    expect(erased.ok).toBe(false);
    expect(erased.errors[0]).toContain("multiple GDPR subjects");
    expect(tombstones.n).toBe(0);

    db.run("INSERT INTO customers (name) VALUES ('Uden CVR')");
    db.run("INSERT INTO customers (name) VALUES ('Uden CVR')");
    const noCvrExport = buildGdprSubjectExport(db, { name: "Uden CVR" });
    const noCvrDiscovery = findGdprSubject(db, { name: "Uden CVR" });
    const noCvrErasure = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: "Uden CVR" }),
    );
    const afterNoCvr = db
      .query("SELECT COUNT(*) AS n FROM gdpr_erasures")
      .get() as { n: number };
    expect(noCvrExport.ok).toBe(false);
    expect(noCvrDiscovery.ok).toBe(false);
    expect(noCvrErasure.ok).toBe(false);
    expect(noCvrErasure.errors[0]).toContain("multiple GDPR subjects");
    expect(afterNoCvr.n).toBe(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("reports immutable journal-only matches as explicit refusals", () => {
    const { root, db } = freshCompany("gdpr-erase-journal-only");
    const posted = postJournalEntry(db, {
      transactionDate: "2000-01-02",
      text: "Journal Only Person",
      lines: [
        { accountNo: "1100", debitAmount: 100, text: "Journal Only Person" },
        { accountNo: "2000", creditAmount: 100 },
      ],
    });
    expect(posted.ok).toBe(true);

    const before = buildGdprSubjectExport(db, { name: "Journal Only Person" });
    const result = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: "Journal Only Person" }),
    );
    const decisions = db
      .query(
        "SELECT message FROM audit_log WHERE event_type = 'gdpr_erasure_decision'",
      )
      .all() as Array<{ message: string }>;

    expect(
      before.records
        .filter((row) => row.source.startsWith("journal_"))
        .every((row) => row.erasable === false),
    ).toBe(true);
    expect(result.erasedCount).toBe(0);
    expect(result.refusedCount).toBeGreaterThanOrEqual(2);
    expect(
      result.refused.every((row) => row.reason.includes("journal integrity")),
    ).toBe(true);
    expect(
      decisions.some((row) => row.message.includes("refused_ledger_integrity")),
    ).toBe(true);
    expect(
      decisions.some((row) => row.message.includes("no_matching_records")),
    ).toBe(false);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("scopes a shared document tombstone to the erased subject", () => {
    const { root, company, db } = freshCompany("gdpr-erase-shared-document");
    const docFile = join(root, "shared-subjects.txt");
    writeFileSync(docFile, "Old invoice shared by sender and recipient\n");
    createVendor(db, { name: "Afsender Alice", vatOrCvr: "DK30303030" });
    const ingested = ingestDocument(db, company, docFile, {
      source: "email",
      issueDate: "2000-03-01",
      invoiceNo: "GDPR-SHARED-1",
      deliveryDescription: "Historisk ydelse",
      amountIncVat: 1250,
      currency: "DKK",
      sender: {
        name: "Afsender Alice",
        address: "Afsendervej 1",
        vatOrCvr: "DK30303030",
      },
      recipient: {
        name: "Rentemester ApS",
        address: "Modtagervej 1",
        vatOrCvr: "DK12345678",
      },
      vatAmount: 250,
    });
    expect(ingested.ok).toBe(true);

    const senderErasure = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { cvr: "DK30303030" }),
    );
    expect(
      senderErasure.erased.some(
        (row) =>
          row.source === "documents" && row.sourceRowId === ingested.documentId,
      ),
    ).toBe(true);

    const recipientReport = buildGdprSubjectExport(db, {
      cvr: "DK12345678",
    });
    const recipientDocument = recipientReport.records.find(
      (row) =>
        row.source === "documents" && row.sourceRowId === ingested.documentId,
    );
    expect(recipientDocument).toBeDefined();
    expect(recipientDocument!.erased).toBe(false);
    expect(recipientDocument!.personalData.name).toBe("Rentemester ApS");

    const recipientErasure = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { cvr: "DK12345678" }),
    );
    expect(
      recipientErasure.erased.some(
        (row) =>
          row.source === "documents" && row.sourceRowId === ingested.documentId,
      ),
    ).toBe(true);
    const documentTombstones = db
      .query(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT subject_key) AS subjects
           FROM gdpr_erasures
          WHERE source = 'documents' AND source_row_id = ?`,
      )
      .get(ingested.documentId) as { n: number; subjects: number };
    expect(documentTombstones.n).toBeGreaterThanOrEqual(2);
    expect(documentTombstones.subjects).toBe(documentTombstones.n);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("does not share a name tombstone between same-name document parties", () => {
    const { root, company, db } = freshCompany("gdpr-erase-shared-name-document");
    const docFile = join(root, "shared-name-subjects.txt");
    writeFileSync(docFile, "Old invoice between two same-name parties\n");
    const sharedName = "Same Name ApS";
    const senderCvr = "DK40404040";
    const recipientCvr = "DK50505050";
    createVendor(db, { name: sharedName, vatOrCvr: senderCvr });
    const ingested = ingestDocument(db, company, docFile, {
      source: "email",
      issueDate: "2000-04-01",
      invoiceNo: "GDPR-SHARED-NAME-1",
      deliveryDescription: "Historisk ydelse",
      amountIncVat: 1250,
      currency: "DKK",
      sender: {
        name: sharedName,
        address: "Afsendervej 1",
        vatOrCvr: senderCvr,
      },
      recipient: {
        name: sharedName,
        address: "Modtagervej 1",
        vatOrCvr: recipientCvr,
      },
      vatAmount: 250,
    });
    expect(ingested.ok).toBe(true);

    const senderErasure = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { cvr: senderCvr }),
    );
    expect(
      senderErasure.erased.some(
        (row) =>
          row.source === "documents" && row.sourceRowId === ingested.documentId,
      ),
    ).toBe(true);

    const recipientReport = buildGdprSubjectExport(db, {
      cvr: recipientCvr,
    });
    const recipientDocument = recipientReport.records.find(
      (row) =>
        row.source === "documents" && row.sourceRowId === ingested.documentId,
    );
    expect(recipientDocument).toBeDefined();
    expect(recipientDocument!.erased).toBe(false);
    expect(recipientDocument!.personalData).toEqual({
      name: sharedName,
      address: "Modtagervej 1",
      email: null,
      vatOrCvr: recipientCvr,
    });

    const nameReference = subjectReferenceForTest(`name:${sharedName}`);
    const leakedNameTombstone = db
      .query(
        `SELECT COUNT(*) AS n
           FROM gdpr_erasures
          WHERE subject_key = ? AND source = 'documents' AND source_row_id = ?`,
      )
      .get(nameReference, ingested.documentId) as { n: number };
    expect(leakedNameTombstone.n).toBe(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps erasures visible when a name-only identity later gains a CVR", () => {
    const { root, db } = freshCompany("gdpr-erase-identity-evolution");
    db.run(
      `INSERT INTO bank_transactions
         (transaction_date, text, amount, currency, transaction_hash)
       VALUES ('2000-01-02', 'Betaling Evolving Person', -100, 'DKK', 'gdpr-evolving-bank')`,
    );

    const erasedByName = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: "Evolving Person" }),
    );
    expect(
      erasedByName.erased.some((row) => row.source === "bank_transactions"),
    ).toBe(true);
    const beforeEnrichment = buildGdprSubjectExport(db, {
      name: "Evolving Person",
    }).records.find((row) => row.source === "bank_transactions");
    expect(beforeEnrichment!.erased).toBe(true);

    createCustomer(db, {
      name: "Evolving Person",
      vatOrCvr: "DK81818181",
    });
    const afterEnrichment = buildGdprSubjectExport(db, {
      cvr: "DK81818181",
    });
    const evolvedBank = afterEnrichment.records.find(
      (row) => row.source === "bank_transactions",
    );
    const priorPseudonymousEvents = afterEnrichment.records.filter(
      (row) =>
        row.source === "audit_log" &&
        row.label === "gdpr_erasure_decision",
    );
    const evolvedDiscovery = findGdprSubject(db, { cvr: "DK81818181" });
    const discoveredBank = evolvedDiscovery.rows.find(
      (row) => row.source === "bank_transactions",
    );

    expect(evolvedBank).toBeDefined();
    expect(evolvedBank!.erased).toBe(true);
    expect(evolvedBank!.personalData.name).not.toContain("Evolving Person");
    expect(discoveredBank!.erased).toBe(true);
    expect(discoveredBank!.personalData.name).not.toContain("Evolving Person");
    expect(priorPseudonymousEvents.length).toBeGreaterThan(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps a no-CVR master-row erasure visible after enrichment creates a new row", () => {
    const { root, db } = freshCompany("gdpr-erase-new-enriched-row");
    createCustomer(db, { name: "Row Evolving Person" });
    db.run(
      `INSERT INTO bank_transactions
         (transaction_date, text, amount, currency, transaction_hash)
       VALUES ('2000-01-02', 'Betaling Row Evolving Person', -100, 'DKK', 'gdpr-row-evolving-bank')`,
    );

    const erasedByName = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: "Row Evolving Person" }),
    );
    expect(
      erasedByName.erased.some((row) => row.source === "bank_transactions"),
    ).toBe(true);

    createCustomer(db, {
      name: "Row Evolving Person",
      vatOrCvr: "DK82828282",
    });
    const enriched = buildGdprSubjectExport(db, { cvr: "DK82828282" });
    const enrichedBank = enriched.records.find(
      (row) => row.source === "bank_transactions",
    );
    const priorAuditEvents = enriched.records.filter(
      (row) =>
        row.source === "audit_log" &&
        row.label === "gdpr_erasure_decision",
    );

    expect(enrichedBank).toBeDefined();
    expect(enrichedBank!.erased).toBe(true);
    expect(enrichedBank!.personalData.name).not.toContain("Row Evolving Person");
    expect(priorAuditEvents.length).toBeGreaterThan(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("binds a safe name erasure to CVR before a later name collision", () => {
    const { root, db } = freshCompany("gdpr-erase-late-name-collision");
    const sharedName = "Late Ambiguous Person";
    const firstCvr = "DK70707070";
    db.run(
      `INSERT INTO bank_transactions
         (transaction_date, text, amount, currency, transaction_hash)
       VALUES ('2000-01-02', ?, -100, 'DKK', 'gdpr-late-ambiguous-bank')`,
      [`Betaling ${sharedName} ${firstCvr}`],
    );

    const erasedByName = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { name: sharedName }),
    );
    const bankRow = erasedByName.erased.find(
      (row) => row.source === "bank_transactions",
    );
    expect(bankRow).toBeDefined();

    const otherCvr = "DK71717171";
    createCustomer(db, {
      name: sharedName,
      vatOrCvr: otherCvr,
    });
    const otherReference = subjectReferenceForTest(`cvr:${otherCvr}`);
    const incorrectlyBound = db
      .query(
        `SELECT COUNT(*) AS n
           FROM gdpr_erasures
          WHERE subject_key = ?
            AND source = 'bank_transactions'
            AND source_row_id = ?`,
      )
      .get(otherReference, bankRow!.sourceRowId) as { n: number };
    expect(incorrectlyBound.n).toBe(0);

    createCustomer(db, { name: sharedName, vatOrCvr: firstCvr });
    const cvrReference = subjectReferenceForTest(`cvr:${firstCvr}`);
    const strengthened = db
      .query(
        `SELECT COUNT(*) AS n
           FROM gdpr_erasures
          WHERE subject_key = ?
            AND source = 'bank_transactions'
            AND source_row_id = ?`,
      )
      .get(cvrReference, bankRow!.sourceRowId) as { n: number };
    expect(strengthened.n).toBe(1);

    const firstCvrExport = buildGdprSubjectExport(db, { cvr: firstCvr });
    const afterBank = firstCvrExport.records.find(
      (row) => row.source === "bank_transactions",
    );
    expect(afterBank).toBeDefined();
    expect(afterBank!.erased).toBe(true);
    expect(afterBank!.personalData.name).not.toContain(sharedName);

    const otherSubject = buildGdprSubjectExport(db, { cvr: otherCvr });
    expect(
      otherSubject.records.some(
        (row) =>
          row.source === "bank_transactions" &&
          row.sourceRowId === bankRow!.sourceRowId,
      ),
    ).toBe(false);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a second erasure of an already-erased subject is idempotent", () => {
    const { root, db } = freshCompany("gdpr-erase-idem");
    createCustomer(db, { name: "Idem Kunde", vatOrCvr: "DK66778899", email: "idem@example.com" });

    const first = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { cvr: "DK66778899" }),
    );
    expect(first.ok).toBe(true);
    expect(first.erasedCount).toBeGreaterThan(0);

    const second = withToday("2026-07-18", () =>
      eraseGdprSubject(db, { cvr: "DK66778899" }),
    );
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(second.ok).toBe(true);
    expect(second.erasedCount).toBe(0);
    expect(second.alreadyErasedCount).toBeGreaterThan(0);
  });
});
