import { constants, fstatSync, openSync, readFileSync, closeSync } from "node:fs";
import { resolveWorkspaceRoot, findWorkspaceCompany } from "../core/workspace";
import { openWorkspaceControlDb } from "../core/workspace-control";
import { runFirstWorkspaceBootstrap } from "../core/workspace-bootstrap";
import { createPrivateBootstrapService } from "../server/better-auth";
import { createHttpJsonV1AuthEmailSender } from "../server/auth-email";
import { resolveServerConfig } from "../server/config";
import type { CommandDispatch } from "../cli-dispatch";

/** Never include password-file path or contents in a user-facing error. */
export function readPrivateWorkspaceBootstrapPassword(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw new Error("unsafe");
    const raw = readFileSync(fd, "utf8");
    const normalized = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw;
    if (!normalized || normalized.includes("\n") || normalized.includes("\r")) throw new Error("unsafe");
    return normalized;
  } catch {
    throw new Error("password file must be a regular 0600 file up to 4 KiB containing one logical line");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Provider errors can contain URLs, tokens, or implementation details. */
function safeBootstrapFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "password file must be a regular 0600 file up to 4 KiB containing one logical line") return message;
  if (message === "initial company is not an active registered workspace company") return message;
  if (message === "workspace bootstrap requires hosted deployment configuration") return message;
  return "workspace bootstrap could not be completed; correct the hosted configuration or retry the same identity";
}

export function register(dispatch: CommandDispatch): void {
  dispatch.on("workspace-access", "bootstrap-first", async (ctx) => {
    if ((ctx.arg("--confirm") ?? "").trim().toLowerCase() !== "yes") {
      ctx.emitResult({ ok: false, errors: ["--confirm yes required to bootstrap the first workspace identity"] });
      return;
    }
    const workspaceRaw = ctx.trimToNull(ctx.arg("--workspace"));
    const companySlug = ctx.trimToNull(ctx.arg("--company"));
    const name = ctx.trimToNull(ctx.arg("--name"));
    const email = ctx.trimToNull(ctx.arg("--email"));
    const passwordPath = ctx.trimToNull(ctx.arg("--password-file"));
    if (!workspaceRaw || !companySlug || !name || !email || !passwordPath) {
      ctx.fatal("workspace-access bootstrap-first requires --workspace, --company, --name, --email and --password-file");
      return;
    }
    try {
      const workspaceRoot = resolveWorkspaceRoot(workspaceRaw!);
      const company = findWorkspaceCompany(workspaceRoot, companySlug!);
      if (!company || company.archived) throw new Error("initial company is not an active registered workspace company");
      // Hosted config and delivery gateway are checked before DB reservation and password read.
      const config = resolveServerConfig({ workspaceRoot });
      if (config.deploymentProfile !== "hosted" || !config.hostedBetterAuth) throw new Error("workspace bootstrap requires hosted deployment configuration");
      const password = readPrivateWorkspaceBootstrapPassword(passwordPath!);
      const sender = createHttpJsonV1AuthEmailSender({
        ...config.hostedBetterAuth.authEmail,
        idempotencySecret: config.hostedBetterAuth.secret,
      });
      const db = openWorkspaceControlDb(workspaceRoot);
      try {
        const service = createPrivateBootstrapService(db, {
          secret: config.hostedBetterAuth.secret,
          secrets: config.hostedBetterAuth.secrets,
          legacySecret: config.hostedBetterAuth.legacySecret,
          baseURL: config.hostedBetterAuth.baseURL,
          trustedOrigins: config.hostedBetterAuth.trustedOrigins,
          deploymentMode: "hosted",
          useSecureCookies: true,
          rateLimitIpHeader: config.hostedBetterAuth.rateLimitIpHeader,
          emailSender: sender,
        });
        const result = await runFirstWorkspaceBootstrap(db, workspaceRoot, service, {
          name: name!, email: email!, password, companySlug: companySlug!,
          createdBy: process.env.RENTEMESTER_ACTOR!,
          createdByProgram: process.env.RENTEMESTER_ACTOR_VIA ?? "rentemester-cli",
        });
        ctx.emitResult({ ok: true, userId: result.userId, reservationStatus: result.phase, workspaceRole: "workspace_owner", companyRole: "owner", companySlug: result.companySlug, verificationNextStep: "check_verification_email" });
      } finally { db.close(); }
    } catch (error) {
      ctx.emitResult({ ok: false, errors: [safeBootstrapFailure(error)] });
    }
  });
}
