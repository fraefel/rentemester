import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { companyPaths } from "./paths";
import { migrate, openDb } from "./db";
import {
  createSystemBackup,
  packBackupArchive,
  type ManifestFile,
} from "./system-backups";
import { restoreSystemBackup } from "./system-restore";
import {
  companyRootForSlug,
  initWorkspace,
  listWorkspaceCompanies,
  loadWorkspaceManifest,
  saveWorkspaceManifest,
  type WorkspaceManifest,
} from "./workspace";
import { listWorkspaceMembers, type CompanyRole, type WorkspaceRole } from "./workspace-access";
import { openWorkspaceControlDb, workspaceControlPaths } from "./workspace-control";
import { createTar, dirToTarEntries, extractTar, readTar } from "./tar";
import { getReleaseProvenance, isReleaseProvenance, type ReleaseProvenance } from "./release-provenance";
import { promoteTempFileExclusive, writeFileAtomic, writeTempFileFor } from "./atomic-file";
import { removePathWithRetry, renamePathWithRetry } from "./fs-cleanup";

const SNAPSHOT_RULE_ID = "RENTEMESTER-WORKSPACE-SNAPSHOT-001";
const SAFE_PORTABLE_CONFIG = new Set(["backup-lock.json", "backup-manifest.pub", "policy.yaml"]);

type SnapshotAccessPlan = {
  version: 1;
  recovery: "bootstrap-owner-then-reinvite";
  users: Array<{
    name: string;
    email: string;
    workspaceRole: WorkspaceRole;
    memberships: Array<{ companySlug: string; role: CompanyRole }>;
  }>;
};

export type WorkspaceSnapshotManifestV1 = {
  version: 1;
  createdAt: string;
  provenance: ReleaseProvenance;
  credentialPolicy: "omit-all-auth-and-operational-credentials-v1";
  workspaceManifest: ManifestFile;
  accessPlan: ManifestFile;
  companies: Array<{
    slug: string;
    name: string;
    archived: boolean;
    backup: ManifestFile;
  }>;
};

export type CreateWorkspaceSnapshotResult = {
  ok: boolean;
  snapshotPath?: string;
  sha256?: string;
  sha256Path?: string;
  companyCount?: number;
  accessIdentityCount?: number;
  appliedRules: string[];
  errors: string[];
};

export type RestoreWorkspaceSnapshotResult = {
  ok: boolean;
  targetWorkspaceRoot?: string;
  companyCount?: number;
  accessRecoveryPlanPath?: string;
  nextStep?: "bootstrap-owner-then-reinvite";
  appliedRules: string[];
  errors: string[];
};

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileEvidence(root: string, path: string): ManifestFile {
  const content = readFileSync(path);
  return {
    path: path.slice(root.length + 1).replaceAll("\\", "/"),
    sha256: sha256(content),
    sizeBytes: content.byteLength,
  };
}

function validInstant(value?: string): string | null {
  const instant = value ?? new Date().toISOString();
  return Number.isNaN(Date.parse(instant)) ? null : new Date(instant).toISOString();
}

function snapshotError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export function createWorkspaceSnapshot(
  workspaceRoot: string,
  input: { outPath: string; createdAt?: string; createdBy?: string; createdByProgram?: string },
): CreateWorkspaceSnapshotResult {
  const createdAt = validInstant(input.createdAt);
  const outPath = input.outPath?.trim();
  if (!createdAt || !outPath) {
    return { ok: false, appliedRules: [SNAPSHOT_RULE_ID], errors: ["outPath and a valid createdAt are required"] };
  }
  if (existsSync(outPath)) {
    return { ok: false, appliedRules: [SNAPSHOT_RULE_ID], errors: ["snapshot destination already exists"] };
  }
  const companies = listWorkspaceCompanies(workspaceRoot);
  if (companies.length === 0) {
    return { ok: false, appliedRules: [SNAPSHOT_RULE_ID], errors: ["workspace has no registered companies"] };
  }
  const staging = mkdtempSync(join(tmpdir(), "rentemester-workspace-snapshot-"));
  try {
    const workspaceManifestPath = join(staging, "workspace.json");
    saveWorkspaceManifest(staging, loadWorkspaceManifest(workspaceRoot));
    const controlDbPath = workspaceControlPaths(workspaceRoot).db;
    const accessPlan: SnapshotAccessPlan = { version: 1, recovery: "bootstrap-owner-then-reinvite", users: [] };
    if (existsSync(controlDbPath)) {
      const controlDb = openWorkspaceControlDb(workspaceRoot);
      try {
        accessPlan.users = listWorkspaceMembers(controlDb, workspaceRoot).map((member) => ({
          name: member.name,
          email: member.email,
          workspaceRole: member.workspaceRole,
          memberships: member.memberships.map(({ companySlug, role }) => ({ companySlug, role })),
        }));
      } finally { controlDb.close(); }
    }
    const accessPlanPath = join(staging, "access-plan.json");
    writeFileAtomic(accessPlanPath, `${JSON.stringify(accessPlan, null, 2)}\n`);

    const companyEntries: WorkspaceSnapshotManifestV1["companies"] = [];
    for (const company of companies) {
      const companyRoot = companyRootForSlug(workspaceRoot, company.slug);
      const db = openDb(companyPaths(companyRoot).db);
      try {
        migrate(db);
        const backup = createSystemBackup(db, companyRoot, {
          createdAt,
          signWithEd25519: true,
          credentialFree: true,
          createdBy: input.createdBy,
          createdByProgram: input.createdByProgram,
        });
        if (!backup.ok || !backup.backupId) throw new Error(backup.errors.join("; "));
        const archivePath = join(staging, "companies", `${company.slug}.tar`);
        mkdirSync(dirname(archivePath), { recursive: true });
        const packed = packBackupArchive(db, companyRoot, {
          backupId: backup.backupId,
          outPath: archivePath,
          createdBy: input.createdBy,
          createdByProgram: input.createdByProgram,
        });
        if (!packed.ok) throw new Error(packed.errors.join("; "));
        removePathWithRetry(`${archivePath}.sha256`);
        companyEntries.push({
          slug: company.slug,
          name: company.name,
          archived: company.archived,
          backup: fileEvidence(staging, archivePath),
        });
      } finally { db.close(); }
    }

    const manifest: WorkspaceSnapshotManifestV1 = {
      version: 1,
      createdAt,
      provenance: getReleaseProvenance(),
      credentialPolicy: "omit-all-auth-and-operational-credentials-v1",
      workspaceManifest: fileEvidence(staging, workspaceManifestPath),
      accessPlan: fileEvidence(staging, accessPlanPath),
      companies: companyEntries.sort((a, b) => a.slug.localeCompare(b.slug)),
    };
    writeFileAtomic(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const archive = createTar(dirToTarEntries(staging));
    const digest = sha256(archive);
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    const temp = writeTempFileFor(outPath, archive);
    promoteTempFileExclusive(temp, outPath);
    const sha256Path = `${outPath}.sha256`;
    writeFileAtomic(sha256Path, `${digest}  ${basename(outPath)}\n`);
    return {
      ok: true,
      snapshotPath: outPath,
      sha256: digest,
      sha256Path,
      companyCount: companyEntries.length,
      accessIdentityCount: accessPlan.users.length,
      appliedRules: [SNAPSHOT_RULE_ID],
      errors: [],
    };
  } catch (error) {
    return { ok: false, appliedRules: [SNAPSHOT_RULE_ID], errors: [`workspace snapshot failed: ${snapshotError(error)}`] };
  } finally {
    removePathWithRetry(staging);
  }
}

function isManifestFile(value: unknown): value is ManifestFile {
  const file = value as ManifestFile;
  return Boolean(file) && typeof file.path === "string" && /^[a-f0-9]{64}$/.test(file.sha256) &&
    Number.isSafeInteger(file.sizeBytes) && file.sizeBytes >= 0;
}

function parseManifest(raw: string): WorkspaceSnapshotManifestV1 | null {
  try {
    const value = JSON.parse(raw) as WorkspaceSnapshotManifestV1;
    if (value.version !== 1 || value.credentialPolicy !== "omit-all-auth-and-operational-credentials-v1" ||
      !validInstant(value.createdAt) || !isReleaseProvenance(value.provenance) ||
      !isManifestFile(value.workspaceManifest) || !isManifestFile(value.accessPlan) ||
      !Array.isArray(value.companies) || value.companies.length === 0) return null;
    const slugs = new Set<string>();
    for (const company of value.companies) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(company.slug) || !company.name ||
        typeof company.archived !== "boolean" || !isManifestFile(company.backup) || slugs.has(company.slug)) return null;
      slugs.add(company.slug);
    }
    return value;
  } catch { return null; }
}

function verifyFile(root: string, file: ManifestFile): string | null {
  const path = join(root, ...file.path.split("/"));
  if (!existsSync(path) || !statSync(path).isFile()) return `missing snapshot file: ${file.path}`;
  const content = readFileSync(path);
  if (content.byteLength !== file.sizeBytes || sha256(content) !== file.sha256) {
    return `snapshot checksum mismatch: ${file.path}`;
  }
  return null;
}

function parseAccessPlan(raw: string, companies: Set<string>): SnapshotAccessPlan | null {
  try {
    const value = JSON.parse(raw) as SnapshotAccessPlan;
    if (value.version !== 1 || value.recovery !== "bootstrap-owner-then-reinvite" || !Array.isArray(value.users)) return null;
    const emails = new Set<string>();
    for (const user of value.users) {
      const email = user.email?.trim().toLowerCase();
      if (!user.name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || emails.has(email) ||
        (user.workspaceRole !== "workspace_owner" && user.workspaceRole !== "member") || !Array.isArray(user.memberships)) return null;
      emails.add(email);
      if (user.memberships.some((membership) => !companies.has(membership.companySlug) ||
        !["owner", "bookkeeper", "reviewer", "reader"].includes(membership.role))) return null;
    }
    return value;
  } catch { return null; }
}

function assertCredentialFreeCompanyArchive(archive: Buffer): void {
  for (const entry of readTar(archive)) {
    if (!entry.path.startsWith("config/")) continue;
    const name = entry.path.slice("config/".length);
    if (!SAFE_PORTABLE_CONFIG.has(name)) throw new Error("company snapshot contains non-portable configuration");
  }
}

export function restoreWorkspaceSnapshot(input: {
  snapshotPath: string;
  targetWorkspaceRoot: string;
  createdBy?: string;
  createdByProgram?: string;
}): RestoreWorkspaceSnapshotResult {
  if (!input.snapshotPath || !existsSync(input.snapshotPath) || !statSync(input.snapshotPath).isFile()) {
    return { ok: false, appliedRules: [SNAPSHOT_RULE_ID], errors: ["workspace snapshot does not exist"] };
  }
  const target = resolve(input.targetWorkspaceRoot);
  if (!input.targetWorkspaceRoot || (existsSync(target) && readdirSync(target).length > 0)) {
    return { ok: false, appliedRules: [SNAPSHOT_RULE_ID], errors: ["target workspace must be new or empty"] };
  }
  const extracted = mkdtempSync(join(tmpdir(), "rentemester-workspace-restore-source-"));
  const staging = join(dirname(target), `.restore-workspace-${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    if (existsSync(staging)) throw new Error("workspace restore staging path already exists");
    const written = extractTar(readFileSync(input.snapshotPath), extracted).sort();
    const manifestPath = join(extracted, "manifest.json");
    const manifest = existsSync(manifestPath) ? parseManifest(readFileSync(manifestPath, "utf8")) : null;
    if (!manifest) throw new Error("workspace snapshot manifest is invalid");
    const expected = ["manifest.json", manifest.workspaceManifest.path, manifest.accessPlan.path,
      ...manifest.companies.map((company) => company.backup.path)].sort();
    if (JSON.stringify(written) !== JSON.stringify(expected)) throw new Error("workspace snapshot contains unlisted files");
    for (const file of [manifest.workspaceManifest, manifest.accessPlan, ...manifest.companies.map((company) => company.backup)]) {
      const error = verifyFile(extracted, file);
      if (error) throw new Error(error);
    }
    const sourceManifest = loadWorkspaceManifest(extracted);
    const declared = new Map(manifest.companies.map((company) => [company.slug, company]));
    if (sourceManifest.companies.length !== declared.size || sourceManifest.companies.some((company) => {
      const match = declared.get(company.slug);
      return !match || match.name !== company.name || match.archived !== company.archived;
    })) throw new Error("workspace and snapshot company manifests disagree");
    const accessPlan = parseAccessPlan(
      readFileSync(join(extracted, ...manifest.accessPlan.path.split("/")), "utf8"),
      new Set(declared.keys()),
    );
    if (!accessPlan) throw new Error("workspace access recovery plan is invalid");

    initWorkspace(staging);
    saveWorkspaceManifest(staging, sourceManifest as WorkspaceManifest);
    for (const company of manifest.companies) {
      const archivePath = join(extracted, ...company.backup.path.split("/"));
      const archive = readFileSync(archivePath);
      assertCredentialFreeCompanyArchive(archive);
      const companySource = mkdtempSync(join(tmpdir(), `rentemester-company-restore-${company.slug}-`));
      try {
        extractTar(archive, companySource);
        const publicKeyPath = join(companySource, "config", "backup-manifest.pub");
        if (!existsSync(publicKeyPath)) throw new Error("company snapshot is missing its verification key");
        const restored = restoreSystemBackup({
          backupDir: companySource,
          targetCompanyRoot: companyRootForSlug(staging, company.slug),
          publicKeyPath,
          credentialFreePortableMode: true,
          createdBy: input.createdBy,
          createdByProgram: input.createdByProgram,
        });
        if (!restored.ok) throw new Error(restored.errors.join("; "));
      } finally { removePathWithRetry(companySource); }
    }
    const recoveryDir = join(staging, ".rentemester");
    mkdirSync(recoveryDir, { recursive: true });
    const recoveryPath = join(recoveryDir, "restored-access-plan.json");
    writeFileAtomic(recoveryPath, `${JSON.stringify(accessPlan, null, 2)}\n`);
    chmodSync(recoveryPath, 0o600);
    if (existsSync(target)) removePathWithRetry(target);
    else mkdirSync(dirname(target), { recursive: true });
    renamePathWithRetry(staging, target);
    return {
      ok: true,
      targetWorkspaceRoot: target,
      companyCount: manifest.companies.length,
      accessRecoveryPlanPath: join(target, ".rentemester", "restored-access-plan.json"),
      nextStep: "bootstrap-owner-then-reinvite",
      appliedRules: [SNAPSHOT_RULE_ID],
      errors: [],
    };
  } catch (error) {
    if (existsSync(staging)) removePathWithRetry(staging);
    return { ok: false, appliedRules: [SNAPSHOT_RULE_ID], errors: [`workspace restore failed: ${snapshotError(error)}`] };
  } finally {
    removePathWithRetry(extracted);
  }
}
