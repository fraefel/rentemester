import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createTar, readTar } from "../../src/core/tar";
import { companyPaths } from "../../src/core/paths";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "../../src/core/workspace-snapshot";
import { openWorkspaceControlDb, workspaceControlPaths } from "../../src/core/workspace-control";
import { activateWorkspaceUser, grantCompanyMembership } from "../../src/core/workspace-access";
import { openDb } from "../../src/core/db";
import { verifyAuditChain } from "../../src/core/ledger";
import { companyRootForSlug } from "../../src/core/workspace";
import { makeWorkspace } from "./server-api/_shared";
import { proposeCompanyKnowledge, reviewCompanyKnowledge, queryCompanyKnowledge } from "../../src/core/company-knowledge";
import { applyOwnershipSnapshot, ownershipHistory, projectExactCompanyOwnership, proposeOwnershipSnapshot, queryOwnershipGraph, reviewOwnershipSnapshot } from "../../src/core/ownership-graph";

function tempPath(label: string) { return join(mkdtempSync(join(tmpdir(), `${label}-`)), "artifact.tar"); }

function addOwner(workspace: string) {
  const db = openWorkspaceControlDb(workspace);
  const createdAt = "2026-08-23T10:00:00.000Z";
  db.query(`INSERT INTO "user"
    (id,name,email,emailVerified,createdAt,updatedAt,twoFactorEnabled)
    VALUES ('owner','Snapshot Owner','owner@example.test',1,?,?,1)`).run(createdAt, createdAt);
  db.query(`INSERT INTO "account"
    (id,accountId,providerId,issuer,userId,password,createdAt,updatedAt)
    VALUES ('credential','owner','credential','credential','owner','private-password-hash',?,?)`).run(createdAt, createdAt);
  db.query(`INSERT INTO "session"
    (id,expiresAt,token,createdAt,updatedAt,userId)
    VALUES ('private-session',?,'private-session-token',?,?,'owner')`).run(
    "2026-08-24T10:00:00.000Z", createdAt, createdAt,
  );
  activateWorkspaceUser(db, {
    userId: "owner", workspaceRole: "workspace_owner",
    createdBy: "agent:test", createdByProgram: "unit-test",
  });
  for (const companySlug of ["alpha-company", "beta-company"]) {
    grantCompanyMembership(db, workspace, {
      userId: "owner", companySlug, role: "owner",
      createdBy: "agent:test", createdByProgram: "unit-test",
    });
  }
  db.close();
}

describe("credential-free workspace snapshot and restore", () => {
  test("preserves reviewed ownership snapshots, facts and v1-safe projection without credentials", () => {
    const workspace=makeWorkspace("workspace-ownership-snapshot",["Alpha Company","Beta Company"]);const outPath=tempPath("workspace-ownership-out");const target=join(mkdtempSync(join(tmpdir(),"workspace-ownership-target-")),"restored");
    try { addOwner(workspace);const db=openWorkspaceControlDb(workspace);try { const principal={kind:"local_operator" as const,id:"snapshot-test"};const snapshot=proposeOwnershipSnapshot(db,{snapshotId:"ownership-snapshot",source:"synthetic-registry",observedAt:"2026-01-01T00:00:00Z",facts:[{owner:{kind:"company",companySlug:"alpha-company"},ownedCompanySlug:"beta-company",validFrom:"2026-01-01",economicBasisPoints:10000,controlType:"equity",jurisdiction:"DK",evidenceRefs:["synthetic-evidence"]}],actor:"user:test",principal});reviewOwnershipSnapshot(db,{snapshotId:snapshot.snapshotId,decision:"approved",actor:"user:review",principal});applyOwnershipSnapshot(db,{snapshotId:snapshot.snapshotId,snapshotHash:snapshot.snapshotHash,diffHash:snapshot.diffHash,actor:"user:review",principal,authorized:true}); } finally {db.close();}
      expect(createWorkspaceSnapshot(workspace,{outPath,createdAt:"2026-08-23T11:00:00.000Z"}).ok).toBeTrue();const entries=readTar(readFileSync(outPath));const ownershipEntry=entries.find(entry=>entry.path==="ownership-graph.json");expect(ownershipEntry).toBeDefined();const archiveText=entries.map(entry=>new TextDecoder().decode(entry.content)).join("\n");expect(archiveText).not.toContain("private-session-token");expect(archiveText).not.toContain("private-password-hash");const restored=restoreWorkspaceSnapshot({snapshotPath:outPath,targetWorkspaceRoot:target});expect(restored.ok).toBeTrue();const read=openWorkspaceControlDb(target);try{expect(ownershipHistory(read,"ownership-snapshot")[0]).toMatchObject({state:"applied"});expect(queryOwnershipGraph(read,{asOf:"2026-02-01"}).facts).toHaveLength(1);expect(projectExactCompanyOwnership(read,"2026-02-01")).toMatchObject({eligible:true,edges:[{parentCompanySlug:"alpha-company",childCompanySlug:"beta-company",basisPoints:10000}]});expect(read.query("SELECT count(*) AS n FROM rm_ownership_snapshot_events").get()).toEqual({n:3});}finally{read.close();}
    } finally {rmSync(workspace,{recursive:true,force:true});rmSync(dirname(outPath),{recursive:true,force:true});rmSync(dirname(target),{recursive:true,force:true});}
  });
  test("includes source-backed company knowledge without exporting credentials", () => {
    const workspace=makeWorkspace("workspace-knowledge-snapshot",["Alpha Company"]);const outPath=tempPath("workspace-knowledge-out");const target=join(mkdtempSync(join(tmpdir(),"workspace-knowledge-target-")),"restored");
    try { const db=openWorkspaceControlDb(workspace);try { const principal={kind:"local_operator" as const,id:"snapshot-test"};const assertion=proposeCompanyKnowledge(db,{companySlug:"alpha-company",predicate:"markets",value:["DK"],source:{kind:"external_snapshot",ref:"synthetic-source"},validFrom:"2026-01-01",actor:"user:test",principal});reviewCompanyKnowledge(db,{assertionId:assertion.assertionId,decision:"approved",actor:"user:review",principal}); } finally {db.close();}
      expect(createWorkspaceSnapshot(workspace,{outPath,createdAt:"2026-08-23T11:00:00.000Z"}).ok).toBeTrue();const restored=restoreWorkspaceSnapshot({snapshotPath:outPath,targetWorkspaceRoot:target});expect(restored.ok).toBeTrue();const read=openWorkspaceControlDb(target);try{expect(queryCompanyKnowledge(read,{companySlug:"alpha-company",asOf:"2026-02-01"}).assertions).toMatchObject([{predicate:"markets",source:{kind:"external_snapshot",ref:"synthetic-source"}}]);}finally{read.close();}
    } finally {rmSync(workspace,{recursive:true,force:true});rmSync(dirname(outPath),{recursive:true,force:true});rmSync(dirname(target),{recursive:true,force:true});}
  });
  test("restores every ledger and a safe access plan without credentials", () => {
    const workspace = makeWorkspace("workspace-snapshot", ["Alpha Company", "Beta Company"]);
    const outPath = tempPath("workspace-snapshot-out");
    const target = join(mkdtempSync(join(tmpdir(), "workspace-snapshot-target-parent-")), "restored");
    try {
      addOwner(workspace);
      for (const slug of ["alpha-company", "beta-company"]) {
        const config = companyPaths(companyRootForSlug(workspace, slug)).config;
        writeFileSync(join(config, "digisense.json"), '{"apiLicenseKey":"private-digisense-key"}', { mode: 0o600 });
        writeFileSync(join(config, "imap.json"), '{"password":"private-imap-password"}', { mode: 0o600 });
        writeFileSync(join(config, "smtp.json"), '{"password":"private-smtp-password"}', { mode: 0o600 });
      }
      const created = createWorkspaceSnapshot(workspace, {
        outPath,
        createdAt: "2026-08-23T11:00:00.000Z",
        createdBy: "agent:test",
        createdByProgram: "unit-test",
      });
      expect(created).toMatchObject({ ok: true, companyCount: 2, accessIdentityCount: 1 });
      const archive = readFileSync(outPath);
      for (const credential of [
        "private-password-hash", "private-session-token", "private-digisense-key",
        "private-imap-password", "private-smtp-password",
      ]) expect(archive.includes(Buffer.from(credential))).toBe(false);

      const restored = restoreWorkspaceSnapshot({ snapshotPath: outPath, targetWorkspaceRoot: target });
      expect(restored).toMatchObject({
        ok: true, companyCount: 2, nextStep: "bootstrap-owner-then-reinvite",
      });
      expect(existsSync(workspaceControlPaths(target).db)).toBe(false);
      const planPath = join(target, ".rentemester", "restored-access-plan.json");
      expect(statSync(planPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(planPath, "utf8"))).toMatchObject({
        version: 1,
        recovery: "bootstrap-owner-then-reinvite",
        users: [{
          name: "Snapshot Owner", email: "owner@example.test", workspaceRole: "workspace_owner",
          memberships: [
            { companySlug: "alpha-company", role: "owner" },
            { companySlug: "beta-company", role: "owner" },
          ],
        }],
      });
      for (const slug of ["alpha-company", "beta-company"]) {
        const root = companyRootForSlug(target, slug);
        for (const secretFile of ["digisense.json", "imap.json", "smtp.json"]) {
          expect(existsSync(join(companyPaths(root).config, secretFile))).toBe(false);
        }
        const db = openDb(companyPaths(root).db);
        expect(verifyAuditChain(db).ok).toBe(true);
        db.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dirname(outPath), { recursive: true, force: true });
      rmSync(dirname(target), { recursive: true, force: true });
    }
  });

  test("rejects tampering before publishing a target workspace", () => {
    const workspace = makeWorkspace("workspace-snapshot-tamper", ["Alpha Company"]);
    const outPath = tempPath("workspace-snapshot-tamper-out");
    const tamperedPath = tempPath("workspace-snapshot-tampered");
    const target = join(mkdtempSync(join(tmpdir(), "workspace-snapshot-tamper-target-")), "restored");
    try {
      const created = createWorkspaceSnapshot(workspace, {
        outPath, createdAt: "2026-08-23T12:00:00.000Z",
        createdBy: "agent:test", createdByProgram: "unit-test",
      });
      expect(created.ok).toBe(true);
      const entries = readTar(readFileSync(outPath)).map((entry) => entry.path === "access-plan.json"
        ? { ...entry, content: Buffer.from('{"tampered":true}\n') }
        : entry);
      writeFileSync(tamperedPath, createTar(entries));
      const restored = restoreWorkspaceSnapshot({ snapshotPath: tamperedPath, targetWorkspaceRoot: target });
      expect(restored.ok).toBe(false);
      expect(restored.errors.join(" ")).toContain("checksum mismatch");
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dirname(outPath), { recursive: true, force: true });
      rmSync(dirname(tamperedPath), { recursive: true, force: true });
      rmSync(dirname(target), { recursive: true, force: true });
    }
  });
});
