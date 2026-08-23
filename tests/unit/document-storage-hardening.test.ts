import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { openDb, migrate } from "../../src/core/db";
import { ensureCompanyDirs } from "../../src/core/paths";
import { ingestDocument, ingestDocumentAsync } from "../../src/core/documents";
import { MAX_DOCUMENT_BYTES, publishDocumentSnapshot, snapshotDocumentSource } from "../../src/core/document-storage";

const metadata = {
  source: "test", issueDate: "2026-08-23", invoiceNo: "SAFE-1", deliveryDescription: "Synthetic voucher", amountIncVat: 125,
  sender: { name: "Synthetic supplier", address: "Example 1", vatOrCvr: "DK11223344" },
  recipient: { name: "Synthetic buyer", address: "Example 2", vatOrCvr: "DK12345678" }, vatAmount: 25,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rentemester-document-hardening-"));
  const sourceRoot = mkdtempSync(join(tmpdir(), "rentemester-document-source-"));
  const source = join(sourceRoot, "voucher.txt");
  writeFileSync(source, "immutable synthetic voucher\n");
  const db = openDb(ensureCompanyDirs(root).db); migrate(db);
  return { root, sourceRoot, source, db, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); rmSync(sourceRoot, { recursive: true, force: true }); } };
}

describe("document storage hardening", () => {
  test("rejects source and destination symlinks without a row or final evidence", () => {
    const f = fixture();
    try {
      const link = join(f.sourceRoot, "source-link.txt");
      symlinkSync(f.source, link);
      const sourceResult = ingestDocument(f.db, f.root, link, metadata);
      expect(sourceResult.ok).toBe(false);
      expect(sourceResult.errors?.join(" ")).toContain("symbolic link");
      expect(f.db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });

      const originals = join(f.root, "documents", "originals");
      rmSync(originals, { recursive: true, force: true });
      const outside = join(f.sourceRoot, "outside"); mkdirSync(outside);
      symlinkSync(outside, originals);
      const destinationResult = ingestDocument(f.db, f.root, f.source, metadata);
      expect(destinationResult.ok).toBe(false);
      expect(destinationResult.errors?.join(" ")).toContain("non-symlink");
      expect(f.db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });
    } finally { f.cleanup(); }
  });

  test("rejects empty and over-limit sources before evidence publication", () => {
    const f = fixture();
    try {
      const empty = join(f.sourceRoot, "empty.txt");
      const tooLarge = join(f.sourceRoot, "large.txt");
      writeFileSync(empty, "");
      writeFileSync(tooLarge, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61));
      expect(ingestDocument(f.db, f.root, empty, metadata).errors?.join(" ")).toContain("empty");
      expect(ingestDocument(f.db, f.root, tooLarge, metadata).errors?.join(" ")).toContain("exceeds");
      expect(f.db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });
    } finally { f.cleanup(); }
  });

  test("scanner is fail-closed when required and stores clean evidence only after success", async () => {
    const f = fixture();
    try {
      const unavailable = await ingestDocumentAsync(f.db, f.root, f.source, metadata, { scannerPolicy: "required" });
      expect(unavailable.ok).toBe(false);
      expect(f.db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });

      const rejected = await ingestDocumentAsync(f.db, f.root, f.source, metadata, {
        scannerPolicy: "required",
        scanner: { async scan() { return { ok: false, error: "untrusted provider detail" } as const; } },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.errors).toEqual(["document scanner rejected the document"]);
      expect(f.db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });

      const accepted = await ingestDocumentAsync(f.db, f.root, f.source, metadata, {
        scannerPolicy: "required",
        scanner: { async scan(input) { return { ok: true as const, scannerId: "synthetic-scanner", scannerVersion: "v1", evidenceRef: `sha256:${input.sha256}` }; } },
      });
      expect(accepted.ok).toBe(true);
      expect(f.db.query("SELECT sha256_hash, scanner_id, scanner_version, result FROM document_scan_evidence").get()).toEqual({
        sha256_hash: accepted.sha256, scanner_id: "synthetic-scanner", scanner_version: "v1", result: "clean",
      });
    } finally { f.cleanup(); }
  });

  test("a malicious scanner can mutate only its isolated copy, never canonical evidence", async () => {
    const f = fixture();
    try {
      const result = await ingestDocumentAsync(f.db, f.root, f.source, metadata, {
        scannerPolicy: "required",
        scanner: {
          async scan(input) {
            input.bytes.fill(0x58);
            return { ok: true, scannerId: "mutating-test-scanner" };
          },
        },
      });
      expect(result.ok).toBe(true);
      expect(await Bun.file(result.storedPath!).text()).toBe("immutable synthetic voucher\n");
      expect(result.sha256).toBe(createHash("sha256").update("immutable synthetic voucher\n").digest("hex"));
    } finally { f.cleanup(); }
  });

  test("a scanner which never resolves is cancelled and fails closed before publication", async () => {
    const f = fixture();
    try {
      let aborted = false;
      const result = await ingestDocumentAsync(f.db, f.root, f.source, metadata, {
        scannerPolicy: "required",
        scannerTimeoutMs: 100,
        scanner: {
          scan({ signal }) {
            signal.addEventListener("abort", () => { aborted = true; });
            return new Promise(() => {});
          },
        },
      });
      expect(result).toEqual({ ok: false, errors: ["document scanner failed"] });
      expect(aborted).toBe(true);
      expect(f.db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });
    } finally { f.cleanup(); }
  });

  test("conflicting pre-existing evidence is rejected and never overwritten", () => {
    const f = fixture();
    try {
      const bytes = Buffer.from("immutable synthetic voucher\n");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const target = join(f.root, "documents", "originals", `${hash}.txt`);
      writeFileSync(target, "attacker bytes");
      const result = ingestDocument(f.db, f.root, f.source, metadata);
      expect(result.ok).toBe(false);
      expect(result.errors?.join(" ")).toContain("conflicting bytes");
      expect(Bun.file(target).size).toBe(Buffer.byteLength("attacker bytes"));
      expect(lstatSync(target).isFile()).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(f.db.query("SELECT count(*) AS n FROM documents").get()).toEqual({ n: 0 });
    } finally { f.cleanup(); }
  });

  test("a same-byte publication loser never unlinks the winner", () => {
    const f = fixture();
    try {
      const snapshot = snapshotDocumentSource(f.source);
      const store = join(f.root, "documents", "originals");
      const filename = `${snapshot.sha256}.txt`;
      const winner = publishDocumentSnapshot(store, filename, snapshot);
      const loser = publishDocumentSnapshot(store, filename, snapshot);
      expect(winner.published).toBe(true);
      expect(loser.published).toBe(false);
      expect(existsSync(winner.path)).toBe(true);
      expect(Bun.file(winner.path).size).toBe(snapshot.bytes.length);
    } finally { f.cleanup(); }
  });
});
