import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCompanyDirs } from "../../src/core/paths";
import { migrate, openDb } from "../../src/core/db";
import { resolveBoundDigisenseCompanyKey, resolveDigisenseIdentity } from "../../src/core/efaktura/digisense-identity";
import { saveDigisenseCompany } from "../../src/core/efaktura/digisense-state";

function ledger(cvr?: string) {
  const root = mkdtempSync(join(tmpdir(), "rentemester-digisense-identity-"));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  db.run("INSERT INTO companies (id, cvr, name) VALUES (1, ?, ?)", cvr ?? null, "Identity ApS");
  return { root, db };
}

describe("DigiSense ledger identity boundary", () => {
  test("requires a CVR-bearing company profile", () => {
    const { root, db } = ledger();
    try { expect(resolveDigisenseIdentity(db).ok).toBe(false); }
    finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test("keeps two ledgers' company keys isolated and rejects an explicit foreign key", () => {
    const a = ledger("DK12345678");
    const b = ledger("DK87654321");
    try {
      saveDigisenseCompany(a.db, { companyKey: "key-a", companyType: { type: "DK:CVR", id: "DK12345678" }, companyName: "Identity ApS" });
      saveDigisenseCompany(b.db, { companyKey: "key-b", companyType: { type: "DK:CVR", id: "DK87654321" }, companyName: "Identity ApS" });
      expect(resolveBoundDigisenseCompanyKey(a.db)).toEqual({ ok: true, value: "key-a" });
      expect(resolveBoundDigisenseCompanyKey(b.db)).toEqual({ ok: true, value: "key-b" });
      expect(resolveBoundDigisenseCompanyKey(a.db, "key-b").ok).toBe(false);
      expect(resolveBoundDigisenseCompanyKey(b.db, "key-a").ok).toBe(false);
    } finally {
      a.db.close(); b.db.close();
      rmSync(a.root, { recursive: true, force: true });
      rmSync(b.root, { recursive: true, force: true });
    }
  });
});
