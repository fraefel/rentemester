// Tests: src/cli/invoice.ts, src/cli.ts (invoice booking CLI)
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../src/core/db";
import { companyPaths } from "../../src/core/paths";
import { postJournalEntry, verifyAuditChain } from "../../src/core/ledger";

describe("invoice post CLI", () => {
  test("posts an issued invoice to the ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-cli-"));
    const company = join(root, "company");

    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    await Bun.$`bun run src/cli.ts invoice issue --company ${company} --input examples/full-invoice.dk.json`.quiet();

    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "invoice", "post", "--company", company, "--invoice-number", "2026-0001"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    rmSync(root, { recursive: true, force: true });
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.appliedRules).toContain("DK-INVOICE-BOOKKEEPING-001");
  });

  test("repairs one explicitly named unclassified legacy invoice journal", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-repair-cli-"));
    const company = join(root, "company");
    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();
    writeFileSync(join(companyPaths(company).config, "policy.yaml"), `company_policy:\n  country: DK\n  currency: DKK\n  allow_direct_sql_write: false\n  block_if_uncertain: true\nactor_allowlist:\n  agents:\n    - freja\n`);
    await Bun.$`bun run src/cli.ts invoice issue --company ${company} --input examples/full-invoice.dk.json --actor agent:freja`.quiet();

    const db = openDb(companyPaths(company).db);
    const invoice = db.query(
      "SELECT id FROM documents WHERE document_type = 'issued_invoice' AND invoice_no = '2026-0001'",
    ).get() as { id: number };
    const legacy = postJournalEntry(db, {
      transactionDate: "2026-05-16",
      text: "Migrated ambiguous invoice journal",
      documentId: invoice.id,
      lines: [
        { accountNo: "1100", debitAmount: 1250 },
        { accountNo: "1010", creditAmount: 1250 },
      ],
    });
    expect(legacy.ok).toBe(true);
    db.close();

    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts", "invoice", "repair-posting",
      "--company", company,
      "--invoice-number", "2026-0001",
      "--legacy-journal-entry-id", String(legacy.entryId),
      "--reason", "Replace migrated ambiguous posting",
      "--actor", "agent:freja",
      "--actor-via", "openclaw",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.legacyJournalEntryId).toBe(legacy.entryId);

    const verifiedDb = openDb(companyPaths(company).db);
    expect(verifiedDb.query(
      "SELECT journal_entry_id FROM issued_invoice_postings WHERE invoice_document_id = ?",
    ).get(invoice.id)).toEqual({ journal_entry_id: parsed.replacementJournalEntryId });
    expect(verifiedDb.query(
      "SELECT id FROM journal_entries WHERE reversal_of_entry_id = ?",
    ).get(legacy.entryId!)).toEqual({ id: parsed.reversalJournalEntryId });
    expect(verifiedDb.query(
      `SELECT created_by, created_by_program
         FROM journal_entries
        WHERE id IN (?, ?)
        ORDER BY id ASC`,
    ).all(parsed.replacementJournalEntryId, parsed.reversalJournalEntryId)).toEqual([
      { created_by: "agent:freja", created_by_program: "openclaw" },
      { created_by: "agent:freja", created_by_program: "openclaw" },
    ]);
    expect(verifiedDb.query(
      "SELECT actor FROM audit_log WHERE event_type = 'invoice_booking_repair' ORDER BY id DESC LIMIT 1",
    ).get()).toEqual({ actor: "agent:freja via openclaw" });
    expect(verifyAuditChain(verifiedDb).ok).toBe(true);
    verifiedDb.close();

    rmSync(root, { recursive: true, force: true });
  });

  test("treats missing, malformed and blank repair arguments as usage errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-invoicebook-repair-usage-"));
    const company = join(root, "company");
    await Bun.$`bun run src/cli.ts init --company ${company}`.quiet();

    const argumentSets = [
      ["--document-id", "1", "--reason", "required id is missing"],
      ["--document-id", "1", "--legacy-journal-entry-id", "NaN", "--reason", "bad id"],
      ["--document-id", "1", "--legacy-journal-entry-id", "1", "--reason", "   "],
    ];
    for (const args of argumentSets) {
      const proc = Bun.spawn([
        "bun", "run", "src/cli.ts", "invoice", "repair-posting",
        "--company", company,
        ...args,
      ], {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/legacy-journal-entry-id|reason/i);
    }

    rmSync(root, { recursive: true, force: true });
  });
});
