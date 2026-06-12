// Tests: src/server/static.ts — EJER-5: `rentemester serve` must be able to
// say WHICH cockpit-UI build it serves. `app/dist` is gitignored, so the
// served UI is whatever local build happens to exist — possibly weeks older
// than `app/src`. The serve command reports the build's timestamp (and a
// rebuild hint when no build exists) so a stale UI is visible, not silent.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describeStaticUiBuild } from "../../src/server/static";

describe("describeStaticUiBuild (EJER-5)", () => {
  test("reports the build timestamp of the served index.html", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-ui-build-"));
    const indexPath = join(root, "index.html");
    writeFileSync(indexPath, "<!doctype html><title>cockpit</title>");
    // Pin mtime to a known instant so the assertion is deterministic.
    const builtAt = new Date("2026-05-23T07:25:00.000Z");
    utimesSync(indexPath, builtAt, builtAt);

    const info = describeStaticUiBuild(root);
    expect(info.present).toBe(true);
    if (info.present) {
      expect(info.staticRoot).toBe(root);
      expect(info.builtAt).toBe("2026-05-23T07:25:00.000Z");
      // The operator-facing hint explains how to refresh a stale build.
      expect(info.rebuildHint).toContain("cd app && bun run build");
    }

    rmSync(root, { recursive: true, force: true });
  });

  test("reports a missing build (no index.html) with a rebuild hint", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-ui-nobuild-"));

    const info = describeStaticUiBuild(root);
    expect(info.present).toBe(false);
    if (!info.present) {
      expect(info.staticRoot).toBe(root);
      expect(info.hint).toContain("cd app && bun run build");
    }

    rmSync(root, { recursive: true, force: true });
  });

  test("reports a missing build when no static root is configured at all", () => {
    const info = describeStaticUiBuild(undefined);
    expect(info.present).toBe(false);
    if (!info.present) {
      expect(info.staticRoot).toBeNull();
      expect(info.hint).toContain("cd app && bun run build");
    }
  });
});
