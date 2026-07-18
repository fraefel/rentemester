// Tests: src/core/atomic-file.ts — KODE-7 (durable atomic writes).
//
// writeSync + rename only orders the operations in the page cache; a power
// loss before the dirty pages reach stable storage could leave an empty or
// half-written manifest / signature / tar. writeFileAtomic must therefore
// fsync the file's bytes BEFORE rename, and fsync the containing directory
// AFTER rename so the directory entry naming the file is durable too.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  promoteTempFileExclusive,
  removeIfExists,
  writeFileAtomic,
  writeTempFileFor,
} from "../../src/core/atomic-file";

describe("writeFileAtomic durability (KODE-7)", () => {
  test("writes exact content and leaves no temp files for both string and bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "rentemester-atomic-fsync-"));

    const textPath = join(dir, "manifest.json");
    writeFileAtomic(textPath, "real-content\n");
    expect(readFileSync(textPath, "utf8")).toBe("real-content\n");

    const bytesPath = join(dir, "backup.tar");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    writeFileAtomic(bytesPath, bytes);
    expect(new Uint8Array(readFileSync(bytesPath))).toEqual(bytes);

    // No leftover `.tmp` staging files — every temp was renamed into place.
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  test("overwrites an existing file durably and atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "rentemester-atomic-fsync-overwrite-"));
    const target = join(dir, "manifest.json");

    writeFileAtomic(target, "first\n");
    expect(readFileSync(target, "utf8")).toBe("first\n");
    writeFileAtomic(target, "second\n");
    expect(readFileSync(target, "utf8")).toBe("second\n");

    // No staging files survive the directory fsync + rename.
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  test("exclusive promotion never clobbers an existing immutable artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "rentemester-atomic-exclusive-"));
    const target = join(dir, "invoice.json");
    writeFileSync(target, "sentinel\n");
    const tempPath = writeTempFileFor(target, "new legal snapshot\n");

    expect(() => promoteTempFileExclusive(tempPath, target)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("sentinel\n");
    expect(readFileSync(tempPath, "utf8")).toBe("new legal snapshot\n");

    removeIfExists(tempPath);
    rmSync(dir, { recursive: true, force: true });
  });
});
