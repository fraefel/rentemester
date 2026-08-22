import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSource } from "../../src/core/import/source";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function zip(path: string, files: Record<string, string>, args: string[] = []): void {
  const dir = mkdtempSync(join(tmpdir(), "rm-evidence-src-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const file = join(dir, name);
      const parent = file.slice(0, file.length - name.split("/").at(-1)!.length);
      if (parent !== dir) mkdirSync(parent, { recursive: true });
      writeFileSync(file, contents);
    }
    const result = spawnSync("zip", ["-q", ...args, path, ...Object.keys(files)], { cwd: dir });
    expect(result.status).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function malformedZip(path: string, names: string[]): void {
  const script = [
    "import sys, zipfile",
    "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
    ...names.map((name, index) => ` z.writestr(${JSON.stringify(name)}, 'entry-${index}')`),
  ].join("\n");
  const result = spawnSync("python3", ["-c", script, path]);
  expect(result.status).toBe(0);
}

describe("resolveSource — immutable source evidence", () => {
  test("records the exact ZIP snapshot bytes plus its canonical file inventory", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-evidence-"));
    const archive = join(dir, "export.zip");
    zip(archive, { "a.csv": "one\n", "nested/b.csv": "two\n" });
    try {
      const source = resolveSource(archive);
      expect(source.sourceEvidence).toMatchObject({
        sourceKind: "zip",
        listingEntryCount: 2,
        extractedEntryCount: 2,
        importedEntryCount: 2,
        totalUncompressedBytes: 8,
      });
      // Compare exact bytes separately so this test never mistakes an inventory
      // digest for the ZIP container digest.
      const raw = new Uint8Array(readFileSync(archive));
      expect(source.sourceEvidence.rawSha256).toBe(sha256(raw));
      expect(source.sourceEvidence.rawSize).toBe(raw.length);
      expect(source.sourceEvidence.entries.map((entry) => entry.path)).toEqual(["a.csv", "nested/b.csv"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("container order and compression do not affect canonical inventory, but content does", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-evidence-"));
    const first = join(dir, "first.zip");
    const second = join(dir, "second.zip");
    const changed = join(dir, "changed.zip");
    zip(first, { "a.csv": "one", "b.csv": "two" }, ["-0"]);
    // Reverse input order and use deflation: raw ZIP bytes differ, inventory does not.
    const src = mkdtempSync(join(tmpdir(), "rm-evidence-order-"));
    writeFileSync(join(src, "a.csv"), "one"); writeFileSync(join(src, "b.csv"), "two");
    expect(spawnSync("zip", ["-q", "-9", second, "b.csv", "a.csv"], { cwd: src }).status).toBe(0);
    rmSync(src, { recursive: true, force: true });
    zip(changed, { "a.csv": "one", "b.csv": "twO" }, ["-9"]);
    try {
      const a = resolveSource(first).sourceEvidence;
      const b = resolveSource(second).sourceEvidence;
      const c = resolveSource(changed).sourceEvidence;
      expect(a.rawSha256).not.toBe(b.rawSha256);
      expect(a.canonicalInventorySha256).toBe(b.canonicalInventorySha256);
      expect(a.canonicalListingSha256).toBe(b.canonicalListingSha256);
      expect(a.canonicalInventorySha256).not.toBe(c.canonicalInventorySha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("rejects traversal and case-colliding ZIP paths before import", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-evidence-"));
    const traversal = join(dir, "traversal.zip");
    const collision = join(dir, "collision.zip");
    malformedZip(traversal, ["../outside.csv"]);
    malformedZip(collision, ["A.csv", "a.csv"]);
    try {
      expect(() => resolveSource(traversal)).toThrow(/unsafe import entry path/);
      expect(() => resolveSource(collision)).toThrow(/case-colliding import entry paths/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("uses its private ZIP snapshot when the original path is replaced during resolution", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-evidence-"));
    const original = join(dir, "original.zip");
    const replacement = join(dir, "replacement.zip");
    zip(original, { "a.csv": "original" });
    zip(replacement, { "a.csv": "replacement with distinctly different bytes" });
    try {
      const originalHash = sha256(new Uint8Array(readFileSync(original)));
      const replacementHash = sha256(new Uint8Array(readFileSync(replacement)));
      expect(originalHash).not.toBe(replacementHash);
      const source = resolveSource(original);
      // Replacing the user-visible path after resolution cannot retroactively
      // change the bytes or evidence that were read from the private snapshot.
      copyFileSync(replacement, original);
      expect(source.files["a.csv"]!.text).toBe("original");
      expect(source.sourceEvidence.rawSha256).toBe(originalHash);
      expect(source.sourceEvidence.rawSha256).not.toBe(sha256(new Uint8Array(readFileSync(original))));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("directory and single-file evidence carry an inventory, not a ZIP raw hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-evidence-"));
    const single = join(dir, "single.csv");
    writeFileSync(single, "x");
    try {
      const directory = resolveSource(dir).sourceEvidence;
      const file = resolveSource(single).sourceEvidence;
      expect(directory.sourceKind).toBe("directory");
      expect(file.sourceKind).toBe("file");
      expect(directory.rawSha256).toBeUndefined();
      expect(file.rawSha256).toBeUndefined();
      expect(file.canonicalInventorySha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
