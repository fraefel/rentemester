// Tests: src/core/ledger.ts (audit-chain verification)
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { migrate, openDb } from "../../src/core/db";
import { ingestDocument } from "../../src/core/documents";
import { hashEntry, postJournalEntry, seedAccounts, verifyAuditChain } from "../../src/core/ledger";
import { ensureCompanyDirs } from "../../src/core/paths";

type ManualLine = {
  account_no: string;
  debit_amount: number;
  credit_amount: number;
  vat_code: string | null;
  text: string;
};

function insertManualEntry(db: ReturnType<typeof openDb>, input: {
  entryNo: string;
  previousHash: string;
  transactionDate: string;
  text: string;
  lines: ManualLine[];
  sourceBankTransactionId?: number | null;
  documentId?: number | null;
  currency?: string;
  amountForeign?: number | null;
  amountDkk?: number | null;
  fxRateToDkk?: number | null;
  status?: "posted" | "reversed";
  reversalOfEntryId?: number | null;
}) {
  const entry = {
    entry_no: input.entryNo,
    transaction_date: input.transactionDate,
    text: input.text,
    source_bank_transaction_id: input.sourceBankTransactionId ?? null,
    document_id: input.documentId ?? null,
    currency: input.currency ?? "DKK",
    amount_foreign: input.amountForeign ?? null,
    amount_dkk: input.amountDkk ?? null,
    fx_rate_to_dkk: input.fxRateToDkk ?? null,
    rule_version: "dk-v0.0.1",
    created_by: "system",
    created_by_program: "rentemester",
    status: input.status ?? "posted",
    reversal_of_entry_id: input.reversalOfEntryId ?? null,
  };
  // The audit chain binds the row id and per-line ordinal, so the hash must be
  // computed with the id this row will receive once inserted.
  const predictedId = ((db.query("SELECT COALESCE(MAX(id), 0) AS n FROM journal_entries").get() as { n: number }).n) + 1;
  const canonical = {
    id: predictedId,
    ...entry,
    lines: input.lines.map((line, ordinal) => ({
      ordinal,
      account_no: line.account_no,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      vat_code: line.vat_code ?? null,
      text: line.text ?? null,
    })),
  };
  const entryHash = hashEntry(canonical, input.previousHash);

  db.run(
    `INSERT INTO journal_entries (
      id, entry_no, transaction_date, text, source_bank_transaction_id, document_id,
      currency, amount_foreign, amount_dkk, fx_rate_to_dkk,
      rule_version, created_by, created_by_program, status, reversal_of_entry_id, previous_hash, entry_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    predictedId,
    entry.entry_no,
    entry.transaction_date,
    entry.text,
    entry.source_bank_transaction_id,
    entry.document_id,
    entry.currency,
    entry.amount_foreign,
    entry.amount_dkk,
    entry.fx_rate_to_dkk,
    entry.rule_version,
    entry.created_by,
    entry.created_by_program,
    entry.status,
    entry.reversal_of_entry_id,
    input.previousHash,
    entryHash,
  );

  const inserted = db.query("SELECT id FROM journal_entries WHERE entry_no = ?").get(entry.entry_no) as { id: number };
  for (const line of input.lines) {
    const account = db.query("SELECT id FROM accounts WHERE account_no = ?").get(line.account_no) as { id: number };
    db.run(
      `INSERT INTO journal_lines (journal_entry_id, account_id, debit_amount, credit_amount, vat_code, currency, text)
       VALUES (?, ?, ?, ?, ?, 'DKK', ?)`,
      inserted.id,
      account.id,
      line.debit_amount,
      line.credit_amount,
      line.vat_code,
      line.text,
    );
  }

  return { id: inserted.id, entryHash };
}

describe("audit verify", () => {
  test("verifies referenced files inside the current company root and fails closed without leaking host paths", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-document-evidence-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);
    const ingested = ingestDocument(
      db,
      root,
      join(process.cwd(), "examples/vendor-invoice.txt"),
      JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8")),
    );
    expect(ingested.ok).toBe(true);
    const posted = postJournalEntry(
      db,
      JSON.parse(readFileSync(join(process.cwd(), "examples/journal-entry.expense.json"), "utf8")),
    );
    expect(posted.ok).toBe(true);
    expect(verifyAuditChain(db).ok).toBe(true);

    const documentId = ingested.documentId!;
    const storedPath = ingested.storedPath!;
    const originalHash = ingested.sha256!;
    const originalBytes = readFileSync(storedPath);
    const entryNo = posted.entryNo!;
    db.run("DROP TRIGGER documents_no_update_when_linked");

    const expectEvidenceFailure = (message: string) => {
      const result = verifyAuditChain(db);
      expect(result.ok, message).toBe(false);
      const joined = result.errors.join(" | ");
      expect(joined).toContain(entryNo);
      expect(joined).toContain(`document_id ${documentId}`);
      return joined;
    };

    db.run("UPDATE documents SET stored_path = NULL WHERE id = ?", documentId);
    expect(expectEvidenceFailure("missing stored_path")).toContain("stored_path");
    db.run("UPDATE documents SET stored_path = ? WHERE id = ?", storedPath, documentId);

    db.run("UPDATE documents SET sha256_hash = 'not-a-sha256' WHERE id = ?", documentId);
    expect(expectEvidenceFailure("invalid sha256")).toContain("invalid sha256_hash");
    db.run("UPDATE documents SET sha256_hash = ? WHERE id = ?", originalHash, documentId);

    const movedAside = join(root, "moved-aside-evidence");
    renameSync(storedPath, movedAside);
    expect(expectEvidenceFailure("missing file")).toContain("missing or inaccessible");
    renameSync(movedAside, storedPath);

    writeFileSync(storedPath, "tampered evidence");
    expect(expectEvidenceFailure("hash mismatch")).toContain("sha256 does not match");
    writeFileSync(storedPath, originalBytes);

    const directoryEvidence = join(root, "documents", "originals", "directory-evidence");
    mkdirSync(directoryEvidence);
    db.run("UPDATE documents SET stored_path = ? WHERE id = ?", directoryEvidence, documentId);
    expect(expectEvidenceFailure("directory evidence")).toContain("not a safe regular file");
    db.run("UPDATE documents SET stored_path = ? WHERE id = ?", storedPath, documentId);
    rmSync(directoryEvidence, { recursive: true, force: true });

    const symlinkTarget = join(root, "symlink-target-evidence");
    renameSync(storedPath, symlinkTarget);
    symlinkSync(symlinkTarget, storedPath);
    expect(expectEvidenceFailure("symlink evidence")).toContain("not a safe regular file");
    unlinkSync(storedPath);
    renameSync(symlinkTarget, storedPath);

    const escapedHostPath = "/private/host/secret-evidence.txt";
    db.run("UPDATE documents SET stored_path = ? WHERE id = ?", escapedHostPath, documentId);
    const escapedError = expectEvidenceFailure("path escape");
    expect(escapedError).toContain("outside the documents/originals evidence store");
    expect(escapedError).not.toContain(escapedHostPath);
    db.run("UPDATE documents SET stored_path = ? WHERE id = ?", storedPath, documentId);

    // Old Windows and POSIX absolute roots are portable: only their canonical
    // store suffix + basename is trusted, then rebased into THIS company root.
    db.run(
      "UPDATE documents SET stored_path = ? WHERE id = ?",
      `C:\\old-company\\documents\\originals\\${basename(storedPath)}`,
      documentId,
    );
    expect(verifyAuditChain(db).ok).toBe(true);
    db.run(
      "UPDATE documents SET stored_path = ? WHERE id = ?",
      `/old-company/documents/originals/${basename(storedPath)}`,
      documentId,
    );
    expect(verifyAuditChain(db).ok).toBe(true);
    db.run("UPDATE documents SET stored_path = ? WHERE id = ?", storedPath, documentId);

    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      chmodSync(storedPath, 0o000);
      expect(expectEvidenceFailure("unreadable evidence")).toMatch(/cannot be read|inaccessible/);
      chmodSync(storedPath, 0o600);
    }

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("verifies document evidence for balance-only postings and unposted register rows", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-all-documents-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const balanceDocument = ingestDocument(
      db,
      root,
      join(process.cwd(), "examples/vendor-invoice.txt"),
      JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8")),
    );
    expect(balanceDocument.ok).toBe(true);
    const balanceJournal = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Balance-only evidence attachment",
      documentId: balanceDocument.documentId!,
      lines: [
        { accountNo: "2000", debitAmount: 100 },
        { accountNo: "5000", creditAmount: 100 },
      ],
    });
    expect(balanceJournal.ok).toBe(true);
    expect(verifyAuditChain(db).ok).toBe(true);

    writeFileSync(balanceDocument.storedPath!, "tampered balance-only evidence");
    const balanceAudit = verifyAuditChain(db);
    expect(balanceAudit.ok).toBe(false);
    expect(balanceAudit.errors.join(" ")).toContain("stored evidence sha256 does not match");

    db.close();
    rmSync(root, { recursive: true, force: true });

    const unpostedRoot = mkdtempSync(join(tmpdir(), "rentemester-audit-unposted-document-"));
    const unpostedDb = openDb(ensureCompanyDirs(unpostedRoot).db);
    migrate(unpostedDb);
    seedAccounts(unpostedDb);
    const unposted = ingestDocument(
      unpostedDb,
      unpostedRoot,
      join(process.cwd(), "examples/vendor-invoice.txt"),
      JSON.parse(readFileSync(join(process.cwd(), "examples/vendor-invoice.metadata.json"), "utf8")),
    );
    expect(unposted.ok).toBe(true);
    expect(verifyAuditChain(unpostedDb).ok).toBe(true);
    writeFileSync(unposted.storedPath!, "tampered unposted evidence");
    const unpostedAudit = verifyAuditChain(unpostedDb);
    expect(unpostedAudit.ok).toBe(false);
    expect(unpostedAudit.errors.join(" ")).toContain("stored evidence sha256 does not match");

    unpostedDb.close();
    rmSync(unpostedRoot, { recursive: true, force: true });
  });

  test("rejects malformed reversal status at write time and detects legacy rows during audit", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-reversal-shape-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    expect(() => db.run(
      `INSERT INTO journal_entries
         (entry_no, transaction_date, text, rule_version, status, previous_hash, entry_hash)
       VALUES ('2026-00001', '2026-05-16', 'Invalid hidden posting',
               'test', 'reversed', 'GENESIS', 'invalid-reversal-shape')`,
    )).toThrow("journal reversal status requires one existing unreversed posted original");

    db.exec("DROP TRIGGER journal_entries_reversal_shape_insert");
    insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "Legacy hidden posting",
      status: "reversed",
      lines: [
        { account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "5000", debit_amount: 0, credit_amount: 100, vat_code: null, text: "Equity" },
      ],
    });
    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.join(" ")).toContain("journal reversal status does not match reversal_of_entry_id");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("validates the complete reversal relation, metadata, and exact inverse lines", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-reversal-relation-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const original = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Foreign balance movement",
      currency: "EUR",
      amountForeign: 100,
      amountDkk: 745,
      fxRateToDkk: 7.45,
      lines: [
        { accountNo: "2000", debitAmount: 745 },
        { accountNo: "5000", creditAmount: 745 },
      ],
    });
    expect(original.ok).toBe(true);

    expect(() => db.run(
      `INSERT INTO journal_entries
         (id, entry_no, transaction_date, text, rule_version, status,
          reversal_of_entry_id, previous_hash, entry_hash)
       VALUES (?, '2026-00002', '2026-05-17', 'Missing target', 'test',
               'reversed', 999, ?, 'untrusted')`,
      original.entryId! + 1,
      original.entryHash!,
    )).toThrow("one existing unreversed posted original");
    expect(() => db.run(
      `INSERT INTO journal_entries
         (id, entry_no, transaction_date, text, rule_version, status,
          reversal_of_entry_id, previous_hash, entry_hash)
       VALUES (0, '2026-00000', '2026-05-17', 'Target does not precede row',
               'test', 'reversed', ?, ?, 'untrusted')`,
      original.entryId!,
      original.entryHash!,
    )).toThrow("one existing unreversed posted original");

    db.exec("DROP TRIGGER journal_entries_reversal_shape_insert");
    const fake = insertManualEntry(db, {
      entryNo: "2026-00002",
      previousHash: original.entryHash!,
      transactionDate: "2026-05-17",
      text: "Legacy fake reversal",
      currency: "USD",
      amountForeign: 100,
      amountDkk: 745,
      fxRateToDkk: 7.45,
      status: "reversed",
      reversalOfEntryId: original.entryId!,
      lines: [
        { account_no: "2000", debit_amount: 745, credit_amount: 0, vat_code: null, text: "Repeated debit" },
        { account_no: "5000", debit_amount: 0, credit_amount: 745, vat_code: null, text: "Repeated credit" },
      ],
    });
    const orphan = insertManualEntry(db, {
      entryNo: "2026-00003",
      previousHash: fake.entryHash,
      transactionDate: "2026-05-18",
      text: "Legacy orphan reversal",
      status: "reversed",
      reversalOfEntryId: 999,
      lines: [
        { account_no: "2000", debit_amount: 0, credit_amount: 50, vat_code: null, text: "Credit" },
        { account_no: "5000", debit_amount: 50, credit_amount: 0, vat_code: null, text: "Debit" },
      ],
    });
    insertManualEntry(db, {
      entryNo: "2026-00004",
      previousHash: orphan.entryHash,
      transactionDate: "2026-05-19",
      text: "Legacy duplicate reversal",
      currency: "EUR",
      amountForeign: 100,
      amountDkk: 745,
      fxRateToDkk: 7.45,
      status: "reversed",
      reversalOfEntryId: original.entryId!,
      lines: [
        { account_no: "2000", debit_amount: 0, credit_amount: 745, vat_code: null, text: "Inverse credit" },
        { account_no: "5000", debit_amount: 745, credit_amount: 0, vat_code: null, text: "Inverse debit" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    const joined = audit.errors.join(" | ");
    expect(joined).toContain("reversal target journal entry 999 does not exist");
    expect(joined).toContain("has 2 reversal rows; exactly one is allowed");
    expect(joined).toContain("reversal metadata differs");
    expect(joined).toContain("reversal lines do not exactly invert");

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("flags an unbalanced journal entry even when the stored hash chain matches", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "Corrupt unbalanced entry",
      lines: [
        { account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "1000", debit_amount: 0, credit_amount: 90, vat_code: null, text: "Income" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("entry is unbalanced"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("flags duplicate use of the same source bank transaction across journal entries", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, text, amount, currency, transaction_hash, status)
       VALUES ('2026-05-16', 'Customer payment', 1250, 'DKK', 'dup-bank-hash', 'imported')`
    );
    const bankTransaction = db.query("SELECT id FROM bank_transactions WHERE transaction_hash = 'dup-bank-hash'").get() as { id: number };

    const first = insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "First settlement",
      sourceBankTransactionId: bankTransaction.id,
      lines: [
        { account_no: "2000", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "1100", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Receivable" },
      ],
    });
    db.exec("DROP TRIGGER journal_entries_reversal_shape_insert");
    insertManualEntry(db, {
      entryNo: "2026-00002",
      previousHash: first.entryHash,
      transactionDate: "2026-05-16",
      text: "Duplicate settlement marked reversed without reversal link",
      sourceBankTransactionId: bankTransaction.id,
      status: "reversed",
      lines: [
        { account_no: "2000", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Bank again" },
        { account_no: "1100", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Receivable again" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(false);
    expect(audit.errors.some((error) => error.includes("duplicate source_bank_transaction_id"))).toBe(true);
    expect(audit.errors.some((error) => error.includes("journal reversal status does not match"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("detects tail truncation of the most recent journal entries", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-truncate-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    for (let i = 0; i < 3; i++) {
      const posted = postJournalEntry(db, {
        transactionDate: "2026-05-16",
        text: `Balanced entry ${i}`,
        lines: [
          { accountNo: "2000", debitAmount: 1000 },
          { accountNo: "5000", creditAmount: 1000 }
        ]
      });
      expect(posted.ok).toBe(true);
    }
    expect(verifyAuditChain(db).ok).toBe(true);

    // Drop the append-only protection and truncate the most recent entry.
    const lastId = (db.query("SELECT MAX(id) AS id FROM journal_entries").get() as { id: number }).id;
    db.run("DROP TRIGGER journal_lines_no_delete");
    db.run("DROP TRIGGER journal_entries_no_delete");
    db.run("DELETE FROM journal_lines WHERE journal_entry_id = ?", lastId);
    db.run("DELETE FROM journal_entries WHERE id = ?", lastId);

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("missing"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("binds the row id into the entry hash so swapped rows fail verification", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-id-bind-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    const first = insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "First entry",
      lines: [
        { account_no: "2000", debit_amount: 100, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "5000", debit_amount: 0, credit_amount: 100, vat_code: null, text: "Equity" },
      ],
    });
    insertManualEntry(db, {
      entryNo: "2026-00002",
      previousHash: first.entryHash,
      transactionDate: "2026-05-16",
      text: "Second entry",
      lines: [
        { account_no: "2000", debit_amount: 200, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "5000", debit_amount: 0, credit_amount: 200, vat_code: null, text: "Equity" },
      ],
    });
    expect(verifyAuditChain(db).ok).toBe(true);

    // Swap the entry_no values between the two rows. The chain walks by id, so
    // each row keeps a valid previous_hash link, but the id-bound hash no longer
    // matches its row identity.
    db.run("DROP TRIGGER journal_entries_no_update");
    db.run("UPDATE journal_entries SET entry_no = '2026-TMP' WHERE entry_no = '2026-00001'");
    db.run("UPDATE journal_entries SET entry_no = '2026-00001' WHERE entry_no = '2026-00002'");
    db.run("UPDATE journal_entries SET entry_no = '2026-00002' WHERE entry_no = '2026-TMP'");

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("entry_hash mismatch"))).toBe(true);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("allows a reversal pair to share the same source bank transaction without audit failure", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-audit-verify-"));
    const db = openDb(ensureCompanyDirs(root).db);
    migrate(db);
    seedAccounts(db);

    db.run(
      `INSERT INTO bank_transactions (transaction_date, text, amount, currency, transaction_hash, status)
       VALUES ('2026-05-16', 'Customer payment', 1250, 'DKK', 'reversal-bank-hash', 'imported')`
    );
    const bankTransaction = db.query("SELECT id FROM bank_transactions WHERE transaction_hash = 'reversal-bank-hash'").get() as { id: number };

    const original = insertManualEntry(db, {
      entryNo: "2026-00001",
      previousHash: "GENESIS",
      transactionDate: "2026-05-16",
      text: "Settlement",
      sourceBankTransactionId: bankTransaction.id,
      lines: [
        { account_no: "2000", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Bank" },
        { account_no: "1100", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Receivable" },
      ],
    });
    insertManualEntry(db, {
      entryNo: "2026-00002",
      previousHash: original.entryHash,
      transactionDate: "2026-05-17",
      text: "Reversal of settlement",
      sourceBankTransactionId: bankTransaction.id,
      status: "reversed",
      reversalOfEntryId: original.id,
      lines: [
        { account_no: "2000", debit_amount: 0, credit_amount: 1250, vat_code: null, text: "Bank reversal" },
        { account_no: "1100", debit_amount: 1250, credit_amount: 0, vat_code: null, text: "Receivable reversal" },
      ],
    });

    const audit = verifyAuditChain(db);
    expect(audit.ok).toBe(true);
    expect(audit.errors).toHaveLength(0);

    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
