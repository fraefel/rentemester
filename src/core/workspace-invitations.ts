import type { Database } from "bun:sqlite";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { resolveActor, type ResolveActorInput } from "./actor";
import {
  COMPANY_ROLES,
  getCompanyMembership,
  getWorkspaceUserAccess,
  type CompanyRole,
  type WorkspaceRole,
  WORKSPACE_ROLES,
} from "./workspace-access";
import { insertWorkspaceAudit } from "./workspace-control";
import { findWorkspaceCompany, isValidSlug } from "./workspace";

export const WORKSPACE_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type WorkspaceInvitationKey = { version: number; value: string };
export type WorkspaceInvitationStatus =
  | "issued"
  | "delivery_confirmed"
  | "delivery_failed"
  | "accepted"
  | "cancelled";

export type WorkspaceInvitation = {
  invitationId: string;
  email: string;
  workspaceRole: WorkspaceRole;
  companySlug: string;
  companyRole: CompanyRole;
  expiresAt: string;
  status: WorkspaceInvitationStatus;
  userId: string | null;
  createdAt: string;
};

type IssuedRow = {
  id: number;
  invitation_id: string;
  canonical_email: string;
  workspace_role: WorkspaceRole;
  company_slug: string;
  company_role: CompanyRole;
  expires_at: string;
  created_at: string;
};

type LatestEventRow = {
  event_type: WorkspaceInvitationStatus;
  user_id: string | null;
};

function canonicalEmail(value: string): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("invitation email is invalid");
  }
  return email;
}

function assertKey(key: WorkspaceInvitationKey): WorkspaceInvitationKey {
  if (!Number.isSafeInteger(key.version) || key.version < 0 || key.value.length < 32) {
    throw new Error("workspace invitation key is invalid");
  }
  return key;
}

function invitationHash(key: WorkspaceInvitationKey, domain: "token" | "email", value: string): string {
  const checked = assertKey(key);
  return createHmac("sha256", checked.value)
    .update(`rentemester-workspace-invitation-${domain}-v1\0${value}`)
    .digest("hex");
}

function assertCompanyRole(role: CompanyRole): CompanyRole {
  if (!COMPANY_ROLES.includes(role)) throw new Error("company role is invalid");
  return role;
}

function assertWorkspaceRole(role: WorkspaceRole): WorkspaceRole {
  if (!WORKSPACE_ROLES.includes(role)) throw new Error("workspace role is invalid");
  return role;
}

function assertActiveCompany(workspaceRoot: string, companySlug: string) {
  if (!isValidSlug(companySlug)) throw new Error("company slug is invalid");
  const company = findWorkspaceCompany(workspaceRoot, companySlug);
  if (!company || company.archived) throw new Error("invitation company is unavailable");
  return company;
}

function issuedById(db: Database, invitationId: string): IssuedRow | null {
  return db.query(
    `SELECT id, invitation_id, canonical_email, workspace_role, company_slug,
            company_role, expires_at, created_at
       FROM rm_workspace_invitation_events
      WHERE invitation_id = ? AND event_type = 'issued'
      ORDER BY id LIMIT 1`,
  ).get(invitationId) as IssuedRow | null;
}

function issuedByToken(db: Database, tokenHash: string): IssuedRow | null {
  return db.query(
    `SELECT id, invitation_id, canonical_email, workspace_role, company_slug,
            company_role, expires_at, created_at
       FROM rm_workspace_invitation_events
      WHERE token_hash = ? AND event_type = 'issued'`,
  ).get(tokenHash) as IssuedRow | null;
}

function latestEvent(db: Database, invitationId: string): LatestEventRow | null {
  return db.query(
    `SELECT event_type, user_id FROM rm_workspace_invitation_events
      WHERE invitation_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(invitationId) as LatestEventRow | null;
}

function toInvitation(db: Database, issued: IssuedRow): WorkspaceInvitation {
  const latest = latestEvent(db, issued.invitation_id)!;
  return {
    invitationId: issued.invitation_id,
    email: issued.canonical_email,
    workspaceRole: issued.workspace_role,
    companySlug: issued.company_slug,
    companyRole: issued.company_role,
    expiresAt: issued.expires_at,
    status: latest.event_type,
    userId: latest.user_id,
    createdAt: issued.created_at,
  };
}

function appendStatus(
  db: Database,
  invitationId: string,
  eventType: Exclude<WorkspaceInvitationStatus, "issued">,
  actor: string,
  userId: string | null = null,
): void {
  db.query(
    `INSERT INTO rm_workspace_invitation_events
       (invitation_id, event_type, user_id, actor) VALUES (?, ?, ?, ?)`,
  ).run(invitationId, eventType, userId, actor);
}

export function issueWorkspaceInvitation(
  db: Database,
  workspaceRoot: string,
  input: ResolveActorInput & {
    email: string;
    workspaceRole: WorkspaceRole;
    companySlug: string;
    companyRole: CompanyRole;
    key: WorkspaceInvitationKey;
    now?: Date;
  },
): { invitation: WorkspaceInvitation; token: string } {
  const email = canonicalEmail(input.email);
  const workspaceRole = assertWorkspaceRole(input.workspaceRole);
  const companyRole = assertCompanyRole(input.companyRole);
  const company = assertActiveCompany(workspaceRoot, input.companySlug);
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("invitation clock is invalid");
  const invitationId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = invitationHash(input.key, "token", token);
  const emailHash = invitationHash(input.key, "email", email);
  const expiresAt = new Date(now.getTime() + WORKSPACE_INVITATION_TTL_MS).toISOString();
  const actor = resolveActor(input);

  db.transaction(() => {
    db.query(
      `INSERT INTO rm_workspace_invitation_events
         (invitation_id, event_type, token_hash, token_key_version, canonical_email,
          email_hash, workspace_role, company_slug, company_role, expires_at, actor)
       VALUES (?, 'issued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      invitationId, tokenHash, input.key.version, email, emailHash, workspaceRole,
      company.slug, companyRole, expiresAt, actor.auditActor,
    );
    insertWorkspaceAudit(db, {
      eventType: "workspace_invitation_issued",
      entityType: "workspace_invitation",
      entityId: invitationId,
      ...input,
    });
  }).immediate();
  return { invitation: toInvitation(db, issuedById(db, invitationId)!), token };
}

export function recordWorkspaceInvitationDelivery(
  db: Database,
  input: ResolveActorInput & { invitationId: string; delivered: boolean },
): WorkspaceInvitation {
  const actor = resolveActor(input);
  return db.transaction(() => {
    const issued = issuedById(db, input.invitationId);
    if (!issued) throw new Error("workspace invitation does not exist");
    const latest = latestEvent(db, input.invitationId)!;
    if (latest.event_type !== "issued") throw new Error("workspace invitation delivery is already resolved");
    appendStatus(
      db,
      input.invitationId,
      input.delivered ? "delivery_confirmed" : "delivery_failed",
      actor.auditActor,
    );
    insertWorkspaceAudit(db, {
      eventType: input.delivered ? "workspace_invitation_delivery_confirmed" : "workspace_invitation_delivery_failed",
      entityType: "workspace_invitation",
      entityId: input.invitationId,
      ...input,
    });
    return toInvitation(db, issued);
  }).immediate();
}

export function cancelWorkspaceInvitation(
  db: Database,
  input: ResolveActorInput & { invitationId: string },
): WorkspaceInvitation {
  const actor = resolveActor(input);
  return db.transaction(() => {
    const issued = issuedById(db, input.invitationId);
    if (!issued) throw new Error("workspace invitation does not exist");
    const latest = latestEvent(db, input.invitationId)!;
    if (latest.event_type === "cancelled") return toInvitation(db, issued);
    if (latest.event_type === "accepted" || latest.event_type === "delivery_failed") {
      throw new Error("workspace invitation is already terminal");
    }
    appendStatus(db, input.invitationId, "cancelled", actor.auditActor);
    insertWorkspaceAudit(db, {
      eventType: "workspace_invitation_cancelled",
      entityType: "workspace_invitation",
      entityId: input.invitationId,
      ...input,
    });
    return toInvitation(db, issued);
  }).immediate();
}

export function listWorkspaceInvitations(db: Database): WorkspaceInvitation[] {
  const rows = db.query(
    `SELECT id, invitation_id, canonical_email, workspace_role, company_slug,
            company_role, expires_at, created_at
       FROM rm_workspace_invitation_events
      WHERE event_type = 'issued' ORDER BY id DESC`,
  ).all() as IssuedRow[];
  return rows.map((row) => toInvitation(db, row));
}

export function readClaimableWorkspaceInvitation(
  db: Database,
  input: { token: string; key: WorkspaceInvitationKey; now?: Date },
): WorkspaceInvitation {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("workspace invitation is invalid");
  const issued = issuedByToken(db, invitationHash(input.key, "token", token));
  if (!issued) throw new Error("workspace invitation is invalid");
  const latest = latestEvent(db, issued.invitation_id)!;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime()) || latest.event_type !== "delivery_confirmed" ||
    now.getTime() >= Date.parse(issued.expires_at)) {
    throw new Error("workspace invitation is invalid or expired");
  }
  return toInvitation(db, issued);
}

export function acceptWorkspaceInvitation(
  db: Database,
  workspaceRoot: string,
  input: ResolveActorInput & {
    token: string;
    key: WorkspaceInvitationKey;
    userId: string;
    now?: Date;
  },
): { invitation: WorkspaceInvitation; accessReady: boolean } {
  const actor = resolveActor(input);
  return db.transaction(() => {
    const invitation = readClaimableWorkspaceInvitation(db, input);
    const issued = issuedById(db, invitation.invitationId)!;
    assertActiveCompany(workspaceRoot, issued.company_slug);
    const user = db.query(
      'SELECT id, email, emailVerified, twoFactorEnabled FROM "user" WHERE id = ?',
    ).get(input.userId) as {
      id: string;
      email: string;
      emailVerified: number;
      twoFactorEnabled: number | null;
    } | null;
    if (!user || canonicalEmail(user.email) !== issued.canonical_email) {
      throw new Error("workspace invitation identity does not match");
    }

    const workspaceAccess = getWorkspaceUserAccess(db, user.id);
    if (!workspaceAccess.active) {
      db.query(
        `INSERT INTO rm_workspace_user_access_events
           (user_id, event_type, workspace_role, actor) VALUES (?, 'activate', ?, ?)`,
      ).run(user.id, issued.workspace_role, actor.auditActor);
    } else if (workspaceAccess.workspaceRole === "member" && issued.workspace_role === "workspace_owner") {
      db.query(
        `INSERT INTO rm_workspace_user_access_events
           (user_id, event_type, workspace_role, actor) VALUES (?, 'activate', 'workspace_owner', ?)`,
      ).run(user.id, actor.auditActor);
    }

    const membership = getCompanyMembership(db, user.id, issued.company_slug);
    if (!membership.active) {
      db.query(
        `INSERT INTO rm_company_membership_events
           (user_id, company_slug, event_type, company_role, actor)
         VALUES (?, ?, 'grant', ?, ?)`,
      ).run(user.id, issued.company_slug, issued.company_role, actor.auditActor);
    } else if (membership.role !== issued.company_role) {
      throw new Error("workspace invitation conflicts with existing company access");
    }

    appendStatus(db, invitation.invitationId, "accepted", actor.auditActor, user.id);
    insertWorkspaceAudit(db, {
      eventType: "workspace_invitation_accepted",
      entityType: "workspace_invitation",
      entityId: invitation.invitationId,
      ...input,
    });
    return {
      invitation: toInvitation(db, issued),
      accessReady: user.emailVerified === 1 && user.twoFactorEnabled === 1,
    };
  }).immediate();
}
