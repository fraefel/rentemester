// Tests: src/core/efaktura/digisense-config.ts — license-key secret store.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteDigisenseSecretConfig,
  loadDigisenseSecretConfig,
  saveDigisenseSecretConfig,
} from "../../src/core/efaktura/digisense-config";

function freshCompany(label: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-digisense-${label}-`));
  mkdirSync(join(root, "config"), { recursive: true });
  return root;
}

describe("digisense secret config — license-key store", () => {
  test("save → load roundtrip", () => {
    const root = freshCompany("save");
    try {
      const { path } = saveDigisenseSecretConfig(root, {
        apiLicenseKey: "lic-secret-123",
        environment: "production",
      });
      expect(path).toBe(join(root, "config", "digisense.json"));
      const loaded = loadDigisenseSecretConfig(root);
      expect(loaded).not.toBeNull();
      expect(loaded!.apiLicenseKey).toBe("lic-secret-123");
      expect(loaded!.environment).toBe("production");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("secret file is written with 0600 permissions", () => {
    const root = freshCompany("perms");
    try {
      const { path } = saveDigisenseSecretConfig(root, {
        apiLicenseKey: "lic-secret-123",
        environment: "test",
      });
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("load returns null when no config exists", () => {
    const root = freshCompany("missing");
    try {
      expect(loadDigisenseSecretConfig(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an empty license-key", () => {
    const root = freshCompany("empty-key");
    try {
      expect(() =>
        saveDigisenseSecretConfig(root, { apiLicenseKey: "  ", environment: "test" }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an invalid environment", () => {
    const root = freshCompany("bad-env");
    try {
      expect(() =>
        saveDigisenseSecretConfig(root, {
          apiLicenseKey: "lic",
          // @ts-expect-error — exercising the runtime guard
          environment: "staging",
        }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("delete removes the secret file", () => {
    const root = freshCompany("delete");
    try {
      saveDigisenseSecretConfig(root, { apiLicenseKey: "lic", environment: "test" });
      expect(deleteDigisenseSecretConfig(root)).toBe(true);
      expect(existsSync(join(root, "config", "digisense.json"))).toBe(false);
      // Deleting again is a no-op.
      expect(deleteDigisenseSecretConfig(root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
