import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";

/** Browser-only Better Auth client. The cockpit and API share one origin. */
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost" : window.location.origin,
  basePath: "/api/auth",
  plugins: [twoFactorClient()],
});
