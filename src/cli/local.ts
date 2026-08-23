// `rentemester local start` — intentionally small local single-company launcher.
//
// The command creates no alternative data model: it starts the ordinary cockpit
// over an ordinary workspace, but only when exactly one active legal entity is
// registered. Its forced local config makes an accidentally inherited hosted
// environment unable to turn a desktop launch into a network deployment.

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { companyPaths } from "../core/paths";
import {
  companyRootForSlug,
  initWorkspace,
  loadWorkspaceManifest,
  resolveWorkspaceRoot,
  workspaceExists,
} from "../core/workspace";
import { createCompany } from "../core/company";
import { openWorkspaceControlDb } from "../core/workspace-control";
import { isCanonicalActorId } from "../cli-actor";
import type { CommandContext, CommandDispatch } from "../cli-dispatch";
import { startCockpitServer } from "../server/app";
import {
  DEFAULT_APP_HOST,
  DOCUMENT_SCANNER_ENV,
  HOSTED_AUTH_ENV,
  resolveServerConfig,
} from "../server/config";

type BrowserOpener = (url: string) => void;

/**
 * Starts the platform browser without making browser availability a launch
 * precondition. It is deliberately called only after the loopback socket is
 * bound. `--no-open` gives scripts and tests a fully deterministic path.
 */
export function bestEffortOpenBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // A headless machine, missing `open`, or an OS policy must not stop the
    // already-bound local server. The URL is still printed for manual opening.
  }
}

function localOnlyEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Never inherit a shared-token mode or hosted identity configuration into a
  // local desktop launch. `resolveServerConfig` validates this boundary before
  // a socket is opened.
  env.RENTEMESTER_APP_HOST = DEFAULT_APP_HOST;
  env.RENTEMESTER_APP_AUTH = "";
  env.RENTEMESTER_APP_TOKEN = "";
  for (const key of Object.values(HOSTED_AUTH_ENV)) env[key] = "";
  for (const key of Object.values(DOCUMENT_SCANNER_ENV)) env[key] = "";
  env[HOSTED_AUTH_ENV.profile] = "local";
  return env;
}

function isNewOrEmptyWorkspaceRoot(workspaceRoot: string): boolean {
  if (!existsSync(workspaceRoot)) return true;
  const stat = lstatSync(workspaceRoot);
  if (!stat.isDirectory()) throw new Error("--workspace must name a directory, not a file");
  if (!workspaceExists(workspaceRoot)) {
    // An arbitrary non-empty directory is never silently adopted as a
    // workspace: that could mix unrelated user files with accounting data.
    if (readdirSync(workspaceRoot).length > 0) {
      throw new Error("--workspace is not an initialized workspace; refuse to adopt a non-empty directory");
    }
    return true;
  }
  return loadWorkspaceManifest(workspaceRoot).companies.length === 0;
}

function requireCreationConsent(ctx: CommandContext, companyName: string | null): string | null {
  if (!companyName) ctx.fatal("local start requires --company-name <text> for a new or empty workspace");
  if (!ctx.cliActor) ctx.fatal("local start requires an explicit --actor <user:…|agent:…|system:…> when creating a workspace");
  if (!isCanonicalActorId(ctx.cliActor)) ctx.fatal("--actor must have the form user:<id>, agent:<id>, or system:<id>");
  if (ctx.arg("--confirm") !== "yes") {
    ctx.emitResult({
      ok: false,
      errors: ["local start creates a workspace and company; pass --confirm yes to continue"],
    });
    return null;
  }
  return ctx.cliActor;
}

export function register(
  dispatch: CommandDispatch,
  openBrowser: BrowserOpener = bestEffortOpenBrowser,
): void {
  dispatch.on("local", "start", (ctx) => {
    const rawWorkspace = ctx.trimToNull(ctx.arg("--workspace"));
    if (!rawWorkspace) return ctx.fatal("local start requires --workspace <dir>");

    let workspaceRoot: string;
    try {
      workspaceRoot = resolveWorkspaceRoot(rawWorkspace);
    } catch (error) {
      return ctx.fatal(error instanceof Error ? error.message : String(error));
    }

    const port = ctx.parseOptionalNumber("--port");
    if (!port.ok) return ctx.fatal(port.error);
    const companyName = ctx.trimToNull(ctx.arg("--company-name"));

    let createWorkspace: boolean;
    try {
      createWorkspace = isNewOrEmptyWorkspaceRoot(workspaceRoot);
    } catch (error) {
      return ctx.fatal(error instanceof Error ? error.message : String(error));
    }

    let company: { slug: string; name: string };
    if (createWorkspace) {
      // Validate every gate before `initWorkspace` makes its first directory.
      const actor = requireCreationConsent(ctx, companyName);
      if (!actor || !companyName) return;
      try {
        initWorkspace(workspaceRoot);
        const created = createCompany(workspaceRoot, {
          name: companyName,
          onboardingActor: actor,
        });
        company = { slug: created.slug, name: created.name };
      } catch (error) {
        return ctx.fatal(error instanceof Error ? error.message : String(error));
      }
    } else {
      if (companyName) {
        return ctx.fatal("--company-name is only valid when local start creates a new or empty workspace");
      }
      let manifest: ReturnType<typeof loadWorkspaceManifest>;
      try {
        manifest = loadWorkspaceManifest(workspaceRoot);
      } catch (error) {
        return ctx.fatal(error instanceof Error ? error.message : String(error));
      }
      const active = manifest.companies.filter((entry) => !entry.archived);
      if (active.length !== 1) {
        return ctx.emitResult({
          ok: false,
          errors: [
            active.length > 1
              ? "local start requires exactly one active company; use 'rentemester serve --workspace <dir>' for multi-company or hosted operation"
              : "local start requires one active company; restore or create a company explicitly before starting",
          ],
          workspace: workspaceRoot,
          activeCompanyCount: active.length,
        });
      }
      const entry = active[0]!;
      const root = companyRootForSlug(workspaceRoot, entry.slug);
      if (!existsSync(companyPaths(root).db)) {
        return ctx.emitResult({
          ok: false,
          errors: ["registered local company has no ledger database; refuse to start an invalid workspace"],
          workspace: workspaceRoot,
        });
      }
      company = { slug: entry.slug, name: entry.name };
    }

    let cockpit: ReturnType<typeof startCockpitServer>;
    try {
      // Startup owns schema migration; `/api/ready` itself remains strictly
      // read-only and can therefore prove this exact initialized state.
      openWorkspaceControlDb(workspaceRoot).close();
      const config = resolveServerConfig({
        host: DEFAULT_APP_HOST,
        port: port.value,
        workspaceRoot,
        env: localOnlyEnvironment(),
      });
      cockpit = startCockpitServer(config);
    } catch (error) {
      return ctx.fatal(error instanceof Error ? error.message : String(error));
    }

    const noOpen = ctx.hasFlag("--no-open");
    if (!noOpen) {
      try {
        openBrowser(cockpit.url);
      } catch {
        // Keep the launcher best-effort even when a test or platform-specific
        // opener throws synchronously after the socket is already available.
      }
    }

    const shutdown = () => {
      cockpit.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    ctx.emitResult({
      ok: true,
      message: `Local cockpit listening on ${cockpit.url}`,
      mode: "local-single-company",
      url: cockpit.url,
      dataLocation: workspaceRoot,
      company,
      host: cockpit.config.host,
      port: cockpit.server.port,
      authRequired: false,
      deploymentProfile: "local",
      browserOpenAttempted: !noOpen,
    });
  });
}
