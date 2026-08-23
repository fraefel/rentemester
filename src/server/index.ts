// Cockpit backend (#170, #213) — public surface barrel.
//
// A local JSON API on Bun.serve over the workspace + core. Reads and
// workspace-management, plus the #213 human-mode write routes — each routed
// through the `withCompanyMutation` write pipeline (backup lock, confirm gate,
// actor attribution, localhost hard-gate).

export {
  resolveServerConfig,
  DEFAULT_APP_HOST,
  DEFAULT_APP_PORT,
  DEPLOYMENT_PROFILES,
  HOSTED_AUTH_ENV,
} from "./config";
export type { ServerConfig, DeploymentProfile, HostedBetterAuthConfig, HostedAuthEmailConfig } from "./config";
export {
  createDisabledAuthEmailSender,
  createFakeAuthEmailSender,
  createHttpJsonV1AuthEmailSender,
} from "./auth-email";
export type { AuthEmailSender, AuthEmailMessage, AuthEmailHttpJsonV1Config } from "./auth-email";
export { startCockpitServer } from "./app";
export type { CockpitServer } from "./app";
export { handleRequest } from "./router";
export { observeRequest } from "./observability";
export type { RequestLogEvent, RequestLogSink } from "./observability";
export { handleMe } from "./router/me";
export { authMiddleware, LOCALHOST_PRINCIPAL } from "./auth";
export type { Principal } from "./auth";
export { ApiError, toErrorResponse } from "./errors";
export { withCompanyMutation } from "./mutations";
export type { MutationContext, CoreResult } from "./mutations";
export {
  resolveCockpitActor,
  withCockpitActor,
  COCKPIT_ACTOR_ID,
  COCKPIT_ACTOR_PROGRAM,
} from "./actor";
export {
  buildPortfolioOverview,
  buildCompanyDashboardData,
  resolveAsOfDate,
} from "./data";
export type { PortfolioOverview, CompanySummary } from "./data";
