import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { openWorkspaceControlDb } from "../../src/core/workspace-control";
import {
  createBetterAuthRequestProvider,
  createBetterAuthRuntime,
  createPrivateBootstrapService,
} from "../../src/server/better-auth";
import { createFakeAuthEmailSender } from "../../src/server/auth-email";
import { handleRequest } from "../../src/server/router";
import type { ServerConfig } from "../../src/server/config";

const ORIGIN = "https://cockpit.example.test";
const SECRET = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "rentemester-ba-cookie-e2e-"));
}

function cookieHeader(response: Response): string {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  return values.filter(Boolean).map((value) => value.split(";", 1)[0]!).join("; ");
}

function hasSecureCookie(response: Response): void {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  expect(values.join("\n")).toMatch(/HttpOnly/i);
  expect(values.join("\n")).toMatch(/Secure/i);
  expect(values.join("\n")).toMatch(/SameSite=Lax/i);
}

function jsonRequest(path: string, body: unknown, cookie?: string, origin = ORIGIN, clientIp = "198.51.100.20"): Request {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "cf-connecting-ip": clientIp,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("Better Auth cookie E2E security", () => {
  test("verification, cookies, CSRF, MFA challenge/recovery, reset and session revocation", async () => {
    const root = workspace();
    const operationalEvents: unknown[] = [];
    const consoleOutput: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalLog = console.log;
    try {
      console.warn = (...args: unknown[]) => { consoleOutput.push(args); };
      console.error = (...args: unknown[]) => { consoleOutput.push(args); };
      console.log = (...args: unknown[]) => { consoleOutput.push(args); };
      const db = openWorkspaceControlDb(root);
      const mail = createFakeAuthEmailSender();
      const options = {
        secret: SECRET,
        trustedOrigins: [ORIGIN],
        baseURL: ORIGIN,
        deploymentMode: "hosted" as const,
        useSecureCookies: true,
        rateLimitIpHeader: "cf-connecting-ip" as const,
        emailSender: mail,
        operationalLogger: { emit(event) { operationalEvents.push(event); } },
      };
      const auth = createBetterAuthRuntime(db, options);
      const provider = createBetterAuthRequestProvider(auth);
      const routerConfig: ServerConfig = {
        deploymentProfile: "hosted", host: "127.0.0.1", port: 4319,
        workspaceRoot: root, authRequired: true, authToken: null,
        betterAuthProvider: provider,
      };

      // Rentemester blocks public sign-up before Better Auth can process it.
      const blocked = await handleRequest(jsonRequest("/sign-up/email", {
        name: "Outside User", email: "outside@example.test", password: "a-password-with-12",
      }), routerConfig);
      expect(blocked.status).toBe(404);

      const bootstrap = createPrivateBootstrapService(db, options);
      let identity: { userId: string; created: boolean };
      try {
        identity = await bootstrap.createFirstIdentity({
          name: "Cookie User", email: "cookie@example.test", password: "a-password-with-12",
        });
      } catch (error) {
        throw new Error("bootstrap phase", { cause: error });
      }
      expect(identity.created).toBe(true);
      expect(db.query('SELECT COUNT(*) AS count FROM "session"').get()).toEqual({ count: 0 });
      expect(mail.messages).toHaveLength(1);

      // Password credentials cannot authenticate before the captured link is verified.
      const preVerify = await auth.handler(jsonRequest("/sign-in/email", {
        email: "cookie@example.test", password: "a-password-with-12",
      }));
      expect(preVerify.status).toBe(403);

      const verify = await auth.handler(new Request(mail.messages[0]!.url, {
        headers: { origin: ORIGIN, "cf-connecting-ip": "198.51.100.20" },
      }));
      expect(verify.status).toBe(302);
      expect(db.query('SELECT emailVerified FROM "user" WHERE id = ?').get(identity.userId)).toMatchObject({ emailVerified: 1 });

      const login = await auth.handler(jsonRequest("/sign-in/email", {
        email: "cookie@example.test", password: "a-password-with-12",
      }));
      expect(login.status).toBe(200);
      hasSecureCookie(login);
      const firstSession = cookieHeader(login);
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: firstSession } }))).not.toBeNull();

      // Origin checking is enforced by Better Auth's endpoint middleware.
      const csrf = await auth.handler(jsonRequest("/two-factor/enable", {
        password: "a-password-with-12", method: "totp",
      }, firstSession, "https://attacker.example.test"));
      expect(csrf.status).toBe(403);
      expect(operationalEvents).toContainEqual({
        component: "better-auth", event: "better_auth_error", level: "error",
      });
      // The BA global logger path must stay disabled; no raw untrusted Origin
      // (or arbitrary Better Auth argument) may reach console output.
      expect(JSON.stringify(consoleOutput)).not.toContain("attacker.example.test");

      const enroll = await auth.handler(jsonRequest("/two-factor/enable", {
        password: "a-password-with-12", method: "totp",
      }, firstSession));
      expect(enroll.status).toBe(200);
      const enrollment = await enroll.json() as { totpURI: string; backupCodes: string[] };
      expect(enrollment.totpURI).toStartWith("otpauth://totp/Rentemester:");
      expect(enrollment.backupCodes).toHaveLength(10);
      const enrollmentSession = cookieHeader(enroll) || firstSession;

      const totpSecret = new URL(enrollment.totpURI).searchParams.get("secret");
      expect(totpSecret).toBeTruthy();
      const enrollmentCode = await createOTP(new TextDecoder().decode(base32.decode(totpSecret!))).totp();
      const verifyTotp = await auth.handler(jsonRequest("/two-factor/verify-totp", {
        code: enrollmentCode,
      }, enrollmentSession));
      expect(verifyTotp.status).toBe(200);
      const activeSession = cookieHeader(verifyTotp);
      // Completing verified enrollment replaces the pre-enrollment session.
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: firstSession } }))).toBeNull();
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: activeSession } }))).not.toBeNull();

      // A new password login yields only a 2FA challenge, never an authenticated session.
      const challenge = await auth.handler(jsonRequest("/sign-in/email", {
        email: "cookie@example.test", password: "a-password-with-12",
      }));
      expect(challenge.status).toBe(200);
      expect(await challenge.clone().json()).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
      const challengeCookie = cookieHeader(challenge);
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: challengeCookie } }))).toBeNull();

      const recover = await auth.handler(jsonRequest("/two-factor/verify-backup-code", {
        code: enrollment.backupCodes[0],
      }, challengeCookie));
      expect(recover.status).toBe(200);
      const recoverySession = cookieHeader(recover);
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: recoverySession } }))).not.toBeNull();
      const replay = await auth.handler(jsonRequest("/two-factor/verify-backup-code", {
        code: enrollment.backupCodes[0],
      }, challengeCookie));
      expect(replay.status).toBe(401);
      const recoveryTelemetry = db.query(`SELECT endpoint, outcome, identity_hash
        FROM rm_workspace_auth_telemetry_events
        WHERE endpoint = 'two-factor-verify-backup-code' ORDER BY id`).all();
      expect(recoveryTelemetry).toEqual([
        { endpoint: "two-factor-verify-backup-code", outcome: "accepted", identity_hash: null },
        { endpoint: "two-factor-verify-backup-code", outcome: "rejected", identity_hash: null },
      ]);
      expect(JSON.stringify(recoveryTelemetry)).not.toContain(enrollment.backupCodes[0]);

      const passwordChange = await auth.handler(jsonRequest("/change-password", {
        currentPassword: "a-password-with-12",
        newPassword: "a-changed-password-with-12",
        revokeOtherSessions: true,
      }, recoverySession));
      expect(passwordChange.status).toBe(200);
      const passwordSession = cookieHeader(passwordChange);
      expect(passwordSession).not.toBe(recoverySession);
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: activeSession } }))).toBeNull();
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: recoverySession } }))).toBeNull();
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: passwordSession } }))).not.toBeNull();
      expect(db.query(`SELECT COUNT(*) AS count FROM rm_workspace_auth_state_events
        WHERE state_transition='credential_updated'`).get()).toEqual({ count: 1 });

      const revokeAll = await auth.handler(jsonRequest("/revoke-sessions", {}, passwordSession));
      expect(revokeAll.status).toBe(200);
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: activeSession } }))).toBeNull();
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: passwordSession } }))).toBeNull();

      // Establish a fresh MFA session so password reset independently proves
      // its documented revoke-all behavior.
      const resetChallenge = await auth.handler(jsonRequest("/sign-in/email", {
        email: "cookie@example.test", password: "a-changed-password-with-12",
      }, undefined, ORIGIN, "203.0.113.30"));
      const resetChallengeCookie = cookieHeader(resetChallenge);
      const resetLogin = await auth.handler(jsonRequest("/two-factor/verify-backup-code", {
        code: enrollment.backupCodes[1],
      }, resetChallengeCookie));
      expect(resetLogin.status).toBe(200);
      const preResetSession = cookieHeader(resetLogin);
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: preResetSession } }))).not.toBeNull();

      // Reset callback is mail-captured; reset invalidates every existing session.
      const resetRequest = await auth.handler(jsonRequest("/request-password-reset", {
        email: "cookie@example.test",
      }));
      expect(resetRequest.status).toBe(200);
      const resetMail = mail.messages.at(-1)!;
      expect(resetMail.kind).toBe("password-reset");
      const resetToken = new URL(resetMail.url).pathname.split("/").at(-1)!;
      const reset = await auth.handler(jsonRequest("/reset-password", {
        token: resetToken, newPassword: "a-new-password-with-12",
      }));
      expect(reset.status).toBe(200);
      expect(await provider.getSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: preResetSession } }))).toBeNull();

      // Varying raw XFF does not evade the reset endpoint's IP bucket: all
      // requests share the same configured proxy-overwritten CF header.
      const rateStatuses: number[] = [];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await auth.handler(new Request(`${ORIGIN}/api/auth/request-password-reset`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            "cf-connecting-ip": "203.0.113.40",
            "x-forwarded-for": `198.51.100.${attempt}`,
          },
          body: JSON.stringify({ email: "cookie@example.test" }),
        }));
        rateStatuses.push(response.status);
      }
      expect(rateStatuses).toEqual([200, 200, 200, 429]);

      // The only configured IP source is cf-connecting-ip: raw XFF does not
      // enter Better Auth's IP configuration and cannot alter that contract.
      expect(auth.options.advanced).toMatchObject({
        disableOriginCheck: false,
        disableCSRFCheck: false,
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      });
      expect(JSON.stringify(auth.options.advanced)).not.toContain("x-forwarded-for");
      db.close();
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      console.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
