import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { seedAccounts } from "../../src/core/ledger";
import { dineroParser } from "../../src/core/import/dinero";
import { dineroImportFaults, runImportFromSource } from "../../src/core/import/framework";
import { ingestDocument } from "../../src/core/documents";

const FIXTURE = join(import.meta.dir, "../../examples/import-dinero");
const tables = ["journal_entries", "journal_lines", "documents", "import_document_links", "exceptions", "import_archive_years", "audit_log", "dinero_import_sources", "dinero_import_inventories", "dinero_import_inventory_entries", "dinero_import_attempts", "dinero_import_archive_evidence", "dinero_import_document_links"];

function company(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db); seedAccounts(db);
  return { root, db };
}
function counts(db: ReturnType<typeof openDb>) {
  return Object.fromEntries(tables.map((table) => [table, Number((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)]));
}
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string) => forEach(readdirSync(dir, { withFileTypes: true }), dir);
  const forEach = (entries: ReturnType<typeof readdirSync>, dir: string) => {
    for (const entry of entries as unknown as Array<{ name: string; isDirectory(): boolean }>) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  visit(root); return out;
}
function exportCopy(prefix: string) { const dir = mkdtempSync(join(tmpdir(), prefix)); cpSync(FIXTURE, dir, { recursive: true }); return dir; }
function close({ root, db }: ReturnType<typeof company>) { db.close(); rmSync(root, { recursive: true, force: true }); }

describe("Dinero v4 atomic landing", () => {
  test("dry-run returns a preview without changing database, audit/provenance, or files", () => {
    const c = company("rentemester-v4-dry-");
    try {
      const beforeCounts = counts(c.db); const beforeTree = tree(c.root);
      const result = runImportFromSource(c.db, dineroParser, FIXTURE, { createdBy: "user:atomic", dryRun: true, companyRoot: c.root });
      expect(result).toMatchObject({ ok: true, dryRun: true });
      expect(counts(c.db)).toEqual(beforeCounts); expect(tree(c.root)).toEqual(beforeTree);
    } finally { close(c); }
  });

  test("a post-publish failure rolls back rows and removes only attempt-created originals, then records rejection", () => {
    const c = company("rentemester-v4-rollback-");
    try {
      const receipt = join(FIXTURE, "2025/Bilag/2025-Bilag-1.pdf");
      const prior = ingestDocument(c.db, c.root, receipt, { source: "synthetic-prior", documentType: "cash_register_receipt" });
      expect(prior.ok).toBe(true);
      const preexistingPath = prior.storedPath!; const before = counts(c.db);
      dineroImportFaults.link = () => { throw new Error("injected after documents publish"); };
      const result = runImportFromSource(c.db, dineroParser, FIXTURE, { createdBy: "user:atomic", companyRoot: c.root });
      expect(result.ok).toBe(false); expect(result.errors.join(" ")).toContain("injected after documents publish");
      expect(existsSync(preexistingPath)).toBe(true);
      const after = counts(c.db);
      expect(after.documents).toBe(before.documents);
      for (const table of ["journal_entries", "journal_lines", "import_document_links", "exceptions", "import_archive_years", "dinero_import_document_links", "dinero_import_archive_evidence"] as const) expect(after[table]).toBe(before[table]);
      expect(after.dinero_import_attempts).toBe(1);
      expect(c.db.query("SELECT outcome FROM dinero_import_attempts").get()).toEqual({ outcome: "rejected" });
      delete dineroImportFaults.link;
      const attempts = after.dinero_import_attempts;
      const dry = runImportFromSource(c.db, dineroParser, FIXTURE, { createdBy: "user:atomic", dryRun: true, companyRoot: c.root });
      expect(dry).toMatchObject({ ok: true, dryRun: true }); expect(counts(c.db).dinero_import_attempts).toBe(attempts);
    } finally { delete dineroImportFaults.link; close(c); }
  });

  test("legacy archive collision and invalid booked receipt sets reject before mutation", () => {
    const variants: Array<(dir: string) => void> = [
      (dir) => writeFileSync(join(dir, "2025/Bilag/not-a-voucher.pdf"), readFileSync(join(FIXTURE, "2025/Bilag/2025-Bilag-1.pdf"))),
      (dir) => unlinkSync(join(dir, "2025/Bilag/2025-Bilag-5.pdf")),
      (dir) => writeFileSync(join(dir, "2025/Bilag/2025-Bilag-99.pdf"), readFileSync(join(FIXTURE, "2025/Bilag/2025-Bilag-1.pdf"))),
    ];
    for (const change of variants) {
      const c = company("rentemester-v4-plan-"); const source = exportCopy("rentemester-v4-export-");
      try { change(source); const before = counts(c.db); const result = runImportFromSource(c.db, dineroParser, source, { createdBy: "user:atomic", companyRoot: c.root }); expect(result.ok).toBe(false); expect(counts(c.db)).toEqual(before); }
      finally { rmSync(source, { recursive: true, force: true }); close(c); }
    }
    const c = company("rentemester-v4-legacy-");
    try {
      c.db.query("INSERT INTO import_archive_years (source_system, fiscal_year, posting_count, balance_count) VALUES ('dinero', 2024, 0, 0)").run();
      const before = counts(c.db); const result = runImportFromSource(c.db, dineroParser, FIXTURE, { createdBy: "user:atomic", companyRoot: c.root });
      expect(result.ok).toBe(false); expect(result.errors.join(" ")).toContain("legacy archive"); expect(counts(c.db)).toEqual(before);
    } finally { close(c); }
  });

  test("accepted source is immutable/idempotent, receipts link, and unbooked receipt has excluded evidence", () => {
    const c = company("rentemester-v4-success-");
    try {
      const first = runImportFromSource(c.db, dineroParser, FIXTURE, { createdBy: "user:atomic", companyRoot: c.root });
      expect(first.ok).toBe(true); expect(first.bilag).toMatchObject({ linkedCount: 5, unbookedCount: 1 });
      expect(Number((c.db.query("SELECT COUNT(*) AS n FROM import_document_links").get() as { n: number }).n)).toBe(5);
      expect(Number((c.db.query("SELECT COUNT(*) AS n FROM dinero_import_document_links WHERE disposition = 'excluded'").get() as { n: number }).n)).toBe(1);
      const before = counts(c.db); const files = tree(c.root);
      const second = runImportFromSource(c.db, dineroParser, FIXTURE, { createdBy: "user:atomic", companyRoot: c.root });
      expect(second).toMatchObject({ ok: false, errors: ["already-imported"] }); expect(counts(c.db)).toEqual(before); expect(tree(c.root)).toEqual(files);
    } finally { close(c); }
  });

  test("receipt-bearing import without a resolvable company root fails, while pre-existing content still receives all provenance links", () => {
    const memory = openDb(":memory:"); migrate(memory); seedAccounts(memory);
    try {
      const before = counts(memory); const missingRoot = runImportFromSource(memory, dineroParser, FIXTURE, { createdBy: "user:atomic" });
      expect(missingRoot.ok).toBe(false); expect(missingRoot.errors.join(" ")).toContain("requires a resolvable company root"); expect(counts(memory)).toEqual(before);
    } finally { memory.close(); }
    const c = company("rentemester-v4-existing-");
    try {
      const prior = ingestDocument(c.db, c.root, join(FIXTURE, "2025/Bilag/2025-Bilag-1.pdf"), { source: "synthetic-prior", documentType: "cash_register_receipt" }); expect(prior.ok).toBe(true);
      const result = runImportFromSource(c.db, dineroParser, FIXTURE, { createdBy: "user:atomic", companyRoot: c.root }); expect(result.ok).toBe(true);
      expect(Number((c.db.query("SELECT COUNT(*) AS n FROM dinero_import_document_links").get() as { n: number }).n)).toBe(6);
    } finally { close(c); }
  });
});
