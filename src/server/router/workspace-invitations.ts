import type { Database } from "bun:sqlite";
import type { CompanyRole, WorkspaceRole } from "../../core/workspace-access";
import { authorizeWorkspaceRoute } from "../../core/workspace-access";
import {
  acceptWorkspaceInvitation,
  cancelWorkspaceInvitation,
  issueWorkspaceInvitation,
  listWorkspaceInvitations,
  readClaimableWorkspaceInvitation,
  recordWorkspaceInvitationDelivery,
  type WorkspaceInvitationKey,
} from "../../core/workspace-invitations";
import { openWorkspaceControlDb } from "../../core/workspace-control";
import {
  createPrivateInvitationIdentityService,
  type BetterAuthRuntimeOptions,
  type PrivateInvitationIdentityService,
} from "../better-auth";
import { createHttpJsonV1AuthEmailSender, type AuthEmailSender } from "../auth-email";
import type { ServerConfig } from "../config";
import { ApiError } from "../errors";
import { okResponse, readJsonBody, requireString } from "./_shared";

function hostedConfig(config: ServerConfig) {
  if (config.deploymentProfile !== "hosted" || !config.hostedBetterAuth) {
    throw ApiError.notFound("ukendt endpoint");
  }
  return config.hostedBetterAuth;
}

function invitationKey(config: ServerConfig): WorkspaceInvitationKey {
  const hosted = hostedConfig(config);
  return { version: hosted.secrets[0]!.version, value: hosted.secret };
}

function authEmailSender(config: ServerConfig): AuthEmailSender {
  if (config.authEmailSender) return config.authEmailSender;
  const hosted = hostedConfig(config);
  return createHttpJsonV1AuthEmailSender({
    ...hosted.authEmail,
    idempotencySecret: hosted.secret,
  });
}

function invitationIdentityService(
  config: ServerConfig,
  db: Database,
  sender: AuthEmailSender,
): PrivateInvitationIdentityService {
  if (config.invitationIdentityService) return config.invitationIdentityService;
  const hosted = hostedConfig(config);
  const options: BetterAuthRuntimeOptions = {
    secret: hosted.secret,
    secrets: hosted.secrets,
    legacySecret: hosted.legacySecret,
    baseURL: hosted.baseURL,
    trustedOrigins: hosted.trustedOrigins,
    deploymentMode: "hosted",
    useSecureCookies: true,
    rateLimitIpHeader: hosted.rateLimitIpHeader,
    emailSender: sender,
  };
  return createPrivateInvitationIdentityService(db, options);
}

function hostedActor(config: ServerConfig) {
  if (config.requestPrincipal?.via !== "better-auth") {
    throw ApiError.unauthorized("missing or invalid credentials");
  }
  return {
    createdBy: config.requestPrincipal.id,
    createdByProgram: "rentemester-cockpit",
  };
}

function principalUserId(config: ServerConfig): string {
  const principal = config.requestPrincipal;
  if (principal?.via !== "better-auth" || !principal.id.startsWith("user:")) {
    throw ApiError.unauthorized("missing or invalid credentials");
  }
  const userId = principal.id.slice("user:".length).trim();
  if (!userId) throw ApiError.unauthorized("missing or invalid credentials");
  return userId;
}

function requireCompanyOwner(
  config: ServerConfig,
  db: Database,
  companySlug: string,
): void {
  if (!authorizeWorkspaceRoute(db, config.workspaceRoot, {
    userId: principalUserId(config),
    companySlug,
    permission: "company.admin",
  }).allowed) {
    throw ApiError.unauthorized("missing or invalid credentials");
  }
}

export function handleWorkspaceInvitationList(config: ServerConfig): Response {
  hostedConfig(config);
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    const userId = principalUserId(config);
    const invitations = listWorkspaceInvitations(db).filter((invitation) =>
      authorizeWorkspaceRoute(db, config.workspaceRoot, {
        userId,
        companySlug: invitation.companySlug,
        permission: "company.admin",
      }).allowed
    );
    return okResponse({ invitations });
  } finally { db.close(); }
}

export async function handleWorkspaceInvitationCreate(
  config: ServerConfig,
  request: Request,
): Promise<Response> {
  const hosted = hostedConfig(config);
  const body = await readJsonBody(request);
  const actor = hostedActor(config);
  const db = openWorkspaceControlDb(config.workspaceRoot);
  let invitationId: string | null = null;
  try {
    const companySlug = requireString(body, "companySlug");
    requireCompanyOwner(config, db, companySlug);
    let issued: ReturnType<typeof issueWorkspaceInvitation>;
    try {
      issued = issueWorkspaceInvitation(db, config.workspaceRoot, {
        email: requireString(body, "email"),
        workspaceRole: requireString(body, "workspaceRole") as WorkspaceRole,
        companySlug,
        companyRole: requireString(body, "companyRole") as CompanyRole,
        key: invitationKey(config),
        ...actor,
      });
      invitationId = issued.invitation.invitationId;
    } catch {
      throw ApiError.badRequest("invitationen kunne ikke oprettes");
    }
    const sender = authEmailSender(config);
    try {
      await sender.send({
        kind: "workspace-invitation",
        recipient: issued.invitation.email,
        url: `${hosted.baseURL}/invite#token=${encodeURIComponent(issued.token)}`,
        token: issued.token,
      });
      const invitation = recordWorkspaceInvitationDelivery(db, {
        invitationId: issued.invitation.invitationId,
        delivered: true,
        ...actor,
      });
      return okResponse({ invitation }, 201);
    } catch {
      if (invitationId) {
        try {
          recordWorkspaceInvitationDelivery(db, { invitationId, delivered: false, ...actor });
        } catch {
          // Preserve the original generic delivery failure.
        }
      }
      throw new ApiError("internal", "invitationen kunne ikke leveres");
    }
  } finally { db.close(); }
}

export async function handleWorkspaceInvitationCancel(
  config: ServerConfig,
  request: Request,
): Promise<Response> {
  hostedConfig(config);
  const body = await readJsonBody(request);
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    const invitationId = requireString(body, "invitationId");
    const targetInvitation = listWorkspaceInvitations(db)
      .find((candidate) => candidate.invitationId === invitationId);
    if (!targetInvitation) throw ApiError.badRequest("invitationen kunne ikke annulleres");
    requireCompanyOwner(config, db, targetInvitation.companySlug);
    try {
      const invitation = cancelWorkspaceInvitation(db, {
        invitationId,
        ...hostedActor(config),
      });
      return okResponse({ invitation });
    } catch {
      throw ApiError.badRequest("invitationen kunne ikke annulleres");
    }
  } finally { db.close(); }
}

/** Sessionless, token-authorized claim. It creates no session and effective access stays MFA-gated. */
export async function handleWorkspaceInvitationClaim(
  config: ServerConfig,
  request: Request,
): Promise<Response> {
  hostedConfig(config);
  const body = await readJsonBody(request);
  const token = requireString(body, "token");
  const name = requireString(body, "name");
  const password = requireString(body, "password");
  const db = openWorkspaceControlDb(config.workspaceRoot);
  try {
    try {
      const invitation = readClaimableWorkspaceInvitation(db, {
        token,
        key: invitationKey(config),
      });
      const sender = authEmailSender(config);
      const service = invitationIdentityService(config, db, sender);
      const identity = await service.createIdentity({
        name,
        email: invitation.email,
        password,
      });
      const user = db.query(
        'SELECT emailVerified FROM "user" WHERE id = ?',
      ).get(identity.userId) as { emailVerified: number } | null;
      if (!user) throw new Error("invitation identity was not created");
      if (!identity.created && user.emailVerified !== 1) {
        await service.resendVerification(invitation.email);
      }
      const accepted = acceptWorkspaceInvitation(db, config.workspaceRoot, {
        token,
        key: invitationKey(config),
        userId: identity.userId,
        createdBy: `user:${identity.userId}`,
        createdByProgram: "workspace-invitation",
      });
      return okResponse({
        accepted: true,
        accessReady: accepted.accessReady,
        nextStep: accepted.accessReady ? "sign-in" : "verify-email-and-enable-mfa",
      });
    } catch {
      throw ApiError.badRequest("invitationen er ugyldig, udløbet eller allerede brugt");
    }
  } finally { db.close(); }
}
