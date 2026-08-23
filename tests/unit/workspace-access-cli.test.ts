import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCompany } from "../../src/core/company";
import { initWorkspace } from "../../src/core/workspace";
import { workspaceControlPaths } from "../../src/core/workspace-control";
import { readPrivateWorkspaceBootstrapPassword } from "../../src/cli/workspace-access";

const password = "very-private-bootstrap-password";

async function run(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env },
  });
  return { stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text(), exitCode: await proc.exited };
}

describe("workspace-access bootstrap-first CLI boundary", () => {
  test("reads only a no-follow, regular, exact-0600, bounded one-line password file", () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-bootstrap-password-"));
    try {
      const good = join(root, "good"); writeFileSync(good, `${password}\r\n`, { mode: 0o600 }); chmodSync(good, 0o600);
      expect(readPrivateWorkspaceBootstrapPassword(good)).toBe(password);
      const badMode = join(root, "mode"); writeFileSync(badMode, password, { mode: 0o644 }); chmodSync(badMode, 0o644);
      const oversized = join(root, "large"); writeFileSync(oversized, "x".repeat(4097), { mode: 0o600 }); chmodSync(oversized, 0o600);
      const multiline = join(root, "lines"); writeFileSync(multiline, "first\nsecond", { mode: 0o600 }); chmodSync(multiline, 0o600);
      const link = join(root, "link"); symlinkSync(good, link);
      for (const path of [badMode, oversized, multiline, link]) {
        expect(() => readPrivateWorkspaceBootstrapPassword(path)).toThrow("password file must be a regular 0600 file");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("confirm is a business gate before password read or control-db mutation, and output redacts all sensitive inputs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rentemester-bootstrap-cli-"));
    const secretPath = join(workspace, "private-password-file-name");
    const email = "canonical.bootstrap@example.test";
    const bearer = "Bearer-top-secret";
    const authSecret = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
    try {
      initWorkspace(workspace);
      const company = createCompany(workspace, { name: "Bootstrap Company", onboardingActor: "agent:codex" });
      const before = workspaceControlPaths(workspace).db;
      expect(existsSync(before)).toBe(false);
      const rejected = await run([
        "workspace-access", "bootstrap-first", "--workspace", workspace, "--company", company.slug,
        "--name", "Bootstrap", "--email", email, "--password-file", secretPath,
        "--actor", "agent:codex", "--json",
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false });
      expect(existsSync(before)).toBe(false);
      const combined = `${rejected.stdout}\n${rejected.stderr}`;
      for (const value of [password, email, secretPath, bearer, authSecret, "https://provider.example.test"]) expect(combined).not.toContain(value);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });

  test("hosted preflight fails closed and does not echo provider configuration or password input", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "rentemester-bootstrap-cli-preflight-"));
    const secretPath = join(workspace, "password");
    const email = "hidden@example.test";
    const bearer = "super-secret-bearer";
    const authSecret = "I0UjL6i0-ScgvjfIgzMKJxPQyDpPXwg2mMKdLW3Y3WQ";
    const endpoint = "http://provider.example.test/send";
    try {
      initWorkspace(workspace);
      const company = createCompany(workspace, { name: "Hosted Company", onboardingActor: "agent:codex" });
      writeFileSync(secretPath, password, { mode: 0o600 }); chmodSync(secretPath, 0o600);
      const result = await run([
        "workspace-access", "bootstrap-first", "--workspace", workspace, "--company", company.slug,
        "--name", "Bootstrap", "--email", email, "--password-file", secretPath,
        "--confirm", "yes", "--actor", "agent:codex", "--json",
      ], { RENTEMESTER_DEPLOYMENT_PROFILE: "hosted", RENTEMESTER_AUTH_SECRET: authSecret, RENTEMESTER_AUTH_BASE_URL: "https://rentemester.example.test", RENTEMESTER_AUTH_TRUSTED_ORIGINS: "https://rentemester.example.test", RENTEMESTER_AUTH_EMAIL_PROVIDER: "http-json-v1", RENTEMESTER_AUTH_EMAIL_URL: endpoint, RENTEMESTER_AUTH_EMAIL_BEARER_TOKEN: bearer, RENTEMESTER_AUTH_EMAIL_FROM: "auth@rentemester.example.test", RENTEMESTER_AUTH_RATE_LIMIT_IP_HEADER: "x-real-ip", RENTEMESTER_AUTH_RATE_LIMIT_PROXY_CONTRACT: "proxy-overwrites-client-ip-header-v1" });
      expect(result.exitCode).toBe(1);
      const combined = `${result.stdout}\n${result.stderr}`;
      for (const value of [password, email, secretPath, bearer, authSecret, endpoint]) expect(combined).not.toContain(value);
      expect(existsSync(workspaceControlPaths(workspace).db)).toBe(false);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
});
