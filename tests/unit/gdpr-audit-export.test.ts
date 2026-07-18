// Tests: src/core/gdpr.ts signed, self-describing GDPR audit exports.
import { describe, expect, test } from "bun:test";
import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, migrate } from "../../src/core/db";
import { ensureCompanyDirs } from "../../src/core/paths";
import {
  backupEd25519PrivateKeyPath,
  backupEd25519PublicKeyPath,
  ensureEd25519Keypair,
} from "../../src/core/system-backups";
import { buildGdprAuditExport } from "../../src/core/gdpr";

function freshCompany(label: string) {
  const root = mkdtempSync(join(tmpdir(), `rentemester-gdpr-audit-${label}-`));
  const db = openDb(ensureCompanyDirs(root).db);
  migrate(db);
  return { root, db };
}

function insertEvent(db: ReturnType<typeof openDb>, createdAt: string, id: string) {
  db.run(
    `INSERT INTO audit_log
       (created_at, event_type, entity_type, entity_id, message, actor)
     VALUES (?, 'gdpr_export', 'gdpr_subject', ?, ?, 'agent:test via bun-test')`,
    createdAt,
    id,
    `event ${id}`,
  );
}

describe("GDPR audit export", () => {
  test("canonicalPayload is self-describing and until includes the entire date", () => {
    const { root, db } = freshCompany("canonical");
    insertEvent(db, "2026-07-18 00:00:00", "start");
    insertEvent(db, "2026-07-18 12:00:00", "middle");
    insertEvent(db, "2026-07-18 23:59:59", "end");
    insertEvent(db, "2026-07-19 00:00:00", "next-day");

    const result = buildGdprAuditExport(db, {
      since: "2026-07-18",
      until: "2026-07-18",
      asOf: "2026-07-18",
    });
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(result.ok).toBe(true);
    expect(result.events.map((event) => event.subjectKey)).toEqual([
      "start",
      "middle",
      "end",
    ]);
    const canonical = JSON.parse(result.canonicalPayload);
    expect(canonical).toEqual({
      format: result.format,
      ruleId: result.ruleId,
      asOf: result.asOf,
      since: result.since,
      until: result.until,
      events: result.events,
    });
    expect(result.fingerprint).toBe(
      `sha256:${createHash("sha256").update(result.canonicalPayload, "utf8").digest("hex")}`,
    );
  });

  test("rejects invalid dates and reversed intervals without querying events", () => {
    const { root, db } = freshCompany("dates");
    insertEvent(db, "2026-07-18 12:00:00", "event");

    const invalid = buildGdprAuditExport(db, { asOf: "2026-02-30" });
    const reversed = buildGdprAuditExport(db, {
      asOf: "2026-07-18",
      since: "2026-07-19",
      until: "2026-07-18",
    });
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(invalid.ok).toBe(false);
    expect(invalid.events).toEqual([]);
    expect(reversed.ok).toBe(false);
    expect(reversed.events).toEqual([]);
    expect(reversed.errors[0]).toContain("on or before");
  });

  test("signature covers canonicalPayload and identifies the matching public key", () => {
    const { root, db } = freshCompany("signed");
    insertEvent(db, "2026-07-18 12:00:00", "signed");
    ensureEd25519Keypair(root);

    const result = buildGdprAuditExport(db, {
      asOf: "2026-07-18",
      signWithEd25519: true,
      companyRoot: root,
    });
    const publicKey = createPublicKey(
      readFileSync(backupEd25519PublicKeyPath(root), "utf8"),
    );
    const verified = cryptoVerify(
      null,
      Buffer.from(result.canonicalPayload, "utf8"),
      publicKey,
      Buffer.from(result.signature!.base64, "base64"),
    );
    const publicKeyHint = `sha256:${createHash("sha256")
      .update(publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")}`;
    db.close();
    rmSync(root, { recursive: true, force: true });

    expect(result.ok).toBe(true);
    expect(verified).toBe(true);
    expect(result.signature).toMatchObject({
      algorithm: "ed25519",
      encoding: "utf8",
      signedField: "canonicalPayload",
      publicKeyHint,
    });
  });

  test("missing, partial, malformed and mismatched keypairs fail closed without paths", () => {
    const missing = freshCompany("missing");
    const missingResult = buildGdprAuditExport(missing.db, {
      asOf: "2026-07-18",
      signWithEd25519: true,
      companyRoot: missing.root,
    });
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors.join(" ")).not.toContain(missing.root);
    missing.db.close();
    rmSync(missing.root, { recursive: true, force: true });

    const partial = freshCompany("partial");
    ensureEd25519Keypair(partial.root);
    rmSync(backupEd25519PublicKeyPath(partial.root));
    const partialResult = buildGdprAuditExport(partial.db, {
      asOf: "2026-07-18",
      signWithEd25519: true,
      companyRoot: partial.root,
    });
    expect(partialResult.ok).toBe(false);
    expect(partialResult.errors).toEqual([
      "ed25519 backup signing key state is incomplete",
    ]);
    partial.db.close();
    rmSync(partial.root, { recursive: true, force: true });

    const malformed = freshCompany("malformed");
    ensureEd25519Keypair(malformed.root);
    writeFileSync(backupEd25519PrivateKeyPath(malformed.root), "not a PEM key");
    const malformedResult = buildGdprAuditExport(malformed.db, {
      asOf: "2026-07-18",
      signWithEd25519: true,
      companyRoot: malformed.root,
    });
    expect(malformedResult.ok).toBe(false);
    expect(malformedResult.errors.join(" ")).not.toContain(malformed.root);
    malformed.db.close();
    rmSync(malformed.root, { recursive: true, force: true });

    const mismatched = freshCompany("mismatched");
    const other = freshCompany("other-key");
    ensureEd25519Keypair(mismatched.root);
    ensureEd25519Keypair(other.root);
    writeFileSync(
      backupEd25519PublicKeyPath(mismatched.root),
      readFileSync(backupEd25519PublicKeyPath(other.root), "utf8"),
    );
    const mismatchedResult = buildGdprAuditExport(mismatched.db, {
      asOf: "2026-07-18",
      signWithEd25519: true,
      companyRoot: mismatched.root,
    });
    expect(mismatchedResult.ok).toBe(false);
    expect(mismatchedResult.errors).toEqual([
      "ed25519 backup signing keypair does not match",
    ]);
    mismatched.db.close();
    other.db.close();
    rmSync(mismatched.root, { recursive: true, force: true });
    rmSync(other.root, { recursive: true, force: true });
  });
});
