import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Auth } from "better-auth";
import { WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID } from "../server/better-auth";

/** Never serialise these values into audit, logs, or errors. */
export type IssuedWorkspaceServiceCredential = { serviceAccountId: string; credentialId: string; secret: string };
export type WorkspaceServicePrincipal = { serviceAccountId: string; displayName: string };
type OperationType = "create" | "rotate" | "revoke";
type OperationStatus = "pending" | "recovering" | "completed" | "failed" | "recovered";
type CrashPoint = "before-provider-create" | "after-provider-create" | "after-old-disabled" | "before-completion-audit";
type Faultable = { crashAt?: CrashPoint };
export type WorkspaceServicePrincipalRecovery = { operationId: string; status: "recovering" | "completed" | "recovered"; recovered: boolean };

class SimulatedCrash extends Error {}
function crash(input: Faultable, point: CrashPoint): void { if (input.crashAt === point) throw new SimulatedCrash(point); }
function nonBlank(value: string, label: string): string { const normalized = value.trim(); if (!normalized) throw new Error(`${label} is required`); return normalized; }
function serviceAccountId(): string { return `service_${randomUUID().replaceAll("-", "")}`; }
function operationId(value?: string): string {
  const normalized = value?.trim() ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) throw new Error("operationId must be a UUID");
  return normalized.toLowerCase();
}
/** Provider-only, non-secret correlation name. It is never exposed by the API. */
function providerMarker(): string { return randomUUID().replaceAll("-", ""); }

type OperationInput = { operationId: string; type: OperationType; status: OperationStatus; actor: string; serviceAccountId?: string; credentialId?: string; replacementCredentialId?: string; marker?: string; recoveryClaimId?: string };
function appendOperation(db: Database, input: OperationInput): void {
  db.query(`INSERT INTO rm_workspace_service_principal_operation_events
    (operation_id, operation_type, operation_status, user_id, credential_id, replacement_credential_id, provider_operation_marker, recovery_claim_id, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.operationId, input.type, input.status, input.serviceAccountId ?? null, input.credentialId ?? null, input.replacementCredentialId ?? null, input.marker ?? null, input.recoveryClaimId ?? null, input.actor);
}
function beginOperation(db: Database, input: { operationId?: string; type: OperationType; actor: string; serviceAccountId: string; credentialId?: string }): { id: string; marker: string } {
  const id = operationId(input.operationId);
  const existing = db.query(`SELECT operation_status FROM rm_workspace_service_principal_operation_events WHERE operation_id=? ORDER BY id DESC LIMIT 1`).get(id) as { operation_status?: OperationStatus } | null;
  if (existing?.operation_status === "pending" || existing?.operation_status === "recovering") throw new Error("service credential operation is pending; recover it before starting a new operation");
  if (existing?.operation_status === "completed") throw new Error("service credential operation already completed; credential secrets are shown only once");
  if (existing?.operation_status === "failed" || existing?.operation_status === "recovered") throw new Error("service credential operation was recovered; start a new operationId");
  const marker = providerMarker();
  appendOperation(db, { operationId: id, type: input.type, status: "pending", actor: input.actor, serviceAccountId: input.serviceAccountId, credentialId: input.credentialId, marker });
  return { id, marker };
}
function failOperation(db: Database, input: Omit<OperationInput, "status">): void { db.transaction(() => appendOperation(db, { ...input, status: "failed" }))(); }
function providerBody(userId: string, marker: string, expiresInSeconds?: number) { return { configId: WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID, userId, name: marker, ...(expiresInSeconds === undefined ? {} : { expiresIn: expiresInSeconds }) }; }
async function disable(auth: Auth<any>, serviceAccountId: string, credentialId: string): Promise<boolean> {
  const updated = await (auth.api as any).updateApiKey({ body: { configId: WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID, keyId: credentialId, userId: serviceAccountId, enabled: false } }) as { id?: string };
  return Boolean(updated?.id);
}

/** A service account has no browser account/password row; memberships remain its sole authority. */
export async function createWorkspaceServicePrincipal(db: Database, auth: Auth<any>, input: { displayName: string; actor: string; expiresInSeconds?: number; operationId?: string } & Faultable): Promise<IssuedWorkspaceServiceCredential> {
  const displayName = nonBlank(input.displayName, "displayName"); const actor = nonBlank(input.actor, "actor"); const id = serviceAccountId();
  // Setup and operation-id claim are one transaction: a reused operation id
  // cannot leave an orphan service account behind.
  const now = new Date().toISOString();
  const operation = db.transaction(() => {
    db.query(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled) VALUES (?, ?, ?, 0, ?, ?, 0)`).run(id, displayName, `${id}@service.invalid`, now, now);
    db.query("INSERT INTO rm_workspace_service_principals (user_id, display_name) VALUES (?, ?)").run(id, displayName);
    db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, NULL, 'created', ?)").run(id, actor);
    return beginOperation(db, { operationId: input.operationId, type: "create", actor, serviceAccountId: id });
  })();
  try {
    crash(input, "before-provider-create");
    const created = await (auth.api as any).createApiKey({ body: providerBody(id, operation.marker, input.expiresInSeconds) }) as { id?: string; key?: string };
    const credentialId = created.id?.trim() ?? ""; const secret = created.key?.trim() ?? "";
    if (!credentialId || !secret) throw new Error("service credential could not be issued");
    crash(input, "after-provider-create"); crash(input, "before-completion-audit");
    db.transaction(() => {
      db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_issued', ?)").run(id, credentialId, actor);
      appendOperation(db, { operationId: operation.id, type: "create", status: "completed", actor, serviceAccountId: id, credentialId, replacementCredentialId: credentialId, marker: operation.marker });
    })();
    return { serviceAccountId: id, credentialId, secret };
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    failOperation(db, { operationId: operation.id, type: "create", actor, serviceAccountId: id, marker: operation.marker });
    throw new Error("service credential could not be issued");
  }
}

export async function rotateWorkspaceServiceCredential(db: Database, auth: Auth<any>, input: { serviceAccountId: string; credentialId: string; actor: string; expiresInSeconds?: number; operationId?: string } & Faultable): Promise<IssuedWorkspaceServiceCredential> {
  const serviceAccountId = nonBlank(input.serviceAccountId, "serviceAccountId"); const credentialId = nonBlank(input.credentialId, "credentialId"); const actor = nonBlank(input.actor, "actor");
  if (!isWorkspaceServicePrincipal(db, serviceAccountId)) throw new Error("service principal was not found");
  const operation = beginOperation(db, { operationId: input.operationId, type: "rotate", actor, serviceAccountId, credentialId });
  let newCredentialId = "";
  try {
    crash(input, "before-provider-create");
    const created = await (auth.api as any).createApiKey({ body: providerBody(serviceAccountId, operation.marker, input.expiresInSeconds) }) as { id?: string; key?: string };
    newCredentialId = created.id?.trim() ?? ""; const secret = created.key?.trim() ?? "";
    if (!newCredentialId || !secret) throw new Error("service credential could not be issued");
    crash(input, "after-provider-create");
    if (!await disable(auth, serviceAccountId, credentialId)) throw new Error("old credential could not be disabled");
    crash(input, "after-old-disabled"); crash(input, "before-completion-audit");
    db.transaction(() => {
      db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_rotated', ?)").run(serviceAccountId, newCredentialId, actor);
      db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_revoked', ?)").run(serviceAccountId, credentialId, actor);
      appendOperation(db, { operationId: operation.id, type: "rotate", status: "completed", actor, serviceAccountId, credentialId, replacementCredentialId: newCredentialId, marker: operation.marker });
    })();
    return { serviceAccountId, credentialId: newCredentialId, secret };
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    if (newCredentialId) await disable(auth, serviceAccountId, newCredentialId).catch(() => false);
    failOperation(db, { operationId: operation.id, type: "rotate", actor, serviceAccountId, credentialId, marker: operation.marker });
    throw new Error("service credential could not be rotated");
  }
}

export async function revokeWorkspaceServiceCredential(db: Database, auth: Auth<any>, input: { serviceAccountId: string; credentialId: string; actor: string; operationId?: string } & Faultable): Promise<void> {
  const serviceAccountId = nonBlank(input.serviceAccountId, "serviceAccountId"); const credentialId = nonBlank(input.credentialId, "credentialId"); const actor = nonBlank(input.actor, "actor");
  if (!isWorkspaceServicePrincipal(db, serviceAccountId)) throw new Error("service principal was not found");
  const operation = beginOperation(db, { operationId: input.operationId, type: "revoke", actor, serviceAccountId, credentialId });
  try {
    if (!await disable(auth, serviceAccountId, credentialId)) throw new Error("credential could not be disabled");
    crash(input, "before-completion-audit");
    db.transaction(() => {
      db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_revoked', ?)").run(serviceAccountId, credentialId, actor);
      appendOperation(db, { operationId: operation.id, type: "revoke", status: "completed", actor, serviceAccountId, credentialId, marker: operation.marker });
    })();
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    failOperation(db, { operationId: operation.id, type: "revoke", actor, serviceAccountId, credentialId, marker: operation.marker });
    throw new Error("service credential could not be revoked");
  }
}

/** Terminates a crashed operation without returning/reissuing any secret. */
export async function recoverWorkspaceServicePrincipalOperation(db: Database, auth: Auth<any>, input: { operationId: string; actor: string; recoveryLeaseMs?: number } & Faultable): Promise<WorkspaceServicePrincipalRecovery> {
  const id = operationId(input.operationId); const actor = nonBlank(input.actor, "actor");
  type RecoveryEvent = { operation_type: OperationType; operation_status: OperationStatus; user_id: string; credential_id: string | null; provider_operation_marker: string; created_at: string };
  const leaseMs = input.recoveryLeaseMs ?? 30_000;
  const claim = db.transaction(() => {
    const current = db.query(`SELECT operation_type, operation_status, user_id, credential_id, provider_operation_marker, created_at FROM rm_workspace_service_principal_operation_events WHERE operation_id=? ORDER BY id DESC LIMIT 1`).get(id) as RecoveryEvent | null;
    if (!current || current.operation_status === "completed" || current.operation_status === "recovered") return { event: current, claimId: null };
    if (current.operation_status === "recovering" && Date.now() - Date.parse(current.created_at) < leaseMs) return { event: current, claimId: null };
    const claimId = randomUUID();
    appendOperation(db, { operationId: id, type: current.operation_type, status: "recovering", actor, serviceAccountId: current.user_id, credentialId: current.credential_id ?? undefined, marker: current.provider_operation_marker, recoveryClaimId: claimId });
    return { event: current, claimId };
  })();
  const event = claim.event;
  if (!event) throw new Error("service credential operation was not found");
  if (event.operation_status === "completed" || event.operation_status === "recovered") return { operationId: id, status: event.operation_status, recovered: event.operation_status === "recovered" };
  if (!claim.claimId) return { operationId: id, status: "recovering", recovered: false };
  const serviceAccountId = event.user_id; const marker = event.provider_operation_marker;
  if (!serviceAccountId) throw new Error("service credential operation cannot be safely recovered");
  const finish = (status: "completed" | "failed" | "recovered", credentialId = event.credential_id ?? undefined): boolean => db.transaction(() => {
    const latest = db.query(`SELECT operation_status, recovery_claim_id FROM rm_workspace_service_principal_operation_events WHERE operation_id=? ORDER BY id DESC LIMIT 1`).get(id) as { operation_status: OperationStatus; recovery_claim_id: string | null } | null;
    if (latest?.operation_status !== "recovering" || latest.recovery_claim_id !== claim.claimId) return false;
    appendOperation(db, { operationId: id, type: event.operation_type, status, actor, serviceAccountId, credentialId, marker });
    return true;
  })();
  const finishRecovered = (): boolean => db.transaction(() => {
    const latest = db.query(`SELECT operation_status, recovery_claim_id FROM rm_workspace_service_principal_operation_events WHERE operation_id=? ORDER BY id DESC LIMIT 1`).get(id) as { operation_status: OperationStatus; recovery_claim_id: string | null } | null;
    if (latest?.operation_status !== "recovering" || latest.recovery_claim_id !== claim.claimId) return false;
    appendOperation(db, { operationId: id, type: event.operation_type, status: "failed", actor, serviceAccountId, credentialId: event.credential_id ?? undefined, marker });
    appendOperation(db, { operationId: id, type: event.operation_type, status: "recovered", actor, serviceAccountId, credentialId: event.credential_id ?? undefined, marker });
    return true;
  })();
  try {
    if (event.operation_type === "revoke") {
    const key = db.query(`SELECT id, COALESCE(enabled,1) AS enabled FROM "apikey" WHERE id=? AND "referenceId"=? AND "configId"=?`).get(event.credential_id, serviceAccountId, WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID) as { id: string; enabled: number } | null;
    if (key?.enabled && !await disable(auth, serviceAccountId, key.id)) throw new Error("service credential recovery could not disable credential");
      const completed = db.transaction(() => {
        const latest = db.query(`SELECT operation_status, recovery_claim_id FROM rm_workspace_service_principal_operation_events WHERE operation_id=? ORDER BY id DESC LIMIT 1`).get(id) as { operation_status: OperationStatus; recovery_claim_id: string | null } | null;
        if (latest?.operation_status !== "recovering" || latest.recovery_claim_id !== claim.claimId) return false;
        if (key) db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_revoked', ?)").run(serviceAccountId, key.id, actor);
        appendOperation(db, { operationId: id, type: "revoke", status: "completed", actor, serviceAccountId, credentialId: event.credential_id ?? undefined, marker });
        return true;
      })();
      return completed ? { operationId: id, status: "completed", recovered: true } : { operationId: id, status: "recovering", recovered: false };
    }
    // Run this for both pending and failed create/rotate operations. In
    // particular, it repairs a failed compensation attempt after rotation.
    const keys = db.query(`SELECT id FROM "apikey" WHERE "referenceId"=? AND "configId"=? AND name=? AND COALESCE(enabled,1)=1`).all(serviceAccountId, WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID, marker) as Array<{ id: string }>;
    for (const key of keys) if (!await disable(auth, serviceAccountId, key.id)) throw new Error("service credential recovery could not disable credential");
    crash(input, "before-completion-audit");
    if (!finishRecovered()) return { operationId: id, status: "recovering", recovered: false };
    return { operationId: id, status: "recovered", recovered: true };
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    // Recovery did not establish safety; preserve a truthful retryable status.
    finish("failed");
    throw new Error("service credential recovery could not be completed");
  }
}

export function isWorkspaceServicePrincipal(db: Database, userId: string): boolean { return db.query("SELECT 1 FROM rm_workspace_service_principals WHERE user_id = ?").get(userId) != null; }
