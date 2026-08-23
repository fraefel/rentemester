import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { approveAndPostAccountingDraft, createAccountingDraft, getAccountingDraft, listAccountingDrafts, rejectAccountingDraft, reviseAccountingDraft, submitAccountingDraft } from "../../src/core/accounting-drafts";
import { migrate } from "../../src/core/db";
import { seedAccounts, type JournalEntryInput } from "../../src/core/ledger";

const author = { createdBy: "user:author", createdByProgram: "unit-test" };
const submitter = { createdBy: "user:submitter", createdByProgram: "unit-test" };
const reviewer = { createdBy: "user:reviewer", createdByProgram: "unit-test" };

function setup() {
  const db = new Database(":memory:");
  migrate(db);
  seedAccounts(db);
  return db;
}

function payload(amount = 100): JournalEntryInput {
  return {
    transactionDate: "2026-02-01",
    text: "Synthetic reviewed transfer",
    lines: [
      { accountNo: "2000", debitAmount: amount },
      { accountNo: "5000", creditAmount: amount },
    ],
  };
}

describe("generic append-only accounting drafts", () => {
  test("requires an independent reviewer and atomically posts the exact submitted version once", () => {
    const db = setup();
    try {
      const created = createAccountingDraft(db, "synthetic-draft", payload(), author);
      expect(created).toMatchObject({ version: 1, status: "created" });
      expect(db.query("SELECT count(*) AS count FROM journal_entries").get()).toEqual({ count: 0 });
      const submitted = submitAccountingDraft(db, created.id, created.eventHash, submitter);
      expect(submitted.status).toBe("submitted");
      expect(() => approveAndPostAccountingDraft(db, created.id, submitted.eventHash, author)).toThrow("distinct from author and submitter");
      expect(() => approveAndPostAccountingDraft(db, created.id, submitted.eventHash, submitter)).toThrow("distinct from author and submitter");

      const posted = approveAndPostAccountingDraft(db, created.id, submitted.eventHash, reviewer);
      expect(posted).toMatchObject({ status: "approved_posted", journal: { ok: true, entryNo: "2026-00001" } });
      expect(db.query("SELECT count(*) AS count FROM journal_entries").get()).toEqual({ count: 1 });
      expect(db.query("SELECT created_by,created_by_program FROM journal_entries").get()).toEqual({ created_by: "user:reviewer", created_by_program: "rentemester-accounting-draft" });

      // A retry of the exact submitted identity observes existing evidence and
      // never creates a second journal or audit event.
      const eventCount = db.query("SELECT count(*) AS count FROM accounting_draft_events").get();
      const retried = approveAndPostAccountingDraft(db, created.id, submitted.eventHash, reviewer);
      expect(retried.journal.entryNo).toBe(posted.journal.entryNo);
      expect(db.query("SELECT count(*) AS count FROM journal_entries").get()).toEqual({ count: 1 });
      expect(db.query("SELECT count(*) AS count FROM accounting_draft_events").get()).toEqual(eventCount);
      expect(listAccountingDrafts(db)).toHaveLength(1);
    } finally { db.close(); }
  });

  test("rejects with a reason and requires a new immutable version before resubmission", () => {
    const db = setup();
    try {
      const created = createAccountingDraft(db, "revision-draft", payload(), author);
      const submitted = submitAccountingDraft(db, created.id, created.eventHash, submitter);
      expect(() => rejectAccountingDraft(db, created.id, submitted.eventHash, "", reviewer)).toThrow("reason");
      const rejected = rejectAccountingDraft(db, created.id, submitted.eventHash, "Needs corrected amount", reviewer);
      expect(rejected).toMatchObject({ status: "rejected", reason: "Needs corrected amount" });
      expect(() => submitAccountingDraft(db, created.id, rejected.eventHash, submitter)).toThrow("editable");
      const revised = reviseAccountingDraft(db, created.id, rejected.eventHash, payload(125), author);
      expect(revised).toMatchObject({ version: 2, status: "revised" });
      const resubmitted = submitAccountingDraft(db, created.id, revised.eventHash, submitter);
      expect(approveAndPostAccountingDraft(db, created.id, resubmitted.eventHash, reviewer).status).toBe("approved_posted");
      expect(db.query("SELECT SUM(debit_amount) AS total FROM journal_lines").get()).toEqual({ total: 125 });
    } finally { db.close(); }
  });

  test("fails closed when ledger preconditions change and preserves the submitted state", () => {
    const db = setup();
    try {
      const created = createAccountingDraft(db, "stale-draft", payload(), author);
      const submitted = submitAccountingDraft(db, created.id, created.eventHash, submitter);
      db.run("UPDATE accounts SET active = 0 WHERE account_no = '2000'");
      expect(() => approveAndPostAccountingDraft(db, created.id, submitted.eventHash, reviewer)).toThrow("inactive");
      expect(getAccountingDraft(db, created.id)).toMatchObject({ status: "submitted", eventHash: submitted.eventHash });
      expect(db.query("SELECT count(*) AS count FROM journal_entries").get()).toEqual({ count: 0 });
      expect(db.query("SELECT count(*) AS count FROM accounting_draft_events WHERE event_type = 'approved_posted'").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  test("database guards and the application hash chain reject mutation", () => {
    const db = setup();
    try {
      createAccountingDraft(db, "guarded-draft", payload(), author);
      expect(() => db.run("UPDATE accounting_draft_events SET actor_id = 'user:tamper' WHERE id = 1")).toThrow("append-only");
      expect(() => db.run("DELETE FROM accounting_draft_events WHERE id = 1")).toThrow("append-only");
      db.exec("DROP TRIGGER accounting_draft_events_no_update");
      db.run("UPDATE accounting_draft_events SET actor_id = 'user:tamper' WHERE id = 1");
      expect(() => listAccountingDrafts(db)).toThrow("hash-chain");
    } finally { db.close(); }
  });
});
