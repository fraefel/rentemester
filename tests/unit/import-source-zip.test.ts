// Import framework — `.zip` export resolution. Regression guard for #192.
//
// A Dinero data export is delivered as a `.zip`. `resolveSource` must extract
// it into a `MultiArtifactSource` so a multi-file parser can read it. An
// earlier reimplementation of `source.ts` dropped the zip path entirely — the
// zip was treated as one opaque artifact and every required file looked
// "missing". These tests pin the zip behaviour so that cannot regress again.

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSource } from "../../src/core/import/source";

/** Builds a `.zip` of `srcDir`'s contents and returns its path. */
function zipDir(srcDir: string): string {
  const zipPath = join(mkdtempSync(join(tmpdir(), "rm-zip-")), "export.zip");
  const result = spawnSync("zip", ["-q", "-r", zipPath, "."], { cwd: srcDir });
  expect(result.status).toBe(0);
  return zipPath;
}

describe("resolveSource — .zip export extraction (#192)", () => {
  test("extracts a .zip into a MultiArtifactSource keyed by export-root-relative name", () => {
    const src = mkdtempSync(join(tmpdir(), "rm-zip-src-"));
    mkdirSync(join(src, "2025"));
    writeFileSync(join(src, "Firmaoplysninger.csv"), "Firmanavn\nTest ApS\n");
    writeFileSync(join(src, "2025", "Kontoplan.csv"), "Nummer;Navn\n1000;Salg\n");
    const zipPath = zipDir(src);

    const resolved = resolveSource(zipPath);

    // Both files are present, keyed by their forward-slash relative name —
    // NOT as a single opaque "export.zip" artifact.
    expect(resolved.files["Firmaoplysninger.csv"]).toBeDefined();
    expect(resolved.files["2025/Kontoplan.csv"]).toBeDefined();
    expect(resolved.files["export.zip"]).toBeUndefined();
    expect(resolved.files["Firmaoplysninger.csv"]!.text).toContain("Test ApS");
    expect(resolved.files["2025/Kontoplan.csv"]!.text).toContain("1000;Salg");
    expect(resolved.archiveIntegrity).toMatchObject({
      archiveEntryCount: 2,
      extractedEntryCount: 2,
      importedEntryCount: 2,
    });
    expect(resolved.archiveIntegrity!.archiveSha256).toMatch(/^[a-f0-9]{64}$/);

    rmSync(src, { recursive: true, force: true });
    rmSync(zipPath, { recursive: true, force: true });
  });

  test("a nested receipt directory survives the round-trip as a binary artifact", () => {
    const src = mkdtempSync(join(tmpdir(), "rm-zip-src-"));
    mkdirSync(join(src, "2025", "Bilag"), { recursive: true });
    writeFileSync(join(src, "2025", "Bilag", "2025-Bilag-1.pdf"), "%PDF-1.4 receipt\n");
    const zipPath = zipDir(src);

    const resolved = resolveSource(zipPath);
    const receipt = resolved.files["2025/Bilag/2025-Bilag-1.pdf"];
    expect(receipt).toBeDefined();
    expect(receipt!.bytes.length).toBeGreaterThan(0);

    rmSync(src, { recursive: true, force: true });
    rmSync(zipPath, { recursive: true, force: true });
  });

  test("extracts a Dinero Unicode filename on macOS without dropping entries", () => {
    const src = mkdtempSync(join(tmpdir(), "rm-zip-unicode-src-"));
    const zipPath = join(src, "export.zip");
    const made = spawnSync("python3", ["-c", [
      "import sys, zipfile",
      "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
      "  z.writestr('Ikke-bogførte-bilag/receipt.pdf', b'%PDF-1.4 receipt\\n')",
    ].join("\n"), zipPath]);
    expect(made.status).toBe(0);

    const resolved = resolveSource(zipPath);
    expect(resolved.files["Ikke-bogførte-bilag/receipt.pdf"]).toBeDefined();
    expect(resolved.archiveIntegrity).toMatchObject({
      archiveEntryCount: 1,
      extractedEntryCount: 1,
      importedEntryCount: 1,
    });

    rmSync(src, { recursive: true, force: true });
  });
});
