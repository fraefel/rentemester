import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Auth } from "better-auth";
import { WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID } from "../server/better-auth";

/** Never serialise these values into audit, logs, or errors. */
export type IssuedWorkspaceServiceCredential = {
  serviceAccountId: string;
  credentialId: string;
  secret: string;
};

export type WorkspaceServicePrincipal = {
  serviceAccountId: string;
  displayName: string;
};

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function serviceAccountId(): string {
  return `service_${randomUUID().replaceAll("-", "")}`;
}

/**
 * A service account is a Better Auth user deliberately created without an
 * account/password row. It cannot sign into the browser; only an API key can
 * authenticate it, and existing append-only membership events grant access.
 */
export async function createWorkspaceServicePrincipal(
  db: Database,
  auth: Auth<any>,
  input: { displayName: string; actor: string; expiresInSeconds?: number },
): Promise<IssuedWorkspaceServiceCredential> {
  const displayName = nonBlank(input.displayName, "displayName");
  const actor = nonBlank(input.actor, "actor");
  const id = serviceAccountId();
  const now = new Date().toISOString();
  const email = `${id}@service.invalid`;
  db.transaction(() => {
    db.query(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, twoFactorEnabled)
      VALUES (?, ?, ?, 0, ?, ?, 0)`).run(id, displayName, email, now, now);
    db.query("INSERT INTO rm_workspace_service_principals (user_id, display_name) VALUES (?, ?)").run(id, displayName);
    db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, NULL, 'created', ?)").run(id, actor);
  })();
  try {
    const created = await (auth.api as any).createApiKey({
      body: {
        configId: WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID,
        userId: id,
        name: displayName,
        ...(input.expiresInSeconds === undefined ? {} : { expiresIn: input.expiresInSeconds }),
      },
    }) as { id?: string; key?: string };
    const credentialId = created.id?.trim() ?? "";
    const secret = created.key?.trim() ?? "";
    if (!credentialId || !secret) throw new Error("service credential could not be issued");
    db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_issued', ?)").run(id, credentialId, actor);
    return { serviceAccountId: id, credentialId, secret };
  } catch (error) {
    // The identity is retained as immutable evidence but cannot be used without
    // an issued key or membership. Do not include provider error text: it may
    // contain credential-adjacent data.
    throw new Error("service credential could not be issued");
  }
}

export async function rotateWorkspaceServiceCredential(
  db: Database,
  auth: Auth<any>,
  input: { serviceAccountId: string; credentialId: string; actor: string; expiresInSeconds?: number },
): Promise<IssuedWorkspaceServiceCredential> {
  const serviceAccountId = nonBlank(input.serviceAccountId, "serviceAccountId");
  const credentialId = nonBlank(input.credentialId, "credentialId");
  const actor = nonBlank(input.actor, "actor");
  if (!isWorkspaceServicePrincipal(db, serviceAccountId)) throw new Error("service principal was not found");
  const created = await (auth.api as any).createApiKey({
    body: {
      configId: WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID,
      userId: serviceAccountId,
      name: "rotated credential",
      ...(input.expiresInSeconds === undefined ? {} : { expiresIn: input.expiresInSeconds }),
    },
  }) as { id?: string; key?: string };
  const newCredentialId = created.id?.trim() ?? "";
  const secret = created.key?.trim() ?? "";
  if (!newCredentialId || !secret) throw new Error("service credential could not be issued");
  try {
    const updated = await (auth.api as any).updateApiKey({
      body: { configId: WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID, keyId: credentialId, userId: serviceAccountId, enabled: false },
    }) as { id?: string };
    if (!updated?.id) throw new Error("old credential could not be disabled");
  } catch {
    // Never leave a surprise second live key after a failed rotation.
    await (auth.api as any).updateApiKey({ body: { configId: WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID, keyId: newCredentialId, userId: serviceAccountId, enabled: false } }).catch(() => undefined);
    throw new Error("service credential could not be rotated");
  }
  db.transaction(() => {
    db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_rotated', ?)").run(serviceAccountId, newCredentialId, actor);
    db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_revoked', ?)").run(serviceAccountId, credentialId, actor);
  })();
  return { serviceAccountId, credentialId: newCredentialId, secret };
}

export async function revokeWorkspaceServiceCredential(
  db: Database,
  auth: Auth<any>,
  input: { serviceAccountId: string; credentialId: string; actor: string },
): Promise<void> {
  const serviceAccountId = nonBlank(input.serviceAccountId, "serviceAccountId");
  const credentialId = nonBlank(input.credentialId, "credentialId");
  const actor = nonBlank(input.actor, "actor");
  if (!isWorkspaceServicePrincipal(db, serviceAccountId)) throw new Error("service principal was not found");
  const updated = await (auth.api as any).updateApiKey({
    body: { configId: WORKSPACE_SERVICE_PRINCIPAL_CONFIG_ID, keyId: credentialId, userId: serviceAccountId, enabled: false },
  }) as { id?: string };
  if (!updated?.id) throw new Error("service credential could not be revoked");
  db.query("INSERT INTO rm_workspace_service_principal_events (user_id, credential_id, event_type, actor) VALUES (?, ?, 'credential_revoked', ?)").run(serviceAccountId, credentialId, actor);
}

export function isWorkspaceServicePrincipal(db: Database, userId: string): boolean {
  return db.query("SELECT 1 FROM rm_workspace_service_principals WHERE user_id = ?").get(userId) != null;
}

