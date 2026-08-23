import type { Database } from "bun:sqlite";
import { resolveActor, type ResolveActorInput } from "./actor";
import { findWorkspaceCompany } from "./workspace";
import { insertWorkspaceAudit } from "./workspace-control";

/** The minimal private Better Auth seam needed by bootstrap; it never exposes a password or token. */
export type WorkspaceBootstrapIdentityService = {
  canonicalEmailHash(email: string): string;
  createFirstIdentity(input: { name: string; email: string; password: string }): Promise<{ userId: string; created: boolean }>;
  findIdentityByCanonicalEmail(email: string): Promise<{ userId: string } | null>;
  resendVerification(email: string): Promise<void>;
};

export type BootstrapPhase = "reserved" | "identity_created" | "mail_confirmed" | "access_completed";
export type BootstrapReservation = {
  reservationHash: string;
  companySlug: string;
  phase: BootstrapPhase;
  userId: string | null;
};

export type BootstrapInput = ResolveActorInput & {
  email: string;
  companySlug: string;
  name: string;
  password: string;
};

export class WorkspaceBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceBootstrapError";
  }
}

type BootstrapEvent = {
  id: number;
  reservation_hash: string;
  event_type: "reserved" | "identity_created" | "mail_confirmed" | "access_completed";
  user_id: string | null;
  company_slug: string | null;
};

function nonBlank(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new WorkspaceBootstrapError(`${label} is required`);
  return normalized;
}

function assertHash(value: string): string {
  const normalized = nonBlank(value, "reservation hash");
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new WorkspaceBootstrapError("reservation hash is invalid");
  return normalized;
}

function events(db: Database, reservationHash: string): BootstrapEvent[] {
  return db.query(
    `SELECT id, reservation_hash, event_type, user_id, company_slug
       FROM rm_workspace_bootstrap_events
      WHERE reservation_hash = ? ORDER BY id`,
  ).all(reservationHash) as BootstrapEvent[];
}

function reservationFromEvents(rows: readonly BootstrapEvent[]): BootstrapReservation | null {
  const reserved = rows.find((row) => row.event_type === "reserved");
  if (!reserved?.company_slug) return null;
  const latestIdentity = [...rows].reverse().find((row) => row.event_type === "identity_created" || row.event_type === "mail_confirmed" || row.event_type === "access_completed");
  const phase = rows.some((row) => row.event_type === "access_completed") ? "access_completed"
    : rows.some((row) => row.event_type === "mail_confirmed") ? "mail_confirmed"
    : rows.some((row) => row.event_type === "identity_created") ? "identity_created"
    : "reserved";
  return { reservationHash: reserved.reservation_hash, companySlug: reserved.company_slug, phase, userId: latestIdentity?.user_id ?? null };
}

function singletonReservation(db: Database): BootstrapEvent | null {
  return db.query(
    "SELECT id, reservation_hash, event_type, user_id, company_slug FROM rm_workspace_bootstrap_events WHERE event_type = 'reserved' LIMIT 1",
  ).get() as BootstrapEvent | null;
}

function userCount(db: Database): number {
  return (db.query('SELECT COUNT(*) AS count FROM "user"').get() as { count: number }).count;
}

function appendEvent(
  db: Database,
  input: { reservationHash: string; eventType: BootstrapEvent["event_type"]; userId?: string | null; companySlug?: string | null } & ResolveActorInput,
): void {
  const actor = resolveActor(input);
  db.query(
    `INSERT INTO rm_workspace_bootstrap_events (reservation_hash, event_type, user_id, company_slug, actor)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.reservationHash, input.eventType, input.userId ?? null, input.companySlug ?? null, actor.auditActor);
}

/**
 * Atomically reserves the one first-user saga before Better Auth is called.
 * A resume is tied to its email HMAC only—not the previous actor—so a second
 * authorized operator can safely recover a failed mail/API attempt.
 */
export function reserveFirstWorkspaceBootstrap(
  db: Database,
  input: { reservationHash: string; companySlug: string } & ResolveActorInput,
): BootstrapReservation {
  const reservationHash = assertHash(input.reservationHash);
  const companySlug = nonBlank(input.companySlug, "companySlug");
  return db.transaction((): BootstrapReservation => {
    const existing = singletonReservation(db);
    if (existing) {
      if (existing.reservation_hash !== reservationHash) {
        throw new WorkspaceBootstrapError("first workspace identity is already reserved");
      }
      const reservation = reservationFromEvents(events(db, reservationHash));
      if (!reservation) throw new WorkspaceBootstrapError("workspace bootstrap reservation is inconsistent");
      if (reservation.companySlug !== companySlug) throw new WorkspaceBootstrapError("workspace bootstrap company does not match reservation");
      return reservation;
    }
    if (userCount(db) !== 0) {
      throw new WorkspaceBootstrapError("first workspace identity cannot be reserved after an identity exists");
    }
    appendEvent(db, { ...input, reservationHash, eventType: "reserved", companySlug });
    insertWorkspaceAudit(db, { eventType: "workspace_identity_bootstrap_reserved", entityType: "workspace_bootstrap", entityId: reservationHash, ...input });
    return { reservationHash, companySlug, phase: "reserved", userId: null };
  }).immediate();
}

function assertReservationCompany(workspaceRoot: string, companySlug: string): void {
  const company = findWorkspaceCompany(workspaceRoot, companySlug);
  if (!company) throw new WorkspaceBootstrapError("bootstrap company is not registered in this workspace");
  if (company.archived) throw new WorkspaceBootstrapError("bootstrap company is archived");
}

function assertIdentity(db: Database, userId: string): void {
  const user = db.query('SELECT id FROM "user" WHERE id = ?').get(userId) as { id: string } | null;
  if (!user) throw new WorkspaceBootstrapError("bootstrap identity does not exist");
}

/**
 * Creates or recovers a private Better Auth credential. A mail/API failure can
 * leave a user row behind, so recovery first uses the service's canonical
 * read-only lookup and only then resends verification through Better Auth.
 */
export async function createOrResumeBootstrapIdentity(
  db: Database,
  workspaceRoot: string,
  service: WorkspaceBootstrapIdentityService,
  input: BootstrapInput,
): Promise<BootstrapReservation> {
  const email = nonBlank(input.email, "email");
  const reservationHash = service.canonicalEmailHash(email);
  // Company validation happens before the durable singleton reservation, so a
  // typo/archived target cannot permanently consume first-user bootstrap.
  assertReservationCompany(workspaceRoot, input.companySlug);
  let reservation = reserveFirstWorkspaceBootstrap(db, { ...input, reservationHash, companySlug: input.companySlug });
  assertReservationCompany(workspaceRoot, reservation.companySlug);
  if (reservation.phase === "access_completed") return reservation;

  let userId = reservation.userId;
  if (!userId) {
    const existing = await service.findIdentityByCanonicalEmail(email);
    if (existing) userId = existing.userId;
    else {
      try {
        const created = await service.createFirstIdentity({ name: input.name, email, password: input.password });
        userId = created.userId;
        // Better Auth may run sign-up delivery in the background. Do not infer
        // delivery from a credential result; the explicit resend endpoint is
        // the authoritative mail-confirmation step below.
      } catch (error) {
        // Deliberately do not surface provider/credential detail. A subsequent
        // invocation with the same email HMAC can recover a persisted user.
        throw new WorkspaceBootstrapError("identity creation or verification delivery did not complete; retry the same identity");
      }
    }
    assertIdentity(db, userId);
    db.transaction(() => {
      const current = reservationFromEvents(events(db, reservationHash));
      if (!current) throw new WorkspaceBootstrapError("workspace bootstrap reservation is inconsistent");
      if (!current.userId) {
        appendEvent(db, { reservationHash, eventType: "identity_created", userId, ...input, companySlug: null });
        insertWorkspaceAudit(db, { eventType: "workspace_identity_bootstrap_identity_created", entityType: "workspace_bootstrap", entityId: reservationHash, ...input });
      }
    }).immediate();
    reservation = reservationFromEvents(events(db, reservationHash))!;
  }

  if (reservation.phase === "identity_created") {
    try {
      await service.resendVerification(email);
    } catch {
      throw new WorkspaceBootstrapError("verification delivery did not complete; retry the same identity");
    }
    db.transaction(() => {
      const current = reservationFromEvents(events(db, reservationHash));
      if (!current || !current.userId) throw new WorkspaceBootstrapError("workspace bootstrap identity is inconsistent");
      if (current.phase === "identity_created") {
        appendEvent(db, { reservationHash, eventType: "mail_confirmed", userId: current.userId, ...input, companySlug: null });
        insertWorkspaceAudit(db, { eventType: "workspace_identity_bootstrap_mail_confirmed", entityType: "workspace_bootstrap", entityId: reservationHash, ...input });
      }
    }).immediate();
  }
  return reservationFromEvents(events(db, reservationHash))!;
}

/** Completes initial access atomically and never opens a company ledger. */
export function completeFirstWorkspaceBootstrap(
  db: Database,
  workspaceRoot: string,
  input: { reservationHash: string } & ResolveActorInput,
): BootstrapReservation {
  const reservationHash = assertHash(input.reservationHash);
  return db.transaction((): BootstrapReservation => {
    const current = reservationFromEvents(events(db, reservationHash));
    if (!current || !current.userId) throw new WorkspaceBootstrapError("bootstrap identity is not ready for access completion");
    if (current.phase === "access_completed") return current;
    if (current.phase !== "mail_confirmed") throw new WorkspaceBootstrapError("bootstrap verification delivery is not confirmed");
    assertReservationCompany(workspaceRoot, current.companySlug);
    assertIdentity(db, current.userId);
    const actor = resolveActor(input);
    const access = db.query(
      `SELECT event_type, workspace_role FROM rm_workspace_user_access_events
       WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(current.userId) as { event_type: string; workspace_role: string | null } | null;
    const membership = db.query(
      `SELECT event_type, company_role FROM rm_company_membership_events
       WHERE user_id = ? AND company_slug = ? ORDER BY id DESC LIMIT 1`,
    ).get(current.userId, current.companySlug) as { event_type: string; company_role: string | null } | null;
    if (access && (access.event_type !== "activate" || access.workspace_role !== "workspace_owner")) {
      throw new WorkspaceBootstrapError("bootstrap identity already has incompatible workspace access");
    }
    if (membership && (membership.event_type !== "grant" || membership.company_role !== "owner")) {
      throw new WorkspaceBootstrapError("bootstrap identity already has incompatible company access");
    }
    if (!access) db.query(
      `INSERT INTO rm_workspace_user_access_events (user_id, event_type, workspace_role, actor)
       VALUES (?, 'activate', 'workspace_owner', ?)`,
    ).run(current.userId, actor.auditActor);
    if (!membership) db.query(
      `INSERT INTO rm_company_membership_events (user_id, company_slug, event_type, company_role, actor)
       VALUES (?, ?, 'grant', 'owner', ?)`,
    ).run(current.userId, current.companySlug, actor.auditActor);
    appendEvent(db, { ...input, reservationHash, eventType: "access_completed", userId: current.userId, companySlug: current.companySlug });
    insertWorkspaceAudit(db, { eventType: "workspace_identity_bootstrap_access_completed", entityType: "workspace_bootstrap", entityId: reservationHash, ...input });
    return reservationFromEvents(events(db, reservationHash))!;
  }).immediate();
}

/** One safe orchestration call for the future CLI. */
export async function runFirstWorkspaceBootstrap(
  db: Database,
  workspaceRoot: string,
  service: WorkspaceBootstrapIdentityService,
  input: BootstrapInput,
): Promise<BootstrapReservation> {
  const ready = await createOrResumeBootstrapIdentity(db, workspaceRoot, service, input);
  return completeFirstWorkspaceBootstrap(db, workspaceRoot, { reservationHash: ready.reservationHash, ...input });
}
